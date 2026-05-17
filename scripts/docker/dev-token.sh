#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ -z "${OPENCLAW_CONFIG_PATH:-}" ]]; then
  echo "Run this inside the docker-compose.dev.yml openclaw-dev service." >&2
  exit 1
fi

node - "$OPENCLAW_CONFIG_PATH" <<'NODE'
const fs = require("node:fs");

const configPath = process.argv[2];
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  console.error(
    `Could not read OpenClaw config at ${configPath}. Run scripts/docker/dev-setup.sh first.`,
  );
  process.exit(1);
}

const token = cfg?.gateway?.auth?.token;
if (typeof token !== "string" || token.trim().length === 0) {
  console.error(
    `No plaintext gateway auth token was found in ${configPath}. Run scripts/docker/dev-setup.sh first.`,
  );
  process.exit(1);
}

process.stdout.write(`${token.trim()}\n`);
NODE
