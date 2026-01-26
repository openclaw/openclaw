#!/usr/bin/env bash
# meshguard-cli.sh — MeshGuard API wrapper for Clawdbot
set -euo pipefail

# Load config if exists
CONFIG_FILE="${HOME}/.meshguard/config"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$CONFIG_FILE"
fi

MESHGUARD_URL="${MESHGUARD_URL:-https://dashboard.meshguard.app}"
MESHGUARD_API_KEY="${MESHGUARD_API_KEY:-}"
MESHGUARD_ADMIN_TOKEN="${MESHGUARD_ADMIN_TOKEN:-}"

API_BASE="${MESHGUARD_URL}/api/v1"

# ─── Helpers ──────────────────────────────────────────────────────────────────

die() { echo "ERROR: $*" >&2; exit 1; }

auth_header() {
  [[ -n "$MESHGUARD_API_KEY" ]] || die "MESHGUARD_API_KEY not set. Run meshguard-setup.sh first."
  echo "Authorization: Bearer ${MESHGUARD_API_KEY}"
}

admin_header() {
  [[ -n "$MESHGUARD_ADMIN_TOKEN" ]] || die "MESHGUARD_ADMIN_TOKEN not set. Required for this operation."
  echo "Authorization: Bearer ${MESHGUARD_ADMIN_TOKEN}"
}

api_get() {
  local endpoint="$1"
  curl -sf -H "$(auth_header)" -H "Content-Type: application/json" "${API_BASE}${endpoint}"
}

api_post() {
  local endpoint="$1" data="$2"
  curl -sf -H "$(auth_header)" -H "Content-Type: application/json" -d "$data" "${API_BASE}${endpoint}"
}

api_delete() {
  local endpoint="$1"
  curl -sf -X DELETE -H "$(auth_header)" -H "Content-Type: application/json" "${API_BASE}${endpoint}"
}

api_post_admin() {
  local endpoint="$1" data="$2"
  curl -sf -H "$(admin_header)" -H "Content-Type: application/json" -d "$data" "${API_BASE}${endpoint}"
}

format_json() {
  if command -v jq &>/dev/null; then
    jq '.'
  else
    cat
  fi
}

usage() {
  cat <<EOF
Usage: meshguard-cli.sh <command> [subcommand] [args...]

Commands:
  status                                    Check gateway health
  agents list                               List all agents
  agents create <name> --tier <tier>        Create an agent
  agents get <id>                           Get agent details
  agents delete <id>                        Delete an agent
  policies list                             List all policies
  policies create <yaml-file>               Create policy from YAML
  policies get <id>                         Get policy details
  policies delete <id>                      Delete a policy
  audit query [--agent X] [--action Y] [--limit N]  Query audit logs
  signup --name <org> --email <email>       Self-service org signup

Environment:
  MESHGUARD_URL          Gateway URL (default: https://dashboard.meshguard.app)
  MESHGUARD_API_KEY      API key for auth
  MESHGUARD_ADMIN_TOKEN  Admin token for org management
EOF
  exit 1
}

# ─── Commands ─────────────────────────────────────────────────────────────────

cmd_status() {
  echo "Checking MeshGuard gateway at ${MESHGUARD_URL}..."
  local response
  response=$(curl -sf -H "Content-Type: application/json" "${API_BASE}/health" 2>&1) || {
    echo "FAILED: Cannot reach ${API_BASE}/health"
    echo "Response: ${response:-<no response>}"
    exit 1
  }
  echo "$response" | format_json
  echo ""
  echo "✅ Gateway is reachable."
}

cmd_agents_list() {
  api_get "/agents" | format_json
}

cmd_agents_create() {
  local name="" tier="free"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --tier) tier="$2"; shift 2 ;;
      *) name="$1"; shift ;;
    esac
  done
  [[ -n "$name" ]] || die "Agent name required. Usage: agents create <name> --tier <tier>"
  api_post "/agents" "{\"name\":\"${name}\",\"tier\":\"${tier}\"}" | format_json
}

cmd_agents_get() {
  local id="${1:-}"
  [[ -n "$id" ]] || die "Agent ID required. Usage: agents get <id>"
  api_get "/agents/${id}" | format_json
}

cmd_agents_delete() {
  local id="${1:-}"
  [[ -n "$id" ]] || die "Agent ID required. Usage: agents delete <id>"
  api_delete "/agents/${id}" | format_json
  echo "✅ Agent ${id} deleted."
}

cmd_policies_list() {
  api_get "/policies" | format_json
}

cmd_policies_create() {
  local file="${1:-}"
  [[ -n "$file" ]] || die "YAML file required. Usage: policies create <file>"
  [[ -f "$file" ]] || die "File not found: $file"

  # Convert YAML to JSON — try yq first, fall back to inline Python
  local json_data
  if command -v yq &>/dev/null; then
    json_data=$(yq -o=json '.' "$file")
  elif command -v python3 &>/dev/null; then
    json_data=$(python3 -c "
import sys, json, yaml
with open('$file') as f:
    print(json.dumps(yaml.safe_load(f)))
" 2>/dev/null) || die "Cannot parse YAML. Install yq or python3 with PyYAML."
  else
    die "Need yq or python3+PyYAML to parse YAML files."
  fi

  api_post "/policies" "$json_data" | format_json
}

cmd_policies_get() {
  local id="${1:-}"
  [[ -n "$id" ]] || die "Policy ID required. Usage: policies get <id>"
  api_get "/policies/${id}" | format_json
}

cmd_policies_delete() {
  local id="${1:-}"
  [[ -n "$id" ]] || die "Policy ID required. Usage: policies delete <id>"
  api_delete "/policies/${id}" | format_json
  echo "✅ Policy ${id} deleted."
}

cmd_audit_query() {
  local agent="" action="" limit="20"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --agent) agent="$2"; shift 2 ;;
      --action) action="$2"; shift 2 ;;
      --limit) limit="$2"; shift 2 ;;
      *) die "Unknown audit option: $1" ;;
    esac
  done

  local query="?limit=${limit}"
  [[ -n "$agent" ]] && query="${query}&agent=${agent}"
  [[ -n "$action" ]] && query="${query}&action=${action}"

  api_get "/audit/logs${query}" | format_json
}

cmd_signup() {
  local name="" email=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --name) name="$2"; shift 2 ;;
      --email) email="$2"; shift 2 ;;
      *) die "Unknown signup option: $1" ;;
    esac
  done
  [[ -n "$name" ]] || die "Org name required. Usage: signup --name <org> --email <email>"
  [[ -n "$email" ]] || die "Email required. Usage: signup --name <org> --email <email>"

  api_post_admin "/orgs/signup" "{\"name\":\"${name}\",\"email\":\"${email}\"}" | format_json
}

# ─── Router ───────────────────────────────────────────────────────────────────

[[ $# -ge 1 ]] || usage

command="$1"; shift

case "$command" in
  status)
    cmd_status
    ;;
  agents)
    sub="${1:-}"; shift || true
    case "$sub" in
      list)   cmd_agents_list ;;
      create) cmd_agents_create "$@" ;;
      get)    cmd_agents_get "$@" ;;
      delete) cmd_agents_delete "$@" ;;
      *)      die "Unknown agents subcommand: $sub. Use: list|create|get|delete" ;;
    esac
    ;;
  policies)
    sub="${1:-}"; shift || true
    case "$sub" in
      list)   cmd_policies_list ;;
      create) cmd_policies_create "$@" ;;
      get)    cmd_policies_get "$@" ;;
      delete) cmd_policies_delete "$@" ;;
      *)      die "Unknown policies subcommand: $sub. Use: list|create|get|delete" ;;
    esac
    ;;
  audit)
    sub="${1:-}"; shift || true
    case "$sub" in
      query) cmd_audit_query "$@" ;;
      *)     die "Unknown audit subcommand: $sub. Use: query" ;;
    esac
    ;;
  signup)
    cmd_signup "$@"
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    die "Unknown command: $command. Run with 'help' for usage."
    ;;
esac
