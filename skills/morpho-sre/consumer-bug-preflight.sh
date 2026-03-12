#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
JQ_BIN="${JQ_BIN:-jq}"
RESOLVER_CMD="${CONSUMER_BUG_PREFLIGHT_RESOLVER:-${SCRIPT_DIR}/frontend-project-resolver.sh}"
POSTHOG_CMD="${CONSUMER_BUG_PREFLIGHT_POSTHOG:-${SCRIPT_DIR}/posthog-mcp.sh}"
SENTRY_CMD="${CONSUMER_BUG_PREFLIGHT_SENTRY:-${SCRIPT_DIR}/sentry-cli.sh}"
LINEAR_CMD="${CONSUMER_BUG_PREFLIGHT_LINEAR:-${SCRIPT_DIR}/linear-ticket-api.sh}"
CAST_BIN="${CONSUMER_BUG_PREFLIGHT_CAST_BIN:-cast}"
ANVIL_BIN="${CONSUMER_BUG_PREFLIGHT_ANVIL_BIN:-anvil}"
PROBE_TMP="${PROBE_TMP:-$(mktemp -d /tmp/consumer-bug-preflight.XXXXXX)}"

usage() {
  cat <<'EOF'
Usage:
  consumer-bug-preflight.sh <dev|prd> <question text>
EOF
}

die() {
  printf 'consumer-bug-preflight: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

normalize_env_name() {
  case "${1:-}" in
    dev|DEV) printf 'dev\n' ;;
    prd|PRD|prod|PROD) printf 'prd\n' ;;
    *) return 1 ;;
  esac
}

preview_text() {
  tr '\r\n' '  ' | sed -E 's/[[:space:]]+/ /g' | cut -c1-280
}

render_command() {
  local rendered=""
  local arg
  for arg in "$@"; do
    if [[ -n "$rendered" ]]; then
      rendered+=" "
    fi
    rendered+="$(printf '%q' "$arg")"
  done
  printf '%s\n' "$rendered"
}

cleanup_probe_tmp() {
  rm -rf "$PROBE_TMP"
}

probe_paths() {
  local name="$1"
  printf '%s\n%s\n' "$PROBE_TMP/${name}.out" "$PROBE_TMP/${name}.err"
}

wrap_json_probe() {
  local command_text="$1"
  local stdout_path="$2"
  local stderr_path="$3"
  local exit_code="$4"

  if [[ "$exit_code" -eq 0 ]] && "$JQ_BIN" -e . "$stdout_path" >/dev/null 2>&1; then
    "$JQ_BIN" -nc \
      --arg command "$command_text" \
      --slurpfile data "$stdout_path" \
      '{ ok: true, command: $command, data: $data[0] }'
    return 0
  fi

  local error_preview
  if [[ -s "$stderr_path" ]]; then
    error_preview="$(preview_text <"$stderr_path")"
  elif [[ -s "$stdout_path" ]]; then
    error_preview="$(preview_text <"$stdout_path")"
  else
    error_preview="command failed"
  fi

  "$JQ_BIN" -nc \
    --arg command "$command_text" \
    --arg error "$error_preview" \
    --argjson exitCode "$exit_code" \
    '{ ok: false, command: $command, exitCode: $exitCode, error: $error }'
}

run_json_probe() {
  local probe_name probe_files stdout_path stderr_path exit_code command_text
  probe_name="$(printf '%s' "${1##*/}" | tr -c '[:alnum:]' '_')"
  probe_files="$(probe_paths "$probe_name")"
  stdout_path="${probe_files%%$'\n'*}"
  stderr_path="${probe_files#*$'\n'}"
  exit_code=0
  command_text="$(render_command "$@")"
  "$@" >"$stdout_path" 2>"$stderr_path" || exit_code=$?
  wrap_json_probe "$command_text" "$stdout_path" "$stderr_path" "$exit_code"
}

run_text_probe() {
  local probe_name probe_files stdout_path stderr_path exit_code command_text
  probe_name="$(printf '%s' "${1##*/}" | tr -c '[:alnum:]' '_')"
  probe_files="$(probe_paths "$probe_name")"
  stdout_path="${probe_files%%$'\n'*}"
  stderr_path="${probe_files#*$'\n'}"
  exit_code=0
  command_text="$(render_command "$@")"
  "$@" >"$stdout_path" 2>"$stderr_path" || exit_code=$?

  if [[ "$exit_code" -eq 0 ]]; then
    "$JQ_BIN" -nc \
      --arg command "$command_text" \
      --arg outputPreview "$(preview_text <"$stdout_path")" \
      '{ ok: true, command: $command, outputPreview: $outputPreview }'
  else
    local error_preview
    if [[ -s "$stderr_path" ]]; then
      error_preview="$(preview_text <"$stderr_path")"
    elif [[ -s "$stdout_path" ]]; then
      error_preview="$(preview_text <"$stdout_path")"
    else
      error_preview="command failed"
    fi
    "$JQ_BIN" -nc \
      --arg command "$command_text" \
      --arg error "$error_preview" \
      --argjson exitCode "$exit_code" \
      '{ ok: false, command: $command, exitCode: $exitCode, error: $error }'
  fi

}

probe_foundry() {
  local cast_path anvil_path
  cast_path="$(command -v "$CAST_BIN" 2>/dev/null || true)"
  anvil_path="$(command -v "$ANVIL_BIN" 2>/dev/null || true)"

  "$JQ_BIN" -nc \
    --arg castBin "$CAST_BIN" \
    --arg anvilBin "$ANVIL_BIN" \
    --arg castPath "$cast_path" \
    --arg anvilPath "$anvil_path" \
    '{
      ok: ($castPath != "" and $anvilPath != ""),
      castBin: $castBin,
      anvilBin: $anvilBin,
      castPath: (if $castPath == "" then null else $castPath end),
      anvilPath: (if $anvilPath == "" then null else $anvilPath end),
      error: (
        if $castPath != "" and $anvilPath != "" then
          null
        elif $castPath == "" and $anvilPath == "" then
          "missing cast and anvil"
        elif $castPath == "" then
          "missing cast"
        else
          "missing anvil"
        end
      )
    }'
}

main() {
  local env_name prompt resolver_json posthog_json sentry_json linear_json foundry_json posthog_key

  require_cmd "$JQ_BIN"
  trap cleanup_probe_tmp EXIT
  [[ "$#" -ge 2 ]] || {
    usage >&2
    exit 1
  }

  env_name="$(normalize_env_name "$1")" || die "first arg must be dev or prd"
  shift
  prompt="$*"

  resolver_json="$(run_json_probe "$RESOLVER_CMD" "$env_name" "$prompt")"
  posthog_key="$(
    printf '%s\n' "$resolver_json" | "$JQ_BIN" -r '.data.posthog.top.key // empty' 2>/dev/null || true
  )"

  if [[ -n "$posthog_key" ]]; then
    posthog_json="$(run_json_probe "$POSTHOG_CMD" "$env_name" --project-key "$posthog_key" --probe-auth)"
  else
    posthog_json="$(run_json_probe "$POSTHOG_CMD" "$env_name" --probe-auth)"
  fi

  sentry_json="$(run_text_probe "$SENTRY_CMD" "$env_name" info)"
  linear_json="$(run_json_probe "$LINEAR_CMD" probe-auth)"
  foundry_json="$(probe_foundry)"

  "$JQ_BIN" -nc \
    --arg env "$env_name" \
    --arg prompt "$prompt" \
    --argjson resolver "$resolver_json" \
    --argjson posthog "$posthog_json" \
    --argjson sentry "$sentry_json" \
    --argjson linear "$linear_json" \
    --argjson foundry "$foundry_json" \
    '{
      env: $env,
      prompt: $prompt,
      resolver: $resolver,
      posthog: $posthog,
      sentry: $sentry,
      linear: $linear,
      foundry: $foundry
    }'
}

main "$@"
