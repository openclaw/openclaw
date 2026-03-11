#!/usr/bin/env bash
set -euo pipefail

# Derived from current machine config:
# - gateway.mode=local
# - gateway.port=18789
# - gateway.bind=loopback
# - gateway.auth.mode=token
# - agents.defaults.model.primary=openai-codex/gpt-5.4

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ACTION="${1:-run}"
DEFAULT_ROOT="${SCRIPT_DIR}/data"
USB_ROOT_INPUT="${2:-${OPENCLAW_USB_ROOT:-${DEFAULT_ROOT}}}"
CONFIG_ROOT_INPUT="${OPENCLAW_CONFIG_ROOT:-${SCRIPT_DIR}/config}"

usage() {
  cat <<'USAGE'
Usage:
  usb-openclaw-wsl.sh <init|run|status> [data_root_path]

Examples:
  ./deployment/usb-openclaw-wsl.sh init
  ./deployment/usb-openclaw-wsl.sh run
USAGE
}

mkdir -p "${USB_ROOT_INPUT}"
USB_ROOT="$(cd "${USB_ROOT_INPUT}" && pwd)"
mkdir -p "${CONFIG_ROOT_INPUT}"
CONFIG_ROOT="$(cd "${CONFIG_ROOT_INPUT}" && pwd)"

LOCAL_OPENCLAW="${SCRIPT_DIR}/bin/openclaw"
if [[ ! -x "${LOCAL_OPENCLAW}" ]]; then
  echo "[error] missing local launcher: ${LOCAL_OPENCLAW}" >&2
  exit 1
fi

resolve_node_bin() {
  local arch node_bin
  case "$(uname -m)" in
    x86_64 | amd64) arch="x86_64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *)
      echo ""
      return
      ;;
  esac
  node_bin="${SCRIPT_DIR}/bin/node-linux-${arch}"
  if [[ -x "${node_bin}" ]]; then
    echo "${node_bin}"
    return
  fi
  echo ""
}

NODE_BIN="$(resolve_node_bin)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "[error] missing bundled node: deployment/bin/node-linux-$(uname -m)" >&2
  echo "[hint] add Linux Node 22+ binary to deployment/bin before running in WSL." >&2
  exit 1
fi

oc() {
  "${LOCAL_OPENCLAW}" "$@"
}

STATE_DIR="${USB_ROOT}/state-wsl"
CONFIG_PATH="${CONFIG_ROOT}/openclaw-wsl.json"
WORKSPACE_DIR="${USB_ROOT}/workspace"
CODEX_HOME_DIR="${USB_ROOT}/codex-home"

mkdir -p "${STATE_DIR}" "${WORKSPACE_DIR}" "${CODEX_HOME_DIR}"

export OPENCLAW_STATE_DIR="${STATE_DIR}"
export OPENCLAW_CONFIG_PATH="${CONFIG_PATH}"
export CODEX_HOME="${CODEX_HOME_DIR}"

node_eval() {
  "${NODE_BIN}" -e "$1" "${@:2}"
}

read_gateway_token() {
  node_eval '
const fs=require("fs");
const [configPath]=process.argv.slice(1);
try{
  const cfg=JSON.parse(fs.readFileSync(configPath,"utf8"));
  const token=cfg?.gateway?.auth?.token;
  process.stdout.write(typeof token==="string" ? token : "");
}catch{
  process.stdout.write("");
}' "${CONFIG_PATH}"
}

generate_token() {
  node_eval 'console.log(require("crypto").randomBytes(24).toString("hex"))'
}

ensure_gateway_token() {
  local has_token
  has_token="$(node_eval 'const fs=require("fs");const p=process.argv[1];try{const c=JSON.parse(fs.readFileSync(p,"utf8"));const t=c?.gateway?.auth?.token;process.stdout.write(t?"1":"0")}catch{process.stdout.write("0")}' "${CONFIG_PATH}")"
  if [[ "${has_token}" != "1" ]]; then
    local token
    token="$(generate_token)"
    oc config set gateway.auth.token "${token}" >/dev/null
    echo "[init] generated gateway.auth.token in ${CONFIG_PATH}"
  fi
  local resolved_token
  resolved_token="$(read_gateway_token)"
  if [[ -n "${resolved_token}" ]]; then
    export OPENCLAW_GATEWAY_TOKEN="${resolved_token}"
  fi
}

config_value_present() {
  local key="$1"
  node_eval '
const fs=require("fs");
const [configPath,key]=process.argv.slice(1);
try{
  const cfg=JSON.parse(fs.readFileSync(configPath,"utf8"));
  const value=key.split(".").reduce((acc,part)=>acc&&typeof acc==="object"?acc[part]:undefined,cfg);
  process.stdout.write(value === undefined || value === null || String(value) === "" ? "0" : "1");
}catch{
  process.stdout.write("0");
}' "${CONFIG_PATH}" "${key}"
}

set_config_default() {
  local key="$1"
  local value="$2"
  local present
  present="$(config_value_present "${key}")"
  if [[ "${present}" != "1" ]]; then
    oc config set "${key}" "${value}" >/dev/null
  fi
}

print_config_value() {
  local key="$1"
  local value
  value="$(oc config get "${key}" 2>/dev/null | tail -n 1 || true)"
  if [[ -z "${value}" ]]; then
    echo "(unset)"
    return
  fi
  echo "${value}"
}

apply_base_config() {
  set_config_default gateway.mode local
  set_config_default gateway.port 18789
  set_config_default gateway.bind loopback
  set_config_default gateway.auth.mode token
  set_config_default agents.defaults.workspace "${WORKSPACE_DIR}"
  set_config_default agents.defaults.model.primary openai-codex/gpt-5.4
  ensure_gateway_token
}

print_status() {
  echo "OPENCLAW_CONFIG_ROOT=${CONFIG_ROOT}"
  echo "OPENCLAW_STATE_DIR=${OPENCLAW_STATE_DIR}"
  echo "OPENCLAW_CONFIG_PATH=${OPENCLAW_CONFIG_PATH}"
  echo "CODEX_HOME=${CODEX_HOME}"
  echo "OPENCLAW_CMD=${LOCAL_OPENCLAW}"
  print_config_value gateway.mode
  print_config_value gateway.port
  print_config_value gateway.bind
  print_config_value gateway.auth.mode
  print_config_value agents.defaults.workspace
  print_config_value agents.defaults.model.primary
}

case "${ACTION}" in
  init)
    apply_base_config
    print_status
    ;;
  run)
    apply_base_config
    print_status
    oc gateway run
    ;;
  status)
    print_status
    ;;
  *)
    usage
    exit 1
    ;;
esac
