#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCLAW_CMD="${SCRIPT_DIR}/bin/openclaw"
RUNTIME_DIR="${SCRIPT_DIR}/bin/runtime"

PLATFORM="${1:-}"
DATA_ROOT_INPUT="${2:-${SCRIPT_DIR}/data}"
CONFIG_ROOT_INPUT="${3:-${SCRIPT_DIR}/config}"

usage() {
  cat <<'USAGE'
Usage:
  verify-env.sh [platform] [data_root] [config_root]

platform:
  mac | wsl | win

Defaults:
  platform    = auto-detect (Darwin->mac, Linux->wsl)
  data_root   = ./deployment/data
  config_root = ./deployment/config
USAGE
}

if [[ "${PLATFORM}" == "-h" || "${PLATFORM}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -z "${PLATFORM}" ]]; then
  case "$(uname -s)" in
    Darwin) PLATFORM="mac" ;;
    Linux) PLATFORM="wsl" ;;
    *)
      echo "[error] unsupported OS: $(uname -s); pass platform explicitly (mac|wsl|win)." >&2
      exit 1
      ;;
  esac
fi

mkdir -p "${DATA_ROOT_INPUT}" "${CONFIG_ROOT_INPUT}"
DATA_ROOT="$(cd "${DATA_ROOT_INPUT}" && pwd)"
CONFIG_ROOT="$(cd "${CONFIG_ROOT_INPUT}" && pwd)"

case "${PLATFORM}" in
  mac)
    CONFIG_PATH="${CONFIG_ROOT}/openclaw-mac.json"
    STATE_DIR="${DATA_ROOT}/state-mac"
    ;;
  wsl)
    CONFIG_PATH="${CONFIG_ROOT}/openclaw-wsl.json"
    STATE_DIR="${DATA_ROOT}/state-wsl"
    ;;
  win)
    CONFIG_PATH="${CONFIG_ROOT}/openclaw-win.json"
    STATE_DIR="${DATA_ROOT}/state-win"
    ;;
  *)
    echo "[error] invalid platform: ${PLATFORM} (use mac|wsl|win)" >&2
    exit 1
    ;;
esac

CODEX_HOME_DIR="${DATA_ROOT}/codex-home"

if [[ ! -x "${OPENCLAW_CMD}" ]]; then
  echo "[error] missing launcher: ${OPENCLAW_CMD}" >&2
  exit 1
fi

resolve_node_bin() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *)
      echo ""
      return
      ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch="x86_64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *)
      echo ""
      return
      ;;
  esac
  local candidate="${SCRIPT_DIR}/bin/node-${os}-${arch}"
  if [[ -x "${candidate}" ]]; then
    echo "${candidate}"
    return
  fi
  echo ""
}

NODE_BIN="$(resolve_node_bin)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "[error] missing bundled node for this host; cannot verify JSON content." >&2
  exit 1
fi

export OPENCLAW_STATE_DIR="${STATE_DIR}"
export OPENCLAW_CONFIG_PATH="${CONFIG_PATH}"
export CODEX_HOME="${CODEX_HOME_DIR}"

pass_count=0
warn_count=0
fail_count=0

pass() {
  pass_count=$((pass_count + 1))
  echo "[pass] $*"
}

warn() {
  warn_count=$((warn_count + 1))
  echo "[warn] $*"
}

fail() {
  fail_count=$((fail_count + 1))
  echo "[fail] $*"
}

node_eval() {
  "${NODE_BIN}" -e "$1" "${@:2}"
}

if [[ -f "${RUNTIME_DIR}/openclaw.mjs" ]]; then
  pass "runtime entry found: ${RUNTIME_DIR}/openclaw.mjs"
else
  fail "runtime entry missing: ${RUNTIME_DIR}/openclaw.mjs"
fi

if [[ -f "${RUNTIME_DIR}/dist/entry.js" || -f "${RUNTIME_DIR}/dist/entry.mjs" ]]; then
  pass "runtime dist entry found (dist/entry.js or dist/entry.mjs)"
else
  fail "runtime dist entry missing: ${RUNTIME_DIR}/dist/entry.(m)js"
fi

if [[ -f "${RUNTIME_DIR}/dist/control-ui/index.html" ]]; then
  pass "control-ui assets found: ${RUNTIME_DIR}/dist/control-ui/index.html"
else
  fail "control-ui assets missing: ${RUNTIME_DIR}/dist/control-ui/index.html"
fi

if [[ -f "${RUNTIME_DIR}/docs/reference/templates/AGENTS.md" ]]; then
  pass "workspace template found: ${RUNTIME_DIR}/docs/reference/templates/AGENTS.md"
else
  fail "workspace template missing: ${RUNTIME_DIR}/docs/reference/templates/AGENTS.md"
fi

if [[ -d "${RUNTIME_DIR}/node_modules" ]]; then
  if [[ -f "${RUNTIME_DIR}/node_modules/chalk/package.json" ]]; then
    pass "runtime dependencies found: ${RUNTIME_DIR}/node_modules"
  else
    warn "runtime node_modules exists, but common dep missing (chalk); runtime may be incomplete"
  fi
else
  fail "runtime dependencies missing: ${RUNTIME_DIR}/node_modules"
fi

if [[ -f "${CONFIG_PATH}" ]]; then
  pass "config file found: ${CONFIG_PATH}"
else
  fail "config file missing: ${CONFIG_PATH}"
fi

if [[ -d "${STATE_DIR}" ]]; then
  pass "state dir found: ${STATE_DIR}"
else
  warn "state dir missing: ${STATE_DIR} (will be created on first run)"
fi

if [[ -f "${CODEX_HOME_DIR}/auth.json" ]]; then
  pass "codex auth found: ${CODEX_HOME_DIR}/auth.json"
else
  warn "codex auth missing: ${CODEX_HOME_DIR}/auth.json"
fi

if "${OPENCLAW_CMD}" config validate >/dev/null 2>&1; then
  pass "config validate passed"
else
  fail "config validate failed"
fi

gateway_auth_mode="$(node_eval '
const fs=require("fs");
const p=process.argv[1];
try{const c=JSON.parse(fs.readFileSync(p,"utf8"));process.stdout.write(String(c?.gateway?.auth?.mode ?? ""));}
catch{process.stdout.write("");}
' "${CONFIG_PATH}")"

if [[ -n "${gateway_auth_mode}" ]]; then
  pass "gateway.auth.mode=${gateway_auth_mode}"
else
  warn "gateway.auth.mode is unset"
fi

if [[ "${gateway_auth_mode}" == "token" ]]; then
  gateway_token="$(node_eval '
const fs=require("fs");
const p=process.argv[1];
try{const c=JSON.parse(fs.readFileSync(p,"utf8"));process.stdout.write(String(c?.gateway?.auth?.token ?? ""));}
catch{process.stdout.write("");}
' "${CONFIG_PATH}")"
  if [[ -n "${gateway_token}" ]]; then
    pass "gateway.auth.token exists"
  else
    warn "gateway.auth.mode=token but gateway.auth.token is empty (script may auto-generate on init/run)"
  fi
fi

model_primary="$(node_eval '
const fs=require("fs");
const p=process.argv[1];
try{const c=JSON.parse(fs.readFileSync(p,"utf8"));process.stdout.write(String(c?.agents?.defaults?.model?.primary ?? ""));}
catch{process.stdout.write("");}
' "${CONFIG_PATH}")"
if [[ -n "${model_primary}" ]]; then
  pass "agents.defaults.model.primary=${model_primary}"
else
  warn "agents.defaults.model.primary is unset"
fi

workspace_dir="$(node_eval '
const fs=require("fs");
const path=require("path");
const p=process.argv[1];
try{
  const c=JSON.parse(fs.readFileSync(p,"utf8"));
  const raw=typeof c?.agents?.defaults?.workspace === "string" ? c.agents.defaults.workspace.trim() : "";
  process.stdout.write(raw ? path.resolve(raw) : "");
}catch{
  process.stdout.write("");
}
' "${CONFIG_PATH}")"
if [[ -n "${workspace_dir}" ]]; then
  if [[ -d "${workspace_dir}" ]]; then
    pass "workspace dir found: ${workspace_dir}"
  else
    warn "workspace dir missing: ${workspace_dir}"
  fi
  for required_bootstrap in AGENTS.md SOUL.md USER.md TOOLS.md; do
    if [[ -f "${workspace_dir}/${required_bootstrap}" ]]; then
      pass "workspace bootstrap file found: ${workspace_dir}/${required_bootstrap}"
    else
      warn "workspace bootstrap file missing: ${workspace_dir}/${required_bootstrap}"
    fi
  done
  if [[ -f "${workspace_dir}/MEMORY.md" || -f "${workspace_dir}/memory.md" ]]; then
    pass "workspace memory file found (MEMORY.md or memory.md)"
  else
    warn "workspace memory file missing (MEMORY.md/memory.md)"
  fi
else
  warn "agents.defaults.workspace is unset"
fi

channels_count="$(node_eval '
const fs=require("fs");
const p=process.argv[1];
try{
  const c=JSON.parse(fs.readFileSync(p,"utf8"));
  const n=c?.channels && typeof c.channels==="object" ? Object.keys(c.channels).length : 0;
  process.stdout.write(String(n));
}catch{
  process.stdout.write("0");
}
' "${CONFIG_PATH}")"
if [[ "${channels_count}" -gt 0 ]]; then
  pass "channels configured count=${channels_count}"
else
  warn "no channels configured under config.channels"
fi

auth_profiles_path="${STATE_DIR}/agents/main/agent/auth-profiles.json"
if [[ -f "${auth_profiles_path}" ]]; then
  profiles_count="$(node_eval '
const fs=require("fs");
const p=process.argv[1];
try{
  const c=JSON.parse(fs.readFileSync(p,"utf8"));
  const n=c?.profiles && typeof c.profiles==="object" ? Object.keys(c.profiles).length : 0;
  process.stdout.write(String(n));
}catch{
  process.stdout.write("0");
}
' "${auth_profiles_path}")"
  if [[ "${profiles_count}" -gt 0 ]]; then
    pass "auth profiles found (${profiles_count}) at ${auth_profiles_path}"
  else
    warn "auth profiles file exists but no profiles: ${auth_profiles_path}"
  fi
else
  warn "auth profiles file missing: ${auth_profiles_path}"
fi

if [[ -f "${STATE_DIR}/credentials/oauth.json" ]]; then
  pass "oauth credentials found: ${STATE_DIR}/credentials/oauth.json"
else
  warn "oauth credentials file missing: ${STATE_DIR}/credentials/oauth.json"
fi

if "${OPENCLAW_CMD}" channels list >/dev/null 2>&1; then
  pass "channels list command succeeded"
else
  warn "channels list command failed (channel plugins/config may be incomplete)"
fi

template_ref_count="$(node_eval '
const fs=require("fs");
const p=process.argv[1];
let count=0;
function scan(value){
  if (typeof value === "string" && value.includes("${")) count += 1;
  else if (Array.isArray(value)) value.forEach(scan);
  else if (value && typeof value === "object") Object.values(value).forEach(scan);
}
try{
  const c=JSON.parse(fs.readFileSync(p,"utf8"));
  scan(c);
  process.stdout.write(String(count));
}catch{
  process.stdout.write("0");
}
' "${CONFIG_PATH}")"
if [[ "${template_ref_count}" -gt 0 ]]; then
  warn "config contains ${template_ref_count} env-template style placeholders (\${...})"
else
  pass "no unresolved template placeholders detected in config JSON strings"
fi

echo
echo "[summary] pass=${pass_count} warn=${warn_count} fail=${fail_count}"
echo "[paths] config=${CONFIG_PATH} state=${STATE_DIR} codex_home=${CODEX_HOME_DIR}"

if [[ "${fail_count}" -gt 0 ]]; then
  exit 1
fi
exit 0
