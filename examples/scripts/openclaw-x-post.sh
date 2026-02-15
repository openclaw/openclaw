#!/usr/bin/env bash
set -euo pipefail

PROFILE="${OPENCLAW_PROFILE:-main}"
URL="${OPENCLAW_X_COMPOSE_URL:-https://x.com/compose/post}"
MAX_RETRIES="${OPENCLAW_RETRIES:-6}"
WAIT_MS="${OPENCLAW_WAIT_MS:-1200}"
SNAPSHOT_LIMIT="${OPENCLAW_SNAPSHOT_LIMIT:-500}"
LOCK_WAIT_SEC="${OPENCLAW_X_LOCK_WAIT_SEC:-45}"
MIN_INTERVAL_SEC="${OPENCLAW_X_MIN_INTERVAL_SEC:-2}"
TARGET_ID=""
PUBLISH=0
FORCE_OPEN=0
REUSE_COMPOSE_TAB=1

TEXTBOX_REGEX="${OPENCLAW_X_TEXTBOX_REGEX:-Metni gönderi olarak yayınla|Post text|What.?s happening|What is happening}"
PUBLISH_REGEX="${OPENCLAW_X_PUBLISH_REGEX:-Gönderi yayınla|Post|Publish|Yayınla}"
TWEET_BUTTON_SELECTOR="${OPENCLAW_X_TWEET_BUTTON_SELECTOR:-[data-testid=\"tweetButtonInline\"], [data-testid=\"tweetButton\"]}"
SAFE_ACTION_SCRIPT="${OPENCLAW_SAFE_ACTION_SCRIPT:-openclaw-browser-safe-action}"

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") [options] "post text"

Options:
  --profile <name>
  --target-id <id>
  --publish
  --force-open
  --no-reuse-compose-tab
  --url <compose-url>
  --textbox-regex <regex>
  --publish-regex <regex>
  --tweet-button-selector <css>
  --max-retries <n>
  --wait-ms <ms>
  --snapshot-limit <n>

Examples:
  $(basename "$0") "Dry run text"
  $(basename "$0") --publish "Real post text"
USAGE
}

log() {
  printf '[openclaw-x-post] %s\n' "$*"
}

die() {
  printf '[openclaw-x-post] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

build_fallback_fn() {
  local selector_json
  selector_json="$(jq -Rn --arg s "$TWEET_BUTTON_SELECTOR" '$s')"

  cat <<JS
() => {
  const selector = ${selector_json};
  const el = document.querySelector(selector);
  if (!el) return { ok: false, reason: 'not-found' };
  const disabled = !!el.disabled || el.getAttribute('aria-disabled') === 'true';
  if (disabled) return { ok: false, reason: 'disabled' };
  el.click();
  return { ok: true };
}
JS
}

run_safe_action() {
  local include_url=1
  if [[ "${1:-}" == "--no-url" ]]; then
    include_url=0
    shift
  fi

  local action="$1"
  shift
  local -a args=("$SAFE_ACTION_SCRIPT" --json --profile "$PROFILE" --action "$action")

  if [[ -n "$TARGET_ID" ]]; then
    args+=(--target-id "$TARGET_ID")
  fi

  if [[ "$include_url" -eq 1 ]]; then
    args+=(--url "$URL")

    if [[ "$REUSE_COMPOSE_TAB" -eq 1 ]]; then
      args+=(--reuse-url-regex 'https://x\.com/compose/post')
    fi

    if [[ "$FORCE_OPEN" -eq 1 ]]; then
      args+=(--force-open)
    fi
  fi

  args+=(--max-retries "$MAX_RETRIES" --wait-ms "$WAIT_MS" --snapshot-limit "$SNAPSHOT_LIMIT")
  args+=("$@")

  "${args[@]}"
}

POST_TEXT=""
while (($#)); do
  case "$1" in
    --profile)
      shift
      (($#)) || die "--profile requires a value"
      PROFILE="$1"
      ;;
    --target-id)
      shift
      (($#)) || die "--target-id requires a value"
      TARGET_ID="$1"
      ;;
    --publish)
      PUBLISH=1
      ;;
    --force-open)
      FORCE_OPEN=1
      ;;
    --no-reuse-compose-tab)
      REUSE_COMPOSE_TAB=0
      ;;
    --url)
      shift
      (($#)) || die "--url requires a value"
      URL="$1"
      ;;
    --textbox-regex)
      shift
      (($#)) || die "--textbox-regex requires a value"
      TEXTBOX_REGEX="$1"
      ;;
    --publish-regex)
      shift
      (($#)) || die "--publish-regex requires a value"
      PUBLISH_REGEX="$1"
      ;;
    --tweet-button-selector)
      shift
      (($#)) || die "--tweet-button-selector requires a value"
      TWEET_BUTTON_SELECTOR="$1"
      ;;
    --max-retries)
      shift
      (($#)) || die "--max-retries requires a value"
      MAX_RETRIES="$1"
      ;;
    --wait-ms)
      shift
      (($#)) || die "--wait-ms requires a value"
      WAIT_MS="$1"
      ;;
    --snapshot-limit)
      shift
      (($#)) || die "--snapshot-limit requires a value"
      SNAPSHOT_LIMIT="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$POST_TEXT" ]]; then
        POST_TEXT="$1"
      else
        POST_TEXT+=" $1"
      fi
      ;;
  esac
  shift || true
done

[[ -n "$POST_TEXT" ]] || {
  usage
  exit 1
}

require_cmd openclaw
require_cmd jq
require_cmd "$SAFE_ACTION_SCRIPT"

if command -v flock >/dev/null 2>&1; then
  LOCK_FILE="${OPENCLAW_X_LOCK_FILE:-/tmp/openclaw-x-post-${PROFILE}.lock}"
  exec 8>"$LOCK_FILE"
  flock -w "$LOCK_WAIT_SEC" 8 || die "Failed to acquire lock: $LOCK_FILE"
fi

STAMP_FILE="${OPENCLAW_X_STAMP_FILE:-/tmp/openclaw-x-post-${PROFILE}.last}"
now="$(date +%s)"
if [[ -f "$STAMP_FILE" ]]; then
  last="$(cat "$STAMP_FILE" 2>/dev/null || echo 0)"
  if [[ "$last" =~ ^[0-9]+$ ]]; then
    gap=$((now - last))
    if (( gap < MIN_INTERVAL_SEC )); then
      sleep $((MIN_INTERVAL_SEC - gap))
    fi
  fi
fi
printf '%s\n' "$(date +%s)" > "$STAMP_FILE"

log "Typing into compose box with target lock + retry"
type_json="$(run_safe_action type --role textbox --name-regex "$TEXTBOX_REGEX" --text "$POST_TEXT")" || die "Failed to type post text"
TARGET_ID="$(printf '%s\n' "$type_json" | jq -r '.targetId // empty')"
[[ -n "$TARGET_ID" ]] || die "No targetId returned from type action"

if [[ "$PUBLISH" -eq 0 ]]; then
  log "Dry run: validating publish button state"
  run_safe_action --no-url click --role button --name-regex "$PUBLISH_REGEX" --dry-run >/dev/null || die "Publish button not ready"
  log "Ready: publish button is resolvable and enabled (targetId=$TARGET_ID)"
  log "Use --publish to click the publish button"
  exit 0
fi

log "Publishing with retry + JS fallback"
FALLBACK_FN="$(build_fallback_fn)"
run_safe_action --no-url click --role button --name-regex "$PUBLISH_REGEX" --fallback-fn "$FALLBACK_FN" >/dev/null || die "Failed to publish"

log "Publish action sent successfully (targetId=$TARGET_ID)"
