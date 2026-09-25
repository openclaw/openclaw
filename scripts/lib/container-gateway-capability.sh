#!/usr/bin/env bash

# Probe an isolated container, then return its immutable image identity. No host
# state or credentials enter the probe, and a mutable tag cannot change between
# capability verification and deployment.
openclaw_prepare_gateway_image() (
  local runtime="$1" image="$2" pull_policy="$3" probe="" created="" image_id=""
  trap 'if [[ -n "$probe" ]]; then "$runtime" rm -f -v "$probe" >/dev/null 2>&1 || true; fi' EXIT
  created="$(openclaw_host_timeout_cmd 600s "$runtime" create --pull="$pull_policy" \
    --network none --entrypoint node "$image" -e '
const { spawnSync } = require("node:child_process");
const result = spawnSync(process.execPath, ["dist/index.js", "gateway", "--help"], {
  encoding: "utf8", timeout: 30000, killSignal: "SIGKILL", maxBuffer: 1048576,
});
if (result.status !== 0 || !/(?:^|\s)--published-port(?:\s|=)/m.test(result.stdout ?? "")) {
  console.error("Selected image does not support gateway --published-port. Select a compatible image or build this checkout from source before retrying; the running Gateway has not been replaced.");
  process.exit(1);
}
')" || return 1
  [[ "$created" =~ ^[a-fA-F0-9]{12,64}$ ]] || { echo "Invalid capability probe container identity." >&2; return 1; }
  probe="$created"
  image_id="$("$runtime" inspect --format '{{.Image}}' "$probe")" || return 1
  [[ "$image_id" =~ ^(sha256:)?[a-fA-F0-9]{64}$ ]] || { echo "Invalid selected Gateway image identity." >&2; return 1; }
  openclaw_host_timeout_cmd 60s "$runtime" start --attach "$probe" >&2 || return 1
  printf '%s\n' "$image_id"
)
