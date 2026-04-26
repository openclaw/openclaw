#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-update-channel-switch-e2e" OPENCLAW_UPDATE_CHANNEL_SWITCH_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_UPDATE_CHANNEL_SWITCH_E2E_SKIP_BUILD:-0}"

docker_e2e_build_or_reuse "$IMAGE_NAME" update-channel-switch "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "" "$SKIP_BUILD"

echo "Running update channel switch E2E..."
docker run --rm \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENCLAW_SKIP_CHANNELS=1 \
  -e OPENCLAW_SKIP_PROVIDERS=1 \
  "$IMAGE_NAME" \
  bash -lc 'set -euo pipefail

export npm_config_loglevel=error
export npm_config_fund=false
export npm_config_audit=false
export npm_config_prefix=/tmp/npm-prefix
export NPM_CONFIG_PREFIX=/tmp/npm-prefix
export PNPM_HOME=/tmp/pnpm-home
export PATH="/tmp/npm-prefix/bin:/tmp/pnpm-home:$PATH"
export CI=true
export OPENCLAW_DISABLE_BUNDLED_PLUGINS=1
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_NO_PROMPT=1

cat > /app/.gitignore <<'"'"'GITIGNORE'"'"'
node_modules
**/node_modules/
dist
dist-runtime
.turbo
coverage
GITIGNORE

node --import tsx scripts/write-package-dist-inventory.ts

git config --global user.email "docker-e2e@openclaw.local"
git config --global user.name "OpenClaw Docker E2E"
git config --global gc.auto 0
git -C /app init -q
git -C /app config gc.auto 0
git -C /app add -A
git -C /app commit -qm "test fixture"
fixture_sha="$(git -C /app rev-parse HEAD)"

pkg_tgz="$(npm pack --ignore-scripts --silent --pack-destination /tmp /app | tail -n 1 | tr -d "\r")"
pkg_tgz_path="/tmp/$pkg_tgz"
if [ ! -f "$pkg_tgz_path" ]; then
  echo "npm pack failed (expected $pkg_tgz_path)"
  exit 1
fi

npm install -g --prefix /tmp/npm-prefix --omit=optional "$pkg_tgz_path"

home_dir="$(mktemp -d /tmp/openclaw-update-channel-switch-home.XXXXXX)"
export HOME="$home_dir"
mkdir -p "$HOME/.openclaw"
cat > "$HOME/.openclaw/openclaw.json" <<'"'"'JSON'"'"'
{
  "update": {
    "channel": "stable"
  },
  "plugins": {}
}
JSON

export OPENCLAW_GIT_DIR=/app
export OPENCLAW_UPDATE_DEV_TARGET_REF="$fixture_sha"

echo "==> package -> git dev channel"
set +e
dev_json="$(openclaw update --channel dev --yes --json --no-restart)"
dev_status=$?
set -e
printf "%s\n" "$dev_json"
if [ "$dev_status" -ne 0 ]; then
  exit "$dev_status"
fi
DEV_JSON="$dev_json" node - <<'"'"'NODE'"'"'
const payload = JSON.parse(process.env.DEV_JSON);
if (payload.status !== "ok") {
  throw new Error(`expected dev update status ok, got ${payload.status}`);
}
if (payload.mode !== "git") {
  throw new Error(`expected dev update mode git, got ${payload.mode}`);
}
if (payload.postUpdate?.plugins?.status !== "ok") {
  throw new Error(`expected plugin post-update ok, got ${JSON.stringify(payload.postUpdate?.plugins)}`);
}
NODE

node - <<'"'"'NODE'"'"'
const fs = require("node:fs");
const path = require("node:path");
const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (config.update?.channel !== "dev") {
  throw new Error(`expected persisted update.channel dev, got ${JSON.stringify(config.update?.channel)}`);
}
NODE

status_json="$(openclaw update status --json)"
printf "%s\n" "$status_json"
STATUS_JSON="$status_json" node - <<'"'"'NODE'"'"'
const payload = JSON.parse(process.env.STATUS_JSON);
if (payload.update?.installKind !== "git") {
  throw new Error(`expected git install after dev switch, got ${payload.update?.installKind}`);
}
if (payload.channel?.value !== "dev" || payload.channel?.source !== "config") {
  throw new Error(`expected dev config channel after dev switch, got ${JSON.stringify(payload.channel)}`);
}
NODE

echo "==> git -> package stable channel"
set +e
stable_json="$(openclaw update --channel stable --tag "$pkg_tgz_path" --yes --json --no-restart)"
stable_status=$?
set -e
printf "%s\n" "$stable_json"
if [ "$stable_status" -ne 0 ]; then
  exit "$stable_status"
fi
STABLE_JSON="$stable_json" node - <<'"'"'NODE'"'"'
const payload = JSON.parse(process.env.STABLE_JSON);
if (payload.status !== "ok") {
  throw new Error(`expected stable update status ok, got ${payload.status}`);
}
if (!["npm", "pnpm", "bun"].includes(payload.mode)) {
  throw new Error(`expected package-manager mode after stable switch, got ${payload.mode}`);
}
if (payload.postUpdate?.plugins?.status !== "ok") {
  throw new Error(`expected plugin post-update ok, got ${JSON.stringify(payload.postUpdate?.plugins)}`);
}
NODE

node - <<'"'"'NODE'"'"'
const fs = require("node:fs");
const path = require("node:path");
const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (config.update?.channel !== "stable") {
  throw new Error(`expected persisted update.channel stable, got ${JSON.stringify(config.update?.channel)}`);
}
NODE

status_json="$(openclaw update status --json)"
printf "%s\n" "$status_json"
STATUS_JSON="$status_json" node - <<'"'"'NODE'"'"'
const payload = JSON.parse(process.env.STATUS_JSON);
if (payload.update?.installKind !== "package") {
  throw new Error(`expected package install after stable switch, got ${payload.update?.installKind}`);
}
if (payload.channel?.value !== "stable" || payload.channel?.source !== "config") {
  throw new Error(`expected stable config channel after stable switch, got ${JSON.stringify(payload.channel)}`);
}
NODE

echo "OK"
'
