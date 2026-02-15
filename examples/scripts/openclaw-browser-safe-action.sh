#!/usr/bin/env bash
set -euo pipefail

PROFILE="${OPENCLAW_PROFILE:-main}"
TARGET_ID=""
URL=""
REUSE_URL_REGEX=""
ACTION=""
ROLE=""
NAME_REGEX=""
TEXT_VALUE=""
MAX_RETRIES="${OPENCLAW_RETRIES:-6}"
WAIT_MS="${OPENCLAW_WAIT_MS:-1200}"
SNAPSHOT_LIMIT="${OPENCLAW_SNAPSHOT_LIMIT:-500}"
CMD_RETRIES="${OPENCLAW_CMD_RETRIES:-4}"
CMD_RETRY_SLEEP_SEC="${OPENCLAW_CMD_RETRY_SLEEP_SEC:-2}"
LOCK_WAIT_SEC="${OPENCLAW_SAFE_LOCK_WAIT_SEC:-30}"
REQUIRE_ENABLED=1
FALLBACK_FN=""
OUTPUT_JSON=0
FORCE_OPEN=0
DRY_RUN=0

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") --action <click|type> --role <role> --name-regex <regex> [options]

Options:
  --profile <name>
  --target-id <id>
  --url <url>
  --reuse-url-regex <regex>   Try reusing an existing page tab before opening a new one
  --force-open                Force opening a new tab for --url
  --text <value>              Required for --action type
  --max-retries <n>
  --wait-ms <ms>
  --snapshot-limit <n>
  --no-require-enabled        Allow clicking disabled-looking refs
  --fallback-fn <js-fn>       JS function passed to evaluate when retries fail
  --dry-run                   Resolve ref and validate readiness, skip actual action
  --json

Examples:
  $(basename "$0") --action click --role button --name-regex 'Post|Publish' --url 'https://x.com/compose/post'
  $(basename "$0") --action type --role textbox --name-regex 'Post text' --text 'hello' --target-id ABC123
USAGE
}

log() {
  printf '[openclaw-safe] %s\n' "$*" >&2
}

die() {
  printf '[openclaw-safe] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

is_transient_openclaw_error() {
  local msg="$1"
  printf '%s\n' "$msg" | grep -Eq \
    'Port [0-9]+ is in use for profile|ECONNREFUSED|connect ECONN|EADDRINUSE|uv_interface_addresses|CDP|websocket|Timed out'
}

oc_raw() {
  openclaw browser --browser-profile "$PROFILE" "$@"
}

oc_json() {
  local out
  local rc=0
  local attempt=1
  local max_attempts="$CMD_RETRIES"

  while (( attempt <= max_attempts )); do
    rc=0
    out="$(oc_raw "$@" 2>&1)" || rc=$?
    if (( rc == 0 )); then
      printf '%s\n' "$out" | sed -n '/^{/,$p'
      return 0
    fi

    if is_transient_openclaw_error "$out" && (( attempt < max_attempts )); then
      log "Transient openclaw error (attempt ${attempt}/${max_attempts}); retrying in ${CMD_RETRY_SLEEP_SEC}s"
      sleep "$CMD_RETRY_SLEEP_SEC"
      rc=0
      ((attempt++))
      continue
    fi

    printf '%s\n' "$out" >&2
    return "${rc:-1}"
  done

  printf '%s\n' "$out" >&2
  return 1
}

with_target_args() {
  local cmd="$1"
  shift
  local args=("$cmd" "$@")
  if [[ -n "$TARGET_ID" ]]; then
    args+=(--target-id "$TARGET_ID")
  fi
  printf '%s\0' "${args[@]}"
}

oc_json_targeted() {
  local cmd="$1"
  shift
  local -a args
  args=()
  while IFS= read -r -d '' item; do
    args+=("$item")
  done < <(with_target_args "$cmd" "$@")
  oc_json "${args[@]}" --json
}

oc_wait_small() {
  local -a args
  args=(wait --time "$WAIT_MS")
  if [[ -n "$TARGET_ID" ]]; then
    args+=(--target-id "$TARGET_ID")
  fi
  oc_raw "${args[@]}" >/dev/null 2>&1 || true
}

snapshot_json() {
  local -a args
  args=(snapshot --json --efficient --limit "$SNAPSHOT_LIMIT")
  if [[ -n "$TARGET_ID" ]]; then
    args+=(--target-id "$TARGET_ID")
  fi
  oc_json "${args[@]}"
}

find_ref() {
  local snap_json="$1"
  local role="$2"
  local name_regex="$3"

  printf '%s\n' "$snap_json" |
    jq -r --arg role "$role" --arg rx "$name_regex" '
      .refs
      | to_entries
      | map(select((.value.role // "") == $role and ((.value.name // "") | test($rx; "i"))))
      | .[0].key // empty
    '
}

is_ref_disabled() {
  local snap_json="$1"
  local ref="$2"
  local line

  line="$({
    printf '%s\n' "$snap_json" |
      jq -r --arg ref "$ref" '
        .snapshot
        | split("\\n")
        | map(select(test("\\\\[ref=" + $ref + "\\\\]")))
        | .[0] // ""
      '
  })"

  [[ "$line" == *"[disabled]"* ]]
}

resolve_target_from_tabs() {
  local tabs_json
  tabs_json="$(oc_json tabs --json)" || return 1

  TARGET_ID="$(
    printf '%s\n' "$tabs_json" |
      jq -r --arg rx "$REUSE_URL_REGEX" '
        .tabs
        | map(select(.type == "page" and ((.url // "") | test($rx; "i"))))
        | .[-1].targetId // empty
      '
  )"

  [[ -n "$TARGET_ID" ]]
}

open_or_navigate() {
  if [[ -n "$REUSE_URL_REGEX" && -z "$TARGET_ID" ]]; then
    resolve_target_from_tabs || true
    if [[ -n "$TARGET_ID" ]]; then
      log "Reusing existing tab targetId=$TARGET_ID"
    fi
  fi

  if [[ -z "$URL" ]]; then
    return 0
  fi

  if [[ -n "$TARGET_ID" && "$FORCE_OPEN" -eq 0 ]]; then
    log "Navigating existing targetId=$TARGET_ID to URL"
    oc_json_targeted navigate "$URL" >/dev/null || return 1
    return 0
  fi

  log "Opening URL in a new tab"
  local open_json
  open_json="$(oc_json open "$URL" --json)" || return 1
  TARGET_ID="$(printf '%s\n' "$open_json" | jq -r '.targetId // empty')"
  [[ -n "$TARGET_ID" ]] || return 1
}

emit_success() {
  local ref="$1"
  if [[ "$OUTPUT_JSON" -eq 1 ]]; then
    jq -n \
      --arg action "$ACTION" \
      --arg ref "$ref" \
      --arg targetId "$TARGET_ID" \
      '{ok:true, action:$action, ref:$ref, targetId:$targetId}'
  else
    log "Success action=$ACTION ref=$ref targetId=$TARGET_ID"
  fi
}

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
    --url)
      shift
      (($#)) || die "--url requires a value"
      URL="$1"
      ;;
    --reuse-url-regex)
      shift
      (($#)) || die "--reuse-url-regex requires a value"
      REUSE_URL_REGEX="$1"
      ;;
    --force-open)
      FORCE_OPEN=1
      ;;
    --action)
      shift
      (($#)) || die "--action requires a value"
      ACTION="$1"
      ;;
    --role)
      shift
      (($#)) || die "--role requires a value"
      ROLE="$1"
      ;;
    --name-regex)
      shift
      (($#)) || die "--name-regex requires a value"
      NAME_REGEX="$1"
      ;;
    --text)
      shift
      (($#)) || die "--text requires a value"
      TEXT_VALUE="$1"
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
    --no-require-enabled)
      REQUIRE_ENABLED=0
      ;;
    --fallback-fn)
      shift
      (($#)) || die "--fallback-fn requires a value"
      FALLBACK_FN="$1"
      ;;
    --json)
      OUTPUT_JSON=1
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
  shift || true
done

require_cmd openclaw
require_cmd jq

[[ "$ACTION" == "click" || "$ACTION" == "type" ]] || die "--action must be click or type"
[[ -n "$ROLE" ]] || die "--role is required"
[[ -n "$NAME_REGEX" ]] || die "--name-regex is required"
if [[ "$ACTION" == "type" ]]; then
  [[ -n "$TEXT_VALUE" ]] || die "--text is required for type"
fi

if command -v flock >/dev/null 2>&1; then
  LOCK_FILE="${OPENCLAW_SAFE_LOCK_FILE:-/tmp/openclaw-safe-${PROFILE}.lock}"
  exec 9>"$LOCK_FILE"
  if ! flock -w "$LOCK_WAIT_SEC" 9; then
    log "Lock busy ($LOCK_FILE); continuing without lock"
  fi
fi

open_or_navigate || die "Failed to establish target page"

if [[ -n "$URL" ]]; then
  declare -a wait_args=(wait --url '**' --timeout-ms 30000)
  if [[ -n "$TARGET_ID" ]]; then
    wait_args+=(--target-id "$TARGET_ID")
  fi
  oc_raw "${wait_args[@]}" >/dev/null 2>&1 || true
fi

snap=""
ref=""
for ((attempt=1; attempt<=MAX_RETRIES; attempt++)); do
  log "Attempt ${attempt}/${MAX_RETRIES}"

  snap="$(snapshot_json)" || {
    oc_wait_small
    continue
  }

  ref="$(find_ref "$snap" "$ROLE" "$NAME_REGEX")"
  if [[ -z "$ref" ]]; then
    oc_wait_small
    continue
  fi

  if [[ "$ACTION" == "click" && "$REQUIRE_ENABLED" -eq 1 ]]; then
    if is_ref_disabled "$snap" "$ref"; then
      oc_wait_small
      continue
    fi
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    emit_success "$ref"
    exit 0
  fi

  case "$ACTION" in
    click)
      if oc_json_targeted click "$ref" >/dev/null; then
        emit_success "$ref"
        exit 0
      fi
      ;;
    type)
      if oc_json_targeted type "$ref" "$TEXT_VALUE" >/dev/null; then
        emit_success "$ref"
        exit 0
      fi
      ;;
  esac

  oc_wait_small
done

if [[ -n "$FALLBACK_FN" ]]; then
  log "Running fallback evaluate"
  fb_json="$(oc_json_targeted evaluate --fn "$FALLBACK_FN" 2>/dev/null || true)"
  if [[ -n "$fb_json" ]]; then
    if printf '%s\n' "$fb_json" | jq -e '(.ok == true) and ((.result.ok // false) or (.result == true) or (.result.success // false))' >/dev/null 2>&1; then
      emit_success "evaluate-fallback"
      exit 0
    fi
  fi
fi

die "Failed after ${MAX_RETRIES} attempts"
