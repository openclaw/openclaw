#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
SERVICE_TEMPLATE="${SCRIPT_DIR}/systemd/openclaw-qdrant-workspace-reconcile.service"
TIMER_TEMPLATE="${SCRIPT_DIR}/systemd/openclaw-qdrant-workspace-reconcile.timer"
SERVICE_TARGET="${SYSTEMD_USER_DIR}/openclaw-qdrant-workspace-reconcile.service"
TIMER_TARGET="${SYSTEMD_USER_DIR}/openclaw-qdrant-workspace-reconcile.timer"
GATEWAY_CONTAINER_NAME="${OPENCLAW_QDRANT_GATEWAY_CONTAINER:-openclaw-openclaw-gateway-1}"

require_command() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "Missing required command: $1" >&2
        exit 1
    }
}

ensure_linger_enabled() {
    local linger

    linger="$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)"
    if [[ "${linger}" != "yes" ]]; then
        echo "User lingering is disabled for $(id -un)." >&2
        echo "Enable it for unattended user timers:" >&2
        echo "  sudo loginctl enable-linger $(id -un)" >&2
        exit 1
    fi
}

validate_repo_dir() {
    [[ -d "${REPO_DIR}" ]] || {
        echo "Repo directory not found: ${REPO_DIR}" >&2
        exit 1
    }

    [[ -f "${REPO_DIR}/docker-compose.yml" ]] || {
        echo "Expected docker-compose.yml in repo directory: ${REPO_DIR}" >&2
        exit 1
    }
}

validate_docker_access() {
    docker info >/dev/null 2>&1 || {
        echo "Docker daemon is not reachable for user $(id -un)." >&2
        exit 1
    }

    docker inspect "${GATEWAY_CONTAINER_NAME}" >/dev/null 2>&1 || {
        echo "Gateway container not found: ${GATEWAY_CONTAINER_NAME}" >&2
        exit 1
    }

    [[ "$(docker inspect --format '{{.State.Running}}' "${GATEWAY_CONTAINER_NAME}")" == "true" ]] || {
        echo "Gateway container is not running: ${GATEWAY_CONTAINER_NAME}" >&2
        exit 1
    }
}

escape_sed_replacement() {
    printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

install_service_template() {
    local escaped_repo_dir
    local escaped_container_name

    escaped_repo_dir="$(escape_sed_replacement "${REPO_DIR}")"
    escaped_container_name="$(escape_sed_replacement "${GATEWAY_CONTAINER_NAME}")"

    sed \
        -e "s|__OPENCLAW_REPO_DIR__|${escaped_repo_dir}|g" \
        -e "s|__OPENCLAW_GATEWAY_CONTAINER__|${escaped_container_name}|g" \
        "${SERVICE_TEMPLATE}" > "${SERVICE_TARGET}"
}

echo "Installing OpenClaw Qdrant workspace reconcile timer..."

require_command docker
require_command loginctl
require_command systemctl
validate_repo_dir
ensure_linger_enabled
validate_docker_access

mkdir -p "${SYSTEMD_USER_DIR}"
install_service_template
cp "${TIMER_TEMPLATE}" "${TIMER_TARGET}"

systemctl --user daemon-reload
systemctl --user enable --now openclaw-qdrant-workspace-reconcile.timer

echo
echo "OpenClaw Qdrant workspace reconcile timer installed."
echo "Repo dir: ${REPO_DIR}"
echo "Gateway container: ${GATEWAY_CONTAINER_NAME}"
echo "Status:"
echo "  systemctl --user status openclaw-qdrant-workspace-reconcile.timer"
echo "Logs:"
echo "  tail -f ${HOME}/.openclaw-qdrant-workspace-reconcile.log"
