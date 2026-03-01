#!/usr/bin/env bash
set -euo pipefail

# Sync an existing openai-codex OAuth profile from the main agent to other agents.
#
# Usage:
#   scripts/openclaw-codex-profile-sync.sh <label> [--agents all|a,b,c] [--source-agent <id>] [--dry-run]
#
# Examples:
#   scripts/openclaw-codex-profile-sync.sh work
#   scripts/openclaw-codex-profile-sync.sh work --agents dev-openclaw,gpod
#   scripts/openclaw-codex-profile-sync.sh default --agents all --dry-run

LABEL=""
AGENTS="all"
SOURCE_AGENT="main"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agents)
      AGENTS="${2:-}"
      shift 2
      ;;
    --source-agent)
      SOURCE_AGENT="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      sed -n '1,40p' "$0"
      exit 0
      ;;
    --*)
      echo "error: unknown flag: $1" >&2
      exit 1
      ;;
    *)
      if [[ -z "$LABEL" ]]; then
        LABEL="$1"
        shift
      else
        echo "error: unexpected argument: $1" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$LABEL" ]]; then
  echo "error: missing profile label (example: work)" >&2
  exit 1
fi

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
PROFILE_ID="openai-codex:${LABEL}"
SRC_AUTH_FILE="$OPENCLAW_HOME/agents/$SOURCE_AGENT/agent/auth-profiles.json"

if [[ ! -f "$SRC_AUTH_FILE" ]]; then
  echo "error: source auth store not found: $SRC_AUTH_FILE" >&2
  exit 1
fi

# Validate source profile exists and looks like codex oauth.
if ! jq -e --arg pid "$PROFILE_ID" '.profiles[$pid] != null' "$SRC_AUTH_FILE" >/dev/null; then
  echo "error: profile not found in source agent ($SOURCE_AGENT): $PROFILE_ID" >&2
  exit 1
fi

if ! jq -e --arg pid "$PROFILE_ID" '.profiles[$pid].provider == "openai-codex" and .profiles[$pid].type == "oauth"' "$SRC_AUTH_FILE" >/dev/null; then
  echo "error: profile exists but is not openai-codex oauth: $PROFILE_ID" >&2
  exit 1
fi

source_profile_json="$(jq -c --arg pid "$PROFILE_ID" '.profiles[$pid]' "$SRC_AUTH_FILE")"

list_agents() {
  if [[ "$AGENTS" == "all" ]]; then
    for d in "$OPENCLAW_HOME"/agents/*; do
      [[ -d "$d" ]] || continue
      basename "$d"
    done
  else
    printf '%s\n' "$AGENTS" | tr ',' '\n' | sed '/^\s*$/d'
  fi
}

updated=0
skipped=0
for agent in $(list_agents); do
  # Don't rewrite source agent unless explicitly included in list mode.
  if [[ "$AGENTS" == "all" && "$agent" == "$SOURCE_AGENT" ]]; then
    skipped=$((skipped + 1))
    continue
  fi

  agent_dir="$OPENCLAW_HOME/agents/$agent/agent"
  auth_file="$agent_dir/auth-profiles.json"

  if [[ ! -d "$agent_dir" ]]; then
    echo "warn: agent dir missing, skipping: $agent_dir" >&2
    skipped=$((skipped + 1))
    continue
  fi

  if [[ ! -f "$auth_file" ]]; then
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "[dry-run] would create auth store: $auth_file"
    else
      mkdir -p "$agent_dir"
      printf '{"version":1,"profiles":{},"lastGood":{},"usageStats":{}}\n' > "$auth_file"
      chmod 600 "$auth_file"
    fi
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] would set $PROFILE_ID on agent=$agent from source=$SOURCE_AGENT"
    updated=$((updated + 1))
    continue
  fi

  cp "$auth_file" "${auth_file}.bak.$(date +%Y%m%d-%H%M%S)"

  tmp="$(mktemp)"
  jq \
    --arg pid "$PROFILE_ID" \
    --arg provider "openai-codex" \
    --argjson profile "$source_profile_json" \
    '
      .version = (.version // 1) |
      .profiles = (.profiles // {}) |
      .order = (.order // {}) |
      .lastGood = (.lastGood // {}) |
      .usageStats = (.usageStats // {}) |
      .profiles[$pid] = $profile |
      # Ensure per-provider order exists and keeps this profile first without
      # dropping any existing entries.
      .order[$provider] = (
        ([ $pid ] + (.order[$provider] // []))
        | map(select(type == "string" and length > 0))
        | reduce .[] as $x ([]; if index($x) then . else . + [$x] end)
      )
    ' "$auth_file" > "$tmp"

  mv "$tmp" "$auth_file"
  chmod 600 "$auth_file"
  echo "updated: $agent -> $PROFILE_ID"
  updated=$((updated + 1))
done

echo "done: updated=$updated skipped=$skipped profile=$PROFILE_ID source=$SOURCE_AGENT"
