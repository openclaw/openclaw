#!/usr/bin/env bash
set -euo pipefail

# OpenClaw Rust — Linux ARM64 (aarch64) / x86_64 installer.
#
# Mirrors the official install contract where this build can honor it:
#   * state and config live under OPENCLAW_STATE_DIR / OPENCLAW_CONFIG_PATH
#   * the gateway token comes from OPENCLAW_GATEWAY_TOKEN, never a literal file
#   * service installation is delegated to `openclaw gateway install`, the same
#     owner the official installer uses, instead of a hand-written unit
#
# Usage:
#   ./install-linux-arm64.sh [--prefix <dir>] [--state-dir <dir>] [--user] [--dry-run]

PREFIX="/usr/local"
STATE_DIR="${OPENCLAW_STATE_DIR:-${HOME}/.openclaw}"
SERVICE_USER=0
DRY_RUN=0

while [ $# -gt 0 ]; do
    case "$1" in
        --prefix) PREFIX="${2:?--prefix needs a value}"; shift 2 ;;
        --state-dir) STATE_DIR="${2:?--state-dir needs a value}"; shift 2 ;;
        --user) SERVICE_USER=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help)
            sed -n '2,15p' "$0"
            exit 0
            ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

ARCH="$(uname -m)"
case "$ARCH" in
    aarch64|arm64) ;;
    x86_64|amd64) ;;
    *) echo "unsupported architecture: ${ARCH} (need aarch64 or x86_64)" >&2; exit 1 ;;
esac
echo "==> Detected architecture: ${ARCH}"

run() {
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "    [dry-run] $*"
    else
        "$@"
    fi
}

if ! command -v cargo >/dev/null 2>&1; then
    echo "==> Installing Rust toolchain..."
    run sh -c "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"
    # shellcheck disable=SC1091
    [ -f "${HOME}/.cargo/env" ] && . "${HOME}/.cargo/env"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

echo "==> Building release binaries (native ${ARCH})..."
run cargo build --release --locked -p openclaw-cli -p openclaw-node-host

echo "==> Installing binaries to ${PREFIX}/bin..."
run install -d "${PREFIX}/bin"
run install -m 0755 target/release/openclaw "${PREFIX}/bin/openclaw"
run install -m 0755 target/release/openclaw-node "${PREFIX}/bin/openclaw-node"

# Skills stay beside the binary so discovery works without a checkout.
SHARE_DIR="${PREFIX}/share/openclaw"
run install -d "${SHARE_DIR}"
if [ -d "../skills" ]; then
    run cp -r ../skills "${SHARE_DIR}/"
fi
if [ -d "../custodian-skills" ]; then
    run cp -r ../custodian-skills "${SHARE_DIR}/"
fi

echo "==> Preparing state directory ${STATE_DIR}..."
run install -d "${STATE_DIR}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${STATE_DIR}/openclaw.json}"

# The official installer runs onboarding, which generates the gateway token.
# Doing it through the CLI keeps one owner for the config shape.
if [ ! -f "${CONFIG_PATH}" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "    [dry-run] ${PREFIX}/bin/openclaw onboard"
    else
        OPENCLAW_STATE_DIR="${STATE_DIR}" "${PREFIX}/bin/openclaw" onboard
    fi
fi

if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
    echo ""
    echo "!! OPENCLAW_GATEWAY_TOKEN is not set in this shell."
    echo "   A non-loopback Gateway will refuse to start without it. Export the"
    echo "   token printed by onboarding before installing the service, e.g.:"
    echo "     export OPENCLAW_GATEWAY_TOKEN=\"\$(...)\""
fi

echo "==> Installing the Gateway service..."
if [ "$DRY_RUN" -eq 1 ]; then
    echo "    [dry-run] ${PREFIX}/bin/openclaw gateway install $([ "$SERVICE_USER" -eq 1 ] && echo --user)"
elif [ "$SERVICE_USER" -eq 1 ]; then
    "${PREFIX}/bin/openclaw" gateway install --user
else
    sudo -E "${PREFIX}/bin/openclaw" gateway install
fi

echo ""
echo "==> Done."
echo "   Config  : ${CONFIG_PATH}"
echo "   State   : ${STATE_DIR}"
echo "   Gateway : ws://127.0.0.1:18789 (set gateway.listen for remote access)"
echo "   Control : http://127.0.0.1:18790/"
echo "   Logs    : openclaw gateway status"
