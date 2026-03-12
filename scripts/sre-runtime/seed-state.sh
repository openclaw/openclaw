#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${OPENCLAW_SRE_RUNTIME_REPO_DIR:-${OPENCLAW_SRE_REPO_DIR:-/srv/openclaw/repos/openclaw-sre}}"
STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${STATE_DIR}/openclaw.json}"
SKILL_SOURCE_DIR="${OPENCLAW_SRE_SKILL_SOURCE_DIR:-${REPO_ROOT}/skills/morpho-sre}"
SKILL_DEST_DIR="${STATE_DIR}/skills/morpho-sre"
WORKSPACE_DIR="${STATE_DIR}/workspace"
SRE_WORKSPACE_DIR="${STATE_DIR}/workspace-sre"
OWNERSHIP_DEST="${OPENCLAW_SRE_INIT_REPO_OWNERSHIP_FILE:-${OPENCLAW_SRE_REPO_OWNERSHIP_FILE:-${STATE_DIR}/state/sre-index/repo-ownership.json}}"
GRAPH_DIR="${OPENCLAW_SRE_INIT_GRAPH_DIR:-${OPENCLAW_SRE_GRAPH_DIR:-${STATE_DIR}/state/sre-graph}}"
DOSSIERS_DIR="${OPENCLAW_SRE_INIT_DOSSIERS_DIR:-${OPENCLAW_SRE_DOSSIERS_DIR:-${STATE_DIR}/state/sre-dossiers}}"
INDEX_DIR="${OPENCLAW_SRE_INIT_INDEX_DIR:-${OPENCLAW_SRE_INDEX_DIR:-${STATE_DIR}/state/sre-index}}"
PLANS_DIR="${OPENCLAW_SRE_INIT_PLANS_DIR:-${OPENCLAW_SRE_PLANS_DIR:-${STATE_DIR}/state/sre-plans}}"
SLACK_INCIDENT_CHANNELS_RAW="${OPENCLAW_SRE_SLACK_INCIDENT_CHANNELS:-}"

copy_tree() {
  local src="$1"
  local dest="$2"
  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  cp -R "$src" "$dest"
}

copy_file() {
  local src="$1"
  local dest="$2"
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
}

chmod_scripts_in_dir() {
  local dir="$1"
  if [ -d "$dir" ]; then
    find "$dir" -type f -name '*.sh' -exec chmod +x {} +
  fi
}

normalize_slack_incident_channels_json() {
  printf '%s' "$SLACK_INCIDENT_CHANNELS_RAW" \
    | tr ',\n' '\n' \
    | jq -Rsc '
        split("\n")
        | map(gsub("^\\s+|\\s+$"; ""))
        | map(select(length > 0))
        | map(if startswith("#") then . else "#"+. end)
        | map(ascii_downcase)
        | unique
      '
}

apply_slack_incident_channel_override() {
  [ -n "$SLACK_INCIDENT_CHANNELS_RAW" ] || return 0

  local channels_json
  channels_json="$(normalize_slack_incident_channels_json)"
  if ! jq -e 'length > 0' >/dev/null <<<"$channels_json"; then
    echo "seed-state:error OPENCLAW_SRE_SLACK_INCIDENT_CHANNELS did not contain any channels" >&2
    exit 1
  fi

  local tmp_config
  tmp_config="$(mktemp "${CONFIG_PATH}.tmp.XXXXXX")"
  jq --argjson incident_channels "$channels_json" '
    .channels.slack.channels as $channels
    | ($incident_channels | map(select(. != "#bug-report"))) as $override_channels
    | ($channels["#bug-report"]) as $bug_report
    | ($channels["#platform-monitoring"]
        // $channels["#public-api-monitoring"]) as $monitoring_template
    | if $bug_report == null or $monitoring_template == null then
        error("missing seeded Slack incident channel templates")
      else
        .channels.slack.channels = (
          reduce $override_channels[] as $channel
            ({ "#bug-report": $bug_report }; . + { ($channel): $monitoring_template })
        )
      end
  ' "$CONFIG_PATH" >"$tmp_config"
  jq -e '.channels.slack.channels | length > 0 and has("#bug-report")' "$tmp_config" >/dev/null || {
    rm -f "$tmp_config"
    echo "seed-state:error produced invalid Slack incident channel config" >&2
    exit 1
  }
  mv "$tmp_config" "$CONFIG_PATH"
}

ensure_workspace_memory_scaffold() {
  local workspace_dir="$1"
  local today_file yesterday_file

  mkdir -p "${workspace_dir}/memory"
  touch "${workspace_dir}/MEMORY.md"
  if date -u -d 'yesterday' +%F >/dev/null 2>&1; then
    today_file="${workspace_dir}/memory/$(date -u +%F).md"
    yesterday_file="${workspace_dir}/memory/$(date -u -d 'yesterday' +%F).md"
  else
    today_file="${workspace_dir}/memory/$(date -u +%F).md"
    yesterday_file="${workspace_dir}/memory/$(date -u -v-1d +%F).md"
  fi
  touch "$today_file" "$yesterday_file"
}

mkdir -p \
  "$STATE_DIR/bin" \
  "$STATE_DIR/skills" \
  "$WORKSPACE_DIR" \
  "$SRE_WORKSPACE_DIR" \
  "$GRAPH_DIR" \
  "$DOSSIERS_DIR" \
  "$INDEX_DIR" \
  "$PLANS_DIR"

ensure_workspace_memory_scaffold "$WORKSPACE_DIR"
ensure_workspace_memory_scaffold "$SRE_WORKSPACE_DIR"

copy_file "${SKILL_SOURCE_DIR}/config/openclaw.json" "$CONFIG_PATH"
apply_slack_incident_channel_override
chmod 600 "$CONFIG_PATH" || true

rm -rf "$SKILL_DEST_DIR"
mkdir -p "${SKILL_DEST_DIR}/scripts" "${SKILL_DEST_DIR}/references"

copy_file "${SKILL_SOURCE_DIR}/SKILL.md" "${SKILL_DEST_DIR}/SKILL.md"
copy_file "${SKILL_SOURCE_DIR}/HEARTBEAT.md" "${WORKSPACE_DIR}/HEARTBEAT.md"
copy_file "${SKILL_SOURCE_DIR}/HEARTBEAT.md" "${SRE_WORKSPACE_DIR}/HEARTBEAT.md"

if [ -f "${SKILL_SOURCE_DIR}/rca_hypothesis_ids.v1.json" ]; then
  copy_file "${SKILL_SOURCE_DIR}/rca_hypothesis_ids.v1.json" \
    "${SKILL_DEST_DIR}/rca_hypothesis_ids.v1.json"
fi

if [ -f "${SKILL_SOURCE_DIR}/repo-ownership.json" ]; then
  copy_file "${SKILL_SOURCE_DIR}/repo-ownership.json" "$OWNERSHIP_DEST"
  copy_file "${SKILL_SOURCE_DIR}/repo-ownership.json" \
    "${SKILL_DEST_DIR}/references/repo-ownership.json"
fi

while IFS= read -r path; do
  [ -f "$path" ] || continue
  name="$(basename "$path")"
  case "$name" in
    SKILL.md|HEARTBEAT.md|._*)
      ;;
    *.sh)
      copy_file "$path" "${SKILL_DEST_DIR}/scripts/${name}"
      ;;
    *.md)
      copy_file "$path" "${SKILL_DEST_DIR}/${name}"
      ;;
    *.json|*.yaml)
      copy_file "$path" "${SKILL_DEST_DIR}/${name}"
      ;;
  esac
done < <(find "$SKILL_SOURCE_DIR" -maxdepth 1 -type f | sort)

for dir_name in references evidence-manifests; do
  if [ -d "${SKILL_SOURCE_DIR}/${dir_name}" ]; then
    copy_tree "${SKILL_SOURCE_DIR}/${dir_name}" "${SKILL_DEST_DIR}/${dir_name}"
  fi
done

chmod_scripts_in_dir "${SKILL_DEST_DIR}/scripts"

required_bundled_skills=(
  argocd-diff
  eks-troubleshoot
  foundry-evm-debug
  grafana-metrics-best-practices
  go-memory-profiling
  terraform-ci-review
)

for skill_name in "${required_bundled_skills[@]}"; do
  if [ -d "${REPO_ROOT}/skills/${skill_name}" ]; then
    copy_tree "${REPO_ROOT}/skills/${skill_name}" "${STATE_DIR}/skills/${skill_name}"
    chmod_scripts_in_dir "${STATE_DIR}/skills/${skill_name}"
  else
    echo "seed-state:error required skill '${skill_name}' not found at ${REPO_ROOT}/skills/${skill_name}" >&2
    exit 1
  fi
done

echo "seed-state:ok"
