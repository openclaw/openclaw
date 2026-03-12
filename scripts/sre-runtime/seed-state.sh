#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${OPENCLAW_SRE_RUNTIME_REPO_DIR:-${OPENCLAW_SRE_REPO_DIR:-/srv/openclaw/repos/openclaw-sre}}"
STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${STATE_DIR}/openclaw.json}"
SKILL_SOURCE_DIR="${OPENCLAW_SRE_SKILL_SOURCE_DIR:-${REPO_ROOT}/skills/morpho-sre}"
SKILL_DEST_DIR="${STATE_DIR}/skills/morpho-sre"
WORKSPACE_DIR="${STATE_DIR}/workspace"
OWNERSHIP_DEST="${OPENCLAW_SRE_REPO_OWNERSHIP_FILE:-${STATE_DIR}/state/sre-index/repo-ownership.json}"
GRAPH_DIR="${OPENCLAW_SRE_GRAPH_DIR:-${STATE_DIR}/state/sre-graph}"
DOSSIERS_DIR="${OPENCLAW_SRE_DOSSIERS_DIR:-${STATE_DIR}/state/sre-dossiers}"
INDEX_DIR="${OPENCLAW_SRE_INDEX_DIR:-${STATE_DIR}/state/sre-index}"
PLANS_DIR="${OPENCLAW_SRE_PLANS_DIR:-${STATE_DIR}/state/sre-plans}"

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

mkdir -p \
  "$STATE_DIR/bin" \
  "$STATE_DIR/skills" \
  "$WORKSPACE_DIR" \
  "$GRAPH_DIR" \
  "$DOSSIERS_DIR" \
  "$INDEX_DIR" \
  "$PLANS_DIR"

copy_file "${SKILL_SOURCE_DIR}/config/openclaw.json" "$CONFIG_PATH"
chmod 600 "$CONFIG_PATH" || true

rm -rf "$SKILL_DEST_DIR"
mkdir -p "${SKILL_DEST_DIR}/scripts" "${SKILL_DEST_DIR}/references"

copy_file "${SKILL_SOURCE_DIR}/SKILL.md" "${SKILL_DEST_DIR}/SKILL.md"
copy_file "${SKILL_SOURCE_DIR}/HEARTBEAT.md" "${WORKSPACE_DIR}/HEARTBEAT.md"

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
    SKILL.md|HEARTBEAT.md)
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
  go-memory-profiling
  terraform-ci-review
)

for skill_name in "${required_bundled_skills[@]}"; do
  if [ -d "${REPO_ROOT}/skills/${skill_name}" ]; then
    copy_tree "${REPO_ROOT}/skills/${skill_name}" "${STATE_DIR}/skills/${skill_name}"
    chmod_scripts_in_dir "${STATE_DIR}/skills/${skill_name}"
  else
    echo "seed-state:warning required skill '${skill_name}' not found at ${REPO_ROOT}/skills/${skill_name}" >&2
  fi
done

echo "seed-state:ok"
