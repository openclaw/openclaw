#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SOURCE_CONFIG_PATH="${1:-$HOME/.openclaw/openclaw.json}"
SOURCE_STATE_DIR="${2:-$HOME/.openclaw}"
TARGET_CONFIG_ROOT="${3:-${SCRIPT_DIR}/config}"
TARGET_DATA_ROOT="${4:-${SCRIPT_DIR}/data}"

SOURCE_CODEX_AUTH_PATH="${HOME}/.codex/auth.json"
SOURCE_CODEX_HOME="${HOME}/.codex"
TARGET_CODEX_HOME_DIR="${TARGET_DATA_ROOT}/codex-home"
TARGET_WORKSPACE_DIR="${TARGET_DATA_ROOT}/workspace"

TARGET_CONFIG_PATH="${TARGET_CONFIG_ROOT}/openclaw-mac.json"
TARGET_STATE_DIR="${TARGET_DATA_ROOT}/state-mac"

compute_codex_keychain_account() {
  node -e '
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

usage() {
  cat <<'USAGE'
Usage:
  migrate-local-mac.sh [source_config_path] [source_state_dir] [target_config_root] [target_data_root]

Defaults:
  source_config_path = ~/.openclaw/openclaw.json
  source_state_dir   = ~/.openclaw
  target_config_root = ./deployment/config
  target_data_root   = ./deployment/data
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ ! -f "${SOURCE_CONFIG_PATH}" ]]; then
  echo "[error] source config not found: ${SOURCE_CONFIG_PATH}" >&2
  exit 1
fi
if [[ ! -d "${SOURCE_STATE_DIR}" ]]; then
  echo "[error] source state dir not found: ${SOURCE_STATE_DIR}" >&2
  exit 1
fi

mkdir -p "${TARGET_CONFIG_ROOT}" "${TARGET_STATE_DIR}" "${TARGET_CODEX_HOME_DIR}"
mkdir -p "${TARGET_WORKSPACE_DIR}"

cp "${SOURCE_CONFIG_PATH}" "${TARGET_CONFIG_PATH}"

if command -v rsync >/dev/null 2>&1; then
  rsync -a "${SOURCE_STATE_DIR}/" "${TARGET_STATE_DIR}/"
else
  cp -a "${SOURCE_STATE_DIR}/." "${TARGET_STATE_DIR}/"
fi

SOURCE_WORKSPACE_DIR="$(node -e '
const fs=require("fs");
const p=process.argv[1];
try{
  const cfg=JSON.parse(fs.readFileSync(p,"utf8"));
  const workspace=cfg?.agents?.defaults?.workspace;
  process.stdout.write(typeof workspace === "string" ? workspace : "");
}catch{
  process.stdout.write("");
}
' "${SOURCE_CONFIG_PATH}")"

if [[ -n "${SOURCE_WORKSPACE_DIR}" ]]; then
  SOURCE_WORKSPACE_DIR="$(cd "${SOURCE_WORKSPACE_DIR}" 2>/dev/null && pwd || true)"
fi

workspace_copied_any=0
for workspace_subdir in ".openclaw" "skills" ".agents/skills" "memory"; do
  source_dir="${SOURCE_WORKSPACE_DIR}/${workspace_subdir}"
  target_dir="${TARGET_WORKSPACE_DIR}/${workspace_subdir}"
  if [[ -n "${SOURCE_WORKSPACE_DIR}" && -d "${source_dir}" ]]; then
    mkdir -p "${target_dir}"
    if command -v rsync >/dev/null 2>&1; then
      rsync -a "${source_dir}/" "${target_dir}/"
    else
      cp -a "${source_dir}/." "${target_dir}/"
    fi
    echo "[migrate] copied workspace ${workspace_subdir} from ${source_dir}"
    workspace_copied_any=1
  fi
done
for workspace_file in AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md BOOTSTRAP.md MEMORY.md; do
  source_file="${SOURCE_WORKSPACE_DIR}/${workspace_file}"
  target_file="${TARGET_WORKSPACE_DIR}/${workspace_file}"
  if [[ -n "${SOURCE_WORKSPACE_DIR}" && -f "${source_file}" ]]; then
    cp "${source_file}" "${target_file}"
    echo "[migrate] copied workspace ${workspace_file} from ${source_file}"
    workspace_copied_any=1
  fi
done
if [[ "${workspace_copied_any}" -eq 0 ]]; then
  echo "[migrate] workspace defaults/skills/memory not found in source workspace (skipped)"
fi

if [[ -f "${SOURCE_CODEX_AUTH_PATH}" ]]; then
  cp "${SOURCE_CODEX_AUTH_PATH}" "${TARGET_CODEX_HOME_DIR}/auth.json"
  echo "[migrate] copied Codex auth file to ${TARGET_CODEX_HOME_DIR}/auth.json"
else
  echo "[migrate] Codex auth file not found at ${SOURCE_CODEX_AUTH_PATH} (skipped)"
fi

if [[ -d "${SOURCE_CODEX_HOME}/skills" ]]; then
  mkdir -p "${TARGET_CODEX_HOME_DIR}/skills"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a "${SOURCE_CODEX_HOME}/skills/" "${TARGET_CODEX_HOME_DIR}/skills/"
  else
    cp -a "${SOURCE_CODEX_HOME}/skills/." "${TARGET_CODEX_HOME_DIR}/skills/"
  fi
  echo "[migrate] copied Codex skills to ${TARGET_CODEX_HOME_DIR}/skills"
else
  echo "[migrate] Codex skills not found at ${SOURCE_CODEX_HOME}/skills (skipped)"
fi

if command -v security >/dev/null 2>&1; then
  source_account="$(compute_codex_keychain_account "${SOURCE_CODEX_HOME}")"
  target_account="$(compute_codex_keychain_account "${TARGET_CODEX_HOME_DIR}")"
  if [[ -n "${source_account}" && -n "${target_account}" && "${source_account}" != "${target_account}" ]]; then
    secret="$(security find-generic-password -s "Codex Auth" -a "${source_account}" -w 2>/dev/null || true)"
    if [[ -n "${secret}" ]]; then
      if security add-generic-password -U -s "Codex Auth" -a "${target_account}" -w "${secret}" >/dev/null 2>&1; then
        echo "[migrate] synced Codex keychain credential to target CODEX_HOME account"
      fi
    fi
  fi
fi

if command -v node >/dev/null 2>&1; then
  sync_result="$(node -e '
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
process.stdout.write(changed ? `updated:${profileIds.length}` : "noop");
' "${TARGET_STATE_DIR}" "${TARGET_CODEX_HOME_DIR}")"

  case "${sync_result}" in
    updated:*)
      echo "[migrate] synced openai-codex OAuth profiles (${sync_result#updated:})"
      ;;
    no-codex-auth)
      echo "[migrate] no codex auth.json found in ${TARGET_CODEX_HOME_DIR}"
      ;;
    no-codex-tokens)
      echo "[migrate] codex auth.json missing access/refresh token in ${TARGET_CODEX_HOME_DIR}"
      ;;
    *)
      ;;
  esac
fi

if command -v node >/dev/null 2>&1; then
  node -e '
const fs=require("fs");
const path=require("path");
const [configPath, workspaceDir]=process.argv.slice(1);
if (!configPath || !workspaceDir) process.exit(0);
let cfg={};
try{
  cfg=JSON.parse(fs.readFileSync(configPath,"utf8"));
}catch{
  cfg={};
}
if (!cfg.agents || typeof cfg.agents !== "object") cfg.agents={};
if (!cfg.agents.defaults || typeof cfg.agents.defaults !== "object") cfg.agents.defaults={};
cfg.agents.defaults.workspace=workspaceDir;
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
' "${TARGET_CONFIG_PATH}" "${TARGET_WORKSPACE_DIR}"
  echo "[migrate] set agents.defaults.workspace -> ${TARGET_WORKSPACE_DIR}"
fi

echo "[migrate] config -> ${TARGET_CONFIG_PATH}"
echo "[migrate] state  -> ${TARGET_STATE_DIR}"
echo "[next] run: ./deployment/usb-openclaw-mac.sh run ./deployment/data dashboard"
