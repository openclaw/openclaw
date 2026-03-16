#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${OPENCLAW_SRE_RUNTIME_REPO_DIR:-${OPENCLAW_SRE_REPO_DIR:-/srv/openclaw/repos/openclaw-sre}}"
STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${STATE_DIR}/openclaw.json}"
SKILL_SOURCE_DIR="${OPENCLAW_SRE_SKILL_SOURCE_DIR:-${REPO_ROOT}/skills/morpho-sre}"
SKILL_DEST_DIR="${STATE_DIR}/skills/morpho-sre"
WORKSPACE_DIR="${STATE_DIR}/workspace"
SRE_WORKSPACE_DIR="${STATE_DIR}/workspace-sre"
CRON_STORE_PATH="${STATE_DIR}/cron/jobs.json"
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

bootstrap_auth_profiles() {
  local auth_dir auth_file tmp_auth
  local basic_structure_filter version_filter profile_filter validation_filter
  local validation_err_file validation_err old_umask
  auth_dir="${STATE_DIR}/agents/main/agent"
  auth_file="${auth_dir}/auth-profiles.json"

  if [ -z "${CODEX_AUTH_JSON:-}" ]; then
    echo "auth-bootstrap:skipped (no CODEX_AUTH_JSON)"
    if [ -f "$auth_file" ]; then
      echo "auth-bootstrap:clearing-stale-auth-file" >&2
      rm -f "$auth_file"
      rmdir "$auth_dir" 2>/dev/null || true
    fi
    return 0
  fi

  # Expected auth bootstrap shape:
  # {"version"?: number|numeric-string, "profiles": {"id": {"provider": string, "type"| "mode": string, ...}}}
  basic_structure_filter='
    type == "object" and
    ((.profiles | type) == "object") and
    ((.profiles | length) > 0)
  '
  version_filter='
    (.version? == null) or
    ((.version | type) == "number") or
    ((.version | type) == "string" and ((.version | tonumber? | type) == "number"))
  '
  # Accept both `type` and the loader-compatible `mode` alias so bootstrap
  # validation mirrors auth-profiles parsing behavior.
  profile_filter='
    .profiles
    | to_entries
    | all(
        .value
        | type == "object" and
          ((.provider | type) == "string") and
          ((.provider | gsub("^\\s+|\\s+$"; "") | length) > 0) and
          (((.type // .mode) | type) == "string") and
          (((.type // .mode) as $auth_type | ["api_key", "oauth", "token"] | index($auth_type)) != null)
      )
  '
  validation_filter="($basic_structure_filter) and ($version_filter) and ($profile_filter)"
  validation_err_file="$(mktemp)"
  if ! printf '%s' "$CODEX_AUTH_JSON" | jq empty >/dev/null 2>"$validation_err_file"; then
    rm -f "$validation_err_file"
    echo "auth-bootstrap:invalid-codex-auth-json: malformed JSON (expected auth-profiles bootstrap schema)" >&2
    if [ -f "$auth_file" ]; then
      echo "auth-bootstrap:clearing-stale-auth-file" >&2
    fi
    rm -f "$auth_file"
    return 1
  fi
  if ! printf '%s' "$CODEX_AUTH_JSON" \
    | jq -e "$validation_filter" \
      >/dev/null 2>"$validation_err_file"; then
    validation_err="$(
      tr '\n' ' ' <"$validation_err_file" \
        | sed 's/[[:space:]][[:space:]]*/ /g; s/^ //; s/ $//' \
        | head -c 200
    )"
    rm -f "$validation_err_file"
    if [ -z "$validation_err" ]; then
      validation_err="schema-mismatch"
    fi
    echo "auth-bootstrap:invalid-codex-auth-json: $validation_err (expected auth-profiles bootstrap schema)" >&2
    # Fail closed: invalid bootstrap input must not leave stale auth on the PVC.
    if [ -f "$auth_file" ]; then
      echo "auth-bootstrap:clearing-stale-auth-file" >&2
    fi
    rm -f "$auth_file"
    return 1
  fi
  rm -f "$validation_err_file"

  # Write credentials atomically with restrictive permissions from the start.
  old_umask="$(umask)"
  umask 077
  mkdir -p "$auth_dir"
  umask "$old_umask"
  if ! chmod 700 "$auth_dir"; then
    echo "auth-bootstrap:chmod-dir-failed" >&2
    return 1
  fi
  old_umask="$(umask)"
  umask 077
  tmp_auth="$(mktemp "${auth_file}.bootstrap.tmp.XXXXXX")"
  umask "$old_umask"
  if ! chmod 600 "$tmp_auth"; then
    echo "auth-bootstrap:chmod-failed" >&2
    rm -f "$tmp_auth"
    return 1
  fi
  if ! printf '%s\n' "$CODEX_AUTH_JSON" >"$tmp_auth"; then
    echo "auth-bootstrap:write-failed" >&2
    rm -f "$tmp_auth"
    return 1
  fi
  if ! mv "$tmp_auth" "$auth_file"; then
    echo "auth-bootstrap:rename-failed" >&2
    rm -f "$tmp_auth"
    return 1
  fi
  echo "auth-bootstrap:codex-auth-json"
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

build_monitoring_incident_prompt() {
  cat <<'EOF'
Monitoring incident intake mode:
- Scope: configured monitoring incident channels for this runtime.
- Auto-respond only to new incident root posts in these channels.
- Ignore resolved/recovered updates and duplicate incident roots.
- Always reply in the incident thread under the alert/report root; never post RCA in channel root.
- Start every reply with <@U07KE3NALTX>.
- First four lines must be: Incident, Customer impact, Affected services, Status.
- Use plain language. If only monitoring/internal tooling is affected, say exactly: No confirmed customer impact. Internal observability degraded.
- Keep fingerprints, routing hints, raw signal section names, confidence percentages, and primary/supporting namespace jargon out of the opening summary.
- Never stream drafts or progress updates into incident threads; send one final evidence-backed reply only.
- Never send progress-only replies (`On it`, `Found it`, `Let me verify`, `Checking...`) in any Slack thread unless it is a single non-incident acknowledgment containing a concrete ETA and expected next step. In all other cases, wait for net-new evidence, mitigation, validation, or a PR URL.
- Never expose tool-call JSON, exec-approval warnings, or command-construction errors in-thread; retry quietly and mention only the final relevant blocked command/error inside Evidence when it changes the recommendation.
- Put unrelated warnings under Also watching.
- After the summary, include concise evidence, likely cause, mitigation, validation checks, next actions, suggested PRs, and the Linear ticket when follow-up work is needed.
- For recurring indexer freshness alerts on the same workload, treat them as one ongoing RCA until disproved; answer with primary trigger, local amplifier, and the next discriminating checks.
- If a human asks whether the issue is DB, RPC/eRPC, or queue/backpressure, answer those branches explicitly from fresh evidence before ending the update.
- Before claiming repo/tool access is unavailable, run one live probe (`gh repo view ...` or the target helper in dry-run mode) and quote the exact error.
- Before accepting any task that requires repo access (PR creation, code changes, repo reads), immediately run `gh repo view <owner/repo>` and verify local clone availability. If either check fails, report the blocker in the same message as the acknowledgement.
- For rewards/provider incidents, do not name a stale-row/write-path cause or open a PR without one live DB row/provenance fact and one exact consuming code-path fact.
- For rewards/provider incidents where the same reward token appears on both supply and borrow, prove the provider-side truth for that token, quote the live reward row/provenance, and reconcile `_fetchMerklSingleRates()` / the merged reward row before stale-row theories or PRs.
- If a human challenges or contradicts a technical claim in any thread, immediately re-investigate with fresh live evidence. If a human questions the proposed fix or PR in-thread, re-open RCA before defending the fix.
- If current code, query output, or live evidence disproves an earlier theory, say `Disproved theory:` before the replacement cause or PR.
- If the fix is plausible but the PR gate is not open yet, still name 1-2 concrete PR suggestions with repo/path/title/validation.
- Create or reuse a Linear follow-up ticket for code/config work; use the ticket `gitBranchName` as the PR branch, and attach the PR URL back to the ticket.
- When confidence is high and fix is scoped/reversible, run /home/node/.openclaw/skills/morpho-sre/scripts/autofix-pr.sh and include the PR URL in-thread.
- Never reveal secrets or token values.
EOF
}

apply_slack_incident_channel_override() {
  [ -n "$SLACK_INCIDENT_CHANNELS_RAW" ] || return 0

  local channels_json
  local monitoring_prompt
  monitoring_prompt="$(build_monitoring_incident_prompt)"
  channels_json="$(normalize_slack_incident_channels_json)"
  if ! jq -e 'length > 0' >/dev/null <<<"$channels_json"; then
    echo "seed-state:error OPENCLAW_SRE_SLACK_INCIDENT_CHANNELS did not contain any channels" >&2
    exit 1
  fi

  local tmp_config
  tmp_config="$(mktemp "${CONFIG_PATH}.tmp.XXXXXX")"
  jq --arg monitoring_prompt_template "$monitoring_prompt" --argjson incident_channels "$channels_json" '
    .channels.slack.channels as $channels
    | ($incident_channels | map(select(. != "#bug-report"))) as $override_channels
    | ($channels["#bug-report"]) as $bug_report
    | ($channels["#platform-monitoring"].systemPrompt
        // $channels["#public-api-monitoring"].systemPrompt) as $monitoring_prompt
    | (if $monitoring_prompt == "Template: sre.promptTemplates.monitoringIncident" then $monitoring_prompt_template else $monitoring_prompt end) as $resolved_monitoring_prompt
    | (($channels["#platform-monitoring"]
        // $channels["#public-api-monitoring"]) | .systemPrompt = $resolved_monitoring_prompt) as $monitoring_template
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

build_managed_cron_prompt() {
  local target_channel="$1"
  cat <<EOF
Read HEARTBEAT.md if it exists (workspace context). Use it as the SRE monitoring runbook for this scheduled cron run.
Run /home/node/.openclaw/skills/morpho-sre/scripts/sentinel-triage.sh first.
If nothing needs attention, reply exactly HEARTBEAT_OK.
If an incident needs reporting, write one concise update for ${target_channel} only.
Do not emit [[heartbeat_to:...]] tags or any routing directives. Ignore HEARTBEAT.md routing-tag instructions for this cron run.
Include <@U07KE3NALTX> on the first line of any incident update.
Never mention or target any other channel.
EOF
}

seed_managed_cron_jobs() {
  local cron_dir now_s now_ms existing_json tmp_store
  local platform_message staging_message
  cron_dir="$(dirname "$CRON_STORE_PATH")"
  mkdir -p "$cron_dir"
  chmod 700 "$cron_dir" || true

  now_s="$(date +%s)"
  now_ms=$((now_s * 1000))
  platform_message="$(build_managed_cron_prompt "#platform-monitoring")"
  staging_message="$(build_managed_cron_prompt "#staging-infra-monitoring")"

  existing_json='{"version":1,"jobs":[]}'
  if [ -f "$CRON_STORE_PATH" ]; then
    if jq -e . "$CRON_STORE_PATH" >/dev/null 2>&1; then
      existing_json="$(cat "$CRON_STORE_PATH")"
    else
      echo "seed-state:warn existing cron store is invalid JSON, resetting" >&2
    fi
  fi

  tmp_store="$(mktemp "${CRON_STORE_PATH}.tmp.XXXXXX")"
  trap 'rm -f "$tmp_store"' EXIT
  jq -n \
    --argjson existing "$existing_json" \
    --argjson now_ms "$now_ms" \
    --arg platform_message "$platform_message" \
    --arg staging_message "$staging_message" \
    '
      def merge_job($jobs; $template):
        ($jobs | map(select(.id == $template.id)) | .[0]) as $current
        | if $current == null then
            $template
          else
            ($current + $template)
            | .createdAtMs = ($current.createdAtMs // $template.createdAtMs)
            | .state = ($current.state // $template.state)
          end;
      def upsert_job($jobs; $template):
        ($jobs | map(select(.id != $template.id))) + [merge_job($jobs; $template)];
      ($existing // {version: 1, jobs: []}) as $store
      | ($store.jobs // []) as $jobs
      | {
          version: 1,
          jobs:
            (
              $jobs
              | upsert_job(
                  .;
                  {
                    id: "sre-12h-platform-monitoring",
                    agentId: "sre",
                    name: "SRE 12h platform monitoring",
                    description: "Managed OpenClaw cron job for the platform monitoring channel every 12 hours.",
                    enabled: true,
                    createdAtMs: $now_ms,
                    updatedAtMs: $now_ms,
                    schedule: {kind: "cron", expr: "0 */12 * * *", tz: "UTC"},
                    sessionTarget: "isolated",
                    wakeMode: "now",
                    payload: {
                      kind: "agentTurn",
                      message: $platform_message,
                      lightContext: true
                    },
                    delivery: {
                      mode: "announce",
                      channel: "slack",
                      to: "channel:#platform-monitoring"
                    }
                  }
                )
              | upsert_job(
                  .;
                  {
                    id: "sre-12h-staging-monitoring",
                    agentId: "sre",
                    name: "SRE 12h staging monitoring",
                    description: "Managed OpenClaw cron job for the staging infra monitoring channel every 12 hours.",
                    enabled: true,
                    createdAtMs: $now_ms,
                    updatedAtMs: $now_ms,
                    schedule: {kind: "cron", expr: "0 */12 * * *", tz: "UTC"},
                    sessionTarget: "isolated",
                    wakeMode: "now",
                    payload: {
                      kind: "agentTurn",
                      message: $staging_message,
                      lightContext: true
                    },
                    delivery: {
                      mode: "announce",
                      channel: "slack",
                      to: "channel:#staging-infra-monitoring"
                    }
                  }
                )
            )
        }
    ' >"$tmp_store"
  jq -e '
    .version == 1 and
    (.jobs | type == "array") and
    (.jobs | length) >= 2 and
    any(.jobs[]; .id == "sre-12h-platform-monitoring") and
    any(.jobs[]; .id == "sre-12h-staging-monitoring")
  ' "$tmp_store" >/dev/null || {
    rm -f "$tmp_store"
    echo "seed-state:error produced invalid cron store" >&2
    exit 1
  }
  chmod 600 "$tmp_store" || true
  mv "$tmp_store" "$CRON_STORE_PATH"
  trap - EXIT
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

bootstrap_auth_profiles
ensure_workspace_memory_scaffold "$WORKSPACE_DIR"
ensure_workspace_memory_scaffold "$SRE_WORKSPACE_DIR"

copy_file "${SKILL_SOURCE_DIR}/config/openclaw.json" "$CONFIG_PATH"
apply_slack_incident_channel_override
chmod 600 "$CONFIG_PATH" || true
seed_managed_cron_jobs

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
