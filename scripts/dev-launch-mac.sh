#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="${ROOT_DIR}/dist/OpenClaw.app"
NO_BUILD=0

# Trim leading/trailing whitespace for robust .env parsing.
trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Remove one pair of matching outer quotes if present.
strip_outer_quotes() {
  local value="$1"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    printf '%s' "${value:1:${#value}-2}"
    return
  fi
  if [[ "$value" == \'*\' && "$value" == *\' ]]; then
    printf '%s' "${value:1:${#value}-2}"
    return
  fi
  printf '%s' "$value"
}

# Parse KEY=value (with optional "export") and return the normalized value.
parse_env_assignment() {
  local key="$1"
  local line="$2"
  local parsed=""
  if [[ "$line" =~ ^(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*(.*)$ ]]; then
    parsed="$(trim "${BASH_REMATCH[2]}")"
    parsed="$(strip_outer_quotes "$parsed")"
  fi
  printf '%s' "$parsed"
}

# Return the last occurrence of KEY from an env-style file.
read_last_env_value() {
  local file_path="$1"
  local key="$2"
  local line=""
  local trimmed=""
  local parsed=""
  local last_value=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim "$line")"
    if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
      continue
    fi
    parsed="$(parse_env_assignment "$key" "$trimmed")"
    if [[ -n "$parsed" ]]; then
      last_value="$parsed"
    fi
  done < "$file_path"

  printf '%s' "$last_value"
}

# Mask token output so logs never leak full credentials.
mask_token() {
  local token="$1"
  local len=${#token}
  if (( len <= 4 )); then
    printf '****'
    return
  fi
  if (( len <= 8 )); then
    printf '%s...%s' "${token:0:1}" "${token:len-1:1}"
    return
  fi
  printf '%s...%s' "${token:0:4}" "${token:len-4:4}"
}

usage() {
  cat <<'EOF'
Usage: scripts/dev-launch-mac.sh [--no-build]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build)
      NO_BUILD=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

ENV_FILE="${ROOT_DIR}/.dev-launch.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: ${ENV_FILE} not found." >&2
  echo "Run bash scripts/new-worktree.sh <feature-name> to create a worktree with dev launch settings." >&2
  exit 1
fi

OPENCLAW_STATE_DIR="$(read_last_env_value "$ENV_FILE" "OPENCLAW_STATE_DIR")"
OPENCLAW_GATEWAY_PORT="$(read_last_env_value "$ENV_FILE" "OPENCLAW_GATEWAY_PORT")"

if [[ -z "$OPENCLAW_STATE_DIR" ]]; then
  echo "Error: OPENCLAW_STATE_DIR missing in ${ENV_FILE}." >&2
  exit 1
fi
if [[ -z "$OPENCLAW_GATEWAY_PORT" ]]; then
  echo "Error: OPENCLAW_GATEWAY_PORT missing in ${ENV_FILE}." >&2
  exit 1
fi

if [[ "$NO_BUILD" != "1" ]]; then
  bash "${ROOT_DIR}/scripts/package-mac-app.sh"
fi

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "Error: dist/OpenClaw.app not found. Run bash scripts/dev-launch-mac.sh without --no-build first." >&2
  exit 1
fi

# LaunchServices should inherit only the isolation settings we explicitly want.
# This keeps each dev instance pinned to its own state directory and gateway
# port instead of accidentally sharing the shell's ambient environment.
env -i \
  HOME="${HOME}" \
  USER="${USER:-$(id -un)}" \
  LOGNAME="${LOGNAME:-$(id -un)}" \
  TMPDIR="${TMPDIR:-/tmp}" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  LANG="${LANG:-en_US.UTF-8}" \
  OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR}" \
  OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT}" \
  /usr/bin/open -n "$APP_BUNDLE"

echo "worktree=${ROOT_DIR}"
echo "app_path=${APP_BUNDLE}"
echo "state_dir=${OPENCLAW_STATE_DIR}"
echo "gateway_port=${OPENCLAW_GATEWAY_PORT}"
