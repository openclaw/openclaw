#!/usr/bin/env bash

# Probe an isolated container, then return its immutable image identity. No host
# state or credentials enter the probe, and a mutable tag cannot change between
# capability verification and deployment.
openclaw_prepare_gateway_image() (
  local runtime="$1" image="$2" pull_policy="$3" mode="${4:-require-published-port}"
  local probe="" created="" image_id="" capability=""
  case "$mode" in
    require-published-port|allow-legacy) ;;
    *) echo "Invalid Gateway image capability mode." >&2; return 1 ;;
  esac
  trap 'if [[ -n "$probe" ]]; then "$runtime" rm -f -v "$probe" >/dev/null 2>&1 || true; fi' EXIT
  created="$(openclaw_host_timeout_cmd 600s "$runtime" create --pull="$pull_policy" \
    --network none --entrypoint sh "$image" -c 'exec node -e "$2" "$1"' \
    openclaw-capability-probe "$mode" '
const { spawnSync } = require("node:child_process");
const result = spawnSync(process.execPath, ["dist/index.js", "gateway", "--help"], {
  encoding: "utf8", timeout: 30000, killSignal: "SIGKILL", maxBuffer: 1048576,
});
const help = result.stdout ?? "";
const hasPort = /^\s*--port(?:\s|=)/m.test(help);
const hasPublishedPort = /^\s*--published-port(?:\s|=)/m.test(help);
if (result.status !== 0 || !hasPort || (!hasPublishedPort && process.argv.at(-1) !== "allow-legacy")) {
  console.error("Selected image does not support the required gateway --port and --published-port options. Select a compatible image or build this checkout from source before retrying; the running Gateway has not been replaced.");
  process.exit(1);
}
process.stdout.write(hasPublishedPort ? "published-port" : "legacy");
')" || return 1
  [[ "$created" =~ ^[a-fA-F0-9]{12,64}$ ]] || { echo "Invalid capability probe container identity." >&2; return 1; }
  probe="$created"
  image_id="$("$runtime" inspect --format '{{.Image}}' "$probe")" || return 1
  [[ "$image_id" =~ ^(sha256:)?[a-fA-F0-9]{64}$ ]] || { echo "Invalid selected Gateway image identity." >&2; return 1; }
  capability="$(openclaw_host_timeout_cmd 60s "$runtime" start --attach "$probe")" || return 1
  [[ "$capability" == "published-port" || ("$mode" == "allow-legacy" && "$capability" == "legacy") ]] || {
    echo "Invalid Gateway image capability result." >&2
    return 1
  }
  if [[ "$mode" == "allow-legacy" ]]; then
    printf '%s\t%s\n' "$image_id" "$capability"
  else
    printf '%s\n' "$image_id"
  fi
)
