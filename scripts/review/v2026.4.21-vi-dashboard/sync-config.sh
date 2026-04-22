#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

review_require_cmd jq
review_ensure_layout
review_generate_token

tmp_config="$(mktemp "${TMPDIR:-/tmp}/openclaw-review-config.XXXXXX.json")"
cleanup() {
  rm -f "$tmp_config"
}
trap cleanup EXIT

if [[ -f "$SOURCE_CONFIG_PATH" ]]; then
  jq \
    --arg source_state_dir "$SOURCE_STATE_DIR" \
    --arg state_dir "$REVIEW_STATE_DIR" \
    --arg workspace_dir "$REVIEW_WORKSPACE_DIR" \
    --arg port "$REVIEW_PORT" \
    '
      def replace_source_state:
        walk(
          if type == "string" then
            gsub($source_state_dir; $state_dir)
          else
            .
          end
        );
      replace_source_state
      | .gateway = (.gateway // {})
      | .gateway.mode = "local"
      | .gateway.port = ($port | tonumber)
      | .gateway.bind = "loopback"
      | del(.gateway.remote)
      | .gateway.controlUi = (.gateway.controlUi // {})
      | .gateway.controlUi.enabled = true
      | .gateway.controlUi.allowInsecureAuth = true
      | .gateway.controlUi.allowedOrigins = [
          "http://127.0.0.1:\($port)",
          "http://localhost:\($port)"
        ]
      | .gateway.auth = (.gateway.auth // {})
      | .gateway.auth.mode = (.gateway.auth.mode // "token")
      | if .gateway.auth.mode == "token" and (.gateway.auth.token | type) == "null" then
          .gateway.auth.token = {
            "source": "env",
            "provider": "default",
            "id": "OPENCLAW_GATEWAY_TOKEN"
          }
        else
          .
        end
      | .gateway.tailscale = (.gateway.tailscale // {})
      | .gateway.tailscale.mode = "off"
      | .gateway.tailscale.resetOnExit = false
      | .gateway.channelHealthCheckMinutes = 0
      | .agents = (.agents // {})
      | .agents.defaults = (.agents.defaults // {})
      | .agents.defaults.workspace = $workspace_dir
      | .agents.defaults.skipBootstrap = true
      | .agents.defaults.sandbox = (.agents.defaults.sandbox // {})
      | .agents.defaults.sandbox.docker = (.agents.defaults.sandbox.docker // {})
      | .agents.defaults.sandbox.docker.binds = [
          "\($state_dir):\($state_dir):rw"
        ]
      | .cron = (.cron // {})
      | .cron.enabled = false
      | .discovery = (.discovery // {})
      | .discovery.mdns = (.discovery.mdns // {})
      | .discovery.mdns.mode = "off"
      | .plugins = (.plugins // {})
      | .plugins.enabled = true
      | .plugins.allow = (
          (.plugins.allow // [])
          | map(select(. != "telegram" and . != "openviking"))
        )
      | .plugins.deny = (
          ((.plugins.deny // []) + ["telegram"])
          | unique
        )
      | .plugins.entries = (
          (.plugins.entries // {})
          | del(.telegram, .openviking)
        )
      | .plugins.slots = (
          (.plugins.slots // {})
          | del(.contextEngine)
        )
      | .channels = {}
    ' \
    "$SOURCE_CONFIG_PATH" >"$tmp_config"
else
  jq -n \
    --arg state_dir "$REVIEW_STATE_DIR" \
    --arg workspace_dir "$REVIEW_WORKSPACE_DIR" \
    --arg port "$REVIEW_PORT" \
    '
      {
        gateway: {
          mode: "local",
          port: ($port | tonumber),
          bind: "loopback",
          auth: {
            mode: "token",
            token: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_GATEWAY_TOKEN"
            }
          },
          controlUi: {
            enabled: true,
            allowInsecureAuth: true,
            allowedOrigins: [
              "http://127.0.0.1:\($port)",
              "http://localhost:\($port)"
            ]
          },
          tailscale: {
            mode: "off",
            resetOnExit: false
          },
          channelHealthCheckMinutes: 0
        },
        agents: {
          defaults: {
            workspace: $workspace_dir,
            skipBootstrap: true,
            sandbox: {
              docker: {
                binds: [
                  "\($state_dir):\($state_dir):rw"
                ]
              }
            }
          }
        },
        cron: {
          enabled: false
        },
        plugins: {
          enabled: true,
          deny: ["telegram"]
        },
        discovery: {
          mdns: {
            mode: "off"
          }
        },
        channels: {}
      }
    ' >"$tmp_config"
fi

mv "$tmp_config" "$REVIEW_CONFIG_PATH"
chmod 600 "$REVIEW_CONFIG_PATH"

echo "Synced review config: $REVIEW_CONFIG_PATH"
