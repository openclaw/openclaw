#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: nip63-debug-loop.sh [options]

Environment:
  NOSTR_BOT_SECRET     Bot private key in hex or nsec format (required)
  NOSTR_SENDER_SECRET  Sender key in hex or nsec format (optional, auto-generated)

Options:
  --bot-secret <key>          Override NOSTR_BOT_SECRET
  --sender-secret <key>       Override NOSTR_SENDER_SECRET
  --relay <url>               Relay URL (repeatable, default: ws://localhost:7777)
  --iterations <n>            Number of request/response cycles (default: 5)
  --message <template>        Message template, supports {{i}} token (default: "Nostr NIP-63 debug {{i}}")
  --timeout <seconds>         Wait time for each response (default: 30)
  --session-prefix <text>     Session prefix, default: nip63-debug-loop
  --interval <seconds>        Sleep between iterations (default: 1)
  --jsonl <path>             Write each inbound/outbound event as JSONL
  --require-thread            Require response to include e-tag pointing to outbound event (default)
  --no-require-thread         Disable thread requirement
  --capture-tool-events       Include ai tool/telemetry events (kinds 25800/25801/25804/25805/25806)
  --no-capture-tool-events    Only wait on ai.response (25803)
  --tool-plan <json>          JSON array of expected tool names for strict validation (e.g. '[\"exec\",\"web_search\",\"web_fetch\"]')
  --strict-tool-validation    Require observed tool-step count/streaming to match expected plan (disabled by default)
  --no-strict-tool-validation Disable strict tool validation (default)
  --require-tool-streaming     Require at least one 25803 response per expected tool step
  --no-require-tool-streaming  Do not require per-step streaming responses (default)
  --quiet                     Reduce status output
  -h, --help                 Show this help

Example:
  NOSTR_BOT_SECRET=nsec1... NOSTR_SENDER_SECRET=... \\
    extensions/nostr/scripts/nip63-debug-loop.sh --iterations 3 --relay ws://localhost:7777
EOF
}

require_command() {
  local command_name=$1
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
}

require_command jq
require_command nak

if ! command -v timeout >/dev/null 2>&1; then
  echo "Missing required command: timeout" >&2
  exit 1
fi

BOT_SECRET="${NOSTR_BOT_SECRET:-}"
SENDER_SECRET="${NOSTR_SENDER_SECRET:-}"
RELAYS=("ws://localhost:7777")
ITERATIONS=5
MESSAGE_TEMPLATE="Nostr NIP-63 debug {{i}}"
WAIT_SECONDS=30
SESSION_PREFIX="nip63-debug-loop"
INTERVAL_SECONDS=1
REQUIRE_THREAD=1
QUIET=0
JSONL_PATH=""
CAPTURE_TOOL_EVENTS=1
TOOL_PLAN_JSON=""
STRICT_TOOL_VALIDATION=0
REQUIRE_TOOL_STREAMING=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot-secret)
      BOT_SECRET=${2:?}
      shift 2
      ;;
    --sender-secret)
      SENDER_SECRET=${2:?}
      shift 2
      ;;
    --relay)
      RELAYS+=("${2:?}")
      shift 2
      ;;
    --iterations)
      ITERATIONS=${2:?}
      shift 2
      ;;
    --message)
      MESSAGE_TEMPLATE=${2:?}
      shift 2
      ;;
    --timeout)
      WAIT_SECONDS=${2:?}
      shift 2
      ;;
    --session-prefix)
      SESSION_PREFIX=${2:?}
      shift 2
      ;;
    --interval)
      INTERVAL_SECONDS=${2:?}
      shift 2
      ;;
    --jsonl)
      JSONL_PATH=${2:?}
      shift 2
      ;;
    --capture-tool-events)
      CAPTURE_TOOL_EVENTS=1
      shift
      ;;
    --no-capture-tool-events)
      CAPTURE_TOOL_EVENTS=0
      shift
      ;;
    --tool-plan)
      TOOL_PLAN_JSON=${2:?}
      shift 2
      ;;
    --strict-tool-validation)
      STRICT_TOOL_VALIDATION=1
      REQUIRE_TOOL_STREAMING=1
      shift
      ;;
    --no-strict-tool-validation)
      STRICT_TOOL_VALIDATION=0
      REQUIRE_TOOL_STREAMING=0
      shift
      ;;
    --require-tool-streaming)
      REQUIRE_TOOL_STREAMING=1
      shift
      ;;
    --no-require-tool-streaming)
      REQUIRE_TOOL_STREAMING=0
      shift
      ;;
    --require-thread)
      REQUIRE_THREAD=1
      shift
      ;;
    --no-require-thread)
      REQUIRE_THREAD=0
      shift
      ;;
    --quiet)
      QUIET=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$BOT_SECRET" ]]; then
  echo "Missing --bot-secret (or NOSTR_BOT_SECRET)." >&2
  exit 2
fi

if ! [[ "$ITERATIONS" =~ ^[0-9]+$ ]] || [[ "$ITERATIONS" -lt 1 ]]; then
  echo "Iterations must be a positive integer." >&2
  exit 2
fi

if ! [[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]] || [[ "$WAIT_SECONDS" -lt 1 ]]; then
  echo "Timeout must be a positive integer." >&2
  exit 2
fi

if ! [[ "$INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || [[ "$INTERVAL_SECONDS" -lt 0 ]]; then
  echo "Interval must be a non-negative integer." >&2
  exit 2
fi

if [[ -z "$SENDER_SECRET" ]]; then
  SENDER_SECRET="$(nak key generate)"
  if [[ $QUIET -eq 0 ]]; then
    echo "Generated ephemeral sender secret: $SENDER_SECRET"
  fi
fi

BOT_PUBLIC_KEY="$(nak key public "$BOT_SECRET")"
SENDER_PUBLIC_KEY="$(nak key public "$SENDER_SECRET")"

if [[ $QUIET -eq 0 ]]; then
  echo "Using bot pubkey   : $BOT_PUBLIC_KEY"
  echo "Using sender pubkey: $SENDER_PUBLIC_KEY"
  echo "Relays            : ${RELAYS[*]}"
  if [[ -n "$JSONL_PATH" ]]; then
    echo "JSONL output      : $JSONL_PATH"
  fi
  echo
fi

if [[ -n "$JSONL_PATH" ]]; then
  : >"$JSONL_PATH"
fi

append_jsonl_record() {
  if [[ -z "$JSONL_PATH" ]]; then
    return 0
  fi

  local direction=$1
  local raw_event_json=$2
  local related_event_id=${3:-}
  local payload_text=${4:-}
  local payload_json=${5:-null}

  local event_json_for_jq='{}'
  local payload_json_for_jq='null'
  local tool_calls='null'
  local parsed_payload_text='null'

  if jq -e . >/dev/null 2>&1 <<<"$raw_event_json"; then
    event_json_for_jq="$raw_event_json"
  fi

  if [[ "$payload_json" != "null" ]] && jq -e . >/dev/null 2>&1 <<<"$payload_json"; then
    payload_json_for_jq="$payload_json"
    tool_calls="$(jq -c '.tool_calls // null' <<<"$payload_json" 2>/dev/null || echo "null")"
    parsed_payload_text="$(jq -r '.text // ""' <<<"$payload_json" 2>/dev/null || echo "")"
    if [[ "$tool_calls" == "null" && -n "$parsed_payload_text" && "$parsed_payload_text" != "null" ]]; then
      tool_calls="$(jq -c 'try (fromjson | .steps // .tool_calls // null) catch null' <<<"$parsed_payload_text" 2>/dev/null || echo "null")"
    fi
  fi

  jq -n \
    --arg timestamp "$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')" \
    --arg direction "$direction" \
    --arg session_id "$session_id" \
    --argjson iteration "$iteration" \
    --arg related_event_id "${related_event_id:-}" \
    --arg raw_payload "$payload_text" \
    --argjson event "$event_json_for_jq" \
    --argjson payload "$payload_json_for_jq" \
    --argjson tool_calls "$tool_calls" \
    '{timestamp:$timestamp,direction:$direction,iteration:$iteration,session_id:$session_id,related_event_id:(if $related_event_id == "" then null else $related_event_id end),event:$event,payload:$payload,payload_raw_text:$raw_payload,payload_tool_calls:$tool_calls}' \
    >>"$JSONL_PATH"
}

success_count=0
fail_count=0

tag_value() {
  local event_json=$1
  local wanted=$2
  jq -r --arg wanted "$wanted" '.tags // [] | map(select(length >= 2 and .[0] == $wanted)) | .[0][1] // ""' <<<"$event_json"
}

has_tag_value() {
  local event_json=$1
  local wanted=$2
  local expected=$3
  local match_count
  match_count=$(jq --arg wanted "$wanted" --arg expected "$expected" '.tags // [] | map(select(length >= 2 and .[0] == $wanted and .[1] == $expected)) | length' <<<"$event_json")
  [[ "$match_count" != "0" ]]
}

normalize_tool_name() {
  local candidate
  candidate="${1,,}"
  case "$candidate" in
    exec|shell|bash|command|cmd)
      echo "exec"
      ;;
    websearch|web_search|search|web-search|search-web|internet_search)
      echo "web_search"
      ;;
    webfetch|web_fetch|fetch|open|open_url|openurl|visit)
      echo "web_fetch"
      ;;
    *)
      echo "$candidate"
      ;;
  esac
}

detect_tool_from_text() {
  local text
  text="${1,,}"
  if [[ "$text" == *"exec"* || "$text" == *"bash"* || "$text" == *" command "* ]]; then
    echo "exec"
    return 0
  fi
  if [[ "$text" == *"web_search"* || "$text" == *"search web"* || "$text" == *"web search"* || "$text" == *"search"* ]]; then
    echo "web_search"
    return 0
  fi
  if [[ "$text" == *"web_fetch"* || "$text" == *"web fetch"* || "$text" == *"fetch"* ]]; then
    echo "web_fetch"
    return 0
  fi
}

collect_expected_tool_plan_from_message() {
  local message=$1
  local -n target_plan=$2
  target_plan=()

  if [[ -n "$TOOL_PLAN_JSON" ]] && jq -e . >/dev/null 2>&1 <<<"$TOOL_PLAN_JSON"; then
    while IFS= read -r raw_tool; do
      raw_tool="$(normalize_tool_name "$raw_tool")"
      if [[ -n "$raw_tool" ]]; then
        target_plan+=("$raw_tool")
      fi
    done < <(jq -r '.[]' <<<"$TOOL_PLAN_JSON")
    return
  fi

  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*[0-9]+[[:space:]]*[[:punct:]]*[[:space:]]*([A-Za-z_][A-Za-z0-9_]*) ]]; then
      local tool_text
      local tool
      tool_text="${BASH_REMATCH[1]}"
      tool="$(normalize_tool_name "$tool_text")"
      if [[ -n "$tool" ]]; then
        target_plan+=("$tool")
      fi
    fi
  done <<<"$message"
}

extract_tool_steps_from_payload() {
  local payload_json=$1
  local payload_text=$2
  local -n out_steps=$3
  local -n out_steps_seen=$4
  local -n out_total_count=$5

  local step_tool
  local line

  if [[ "$payload_json" != "null" ]] && jq -e . >/dev/null 2>&1 <<<"$payload_json"; then
    while IFS= read -r step_tool; do
      if [[ -z "$step_tool" ]]; then
        continue
      fi
      step_tool="$(normalize_tool_name "$step_tool")"
      if [[ -n "$step_tool" ]]; then
        out_steps+=("$step_tool")
        out_steps_seen["$step_tool"]=1
        out_total_count=$((out_total_count + 1))
      fi
    done < <(jq -r '(.steps // .tool_calls // [])[]? | (.tool // .name // .kind // .type // .tool_name // empty)' <<<"$payload_json" | sed '/^$/d')
  fi

  while IFS= read -r line; do
    local step_tool_candidate=""
    local step_name=""
    local step_no=""

    if [[ "$line" =~ [Ss]tep[[:space:]]*([0-9]+)[[:space:]]*[:-][[:space:]]*(.*) ]]; then
      step_no="${BASH_REMATCH[1]}"
      step_name="${BASH_REMATCH[2]}"
    fi

    if [[ -z "$step_name" ]] && [[ "$line" =~ ^[[:space:]]*([0-9]+)[[:space:]]*[[:punct:]]*[[:space:]]*(.+)$ ]]; then
      step_no="${BASH_REMATCH[1]}"
      step_name="${BASH_REMATCH[2]}"
    fi

    if [[ -z "$step_name" ]] && [[ "$line" =~ ^[[:space:]]*\|[[:space:]]*([0-9]+)[[:space:]]*\|[[:space:]]*([^|]+)\| ]]; then
      step_no="${BASH_REMATCH[1]}"
      step_name="${BASH_REMATCH[2]}"
    fi

    if [[ -n "$step_name" ]]; then
      step_tool_candidate="$(detect_tool_from_text "$step_name")"
      if [[ -n "$step_tool_candidate" ]]; then
        out_steps+=("$step_tool_candidate")
        out_steps_seen["$step_no"]=1
        out_total_count=$((out_total_count + 1))
      fi
    fi
  done <<<"$payload_text"
}

validate_tool_plan() {
  local -n expected_plan=$1
  local -n observed_steps=$2
  local -n observed_count=$3
  local response_25803_count=$4

  if ((${#expected_plan[@]} == 0)); then
    return 0
  fi

  if (( observed_count < ${#expected_plan[@]} )); then
    echo "  fail: expected ${#expected_plan[@]} tool steps, observed $observed_count tool step observations." >&2
    return 1
  fi

  if (( REQUIRE_TOOL_STREAMING == 1 )) && (( response_25803_count < ${#expected_plan[@]} )); then
    echo "  fail: expected at least ${#expected_plan[@]} streaming inbound response chunks (25803), got $response_25803_count." >&2
    return 1
  fi

  local cursor=0
  for expected in "${expected_plan[@]}"; do
    local matched=0
    for ((i = cursor; i < ${#observed_steps[@]}; i++)); do
      if [[ "${observed_steps[$i]}" == "$expected" ]]; then
        matched=1
        cursor=$((i + 1))
        break
      fi
    done
    if (( matched == 0 )); then
      echo "  fail: expected tool '${expected}' in tool-step sequence; observed: ${observed_steps[*]}" >&2
      return 1
    fi
  done

  return 0
}

for ((iteration = 1; iteration <= ITERATIONS; iteration++)); do
  session_id="${SESSION_PREFIX}-${iteration}"
  message="${MESSAGE_TEMPLATE//\{\{i\}\}/$iteration}"
  if [[ $QUIET -eq 0 ]]; then
    echo "[$iteration/$ITERATIONS] session=$session_id"
  fi

  payload="$(jq -n --arg msg "$message" '{ver:1, message:$msg}')"
  encrypted_prompt="$(nak encrypt "$payload" --recipient-pubkey "$BOT_PUBLIC_KEY" --sec "$SENDER_SECRET")"
  created_at="$(date +%s)"
  since_filter=$((created_at - 5))
  if (( since_filter < 0 )); then
    since_filter=0
  fi

  outbound_event="$(nak event -q -k 25802 -p "$BOT_PUBLIC_KEY" -t "s=$session_id" -t "encryption=nip44" -c "$encrypted_prompt" --sec "$SENDER_SECRET" "${RELAYS[@]}")"
  outbound_event_id="$(jq -r '.id' <<<"$outbound_event")"

  if [[ -z "$outbound_event_id" || "$outbound_event_id" == "null" ]]; then
    echo "[$iteration/$ITERATIONS] FAIL: no outbound event id." >&2
    fail_count=$((fail_count + 1))
    continue
  fi
  append_jsonl_record "outbound_prompt" "$outbound_event" "" "$message" "$payload"

  if [[ $QUIET -eq 0 ]]; then
    echo "  sent outbound event: $outbound_event_id"
  fi

  tmp_events="$(mktemp)"
  if (( CAPTURE_TOOL_EVENTS == 1 )); then
    if ! timeout "$WAIT_SECONDS" nak req -q --stream \
      -k 25800 -k 25801 -k 25803 -k 25804 -k 25805 -k 25806 \
      -p "$SENDER_PUBLIC_KEY" -t "s=$session_id" -s "$since_filter" "${RELAYS[@]}" >"$tmp_events"; then
      if ! timeout "$WAIT_SECONDS" nak req -q --stream \
        -k 25800 -k 25801 -k 25803 -k 25804 -k 25805 -k 25806 \
        -t "s=$session_id" -s "$since_filter" "${RELAYS[@]}" >"$tmp_events"; then
        true
      fi
    fi
  else
    if ! timeout "$WAIT_SECONDS" nak req -q --stream \
      -k 25803 \
      -p "$SENDER_PUBLIC_KEY" -t "s=$session_id" -s "$since_filter" "${RELAYS[@]}" >"$tmp_events"; then
      if ! timeout "$WAIT_SECONDS" nak req -q --stream \
        -k 25803 \
        -t "s=$session_id" -s "$since_filter" "${RELAYS[@]}" >"$tmp_events"; then
        true
      fi
    fi
  fi

  response_event=""
  response_payload=""
  response_payload_json="null"
  response_event_count=0
  response_25803_count=0
  observed_tool_steps=()
  declare -A observed_tool_steps_by_index=()
  observed_tool_step_count=0
  expected_tool_plan=()
  collect_expected_tool_plan_from_message "$message" expected_tool_plan

  if (( STRICT_TOOL_VALIDATION == 1 && ${#expected_tool_plan[@]} == 0 )); then
    echo "  fail: strict tool validation enabled but no tool plan could be inferred from message or --tool-plan." >&2
    fail_count=$((fail_count + 1))
    continue
  fi

  while IFS= read -r response_line; do
    [[ -z "$response_line" ]] && continue
    response_event_count=$((response_event_count + 1))
    response_kind="$(jq -r '.kind // empty' <<<"$response_line")"
    if [[ "$response_kind" == "25803" ]]; then
      response_25803_count=$((response_25803_count + 1))
    fi

    payload_plain=""
    payload_json="null"
    candidate_cipher="$(jq -r '.content // empty' <<<"$response_line")"
    if [[ -n "$candidate_cipher" && "$candidate_cipher" != "null" ]]; then
      if payload_plain="$(nak decrypt "$candidate_cipher" --sender-pubkey "$BOT_PUBLIC_KEY" --sec "$SENDER_SECRET" 2>/dev/null)"; then
        payload_json="$(jq -c . <<<"$payload_plain" 2>/dev/null || echo "null")"
      fi
    fi

    append_jsonl_record "inbound_event" "$response_line" "$outbound_event_id" "$payload_plain" "$payload_json"

    if [[ -z "$response_event" ]] && [[ "$(jq -r '.kind // empty' <<<"$response_line")" == "25803" ]]; then
      response_event="$response_line"
      response_payload="$payload_plain"
      response_payload_json="$payload_json"
    fi

    if [[ "$response_kind" == "25803" ]]; then
      extract_tool_steps_from_payload "$payload_json" "$payload_plain" observed_tool_steps observed_tool_steps_by_index observed_tool_step_count
    fi
  done <"$tmp_events"
  rm -f "$tmp_events"

  if [[ "$response_event_count" -eq 0 ]]; then
    echo "  fail: no response events on relays before timeout ($WAIT_SECONDS sec)." >&2
    fail_count=$((fail_count + 1))
    continue
  fi

  if [[ -z "$response_event" ]]; then
    echo "  fail: no matching kind=25803 response." >&2
    fail_count=$((fail_count + 1))
    continue
  fi

  response_encryption="$(tag_value "$response_event" "encryption")"
  if [[ "$response_encryption" != "nip44" ]]; then
    echo "  fail: response encryption tag is '$response_encryption'." >&2
    fail_count=$((fail_count + 1))
    continue
  fi

  if (( REQUIRE_THREAD == 1 )); then
    if ! has_tag_value "$response_event" "e" "$outbound_event_id"; then
      echo "  fail: response missing expected thread tag e=$outbound_event_id." >&2
      fail_count=$((fail_count + 1))
      continue
    fi
  fi

  if [[ "$session_id" != "$(tag_value "$response_event" "s")" ]]; then
    echo "  fail: response session mismatch." >&2
    fail_count=$((fail_count + 1))
    continue
  fi

  if [[ "$response_payload_json" == "null" ]]; then
    echo "  fail: response payload not valid JSON." >&2
    fail_count=$((fail_count + 1))
    continue
  fi

  response_text="$(jq -r '.text // empty' <<<"$response_payload")"
  response_version="$(jq -r '.ver // empty' <<<"$response_payload")"

  if [[ "$response_version" != "1" ]]; then
    echo "  fail: response payload version '$response_version'." >&2
    fail_count=$((fail_count + 1))
    continue
  fi

  if [[ -z "$response_text" ]]; then
    echo "  fail: response payload text empty." >&2
    fail_count=$((fail_count + 1))
    continue
  fi

  if (( STRICT_TOOL_VALIDATION == 1 )); then
    if ! validate_tool_plan expected_tool_plan observed_tool_steps observed_tool_step_count "$response_25803_count"; then
      fail_count=$((fail_count + 1))
      continue
    fi
  fi

  response_event_id="$(jq -r '.id' <<<"$response_event")"
  if [[ $QUIET -eq 0 ]]; then
    echo "  ok: response=$response_event_id text=${response_text:0:120}"
  fi
  success_count=$((success_count + 1))

  if (( iteration < ITERATIONS && INTERVAL_SECONDS > 0 )); then
    sleep "$INTERVAL_SECONDS"
  fi
done

if [[ $QUIET -eq 0 ]]; then
  echo
  echo "Summary: success=$success_count fail=$fail_count"
  if [[ -n "$JSONL_PATH" ]]; then
    echo "JSONL log: $JSONL_PATH"
  fi
fi

if [[ "$fail_count" -ne 0 ]]; then
  exit 1
fi
