#!/usr/bin/env bash
set -Eeuo pipefail

# Automatically apply upstream tagged releases to a custom branch:
# - fetch remotes/tags
# - rebase custom branch onto upstream main
# - force-update fork branch
# - reinstall live OpenClaw via scripts/patch-live-openclaw.sh
#
# Optional notifications:
# - pre-restart warning (sent right before gateway restart in patch script)
# - success summary
# - failure summary
#
# Usage:
#   scripts/auto-upgrade-on-release-tag.sh [--force] [--dry-run]
#     [--repo-dir /path/to/openclaw.git]
#     [--branch feat/openai-codex-oauth-profile-id]
#     [--upstream-remote origin] [--fork-remote fork]
#     [--channel slack] [--target C0AGFJ7D0RY]
#     [--reply-to 1772115869.821949]
#
# Environment equivalents are supported via OPENCLAW_AUTO_* vars.

REPO_DIR="${OPENCLAW_AUTO_REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
WORK_BRANCH="${OPENCLAW_AUTO_BRANCH:-feat/openai-codex-oauth-profile-id}"
UPSTREAM_REMOTE="${OPENCLAW_AUTO_UPSTREAM_REMOTE:-origin}"
FORK_REMOTE="${OPENCLAW_AUTO_FORK_REMOTE:-fork}"

STATE_DIR="${OPENCLAW_AUTO_STATE_DIR:-$HOME/.openclaw/state}"
STATE_FILE="${OPENCLAW_AUTO_STATE_FILE:-$STATE_DIR/openclaw-auto-upgrade.state}"
LOCK_FILE="${OPENCLAW_AUTO_LOCK_FILE:-$STATE_DIR/openclaw-auto-upgrade.lock}"
LOG_DIR="${OPENCLAW_AUTO_LOG_DIR:-$HOME/.openclaw/logs/auto-upgrade}"

NOTIFY_CHANNEL="${OPENCLAW_AUTO_NOTIFY_CHANNEL:-}"
NOTIFY_TARGET="${OPENCLAW_AUTO_NOTIFY_TARGET:-}"
NOTIFY_REPLY_TO="${OPENCLAW_AUTO_NOTIFY_REPLY_TO:-}"
NOTIFY_ACCOUNT="${OPENCLAW_AUTO_NOTIFY_ACCOUNT:-}"

FORCE=0
DRY_RUN=0

PHASE="INIT"
LATEST_TAG=""
RUN_LOG=""
PREV_BRANCH=""
IN_ERROR_HANDLER=0

usage() {
  cat <<'EOF'
Usage: auto-upgrade-on-release-tag.sh [options]

Options:
  --force                    Run even when latest tag was already applied
  --dry-run                  Print actions without making changes
  --repo-dir <dir>           Path to openclaw repo
  --branch <name>            Custom branch to rebase/push
  --upstream-remote <name>   Upstream remote (default: origin)
  --fork-remote <name>       Fork remote (default: fork)
  --channel <name>           Notify channel (e.g. slack)
  --target <id>              Notify target (e.g. Slack channel id)
  --reply-to <id>            Reply/thread id for notifications
  --account <id>             Optional channel account id
  -h, --help                 Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --repo-dir)
      REPO_DIR="$2"
      shift 2
      ;;
    --branch)
      WORK_BRANCH="$2"
      shift 2
      ;;
    --upstream-remote)
      UPSTREAM_REMOTE="$2"
      shift 2
      ;;
    --fork-remote)
      FORK_REMOTE="$2"
      shift 2
      ;;
    --channel)
      NOTIFY_CHANNEL="$2"
      shift 2
      ;;
    --target)
      NOTIFY_TARGET="$2"
      shift 2
      ;;
    --reply-to)
      NOTIFY_REPLY_TO="$2"
      shift 2
      ;;
    --account)
      NOTIFY_ACCOUNT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

mkdir -p "$STATE_DIR" "$LOG_DIR"
RUN_LOG="$LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"
touch "$RUN_LOG"

log() {
  local line="[$(date +'%Y-%m-%d %H:%M:%S %Z')] $*"
  echo "$line" | tee -a "$RUN_LOG" >&2
}

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] $*"
  else
    "$@"
  fi
}

state_get() {
  local key="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    return 1
  fi
  awk -F= -v k="$key" '$1==k{print substr($0, index($0,"=")+1)}' "$STATE_FILE" | tail -n1
}

state_set_all() {
  local last_seen_tag="$1"
  local last_success_tag="$2"
  local last_success_sha="$3"
  local last_success_ts="$4"
  cat > "$STATE_FILE" <<EOF
last_seen_tag=${last_seen_tag}
last_success_tag=${last_success_tag}
last_success_sha=${last_success_sha}
last_success_ts=${last_success_ts}
EOF
}

send_message() {
  local text="$1"
  if [[ -z "$NOTIFY_CHANNEL" || -z "$NOTIFY_TARGET" ]]; then
    log "notification skipped (channel/target not configured): $text"
    return 0
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] openclaw message send --channel '$NOTIFY_CHANNEL' --target '$NOTIFY_TARGET' --message '$text'"
    return 0
  fi

  local cmd=(openclaw message send --channel "$NOTIFY_CHANNEL" --target "$NOTIFY_TARGET" --message "$text")
  if [[ -n "$NOTIFY_REPLY_TO" ]]; then
    cmd+=(--reply-to "$NOTIFY_REPLY_TO")
  fi
  if [[ -n "$NOTIFY_ACCOUNT" ]]; then
    cmd+=(--account "$NOTIFY_ACCOUNT")
  fi

  if ! "${cmd[@]}" >/dev/null 2>&1; then
    log "warning: failed to send notification"
  fi
}

abort_rebase_if_needed() {
  if [[ -d .git/rebase-merge || -d .git/rebase-apply ]]; then
    log "rebase in progress; aborting"
    git rebase --abort >/dev/null 2>&1 || true
  fi
}

on_error() {
  local line="$1"
  local cmd="$2"
  local rc="$3"

  if [[ "$IN_ERROR_HANDLER" == "1" ]]; then
    exit "$rc"
  fi
  IN_ERROR_HANDLER=1

  {
    abort_rebase_if_needed
    if [[ -n "$PREV_BRANCH" ]]; then
      git checkout "$PREV_BRANCH" >/dev/null 2>&1 || true
    fi
  } || true

  local summary="🚨 OpenClaw auto-upgrade failed | phase=${PHASE} | tag=${LATEST_TAG:-unknown} | branch=${WORK_BRANCH} | rc=${rc}"
  local detail="line=${line} cmd=${cmd}"
  send_message "$summary
$detail
log=${RUN_LOG}"

  log "$summary"
  log "$detail"
  exit "$rc"
}
trap 'on_error "$LINENO" "$BASH_COMMAND" "$?"' ERR

if [[ ! -d "$REPO_DIR/.git" ]]; then
  log "error: repo is not a git checkout: $REPO_DIR"
  exit 1
fi

cd "$REPO_DIR"
PREV_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "NOOP: another auto-upgrade run is already active"
  exit 0
fi

latest_release_tag() {
  git tag --merged "$UPSTREAM_REMOTE/main" --list --sort=-version:refname \
    | grep -E '^v?[0-9]{4}\.[0-9]{1,2}\.[0-9]+$' \
    | head -n1
}

PHASE="FETCH"
log "Fetching remotes + tags"
run git fetch --all --prune --tags

LATEST_TAG="$(latest_release_tag || true)"
if [[ -z "$LATEST_TAG" ]]; then
  log "error: could not find a CalVer-style release tag (e.g. 2026.3.4)"
  exit 1
fi

LAST_SUCCESS_TAG="$(state_get last_success_tag || true)"
LAST_SUCCESS_SHA="$(state_get last_success_sha || true)"

if [[ "$FORCE" != "1" && "$LATEST_TAG" == "$LAST_SUCCESS_TAG" ]]; then
  PHASE="NOOP"
  state_set_all "$LATEST_TAG" "$LAST_SUCCESS_TAG" "$LAST_SUCCESS_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log "NOOP: latest tag already applied ($LATEST_TAG)"
  exit 0
fi

EXPECTED_VERSION="${LATEST_TAG#v}"
TAG_SHA="$(git rev-list -n1 "$LATEST_TAG")"

PHASE="CHECKOUT"
log "Checking out branch $WORK_BRANCH"
run git checkout "$WORK_BRANCH"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  log "error: working tree has tracked changes; commit/stash before auto-upgrade"
  exit 1
fi

PHASE="REBASE"
log "Rebasing $WORK_BRANCH onto release tag $LATEST_TAG"
run git rebase "$LATEST_TAG"

NEW_HEAD_SHA="$(git rev-parse HEAD)"

PHASE="PUSH"
log "Force-updating $FORK_REMOTE/$WORK_BRANCH"
run git push --force-with-lease "$FORK_REMOTE" "$WORK_BRANCH"

PHASE="PATCH"
log "Running patch-live-openclaw.sh"
PATCH_WARNING="⚠️ OpenClaw auto-upgrade for tag ${LATEST_TAG} is about to restart the gateway. If no success message appears in a few minutes, please intervene."
export OPENCLAW_PATCH_NOTIFY_CHANNEL="$NOTIFY_CHANNEL"
export OPENCLAW_PATCH_NOTIFY_TARGET="$NOTIFY_TARGET"
export OPENCLAW_PATCH_NOTIFY_REPLY_TO="$NOTIFY_REPLY_TO"
export OPENCLAW_PATCH_NOTIFY_ACCOUNT="$NOTIFY_ACCOUNT"
export OPENCLAW_PATCH_RESTART_WARNING_TEXT="$PATCH_WARNING"
if [[ "$DRY_RUN" == "1" ]]; then
  run "$REPO_DIR/scripts/patch-live-openclaw.sh" --dry-run
  PHASE="DONE"
  log "Dry-run complete (no changes applied)."
  exit 0
else
  run "$REPO_DIR/scripts/patch-live-openclaw.sh"
fi

PHASE="VERIFY"
CLI_VERSION_RAW="$(openclaw --version 2>/dev/null | tr -d '[:space:]')"
CLI_VERSION="$CLI_VERSION_RAW"
if [[ -z "$CLI_VERSION" ]]; then
  log "error: failed to read openclaw --version"
  exit 1
fi

if [[ "$CLI_VERSION" != "$EXPECTED_VERSION" ]]; then
  log "error: CLI version mismatch (expected $EXPECTED_VERSION, got $CLI_VERSION)"
  exit 1
fi

GATEWAY_APP_VERSION="$(openclaw gateway status --json 2>/dev/null | node -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => (raw += c));
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(raw);
    process.stdout.write(parsed?.app?.version ?? "");
  } catch {
    process.stdout.write("");
  }
});
' || true)"

if [[ -n "$GATEWAY_APP_VERSION" && "$GATEWAY_APP_VERSION" != "$EXPECTED_VERSION" ]]; then
  log "error: gateway app version mismatch (expected $EXPECTED_VERSION, got $GATEWAY_APP_VERSION)"
  exit 1
fi

PHASE="STATE"
state_set_all "$LATEST_TAG" "$LATEST_TAG" "$NEW_HEAD_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

PHASE="DONE"
SUCCESS_MSG="✅ OpenClaw auto-upgrade complete | tag=${LATEST_TAG} | branch=${WORK_BRANCH} | head=${NEW_HEAD_SHA:0:9} | cli=${CLI_VERSION}"
if [[ -n "$GATEWAY_APP_VERSION" ]]; then
  SUCCESS_MSG+=" | gateway=${GATEWAY_APP_VERSION}"
fi
SUCCESS_MSG+="\nrelease_sha=${TAG_SHA:0:9}"
send_message "$SUCCESS_MSG"

log "$SUCCESS_MSG"
if [[ -n "$PREV_BRANCH" && "$PREV_BRANCH" != "$WORK_BRANCH" ]]; then
  git checkout "$PREV_BRANCH" >/dev/null 2>&1 || true
fi

exit 0
