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
EXTRA_ARG="${3:-}"
OPEN_DASHBOARD_ON_RUN=false
CONFIG_ROOT_INPUT="${OPENCLAW_CONFIG_ROOT:-${SCRIPT_DIR}/config}"
SOURCE_CODEX_HOME="${OPENCLAW_SOURCE_CODEX_HOME:-$HOME/.codex}"
OPENCLAW_AUTO_CODEX_RELOGIN="${OPENCLAW_AUTO_CODEX_RELOGIN:-1}"
OPENCLAW_CODEX_SOURCE_SYNC_MODE="${OPENCLAW_CODEX_SOURCE_SYNC_MODE:-if-missing}"

usage() {
  cat <<'USAGE'
Usage:
  usb-openclaw-mac.sh <init|run|status|dashboard> [data_root_path] [dashboard]

Examples:
  ./deployment/usb-openclaw-mac.sh init
  ./deployment/usb-openclaw-mac.sh run
  ./deployment/usb-openclaw-mac.sh run ./deployment/data dashboard
  ./deployment/usb-openclaw-mac.sh dashboard
USAGE
}

if [[ "${ACTION}" == "run" ]]; then
  if [[ "${USB_ROOT_INPUT}" == "dashboard" ]]; then
    USB_ROOT_INPUT="${OPENCLAW_USB_ROOT:-${DEFAULT_ROOT}}"
    OPEN_DASHBOARD_ON_RUN=true
  elif [[ "${EXTRA_ARG}" == "dashboard" ]]; then
    OPEN_DASHBOARD_ON_RUN=true
  fi
fi

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
  node_bin="${SCRIPT_DIR}/bin/node-darwin-${arch}"
  if [[ -x "${node_bin}" ]]; then
    echo "${node_bin}"
    return
  fi
  echo ""
}

NODE_BIN="$(resolve_node_bin)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "[error] missing bundled node: deployment/bin/node-darwin-$(uname -m)" >&2
  echo "[hint] run: ./deployment/build-local-runtime.sh" >&2
  exit 1
fi

oc() {
  "${LOCAL_OPENCLAW}" "$@"
}

STATE_DIR="${USB_ROOT}/state-mac"
CONFIG_PATH="${CONFIG_ROOT}/openclaw-mac.json"
WORKSPACE_DIR="${USB_ROOT}/workspace"
CODEX_HOME_DIR="${USB_ROOT}/codex-home"

mkdir -p "${STATE_DIR}" "${WORKSPACE_DIR}" "${CODEX_HOME_DIR}"

export OPENCLAW_STATE_DIR="${STATE_DIR}"
export OPENCLAW_CONFIG_PATH="${CONFIG_PATH}"
export CODEX_HOME="${CODEX_HOME_DIR}"

node_eval() {
  "${NODE_BIN}" -e "$1" "${@:2}"
}

compute_codex_keychain_account() {
  node_eval '
const fs=require("fs");
const crypto=require("crypto");
const input=process.argv[1];
if (!input) {
  process.stdout.write("");
  process.exit(0);
}
let resolved=input;
try {
  resolved=fs.realpathSync.native(input);
} catch {
  resolved=input;
}
const hash=crypto.createHash("sha256").update(resolved).digest("hex").slice(0,16);
process.stdout.write(`cli|${hash}`);
' "$1"
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

sync_codex_keychain_entry() {
  if ! command -v security >/dev/null 2>&1; then
    return
  fi
  local mode
  mode="$(printf '%s' "${OPENCLAW_CODEX_SOURCE_SYNC_MODE}" | tr '[:upper:]' '[:lower:]')"
  if [[ "${mode}" == "off" ]]; then
    return
  fi
  local source_account target_account secret
  source_account="$(compute_codex_keychain_account "${SOURCE_CODEX_HOME}")"
  target_account="$(compute_codex_keychain_account "${CODEX_HOME_DIR}")"
  if [[ -z "${source_account}" || -z "${target_account}" || "${source_account}" == "${target_account}" ]]; then
    return
  fi
  if [[ "${mode}" != "always" ]]; then
    if security find-generic-password -s "Codex Auth" -a "${target_account}" -w >/dev/null 2>&1; then
      return
    fi
    if [[ -f "${CODEX_HOME_DIR}/auth.json" ]]; then
      local has_target_refresh
      has_target_refresh="$(node_eval '
const fs=require("fs");
const p=process.argv[1];
try {
  const raw=JSON.parse(fs.readFileSync(p,"utf8"));
  const refresh=typeof raw?.tokens?.refresh_token==="string" ? raw.tokens.refresh_token.trim() : "";
  process.stdout.write(refresh ? "1" : "0");
} catch {
  process.stdout.write("0");
}
' "${CODEX_HOME_DIR}/auth.json")"
      if [[ "${has_target_refresh}" == "1" ]]; then
        return
      fi
    fi
  fi
  secret="$(security find-generic-password -s "Codex Auth" -a "${source_account}" -w 2>/dev/null || true)"
  if [[ -z "${secret}" ]]; then
    return
  fi
  if security add-generic-password -U -s "Codex Auth" -a "${target_account}" -w "${secret}" >/dev/null 2>&1; then
    CODEX_SECRET_JSON="${secret}" node_eval '
const fs=require("fs");
const path=require("path");
const authPath=process.argv[1];
const raw=process.env.CODEX_SECRET_JSON || "";
if (!authPath || !raw) process.exit(0);
let parsed;
try {
  parsed=JSON.parse(raw);
} catch {
  process.exit(0);
}
const tokens=parsed?.tokens;
if (!tokens || typeof tokens !== "object") process.exit(0);
if (typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string") process.exit(0);
const payload={
  auth_mode:"chatgpt",
  OPENAI_API_KEY:null,
  tokens,
  last_refresh: typeof parsed?.last_refresh === "string" ? parsed.last_refresh : new Date().toISOString(),
};
fs.mkdirSync(path.dirname(authPath), { recursive: true });
fs.writeFileSync(authPath, JSON.stringify(payload, null, 2) + "\n");
' "${CODEX_HOME_DIR}/auth.json" >/dev/null 2>&1 || true
    echo "[init] synced Codex keychain credential into ${CODEX_HOME_DIR}"
  fi
}

sync_openai_codex_auth_profiles() {
  local result
  result="$(node_eval '
const fs=require("fs");
const path=require("path");

const stateDir=process.argv[1];
const codexHome=process.argv[2];
if (!stateDir || !codexHome) {
  process.stdout.write("skip");
  process.exit(0);
}

const codexAuthPath=path.join(codexHome, "auth.json");
let codexRaw;
try {
  codexRaw=JSON.parse(fs.readFileSync(codexAuthPath, "utf8"));
} catch {
  process.stdout.write("no-codex-auth");
  process.exit(0);
}
const tokens=codexRaw?.tokens;
const access=typeof tokens?.access_token === "string" ? tokens.access_token.trim() : "";
const refresh=typeof tokens?.refresh_token === "string" ? tokens.refresh_token.trim() : "";
if (!access || !refresh) {
  process.stdout.write("no-codex-tokens");
  process.exit(0);
}
const accountId=typeof tokens?.account_id === "string" && tokens.account_id.trim()
  ? tokens.account_id.trim()
  : undefined;

const decodeJwtExpiryMs=(token)=>{
  try {
    const parts=token.split(".");
    if (parts.length < 2) return null;
    const base64=parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded=base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const payload=JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    const exp=typeof payload?.exp === "number" ? payload.exp : Number(payload?.exp);
    if (!Number.isFinite(exp) || exp <= 0) return null;
    return exp * 1000;
  } catch {
    return null;
  }
};
// Prefer JWT exp; if unavailable, force refresh instead of risking stale access-token reuse.
const expires=decodeJwtExpiryMs(access) ?? (Date.now() - 60 * 1000);

const authStorePath=path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
let store={ version: 1, profiles: {} };
try {
  const parsed=JSON.parse(fs.readFileSync(authStorePath, "utf8"));
  if (parsed && typeof parsed === "object") {
    store=parsed;
  }
} catch {
  // use defaults
}
if (!store.profiles || typeof store.profiles !== "object") {
  store.profiles={};
}

const profileIds=Object.entries(store.profiles)
  .filter((entry) => {
    const profile=entry[1];
    return Boolean(
      profile &&
      typeof profile === "object" &&
      profile.provider === "openai-codex" &&
      profile.type === "oauth",
    );
  })
  .map((entry) => entry[0]);
if (profileIds.length === 0) {
  profileIds.push("openai-codex:default");
}

let changed=false;
for (const id of profileIds) {
  const previous=store.profiles[id];
  const previousObj=previous && typeof previous === "object" ? previous : {};
  const previousAccess=typeof previousObj.access === "string" ? previousObj.access.trim() : "";
  const previousRefresh=typeof previousObj.refresh === "string" ? previousObj.refresh.trim() : "";
  const previousExpires=typeof previousObj.expires === "number"
    ? previousObj.expires
    : Number(previousObj.expires);
  const needsUpdate=
    !previousAccess ||
    !previousRefresh ||
    !Number.isFinite(previousExpires) ||
    previousExpires <= Date.now() + 60_000;
  if (!needsUpdate) {
    continue;
  }
  const next={
    ...previousObj,
    type:"oauth",
    provider:"openai-codex",
    access,
    refresh,
    expires,
    ...(accountId ? { accountId } : {}),
  };
  if (JSON.stringify(previousObj) !== JSON.stringify(next)) {
    changed=true;
  }
  store.profiles[id]=next;
}
if (changed) {
  fs.mkdirSync(path.dirname(authStorePath), { recursive: true });
  fs.writeFileSync(authStorePath, JSON.stringify(store, null, 2) + "\n");
}

const oauthPath=path.join(stateDir, "credentials", "oauth.json");
let oauthStore={};
try {
  const parsed=JSON.parse(fs.readFileSync(oauthPath, "utf8"));
  if (parsed && typeof parsed === "object") {
    oauthStore=parsed;
  }
} catch {
  // missing oauth file is fine
}
const previousOauth=oauthStore["openai-codex"];
const previousOauthObj=previousOauth && typeof previousOauth === "object" ? previousOauth : {};
const previousOauthAccess=typeof previousOauthObj.access === "string" ? previousOauthObj.access.trim() : "";
const previousOauthRefresh=typeof previousOauthObj.refresh === "string" ? previousOauthObj.refresh.trim() : "";
const previousOauthExpires=typeof previousOauthObj.expires === "number"
  ? previousOauthObj.expires
  : Number(previousOauthObj.expires);
const oauthNeedsUpdate=
  !previousOauthAccess ||
  !previousOauthRefresh ||
  !Number.isFinite(previousOauthExpires) ||
  previousOauthExpires <= Date.now() + 60_000;
const nextOauth={
  ...previousOauthObj,
  access,
  refresh,
  expires,
  ...(accountId ? { accountId } : {}),
};
const oauthChanged=oauthNeedsUpdate && JSON.stringify(previousOauthObj) !== JSON.stringify(nextOauth);
if (oauthChanged) {
  oauthStore["openai-codex"]=nextOauth;
  fs.mkdirSync(path.dirname(oauthPath), { recursive: true });
  fs.writeFileSync(oauthPath, JSON.stringify(oauthStore, null, 2) + "\n");
}

if (changed || oauthChanged) {
  process.stdout.write(`updated:${profileIds.length}`);
} else {
  process.stdout.write("noop");
}
' "${STATE_DIR}" "${CODEX_HOME_DIR}")"

  case "${result}" in
    updated:*)
      echo "[init] synced openai-codex OAuth credentials into state (${result#updated:} profile(s))"
      ;;
    no-codex-auth)
      echo "[warn] ${CODEX_HOME_DIR}/auth.json not found; openai-codex OAuth may require re-login."
      ;;
    no-codex-tokens)
      echo "[warn] ${CODEX_HOME_DIR}/auth.json is missing access/refresh tokens; openai-codex OAuth may fail."
      ;;
    *)
      ;;
  esac
}

read_codex_refresh_token() {
  node_eval '
const fs=require("fs");
const path=require("path");
const codexHome=process.argv[1];
if (!codexHome) {
  process.stdout.write("");
  process.exit(0);
}
const authPath=path.join(codexHome, "auth.json");
try {
  const raw=JSON.parse(fs.readFileSync(authPath, "utf8"));
  const refresh=typeof raw?.tokens?.refresh_token === "string" ? raw.tokens.refresh_token.trim() : "";
  process.stdout.write(refresh);
} catch {
  process.stdout.write("");
}
' "$1"
}

check_openai_codex_profile_expired() {
  node_eval '
const fs=require("fs");
const path=require("path");
const stateDir=process.argv[1];
if (!stateDir) {
  process.stdout.write("0");
  process.exit(0);
}
const authStorePath=path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
let store;
try {
  store=JSON.parse(fs.readFileSync(authStorePath, "utf8"));
} catch {
  process.stdout.write("0");
  process.exit(0);
}
const profiles=store?.profiles && typeof store.profiles === "object" ? store.profiles : {};
const target=Object.values(profiles).find((p) =>
  p && typeof p === "object" && p.provider === "openai-codex" && p.type === "oauth",
);
if (!target || typeof target !== "object") {
  process.stdout.write("0");
  process.exit(0);
}
const expires=typeof target.expires === "number" ? target.expires : Number(target.expires);
if (!Number.isFinite(expires)) {
  process.stdout.write("1");
  process.exit(0);
}
process.stdout.write(expires <= Date.now() + 60_000 ? "1" : "0");
' "${STATE_DIR}"
}

check_model_prefers_openai_codex() {
  node_eval '
const fs=require("fs");
const configPath=process.argv[1];
try {
  const cfg=JSON.parse(fs.readFileSync(configPath, "utf8"));
  const primary=String(cfg?.agents?.defaults?.model?.primary ?? "");
  process.stdout.write(primary.startsWith("openai-codex/") ? "1" : "0");
} catch {
  process.stdout.write("0");
}
' "${CONFIG_PATH}"
}

maybe_relogin_openai_codex() {
  local model_prefers_codex profile_expired source_refresh target_refresh shared_refresh
  model_prefers_codex="$(check_model_prefers_openai_codex)"
  if [[ "${model_prefers_codex}" != "1" ]]; then
    return
  fi

  profile_expired="$(check_openai_codex_profile_expired)"
  source_refresh="$(read_codex_refresh_token "${SOURCE_CODEX_HOME}")"
  target_refresh="$(read_codex_refresh_token "${CODEX_HOME_DIR}")"
  shared_refresh="0"
  if [[ -n "${source_refresh}" && -n "${target_refresh}" && "${source_refresh}" == "${target_refresh}" ]]; then
    shared_refresh="1"
  fi

  if [[ "${profile_expired}" != "1" && "${shared_refresh}" != "1" ]]; then
    return
  fi

  if [[ "${OPENCLAW_AUTO_CODEX_RELOGIN}" != "1" ]]; then
    echo "[warn] openai-codex auth may be invalid (expired/shared refresh token)."
    echo "[warn] run: OPENCLAW_STATE_DIR=${STATE_DIR} OPENCLAW_CONFIG_PATH=${CONFIG_PATH} CODEX_HOME=${CODEX_HOME_DIR} ${LOCAL_OPENCLAW} models auth login --provider openai-codex --set-default"
    return
  fi

  if [[ ! -t 0 || ! -t 1 ]]; then
    echo "[error] openai-codex auth requires re-login, but current shell is non-interactive."
    echo "[error] run interactively: OPENCLAW_STATE_DIR=${STATE_DIR} OPENCLAW_CONFIG_PATH=${CONFIG_PATH} CODEX_HOME=${CODEX_HOME_DIR} ${LOCAL_OPENCLAW} models auth login --provider openai-codex --set-default"
    exit 1
  fi

  if [[ "${profile_expired}" == "1" ]]; then
    echo "[init] openai-codex OAuth is expired; running interactive re-login..."
  else
    echo "[init] detected shared openai-codex refresh token between source/target; running interactive re-login to isolate credentials..."
  fi

  if ! oc models auth login --provider openai-codex --set-default; then
    echo "[error] openai-codex re-login failed."
    exit 1
  fi
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
    # Keep dashboard URL token and gateway runtime auth token in sync even if shell env has stale token.
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

read_config_value() {
  local key="$1"
  node_eval '
const fs=require("fs");
const [configPath,key]=process.argv.slice(1);
try{
  const cfg=JSON.parse(fs.readFileSync(configPath,"utf8"));
  const value=key.split(".").reduce((acc,part)=>acc&&typeof acc==="object"?acc[part]:undefined,cfg);
  if (value === undefined || value === null) {
    process.stdout.write("");
    process.exit(0);
  }
  process.stdout.write(String(value));
}catch{
  process.stdout.write("");
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

ensure_workspace_bootstrap() {
  local workspace
  workspace="$(read_config_value agents.defaults.workspace)"
  if [[ -z "${workspace}" ]]; then
    workspace="${WORKSPACE_DIR}"
  fi
  if ! oc setup --workspace "${workspace}" >/dev/null 2>&1; then
    echo "[warn] failed to ensure workspace bootstrap files via 'openclaw setup --workspace ${workspace}'"
  fi
}

ensure_workspace_memory_file() {
  local workspace
  workspace="$(read_config_value agents.defaults.workspace)"
  if [[ -z "${workspace}" ]]; then
    workspace="${WORKSPACE_DIR}"
  fi
  mkdir -p "${workspace}/memory"
  if [[ ! -f "${workspace}/MEMORY.md" && ! -f "${workspace}/memory.md" ]]; then
    cat >"${workspace}/MEMORY.md" <<'EOF'
# MEMORY.md

Long-term notes for this workspace.

- Keep stable preferences and durable facts here.
- Put day-by-day notes in `memory/YYYY-MM-DD.md`.
EOF
    echo "[init] created ${workspace}/MEMORY.md"
  fi
}

apply_base_config() {
  # Only fill defaults when keys are missing. Never overwrite imported custom config.
  set_config_default gateway.mode local
  set_config_default gateway.port 18789
  set_config_default gateway.bind loopback
  set_config_default gateway.auth.mode token
  set_config_default agents.defaults.workspace "${WORKSPACE_DIR}"
  set_config_default agents.defaults.model.primary openai-codex/gpt-5.4
  sync_codex_keychain_entry
  sync_openai_codex_auth_profiles
  #maybe_relogin_openai_codex
  ensure_gateway_token
  ensure_workspace_bootstrap
  ensure_workspace_memory_file
}

print_dashboard_hint() {
  local mode="${1:-no-open}"
  echo "[hint] Open dashboard with tokenized URL:"
  local output url
  output="$(oc dashboard --no-open 2>&1 || true)"
  printf '%s\n' "${output}"
  url="$(printf '%s\n' "${output}" | sed -n 's/^Dashboard URL: //p' | head -n 1)"
  if [[ "${mode}" == "open" && -n "${url}" ]]; then
    if command -v open >/dev/null 2>&1; then
      if open "${url}" >/dev/null 2>&1; then
        echo "Opened in your browser. Keep that tab to control OpenClaw."
      else
        echo "[warn] Browser auto-open failed. Use the URL above."
      fi
    else
      echo "[warn] Browser auto-open is not available. Use the URL above."
    fi
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
    if [[ "${OPEN_DASHBOARD_ON_RUN}" == "true" ]]; then
      print_dashboard_hint open
    fi
    oc gateway run
    ;;
  dashboard)
    apply_base_config
    print_dashboard_hint open
    ;;
  status)
    print_status
    ;;
  *)
    usage
    exit 1
    ;;
esac
