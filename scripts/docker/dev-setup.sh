#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ -z "${OPENCLAW_CONFIG_PATH:-}" || -z "${OPENCLAW_WORKSPACE_DIR:-}" ]]; then
  echo "Run this inside the docker-compose.dev.yml openclaw-dev service." >&2
  exit 1
fi

read_existing_gateway_token() {
  local config_path="$1"
  if [[ ! -f "$config_path" ]]; then
    return 0
  fi
  node - "$config_path" <<'NODE'
const fs = require("node:fs");
const configPath = process.argv[2];
try {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const token = cfg?.gateway?.auth?.token;
  if (typeof token === "string" && token.trim()) {
    process.stdout.write(token.trim());
  }
} catch {
  // Missing or partial config is repaired by config set below.
}
NODE
}

mkdir -p "$(dirname "$OPENCLAW_CONFIG_PATH")" "$OPENCLAW_WORKSPACE_DIR"

pnpm install --frozen-lockfile

GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"
if [[ -z "$GATEWAY_TOKEN" ]]; then
  GATEWAY_TOKEN="$(read_existing_gateway_token "$OPENCLAW_CONFIG_PATH")"
fi
if [[ -z "$GATEWAY_TOKEN" ]]; then
  GATEWAY_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
fi

CONFIG_BATCH="$(mktemp)"
trap 'rm -f "$CONFIG_BATCH"' EXIT
node - "$CONFIG_BATCH" "$GATEWAY_TOKEN" <<'NODE'
const fs = require("node:fs");
const [batchPath, gatewayToken] = process.argv.slice(2);
fs.writeFileSync(
  batchPath,
  JSON.stringify(
    [
      { path: "gateway.mode", value: "local" },
      { path: "gateway.bind", value: "lan" },
      { path: "gateway.port", value: 18789 },
      { path: "gateway.auth.mode", value: "token" },
      { path: "gateway.auth.token", value: gatewayToken },
      {
        path: "gateway.controlUi.allowedOrigins",
        value: [
          "http://localhost:18789",
          "http://127.0.0.1:18789",
          "http://localhost:5173",
          "http://127.0.0.1:5173",
        ],
      },
    ],
    null,
    2,
  ),
);
NODE

pnpm openclaw config set --batch-file "$CONFIG_BATCH"

cat <<'EOF'
OpenClaw dev container is ready.

Start the foreground gateway watcher with:
  docker compose -f docker-compose.dev.yml run --rm --service-ports openclaw-dev pnpm gateway:watch:raw
EOF
