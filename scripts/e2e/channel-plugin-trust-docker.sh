#!/usr/bin/env bash
set -euo pipefail

# Definition:
#   Docker/package E2E proof for local channel plugin trust gating. The host
#   mode builds or reuses the functional Docker image, then runs the container
#   mode against the installed OpenClaw package.
#
# Parameters:
#   --container: run the in-container scenario. Host mode is the default.
#   OPENCLAW_CHANNEL_PLUGIN_TRUST_E2E_IMAGE: override the Docker image name.
#   OPENCLAW_CHANNEL_PLUGIN_TRUST_E2E_SKIP_BUILD=1: reuse/pull the image.
#
# Outputs:
#   stdout logs each case and prints "Channel plugin trust Docker E2E passed."
#   Exit 0 means both representative package-environment cases passed.
#   Exit non-zero means the package build, Docker run, or trust assertion failed.

usage() {
  cat <<'EOF'
Usage:
  bash scripts/e2e/channel-plugin-trust-docker.sh [--container]

Description:
  Proves the packaged OpenClaw CLI enforces local channel plugin trust for
  plugins.load.paths entries in a clean Docker/package environment.

Options:
  --container   Run the in-container scenario. Used by the host wrapper.
  -h, --help    Show this help.

Environment:
  OPENCLAW_CHANNEL_PLUGIN_TRUST_E2E_IMAGE       Override Docker image name.
  OPENCLAW_CHANNEL_PLUGIN_TRUST_E2E_SKIP_BUILD  Reuse/pull image instead of building.
  OPENCLAW_TEST_STATE_SCRIPT_B64                Required in --container mode.

Outputs:
  Prints case progress and PASS lines to stdout. Exits non-zero on assertion
  failure and leaves the failing command output in the container log.

Examples:
  bash scripts/e2e/channel-plugin-trust-docker.sh
  OPENCLAW_CHANNEL_PLUGIN_TRUST_E2E_SKIP_BUILD=1 bash scripts/e2e/channel-plugin-trust-docker.sh
EOF
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

run_openclaw() {
  if command -v openclaw >/dev/null 2>&1; then
    openclaw "$@"
    return
  fi
  if [ -f /app/openclaw.mjs ]; then
    node /app/openclaw.mjs "$@"
    return
  fi
  echo "openclaw CLI not found in Docker image" >&2
  exit 1
}

write_load_paths_fixture() {
  local plugin_dir="${1:?missing plugin dir}"
  local origin="${2:?missing origin}"
  local plugin_id="e2e-load-paths-shadow"
  local channel_id="e2e-load-paths"
  mkdir -p "$plugin_dir"

  cat >"$plugin_dir/package.json" <<EOF
{
  "name": "@openclaw-e2e/$plugin_id",
  "version": "0.0.0-e2e",
  "private": true,
  "openclaw": {
    "extensions": ["./index.cjs"],
    "setupEntry": "./setup-entry.cjs",
    "channel": {
      "id": "$channel_id",
      "label": "E2E Load Paths",
      "selectionLabel": "E2E Load Paths",
      "docsPath": "/channels/$channel_id",
      "blurb": "Docker E2E local trust fixture."
    }
  }
}
EOF

  cat >"$plugin_dir/openclaw.plugin.json" <<EOF
{
  "id": "$plugin_id",
  "name": "E2E load-paths Shadow",
  "description": "Docker E2E local trust fixture.",
  "activation": { "onStartup": false },
  "channels": ["$channel_id"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
EOF

  cat >"$plugin_dir/index.cjs" <<EOF
const fs = require("node:fs");
const path = require("node:path");
const importMarker = process.env.PLUGINTRUST_IMPORT_MARKER;
const registerMarker = process.env.PLUGINTRUST_REGISTER_MARKER;
const canary = process.env.PLUGINTRUST_CANARY ?? "<no-canary>";
function writeMarker(target, payload) {
  if (!target) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, payload, "utf8");
}
writeMarker(importMarker, "imported|origin=$origin|canary=" + canary + "\\n");
module.exports = {
  id: "$plugin_id",
  register(api) {
    writeMarker(registerMarker, "registered|origin=$origin|canary=" + canary + "\\n");
    api.registerChannel({
      plugin: {
        id: "$channel_id",
        meta: {
          id: "$channel_id",
          label: "E2E Load Paths",
          selectionLabel: "E2E Load Paths",
          docsPath: "/channels/$channel_id",
          blurb: "Docker E2E local trust fixture.",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({ accountId: "default" }),
        },
        outbound: { deliveryMode: "direct" },
      },
    });
  },
};
EOF

  cat >"$plugin_dir/setup-entry.cjs" <<EOF
const fs = require("node:fs");
const path = require("node:path");
const importMarker = process.env.PLUGINTRUST_SETUP_IMPORT_MARKER;
const registerMarker = process.env.PLUGINTRUST_SETUP_REGISTER_MARKER;
const canary = process.env.PLUGINTRUST_CANARY ?? "<no-canary>";
function writeMarker(target, payload) {
  if (!target) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, payload, "utf8");
}
writeMarker(importMarker, "setup-imported|origin=$origin|canary=" + canary + "\\n");
module.exports = {
  plugin: {
    id: "$channel_id",
    meta: {
      id: "$channel_id",
      label: "E2E Load Paths setup",
      selectionLabel: "E2E Load Paths setup",
      docsPath: "/channels/$channel_id",
      blurb: "Docker E2E local trust setup fixture.",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({ accountId: "default" }),
    },
    outbound: { deliveryMode: "direct" },
    setup: {
      validateInput: ({ input }) => {
        writeMarker(
          registerMarker,
          "setup-registered|origin=$origin|canary=" + canary + "|token=" + (input?.token ?? "<no-token>") + "\\n",
        );
        return null;
      },
      applyAccountConfig: ({ cfg }) => cfg,
    },
  },
};
EOF
}

write_case_config() {
  local plugin_dir="${1:?missing plugin dir}"
  local trusted="${2:?missing trusted flag}"
  local plugin_id="e2e-load-paths-shadow"
  mkdir -p "$(dirname "$OPENCLAW_CONFIG_PATH")"
  if [ "$trusted" = "1" ]; then
    cat >"$OPENCLAW_CONFIG_PATH" <<EOF
{
  "plugins": {
    "enabled": true,
    "allow": ["$plugin_id"],
    "load": {
      "paths": ["$plugin_dir"]
    }
  }
}
EOF
  else
    cat >"$OPENCLAW_CONFIG_PATH" <<EOF
{
  "plugins": {
    "enabled": true,
    "load": {
      "paths": ["$plugin_dir"]
    }
  }
}
EOF
  fi
}

run_case() {
  local case_id="${1:?missing case id}"
  local trusted="${2:?missing trusted flag}"
  local scratch
  scratch="$(mktemp -d "/tmp/openclaw-channel-plugin-trust-$case_id.XXXXXX")"
  local plugin_dir="$scratch/e2e-load-paths-shadow"
  local marker_dir="$scratch/markers"
  local stdout_file="$scratch/stdout.log"
  local stderr_file="$scratch/stderr.log"
  local canary="$case_id-canary"
  mkdir -p "$marker_dir"

  write_load_paths_fixture "$plugin_dir" "config"
  write_case_config "$plugin_dir" "$trusted"

  echo "[CASE $case_id] plugins.load.paths trusted=$trusted"
  set +e
  PLUGINTRUST_IMPORT_MARKER="$marker_dir/import.marker" \
    PLUGINTRUST_REGISTER_MARKER="$marker_dir/register.marker" \
    PLUGINTRUST_SETUP_IMPORT_MARKER="$marker_dir/setup-import.marker" \
    PLUGINTRUST_SETUP_REGISTER_MARKER="$marker_dir/setup-register.marker" \
    PLUGINTRUST_CANARY="$canary" \
    run_openclaw channels add --channel e2e-load-paths --token "$canary" \
      >"$stdout_file" 2>"$stderr_file"
  local status=$?
  set -e

  if [ "$trusted" = "1" ] && [ "$status" -ne 0 ]; then
    echo "Expected trusted case to succeed; exit=$status" >&2
    cat "$stderr_file" >&2 || true
    exit 1
  fi

  if [ "$trusted" = "1" ]; then
    for marker in setup-import setup-register; do
      local marker_path="$marker_dir/$marker.marker"
      if [ ! -f "$marker_path" ]; then
        echo "Expected $marker marker for trusted case" >&2
        cat "$stderr_file" >&2 || true
        exit 1
      fi
      if ! grep -qF "canary=$canary" "$marker_path"; then
        echo "$marker marker did not include canary $canary" >&2
        cat "$marker_path" >&2 || true
        exit 1
      fi
    done
    echo "PASS: $case_id trusted load-paths setup entry executed"
  else
    for marker in setup-import setup-register import register; do
      if [ -e "$marker_dir/$marker.marker" ]; then
        echo "Expected $marker marker to be absent for untrusted case" >&2
        cat "$marker_dir/$marker.marker" >&2 || true
        exit 1
      fi
    done
    echo "PASS: $case_id untrusted load-paths setup entry blocked"
  fi
}

run_container() {
  source scripts/lib/openclaw-e2e-instance.sh
  openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
  export OPENCLAW_WORKSPACE_DIR="$HOME/.openclaw/workspace"

  run_openclaw --version
  run_case untrusted-load-paths 0
  run_case trusted-load-paths 1
  echo "Channel plugin trust Docker E2E passed."
}

run_host() {
  source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
  local image_name
  image_name="$(
    docker_e2e_resolve_image \
      "openclaw-channel-plugin-trust-e2e:local" \
      OPENCLAW_CHANNEL_PLUGIN_TRUST_E2E_IMAGE
  )"
  local skip_build="${OPENCLAW_CHANNEL_PLUGIN_TRUST_E2E_SKIP_BUILD:-0}"
  docker_e2e_build_or_reuse "$image_name" channel-plugin-trust "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "" "$skip_build"

  local state_script_b64
  state_script_b64="$(docker_e2e_test_state_shell_b64 channel-plugin-trust minimal)"
  echo "Running channel plugin trust Docker E2E..."
  docker_e2e_run_logged_print_with_harness \
    channel-plugin-trust \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$state_script_b64" \
    "$image_name" \
    bash scripts/e2e/channel-plugin-trust-docker.sh --container
}

case "${1:-}" in
  -h | --help)
    usage
    ;;
  --container)
    run_container
    ;;
  "")
    run_host
    ;;
  *)
    echo "Unknown argument: $1" >&2
    echo >&2
    usage >&2
    exit 1
    ;;
esac
