#!/usr/bin/env bash
set -euo pipefail

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
Usage: scripts/new-worktree.sh <feature-name> [--base <branch>]
EOF
}

run_ensure_with_timeout() {
  local worktree_path="$1"
  local timeout_secs="${OPENCLAW_NEW_WORKTREE_ENSURE_TIMEOUT_SECS:-45}"

  if [[ ! "$timeout_secs" =~ ^[0-9]+$ ]] || (( timeout_secs <= 0 )); then
    timeout_secs=45
  fi

  # `telegram-live-runtime.sh ensure` is allowed to wait several minutes for a
  # healthy isolated runtime. That is sensible for a live-test gate, but far
  # too slow for a worktree bootstrap helper whose real job is branch/setup
  # creation. Bound it so the worktree is still usable even if runtime health
  # checks drag or hang.
  if command -v python3 >/dev/null 2>&1; then
    if python3 - "$worktree_path" "$timeout_secs" <<'PY'
import subprocess
import sys

worktree_path = sys.argv[1]
timeout_secs = int(sys.argv[2])

try:
    completed = subprocess.run(
        ["bash", "scripts/telegram-live-runtime.sh", "ensure"],
        cwd=worktree_path,
        timeout=timeout_secs,
        check=False,
    )
    raise SystemExit(completed.returncode)
except subprocess.TimeoutExpired:
    print(
        f"Warning: telegram-live-runtime.sh ensure exceeded {timeout_secs}s; continuing.",
        file=sys.stderr,
    )
    raise SystemExit(124)
PY
    then
      :
    else
      ensure_status=$?
      if [[ "$ensure_status" != "124" ]]; then
        echo "Warning: telegram-live-runtime.sh ensure exited with status ${ensure_status}; continuing." >&2
      fi
    fi
  else
    (cd "$worktree_path" && bash scripts/telegram-live-runtime.sh ensure) || true
  fi
}

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 1
fi

FEATURE_NAME=""
BASE_BRANCH="main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      if [[ $# -lt 2 ]]; then
        echo "Error: --base requires a value." >&2
        exit 1
      fi
      BASE_BRANCH="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$FEATURE_NAME" ]]; then
        FEATURE_NAME="$1"
        shift
      else
        echo "Error: unexpected argument: $1" >&2
        usage >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$FEATURE_NAME" ]]; then
  echo "Error: feature name is required." >&2
  usage >&2
  exit 1
fi

if [[ ! "$FEATURE_NAME" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Error: feature name must match [a-zA-Z0-9_-]+." >&2
  exit 1
fi

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "Error: run this script from inside a git worktree." >&2
  exit 1
fi
REPO_ROOT="$(cd "$REPO_ROOT" && pwd -P)"

WORKTREE_PATH="${REPO_ROOT}/.claude/worktrees/${FEATURE_NAME}"
BRANCH_NAME="claude/${FEATURE_NAME}"

if [[ -e "$WORKTREE_PATH" ]]; then
  echo "Error: worktree path already exists: $WORKTREE_PATH" >&2
  exit 1
fi

if git show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
  echo "Error: branch already exists locally: ${BRANCH_NAME}" >&2
  exit 1
fi

if ! git fetch origin; then
  echo "Warning: git fetch origin failed; continuing with local refs." >&2
fi

if ! git show-ref --verify --quiet "refs/remotes/origin/${BASE_BRANCH}"; then
  echo "Error: origin/${BASE_BRANCH} does not exist locally. Fetch it or choose a different --base." >&2
  exit 1
fi

# Mirror the Telegram live runtime port derivation pattern: normalize the
# absolute worktree path, hash it, then take a stable modulo into a reserved
# dev-only port window that does not overlap the default gateway port.
TARGET_REF="origin/${BASE_BRANCH}"
git worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" "$TARGET_REF"

(cd "$WORKTREE_PATH" && bash scripts/bootstrap-worktree-telegram.sh)

DEV_PORT="$(WORKTREE_PATH="$WORKTREE_PATH" node --input-type=module - <<'NODE'
import crypto from "node:crypto";
import path from "node:path";

const worktreePath = path.resolve(process.env.WORKTREE_PATH ?? "");
const hash = crypto.createHash("sha256").update(worktreePath).digest("hex");
const hashInt = Number.parseInt(hash.slice(0, 8), 16);
const port = 18800 + (Number.isFinite(hashInt) ? hashInt % 100 : 0);
process.stdout.write(String(port));
NODE
)"

cat > "${WORKTREE_PATH}/.dev-launch.env" <<EOF
OPENCLAW_STATE_DIR=/tmp/openclaw-dev-${FEATURE_NAME}
OPENCLAW_GATEWAY_PORT=${DEV_PORT}
EOF

run_ensure_with_timeout "$WORKTREE_PATH"

BOT_FINGERPRINT="none"
if [[ -f "${WORKTREE_PATH}/.env.local" ]]; then
  token_value="$(read_last_env_value "${WORKTREE_PATH}/.env.local" "TELEGRAM_BOT_TOKEN")"
  if [[ -n "$token_value" ]]; then
    BOT_FINGERPRINT="$(mask_token "$token_value")"
  fi
fi

echo "worktree=${WORKTREE_PATH}"
echo "branch=${BRANCH_NAME}"
echo "bot_fingerprint=${BOT_FINGERPRINT}"
echo "dev_port=${DEV_PORT}"
