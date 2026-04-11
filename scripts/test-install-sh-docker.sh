#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./docker/install-sh-common/version-parse.sh
source "$ROOT_DIR/scripts/docker/install-sh-common/version-parse.sh"

SMOKE_IMAGE="${OPENCLAW_INSTALL_SMOKE_IMAGE:-openclaw-install-smoke:local}"
NONROOT_IMAGE="${OPENCLAW_INSTALL_NONROOT_IMAGE:-openclaw-install-nonroot:local}"
SMOKE_PLATFORM="${OPENCLAW_INSTALL_SMOKE_PLATFORM:-linux/amd64}"
NONROOT_PLATFORM="${OPENCLAW_INSTALL_NONROOT_PLATFORM:-$SMOKE_PLATFORM}"
INSTALL_URL="${OPENCLAW_INSTALL_URL:-https://openclaw.bot/install.sh}"
CLI_INSTALL_URL="${OPENCLAW_INSTALL_CLI_URL:-https://openclaw.bot/install-cli.sh}"
PACKAGE_NAME="${OPENCLAW_INSTALL_PACKAGE:-openclaw}"
SKIP_NONROOT="${OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT:-0}"
SKIP_SMOKE_IMAGE_BUILD="${OPENCLAW_INSTALL_SMOKE_SKIP_IMAGE_BUILD:-0}"
SKIP_NONROOT_IMAGE_BUILD="${OPENCLAW_INSTALL_NONROOT_SKIP_IMAGE_BUILD:-0}"
SKIP_UPDATE="${OPENCLAW_INSTALL_SMOKE_SKIP_UPDATE:-0}"
UPDATE_BASELINE_VERSION="${OPENCLAW_INSTALL_SMOKE_UPDATE_BASELINE:-2026.4.10}"
UPDATE_PACKAGE_SPEC="${OPENCLAW_INSTALL_SMOKE_UPDATE_PACKAGE_SPEC:-}"
UPDATE_SKIP_LOCAL_BUILD="${OPENCLAW_INSTALL_SMOKE_UPDATE_SKIP_LOCAL_BUILD:-0}"
UPDATE_HOST_ALIAS="${OPENCLAW_INSTALL_SMOKE_UPDATE_HOST:-host.docker.internal}"
UPDATE_PORT="${OPENCLAW_INSTALL_SMOKE_UPDATE_PORT:-}"
LATEST_DIR="$(mktemp -d)"
LATEST_FILE="${LATEST_DIR}/latest"
UPDATE_DIR="$(mktemp -d)"
UPDATE_SERVER_PID=""
UPDATE_SERVER_LOG="${UPDATE_DIR}/http.log"
UPDATE_TGZ_FILE=""
UPDATE_EXPECT_VERSION=""
UPDATE_TAG_URL=""
UPDATE_DOCKER_HOST_ARGS=()

cleanup() {
  if [[ -n "$UPDATE_SERVER_PID" ]]; then
    kill "$UPDATE_SERVER_PID" >/dev/null 2>&1 || true
    wait "$UPDATE_SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$LATEST_DIR" "$UPDATE_DIR"
}

trap cleanup EXIT

allocate_host_port() {
  node -e '
    const net = require("node:net");
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        process.exit(1);
      }
      process.stdout.write(String(address.port));
      server.close();
    });
  '
}

prepare_update_tarball() {
  local pack_json
  if [[ -n "$UPDATE_PACKAGE_SPEC" ]]; then
    echo "==> Pack update tgz from spec: $UPDATE_PACKAGE_SPEC"
    if [[ -z "$UPDATE_EXPECT_VERSION" ]]; then
      echo "ERROR: OPENCLAW_INSTALL_SMOKE_UPDATE_EXPECT_VERSION is required with OPENCLAW_INSTALL_SMOKE_UPDATE_PACKAGE_SPEC" >&2
      exit 1
    fi
    pack_json="$(
      quiet_npm pack "$UPDATE_PACKAGE_SPEC" --json --pack-destination "$UPDATE_DIR"
    )"
  else
    echo "==> Build local release artifacts for update smoke"
    if [[ "$UPDATE_SKIP_LOCAL_BUILD" != "1" ]]; then
      pnpm build
      pnpm ui:build
    fi
    UPDATE_EXPECT_VERSION="$(
      node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version'
    )"
    pack_json="$(
      quiet_npm pack --ignore-scripts --json --pack-destination "$UPDATE_DIR"
    )"
  fi
  UPDATE_TGZ_FILE="$(
    PACK_JSON="$pack_json" node - <<'NODE'
const raw = process.env.PACK_JSON || "[]";
const parsed = JSON.parse(raw);
const last = Array.isArray(parsed) ? parsed.at(-1) : null;
if (!last || typeof last.filename !== "string" || last.filename.length === 0) {
  process.exit(1);
}
process.stdout.write(last.filename);
NODE
  )"
}

prepare_update_host_access() {
  local host_os
  host_os="$(uname -s)"
  UPDATE_DOCKER_HOST_ARGS=()
  if [[ "$host_os" == "Linux" ]]; then
    UPDATE_DOCKER_HOST_ARGS=(--add-host "${UPDATE_HOST_ALIAS}:host-gateway")
  fi
}

start_update_server() {
  if [[ -z "$UPDATE_PORT" ]]; then
    UPDATE_PORT="$(allocate_host_port)"
  fi
  UPDATE_TAG_URL="http://${UPDATE_HOST_ALIAS}:${UPDATE_PORT}/${UPDATE_TGZ_FILE}"
  echo "==> Serve update tgz: $UPDATE_TAG_URL"
  (
    cd "$UPDATE_DIR"
    exec python3 -m http.server "$UPDATE_PORT" --bind 0.0.0.0
  ) >"$UPDATE_SERVER_LOG" 2>&1 &
  UPDATE_SERVER_PID=$!
  sleep 1
  if ! kill -0 "$UPDATE_SERVER_PID" >/dev/null 2>&1; then
    echo "ERROR: failed to start update tgz server" >&2
    tail -n 50 "$UPDATE_SERVER_LOG" >&2 || true
    exit 1
  fi
}

if [[ "$SKIP_SMOKE_IMAGE_BUILD" == "1" ]]; then
  echo "==> Reuse prebuilt smoke image: $SMOKE_IMAGE"
else
  echo "==> Build smoke image (upgrade, root): $SMOKE_IMAGE"
  docker build \
    --platform "$SMOKE_PLATFORM" \
    -t "$SMOKE_IMAGE" \
    -f "$ROOT_DIR/scripts/docker/install-sh-smoke/Dockerfile" \
    "$ROOT_DIR/scripts/docker"
fi

echo "==> Run installer smoke test (root): $INSTALL_URL"
docker run --rm -t \
  --platform "$SMOKE_PLATFORM" \
  -v "${LATEST_DIR}:/out" \
  -e OPENCLAW_INSTALL_URL="$INSTALL_URL" \
  -e OPENCLAW_INSTALL_PACKAGE="$PACKAGE_NAME" \
  -e OPENCLAW_INSTALL_METHOD=npm \
  -e OPENCLAW_INSTALL_LATEST_OUT="/out/latest" \
  -e OPENCLAW_INSTALL_SMOKE_PREVIOUS="${OPENCLAW_INSTALL_SMOKE_PREVIOUS:-}" \
  -e OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS="${OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS:-0}" \
  -e OPENCLAW_NO_ONBOARD=1 \
  -e OPENCLAW_NO_PROMPT=1 \
  -e DEBIAN_FRONTEND=noninteractive \
  "$SMOKE_IMAGE"

LATEST_VERSION=""
if [[ -f "$LATEST_FILE" ]]; then
  LATEST_VERSION="$(cat "$LATEST_FILE")"
fi

if [[ "$SKIP_UPDATE" == "1" ]]; then
  echo "==> Skip update smoke (OPENCLAW_INSTALL_SMOKE_SKIP_UPDATE=1)"
else
  prepare_update_tarball
  prepare_update_host_access
  start_update_server

  echo "==> Run update smoke (${UPDATE_BASELINE_VERSION} -> ${UPDATE_EXPECT_VERSION})"
  docker run --rm -t \
    --platform "$SMOKE_PLATFORM" \
    "${UPDATE_DOCKER_HOST_ARGS[@]}" \
    -e OPENCLAW_INSTALL_PACKAGE="$PACKAGE_NAME" \
    -e OPENCLAW_INSTALL_SMOKE_MODE=update \
    -e OPENCLAW_INSTALL_UPDATE_BASELINE="$UPDATE_BASELINE_VERSION" \
    -e OPENCLAW_INSTALL_UPDATE_EXPECT_VERSION="$UPDATE_EXPECT_VERSION" \
    -e OPENCLAW_INSTALL_UPDATE_TAG_URL="$UPDATE_TAG_URL" \
    -e OPENCLAW_NO_ONBOARD=1 \
    -e OPENCLAW_NO_PROMPT=1 \
    -e DEBIAN_FRONTEND=noninteractive \
    "$SMOKE_IMAGE"
fi

if [[ "$SKIP_NONROOT" == "1" ]]; then
  echo "==> Skip non-root installer smoke (OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1)"
else
  if [[ "$SKIP_NONROOT_IMAGE_BUILD" == "1" ]]; then
    echo "==> Reuse prebuilt non-root image: $NONROOT_IMAGE"
  else
    echo "==> Build non-root image: $NONROOT_IMAGE"
    docker build \
      --platform "$NONROOT_PLATFORM" \
      -t "$NONROOT_IMAGE" \
      -f "$ROOT_DIR/scripts/docker/install-sh-nonroot/Dockerfile" \
      "$ROOT_DIR/scripts/docker"
  fi

  echo "==> Run installer non-root test: $INSTALL_URL"
  docker run --rm -t \
    --platform "$NONROOT_PLATFORM" \
    -e OPENCLAW_INSTALL_URL="$INSTALL_URL" \
    -e OPENCLAW_INSTALL_PACKAGE="$PACKAGE_NAME" \
    -e OPENCLAW_INSTALL_METHOD=npm \
    -e OPENCLAW_INSTALL_EXPECT_VERSION="$LATEST_VERSION" \
    -e OPENCLAW_NO_ONBOARD=1 \
    -e OPENCLAW_NO_PROMPT=1 \
    -e DEBIAN_FRONTEND=noninteractive \
    "$NONROOT_IMAGE"
fi

if [[ "${OPENCLAW_INSTALL_SMOKE_SKIP_CLI:-0}" == "1" ]]; then
  echo "==> Skip CLI installer smoke (OPENCLAW_INSTALL_SMOKE_SKIP_CLI=1)"
  exit 0
fi

if [[ "$SKIP_NONROOT" == "1" ]]; then
  echo "==> Skip CLI installer smoke (non-root image skipped)"
  exit 0
fi

echo "==> Run CLI installer non-root test (same image)"
docker run --rm -t \
  --platform "$NONROOT_PLATFORM" \
  --entrypoint /bin/bash \
  -e OPENCLAW_INSTALL_URL="$INSTALL_URL" \
  -e OPENCLAW_INSTALL_CLI_URL="$CLI_INSTALL_URL" \
  -e OPENCLAW_NO_ONBOARD=1 \
  -e OPENCLAW_NO_PROMPT=1 \
  -e DEBIAN_FRONTEND=noninteractive \
  "$NONROOT_IMAGE" -lc "curl -fsSL \"$CLI_INSTALL_URL\" | bash -s -- --set-npm-prefix --no-onboard"
