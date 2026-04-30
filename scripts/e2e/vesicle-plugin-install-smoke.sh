#!/usr/bin/env bash
# Fast local smoke test for the installable Vesicle channel plugin package.
#
# This intentionally disables bundled plugin discovery so the smoke only tests
# Vesicle packaging/install behavior and does not stage unrelated bundled
# runtime dependencies.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TMP_ROOT="${OPENCLAW_VESICLE_PLUGIN_TMP_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "$TMP_ROOT"
TMP_ROOT="$(cd "$TMP_ROOT" && pwd -P)"

PACK_DEST="${OPENCLAW_VESICLE_PLUGIN_PACK_DEST:-/tmp}"
mkdir -p "$PACK_DEST"
PACK_DEST="$(cd "$PACK_DEST" && pwd -P)"

NPM_CACHE="${OPENCLAW_VESICLE_PLUGIN_NPM_CACHE:-${npm_config_cache:-${NPM_CONFIG_CACHE:-$TMP_ROOT/openclaw-npm-cache}}}"
STATE_DIR_CREATED=0
if [[ -n "${OPENCLAW_VESICLE_PLUGIN_STATE_DIR:-}" ]]; then
  STATE_DIR="$OPENCLAW_VESICLE_PLUGIN_STATE_DIR"
  mkdir -p "$STATE_DIR"
else
  STATE_DIR="$(mktemp -d "$TMP_ROOT/openclaw-vesicle-plugin-smoke.XXXXXX")"
  STATE_DIR_CREATED=1
fi
STATE_DIR="$(cd "$STATE_DIR" && pwd -P)"
KEEP_STATE="${OPENCLAW_VESICLE_PLUGIN_KEEP_STATE:-$((1 - STATE_DIR_CREATED))}"

cleanup() {
  if [[ "$KEEP_STATE" != "1" ]]; then
    rm -rf "$STATE_DIR"
  fi
}
trap cleanup EXIT

if [[ ! -f "$ROOT_DIR/dist/entry.js" && ! -f "$ROOT_DIR/dist/entry.mjs" ]]; then
  echo "==> dist/entry.js missing; running fast CLI bundle"
  (cd "$ROOT_DIR" && node scripts/tsdown-build.mjs)
fi

echo "==> OpenClaw CLI"
node "$ROOT_DIR/openclaw.mjs" --version

echo "==> Packing @openclaw/vesicle"
pack_name="$(
  cd "$ROOT_DIR"
  env npm_config_cache="$NPM_CACHE" npm pack --silent --ignore-scripts ./extensions/vesicle --pack-destination "$PACK_DEST"
)"
pack_name="$(printf "%s\n" "$pack_name" | tail -n 1)"
pack_path="$PACK_DEST/$pack_name"
if [[ ! -f "$pack_path" ]]; then
  echo "Packed tarball not found: $pack_path" >&2
  exit 1
fi
echo "Packed $pack_path"

run_openclaw() {
  env \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 \
    OPENCLAW_STATE_DIR="$STATE_DIR" \
    OPENCLAW_CONFIG_PATH="$STATE_DIR/openclaw.json" \
    npm_config_cache="$NPM_CACHE" \
    node "$ROOT_DIR/openclaw.mjs" "$@"
}

echo "==> Installing packed Vesicle plugin"
run_openclaw plugins install "$pack_path"

echo "==> Listing plugins"
run_openclaw plugins list

inspect_json="$STATE_DIR/vesicle-inspect.json"
run_openclaw plugins inspect vesicle --json >"$inspect_json"
node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const plugin = data.plugin ?? {};
const diagnostics = Array.isArray(data.diagnostics) ? data.diagnostics : [];
const channelIds = Array.isArray(plugin.channelIds) ? plugin.channelIds : [];
const errors = [];
if (plugin.id !== "vesicle") {
  errors.push(`expected plugin id vesicle, got ${JSON.stringify(plugin.id)}`);
}
if (plugin.status !== "loaded") {
  errors.push(`expected plugin status loaded, got ${JSON.stringify(plugin.status)}`);
}
if (!channelIds.includes("vesicle")) {
  errors.push(`expected channelIds to include vesicle, got ${JSON.stringify(channelIds)}`);
}
if (data.install?.source !== "archive") {
  errors.push(`expected archive install source, got ${JSON.stringify(data.install?.source)}`);
}
if (diagnostics.length > 0) {
  errors.push(`expected no diagnostics, got ${JSON.stringify(diagnostics)}`);
}
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
' "$inspect_json"

echo "Vesicle plugin install smoke passed."
