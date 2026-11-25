#!/usr/bin/env bash
set -euo pipefail
trap "" PIPE
export TERM=xterm-256color
export NO_COLOR=1

source scripts/lib/openclaw-e2e-instance.sh

source scripts/e2e/lib/release-scenarios/setup.sh
export OPENAI_API_KEY="sk-openclaw-release-media-memory"
export OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER=1

PORT="18789"
MOCK_PORT="44200"
SUCCESS_MARKER="OPENCLAW_E2E_OK_MEDIA_MEMORY"
MEMORY_MARKER="release-media-memory-saffron-$(date +%s)"
media_root="$(mktemp -d /tmp/openclaw-release-media-memory.XXXXXX)"
openclaw_release_scenario_logs \
  INSTALL_LOG "$media_root/install.log" \
  ONBOARD_LOG "$media_root/onboard.log" \
  ENV_LOG "$media_root/env.log" \
  CONFIG_JSON "$media_root/config.json" \
  PACKAGE_FILES_LOG "$media_root/package-files.log" \
  PLUGINS_JSON "$media_root/plugins.json" \
  PLUGINS_STDERR_LOG "$media_root/plugins.stderr.log" \
  MOCK_OPENAI_LOG "$media_root/openai.log" \
  MOCK_REQUEST_LOG "$media_root/openai-requests.jsonl" \
  DESCRIBE_JSON "$media_root/describe.json" \
  DESCRIBE_STDERR_LOG "$media_root/describe.stderr.log" \
  GENERATE_JSON "$media_root/generate.json" \
  GENERATE_STDERR_LOG "$media_root/generate.stderr.log" \
  INDEX_LOG "$media_root/index.log" \
  SEARCH_BEFORE_JSON "$media_root/search-before.json" \
  SEARCH_BEFORE_STDERR_LOG "$media_root/search-before.stderr.log" \
  SEARCH_AFTER_JSON "$media_root/search-after.json" \
  SEARCH_AFTER_STDERR_LOG "$media_root/search-after.stderr.log" \
  GATEWAY_1_LOG "$media_root/gateway-1.log" \
  GATEWAY_2_LOG "$media_root/gateway-2.log"
export SUCCESS_MARKER MOCK_REQUEST_LOG

mock_pid=""
gateway_pid=""
cleanup() {
  openclaw_e2e_terminate_gateways "${gateway_pid:-}"
  openclaw_e2e_stop_process "${mock_pid:-}"
  if [ -n "${media_root:-}" ]; then
    rm -rf "$media_root"
  fi
}
trap cleanup EXIT

dump_debug_logs() {
  local status="$1"
  echo "release media memory failed with exit code $status" >&2
  openclaw_e2e_dump_logs "${OPENCLAW_RELEASE_DIAGNOSTIC_LOGS[@]}"
}
openclaw_e2e_enable_failure_diagnostics

openclaw_e2e_install_package "$INSTALL_LOG"
command -v openclaw >/dev/null
package_root="$(openclaw_e2e_package_root)"
entry="$(openclaw_e2e_package_entrypoint "$package_root")"
{
  printf 'openclaw=%s\n' "$(command -v openclaw)"
  printf 'package_root=%s\n' "$package_root"
  printf 'entry=%s\n' "$entry"
  printf 'HOME=%s\n' "$HOME"
  printf 'OPENCLAW_HOME=%s\n' "$OPENCLAW_HOME"
  printf 'OPENCLAW_STATE_DIR=%s\n' "$OPENCLAW_STATE_DIR"
  printf 'OPENCLAW_CONFIG_PATH=%s\n' "$OPENCLAW_CONFIG_PATH"
} >"$ENV_LOG"
openclaw_e2e_enable_openclaw_cli_timeout
(
  cd "$package_root/dist/extensions/memory-core"
  find . -type f | sed 's#^\./##' | sort
) >"$PACKAGE_FILES_LOG"

mock_pid="$(openclaw_e2e_start_mock_openai "$MOCK_PORT" "$MOCK_OPENAI_LOG")"
openclaw_e2e_wait_mock_openai "$MOCK_PORT"

openclaw_release_onboard "$PORT" openclaw >"$ONBOARD_LOG" 2>&1
cp "$OPENCLAW_CONFIG_PATH" "$CONFIG_JSON"
openclaw plugins list --json >"$PLUGINS_JSON" 2>"$PLUGINS_STDERR_LOG"
node scripts/e2e/lib/release-scenarios/assertions.mjs assert-file-contains "$PLUGINS_JSON" memory-core
node scripts/e2e/lib/release-scenarios/assertions.mjs configure-mock-openai "$MOCK_PORT"

mkdir -p "$OPENCLAW_STATE_DIR/workspace/memory"
printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yf7kAAAAASUVORK5CYII=' | base64 -d >"$media_root/input.png"

openclaw infer image describe \
  --file "$media_root/input.png" \
  --model openai/gpt-5.6-luna \
  --prompt "Describe this image and return marker $SUCCESS_MARKER" \
  --json >"$DESCRIBE_JSON" 2>"$DESCRIBE_STDERR_LOG"
node scripts/e2e/lib/release-scenarios/assertions.mjs assert-image-describe "$DESCRIBE_JSON" "$MOCK_REQUEST_LOG"

openclaw infer image generate \
  --model openai/gpt-image-1 \
  --prompt "Generate a tiny test image for $SUCCESS_MARKER" \
  --output "$media_root/generated.png" \
  --json >"$GENERATE_JSON" 2>"$GENERATE_STDERR_LOG"
node scripts/e2e/lib/release-scenarios/assertions.mjs assert-image-generate "$GENERATE_JSON" "$MOCK_REQUEST_LOG"

cat >"$OPENCLAW_STATE_DIR/workspace/MEMORY.md" <<EOF
# Long-term memory

- The release media memory marker is $MEMORY_MARKER.
EOF

openclaw memory index --force >"$INDEX_LOG" 2>&1
openclaw memory search "$MEMORY_MARKER" --json >"$SEARCH_BEFORE_JSON" 2>"$SEARCH_BEFORE_STDERR_LOG"
node scripts/e2e/lib/release-scenarios/assertions.mjs assert-memory-search "$SEARCH_BEFORE_JSON" "$MEMORY_MARKER"

start_gateway "$GATEWAY_1_LOG"
stop_gateway
start_gateway "$GATEWAY_2_LOG"
openclaw memory search "$MEMORY_MARKER" --json >"$SEARCH_AFTER_JSON" 2>"$SEARCH_AFTER_STDERR_LOG"
node scripts/e2e/lib/release-scenarios/assertions.mjs assert-memory-search "$SEARCH_AFTER_JSON" "$MEMORY_MARKER"
stop_gateway

echo "Release media memory scenario passed."
