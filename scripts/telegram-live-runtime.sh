#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HELPER_MODULE="${SCRIPT_DIR}/lib/telegram-live-runtime-helpers.mjs"
ASSIGN_BOT_SCRIPT="${SCRIPT_DIR}/assign-bot.sh"
MAIN_RECOVER_SCRIPT="${SCRIPT_DIR}/gateway-recover-main.sh"

WORKTREE="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"
if [[ -d "$WORKTREE" ]]; then
  WORKTREE="$(cd "$WORKTREE" && pwd -P)"
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
BASE_CONFIG_PATH="${OPENCLAW_TELEGRAM_BASE_CONFIG_PATH:-${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}}"

PROFILE_ID=""
RUNTIME_PORT=""
RUNTIME_STATE_DIR=""
RUNTIME_CONFIG_PATH=""
RUNTIME_LOG_PATH=""
RUNTIME_PID=""
RUNTIME_WORKTREE=""
RUNTIME_OWNERSHIP="fail"
RUNTIME_HEALTH="fail"
RUNTIME_START_ACTION="not-started"
RUNTIME_START_TIMEOUT_SECS="unknown"
RUNTIME_PLUGIN_MODE="telegram-only"
RUNTIME_STOP_RESULT="skip"
STOPPED_RUNTIME_PID=""
TOKEN_PRESENT="no"
TOKEN_POOL_GUARD="fail"
TOKEN_FINGERPRINT="none"
ASSIGNED_BOT_TOKEN=""
ASSIGNED_BOT_ID="unknown"
ASSIGNED_BOT_USERNAME="unknown"
ASSIGNED_BOT_NAME="unknown"
CURRENT_LANE_BOT="unknown"
RUNTIME_TOKEN_SOURCE="unknown"
TOKEN_ORIGIN_HINT="unknown"
TOKEN_CLAIM_COUNT=0
TOKEN_CLAIM_PATHS=()
FAIL=0
FAIL_REASONS=()

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

strip_outer_quotes() {
  local value="$1"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    printf '%s' "${value:1:${#value}-2}"
    return
  fi
  if [[ "$value" == \'*\' && "$value" == *\' ]]; then
    printf '%s' "${value:1:${#value}-2}"
    return
  fi
  printf '%s' "$value"
}

parse_env_assignment() {
  local key="$1"
  local line="$2"
  local parsed=""
  if [[ "$line" =~ ^(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*(.*)$ ]]; then
    parsed="$(trim "${BASH_REMATCH[2]}")"
    parsed="$(strip_outer_quotes "$parsed")"
  fi
  printf '%s' "$parsed"
}

read_last_env_value() {
  local file_path="$1"
  local key="$2"
  local line=""
  local trimmed=""
  local parsed=""
  local last_value=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim "$line")"
    if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
      continue
    fi
    parsed="$(parse_env_assignment "$key" "$trimmed")"
    if [[ -n "$parsed" ]]; then
      last_value="$parsed"
    fi
  done < "$file_path"

  printf '%s' "$last_value"
}

mask_token() {
  local token="$1"
  local len=${#token}
  if (( len <= 4 )); then
    printf '****'
    return
  fi
  if (( len <= 8 )); then
    printf '%s...%s' "${token:0:1}" "${token:len-1:1}"
    return
  fi
  printf '%s...%s' "${token:0:4}" "${token:len-4:4}"
}

add_failure() {
  local reason="$1"
  FAIL=1
  FAIL_REASONS+=("$reason")
}

resolve_token_claims() {
  local current_token="$1"
  local worktree_path=""
  local env_local_path=""
  local claimed=""

  TOKEN_CLAIM_COUNT=0
  TOKEN_CLAIM_PATHS=()

  while IFS= read -r worktree_path || [[ -n "${worktree_path}" ]]; do
    [[ -z "${worktree_path}" ]] && continue
    env_local_path="${worktree_path}/.env.local"
    [[ -f "${env_local_path}" ]] || continue
    claimed="$(read_last_env_value "${env_local_path}" "TELEGRAM_BOT_TOKEN")"
    if [[ -n "${claimed}" && "${claimed}" == "${current_token}" ]]; then
      TOKEN_CLAIM_COUNT=$((TOKEN_CLAIM_COUNT + 1))
      TOKEN_CLAIM_PATHS+=("${worktree_path}")
    fi
  done < <(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
}

resolve_bot_identity() {
  [[ -n "${ASSIGNED_BOT_TOKEN}" ]] || return 0

  if [[ "${ASSIGNED_BOT_TOKEN}" == *:* ]]; then
    ASSIGNED_BOT_ID="${ASSIGNED_BOT_TOKEN%%:*}"
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi

  local identity
  identity="$(
    TELEGRAM_BOT_TOKEN="${ASSIGNED_BOT_TOKEN}" python3 - <<'PY' 2>/dev/null || true
import json
import os
import urllib.request

token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
if not token:
    raise SystemExit(0)

req = urllib.request.Request(
    f"https://api.telegram.org/bot{token}/getMe",
    headers={"User-Agent": "openclaw-telegram-live-runtime"},
)
with urllib.request.urlopen(req, timeout=10) as response:
    data = json.load(response)
result = data.get("result") or {}
print(json.dumps({
    "id": result.get("id"),
    "username": result.get("username"),
    "name": result.get("first_name"),
}))
PY
  )"

  if [[ -n "${identity}" ]]; then
    ASSIGNED_BOT_ID="$(python3 -c 'import json,sys; data=json.loads(sys.stdin.read()); print(data.get("id") or "unknown")' <<<"${identity}" 2>/dev/null || printf '%s' "${ASSIGNED_BOT_ID}")"
    ASSIGNED_BOT_USERNAME="$(python3 -c 'import json,sys; data=json.loads(sys.stdin.read()); print(data.get("username") or "unknown")' <<<"${identity}" 2>/dev/null || printf 'unknown')"
    ASSIGNED_BOT_NAME="$(python3 -c 'import json,sys; data=json.loads(sys.stdin.read()); print(data.get("name") or "unknown")' <<<"${identity}" 2>/dev/null || printf 'unknown')"
  fi
}

sanitize_runtime_log_line() {
  local line="$1"
  printf '%s\n' "$line" | sed -E \
    -e 's/([A-Za-z_][A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_]*=)[^[:space:]]+/\1***REDACTED***/Ig' \
    -e 's/[0-9]{8,}:[A-Za-z0-9_-]{20,}/****:***REDACTED***/g' \
    -e 's/sk-[A-Za-z0-9_-]{16,}/sk-***REDACTED***/g' \
    -e 's/(fc|nvapi|rnd|BSA)-[A-Za-z0-9_-]{8,}/\1-***REDACTED***/g'
}

emit_runtime_log_summary() {
  local lines="${OPENCLAW_TELEGRAM_LIVE_FAIL_LOG_LINES:-40}"
  if [[ ! "$lines" =~ ^[0-9]+$ ]]; then
    lines=40
  fi
  if [[ -z "$RUNTIME_LOG_PATH" || ! -f "$RUNTIME_LOG_PATH" ]]; then
    return
  fi

  echo "runtime_log_tail_begin" >&2
  while IFS= read -r line || [[ -n "$line" ]]; do
    sanitize_runtime_log_line "$line" >&2
  done < <(tail -n "$lines" "$RUNTIME_LOG_PATH")
  echo "runtime_log_tail_end" >&2
}

clear_env_assignment_file() {
  local file_path="$1"
  local key="$2"
  local clear_lines

  clear_lines="$(
    HELPER_MODULE="$HELPER_MODULE" FILE_PATH="$file_path" TARGET_KEY="$key" node --input-type=module - <<'NODE'
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const helperPath = process.env.HELPER_MODULE;
const filePath = process.env.FILE_PATH;
const key = process.env.TARGET_KEY;

if (!helperPath || !filePath || !key) {
  process.exit(1);
}

const helpers = await import(pathToFileURL(helperPath).href);
const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
const result = helpers.clearEnvAssignmentText({ key, content });

fs.writeFileSync(filePath, result.content, "utf8");
process.stdout.write(
  `${result.removed ? "1" : "0"}\n${String(result.removedValue ?? "")}\n`,
);
NODE
  )" || return 1

  printf '%s' "$clear_lines"
}

resolve_profile() {
  if [[ ! -f "$HELPER_MODULE" ]]; then
    add_failure "helper_missing:${HELPER_MODULE}"
    return
  fi

  local state_root="${OPENCLAW_TELEGRAM_LIVE_STATE_ROOT:-}"
  local profile_lines
  profile_lines="$(
    WORKTREE_PATH="$WORKTREE" STATE_ROOT="$state_root" node --input-type=module - "$HELPER_MODULE" <<'NODE'
import { pathToFileURL } from "node:url";

const [helperPath] = process.argv.slice(2);
const helpers = await import(pathToFileURL(helperPath).href);
const profile = helpers.deriveTelegramLiveRuntimeProfile({
  worktreePath: process.env.WORKTREE_PATH,
  stateRoot: process.env.STATE_ROOT || undefined,
});

process.stdout.write(`${profile.profileId}\n${String(profile.runtimePort)}\n${profile.runtimeStateDir}\n`);
NODE
  )"

  PROFILE_ID="$(printf '%s\n' "$profile_lines" | sed -n '1p')"
  RUNTIME_PORT="$(printf '%s\n' "$profile_lines" | sed -n '2p')"
  RUNTIME_STATE_DIR="$(printf '%s\n' "$profile_lines" | sed -n '3p')"
  RUNTIME_LOG_PATH="/tmp/openclaw-telegram-live-${PROFILE_ID}.log"

  if [[ -z "$PROFILE_ID" || -z "$RUNTIME_PORT" || -z "$RUNTIME_STATE_DIR" ]]; then
    add_failure "profile_resolution_failed"
  fi
}

resolve_runtime_owner() {
  RUNTIME_PID=""
  RUNTIME_WORKTREE=""
  RUNTIME_OWNERSHIP="fail"

  if [[ -z "$RUNTIME_PORT" ]]; then
    return
  fi

  local pids
  pids="$(lsof -nP -tiTCP:"${RUNTIME_PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  local count
  count="$(printf '%s\n' "$pids" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"

  if [[ "$count" == "0" ]]; then
    return
  fi
  if [[ "$count" != "1" ]]; then
    add_failure "multiple_listeners_on_runtime_port:${RUNTIME_PORT}"
    return
  fi

  RUNTIME_PID="$(printf '%s\n' "$pids" | sed -n '1p' | tr -d '[:space:]')"
  if [[ -z "$RUNTIME_PID" ]]; then
    return
  fi

  local runtime_cmd
  runtime_cmd="$(ps -o command= -p "$RUNTIME_PID" 2>/dev/null || true)"
  RUNTIME_WORKTREE="$(lsof -a -p "$RUNTIME_PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | sed -n '1p')"

  if [[ -n "$RUNTIME_WORKTREE" && "$RUNTIME_WORKTREE" == "$WORKTREE" ]] &&
    [[ "$runtime_cmd" == *" gateway run"* || "$runtime_cmd" == *"openclaw-gateway"* ]]; then
    RUNTIME_OWNERSHIP="ok"
  fi
}

stop_owned_runtime() {
  RUNTIME_STOP_RESULT="skip"
  STOPPED_RUNTIME_PID=""

  if [[ -n "$RUNTIME_PID" && "$RUNTIME_OWNERSHIP" == "ok" ]]; then
    STOPPED_RUNTIME_PID="$RUNTIME_PID"
    if kill "$RUNTIME_PID" 2>/dev/null; then
      local waited=0
      while [[ "$waited" -lt 15 ]]; do
        if ! kill -0 "$RUNTIME_PID" 2>/dev/null; then
          break
        fi
        sleep 1
        waited=$((waited + 1))
      done
      if kill -0 "$RUNTIME_PID" 2>/dev/null; then
        kill -9 "$RUNTIME_PID" 2>/dev/null || true
      fi
      RUNTIME_STOP_RESULT="ok"
    else
      RUNTIME_STOP_RESULT="fail"
      add_failure "runtime_stop_failed"
    fi
  fi
}

probe_runtime_health() {
  RUNTIME_HEALTH="fail"
  if [[ -z "$RUNTIME_PORT" || -z "$RUNTIME_STATE_DIR" || -z "$RUNTIME_CONFIG_PATH" ]]; then
    return
  fi
  # Readiness probe is bounded and profile-scoped (derived runtime port).
  if RUNTIME_PORT="$RUNTIME_PORT" node --input-type=module - >/tmp/openclaw-telegram-live-health.$$ 2>&1 <<'NODE'
const port = Number.parseInt(process.env.RUNTIME_PORT ?? "", 10);
if (!Number.isFinite(port) || port <= 0) {
  process.exit(1);
}

let response;
try {
  response = await fetch(`http://127.0.0.1:${port}/readyz`, {
    signal: AbortSignal.timeout(2500),
  });
} catch {
  process.exit(1);
}

if (!response.ok) {
  process.exit(1);
}

let payload = null;
try {
  payload = await response.json();
} catch {
  process.exit(1);
}

if (payload && typeof payload === "object" && payload.ready === true) {
  process.exit(0);
}

process.exit(1);
NODE
  then
    RUNTIME_HEALTH="ok"
  fi
}

ensure_tester_bot_claim() {
  if [[ ! -x "$ASSIGN_BOT_SCRIPT" ]]; then
    add_failure "assign_bot_script_missing:${ASSIGN_BOT_SCRIPT}"
    return
  fi

  if ! (cd "$REPO_ROOT" && bash "$ASSIGN_BOT_SCRIPT"); then
    add_failure "assign_bot_failed"
    return
  fi

  local env_local="${REPO_ROOT}/.env.local"
  local env_bots="${REPO_ROOT}/.env.bots"
  if [[ ! -f "$env_local" ]]; then
    add_failure "env_local_missing_after_assign"
    return
  fi
  if [[ ! -f "$env_bots" ]]; then
    add_failure "env_bots_missing_after_assign"
    return
  fi

  local token
  token="$(read_last_env_value "$env_local" "TELEGRAM_BOT_TOKEN")"
  if [[ -z "$token" ]]; then
    add_failure "telegram_token_missing_in_env_local"
    return
  fi

  TOKEN_PRESENT="yes"
  ASSIGNED_BOT_TOKEN="$token"
  TOKEN_FINGERPRINT="$(mask_token "$token")"
  RUNTIME_TOKEN_SOURCE="repo_env_local"
  TOKEN_ORIGIN_HINT="repo_env_local"
  resolve_token_claims "$token"
  resolve_bot_identity
  if [[ "${ASSIGNED_BOT_USERNAME}" != "unknown" ]]; then
    CURRENT_LANE_BOT="@${ASSIGNED_BOT_USERNAME}"
  elif [[ "${ASSIGNED_BOT_ID}" != "unknown" ]]; then
    CURRENT_LANE_BOT="id=${ASSIGNED_BOT_ID}"
  fi

  local in_pool="no"
  local line=""
  local trimmed=""
  local parsed=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim "$line")"
    if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
      continue
    fi
    parsed="$(parse_env_assignment "BOT_TOKEN" "$trimmed")"
    if [[ -n "$parsed" && "$parsed" == "$token" ]]; then
      in_pool="yes"
      break
    fi
  done < "$env_bots"

  if [[ "$in_pool" == "yes" ]]; then
    TOKEN_POOL_GUARD="ok"
  else
    TOKEN_POOL_GUARD="fail"
    add_failure "token_not_in_pool"
  fi
}

prepare_isolated_runtime_config() {
  if [[ -z "$RUNTIME_STATE_DIR" ]]; then
    add_failure "runtime_state_dir_missing"
    return
  fi
  if [[ -z "$ASSIGNED_BOT_TOKEN" ]]; then
    add_failure "assigned_token_missing"
    return
  fi
  if [[ -z "$RUNTIME_PORT" ]]; then
    add_failure "runtime_port_missing"
    return
  fi

  RUNTIME_CONFIG_PATH="${RUNTIME_STATE_DIR}/openclaw.telegram-live.json"
  mkdir -p "$RUNTIME_STATE_DIR"

  if ! BASE_CONFIG_PATH="$BASE_CONFIG_PATH" \
    RUNTIME_CONFIG_PATH="$RUNTIME_CONFIG_PATH" \
    ASSIGNED_BOT_TOKEN="$ASSIGNED_BOT_TOKEN" \
    RUNTIME_PORT="$RUNTIME_PORT" \
    node --input-type=module - <<'NODE'
import fs from "node:fs";
import path from "node:path";

const basePath = process.env.BASE_CONFIG_PATH;
const runtimeConfigPath = process.env.RUNTIME_CONFIG_PATH;
const assignedToken = process.env.ASSIGNED_BOT_TOKEN;
const runtimePort = Number.parseInt(process.env.RUNTIME_PORT ?? "", 10);

if (!runtimeConfigPath || !assignedToken || !Number.isFinite(runtimePort) || runtimePort <= 0) {
  throw new Error("Missing runtime config path, assigned token, or runtime port.");
}

let config = {};
if (basePath && fs.existsSync(basePath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(basePath, "utf8"));
    if (parsed && typeof parsed === "object") {
      config = parsed;
    }
  } catch {
    // Fall back to a minimal config if base config is absent/invalid.
  }
}

const gateway = config.gateway && typeof config.gateway === "object" ? config.gateway : {};
const controlUi =
  gateway.controlUi && typeof gateway.controlUi === "object" ? gateway.controlUi : {};
config.gateway = {
  ...gateway,
  port: runtimePort,
  bind: "loopback",
  mode: "local",
  controlUi: {
    ...controlUi,
    enabled: false,
    allowedOrigins: [
      `http://localhost:${runtimePort}`,
      `http://127.0.0.1:${runtimePort}`,
    ],
  },
};

const baseChannels = config.channels && typeof config.channels === "object" ? config.channels : {};
const telegram =
  baseChannels.telegram && typeof baseChannels.telegram === "object" ? baseChannels.telegram : {};
const basePlugins = config.plugins && typeof config.plugins === "object" ? config.plugins : {};
const pluginSlots =
  basePlugins.slots && typeof basePlugins.slots === "object" ? basePlugins.slots : {};

// Force a Telegram-only runtime profile for worktree live tests. Telegram is a
// bundled channel plugin in this repo, so isolation must allow the telegram
// plugin while still blocking unrelated plugins and memory slot side effects.
delete telegram.accounts;
config.channels = {
  telegram: {
    ...telegram,
    enabled: true,
    botToken: assignedToken,
  },
};
config.plugins = {
  ...basePlugins,
  enabled: true,
  allow: ["telegram"],
  entries: {
    ...(basePlugins.entries && typeof basePlugins.entries === "object" ? basePlugins.entries : {}),
    telegram: {
      enabled: true,
    },
  },
  slots: {
    ...pluginSlots,
    memory: "none",
  },
};

fs.mkdirSync(path.dirname(runtimeConfigPath), { recursive: true });
fs.writeFileSync(runtimeConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
NODE
  then
    add_failure "runtime_config_prepare_failed"
  fi
}

sync_runtime_auth_profiles() {
  if [[ -z "$RUNTIME_STATE_DIR" ]]; then
    add_failure "runtime_state_dir_missing"
    return
  fi

  purge_runtime_auth_profiles() {
    local auth_path=""
    while IFS= read -r auth_path || [[ -n "$auth_path" ]]; do
      [[ -z "$auth_path" ]] && continue
      rm -f "$auth_path"
    done < <(
      find "$RUNTIME_STATE_DIR/agents" \
        \( -path "*/agent/auth-profiles.json" -o -path "*/agent/auth.json" \) \
        -type f 2>/dev/null
    )
  }

  # Telegram live tester lanes should be able to run with fully isolated auth.
  # When this flag is set we intentionally do not inherit any auth-profiles
  # from the shared ~/.openclaw agent state, which avoids OAuth refresh-token
  # races between the tester runtime and the user's main runtime.
  if [[ "${OPENCLAW_TELEGRAM_LIVE_SKIP_AUTH_SYNC:-0}" == "1" ]]; then
    # Scrub any stale inherited auth that might already be sitting in the
    # runtime state from an earlier non-isolated run.
    purge_runtime_auth_profiles
    return
  fi

  # Worktree runtimes keep isolated state, but they still need the operator's
  # existing auth profiles copied in so inbound Telegram messages can actually
  # execute the same agent models as the stable runtime.
  if ! BASE_CONFIG_PATH="$BASE_CONFIG_PATH" \
    RUNTIME_STATE_DIR="$RUNTIME_STATE_DIR" \
    node --input-type=module - <<'NODE'
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const basePath = process.env.BASE_CONFIG_PATH;
const runtimeStateDir = process.env.RUNTIME_STATE_DIR;

if (!runtimeStateDir) {
  throw new Error("Missing runtime state dir.");
}

let config = {};
if (basePath && fs.existsSync(basePath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(basePath, "utf8"));
    if (parsed && typeof parsed === "object") {
      config = parsed;
    }
  } catch {
    // Ignore invalid base config here; auth sync simply falls back to defaults.
  }
}

const agentEntries = new Map();
const configuredAgents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
for (const entry of configuredAgents) {
  if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id.trim()) {
    continue;
  }
  agentEntries.set(entry.id, entry);
}

if (!agentEntries.has("main")) {
  agentEntries.set("main", { id: "main" });
}

for (const [agentId, entry] of agentEntries) {
  const sourceAgentDir =
    typeof entry.agentDir === "string" && entry.agentDir.trim()
      ? entry.agentDir.trim()
      : path.join(os.homedir(), ".openclaw", "agents", agentId, "agent");
  const sourceAuthPath = path.join(sourceAgentDir, "auth-profiles.json");
  if (!fs.existsSync(sourceAuthPath)) {
    continue;
  }

  const targetAuthPath = path.join(runtimeStateDir, "agents", agentId, "agent", "auth-profiles.json");
  fs.mkdirSync(path.dirname(targetAuthPath), { recursive: true });

  const sourceContent = fs.readFileSync(sourceAuthPath);
  const targetContent = fs.existsSync(targetAuthPath) ? fs.readFileSync(targetAuthPath) : null;
  if (targetContent && Buffer.compare(sourceContent, targetContent) === 0) {
    continue;
  }

  fs.writeFileSync(targetAuthPath, sourceContent);
  fs.chmodSync(targetAuthPath, 0o600);
}
NODE
  then
    add_failure "runtime_auth_sync_failed"
  fi
}

start_isolated_runtime() {
  mkdir -p "$RUNTIME_STATE_DIR"
  if [[ -z "$RUNTIME_CONFIG_PATH" ]]; then
    RUNTIME_START_ACTION="start-failed"
    add_failure "runtime_config_path_missing"
    return
  fi
  # Use direct Node entrypoint under the current worktree. `pnpm openclaw` can
  # exit early under nohup in some environments, leaving no listener behind.
  if (
    cd "$REPO_ROOT"
    nohup env \
      OPENCLAW_STATE_DIR="$RUNTIME_STATE_DIR" \
      OPENCLAW_CONFIG_PATH="$RUNTIME_CONFIG_PATH" \
      OPENCLAW_GATEWAY_PORT="$RUNTIME_PORT" \
      OPENCLAW_SKIP_GMAIL_WATCHER=1 \
      OPENCLAW_SKIP_CRON=1 \
      OPENCLAW_SKIP_CANVAS_HOST=1 \
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER=1 \
      OPENCLAW_DISABLE_BONJOUR=1 \
      OPENCLAW_DISABLE_EXTERNAL_CLI_AUTH_SYNC="${OPENCLAW_TELEGRAM_LIVE_SKIP_AUTH_SYNC:-0}" \
      node scripts/run-node.mjs gateway run --bind loopback --port "$RUNTIME_PORT" --force --allow-unconfigured \
      >"$RUNTIME_LOG_PATH" 2>&1 &
  ); then
    RUNTIME_START_ACTION="started"
  else
    RUNTIME_START_ACTION="start-failed"
    add_failure "runtime_start_failed"
  fi
}

emit_ensure_proof_lines() {
  echo "branch=${BRANCH:-unknown}"
  echo "worktree=${WORKTREE}"
  echo "runtime_pid=${RUNTIME_PID:-}"
  echo "runtime_worktree=${RUNTIME_WORKTREE:-}"
  echo "runtime_port=${RUNTIME_PORT:-}"
  echo "runtime_state_dir=${RUNTIME_STATE_DIR:-}"
  echo "runtime_ownership=${RUNTIME_OWNERSHIP}"
  echo "runtime_health=${RUNTIME_HEALTH}"
  echo "runtime_start_action=${RUNTIME_START_ACTION}"
  echo "runtime_start_timeout_secs=${RUNTIME_START_TIMEOUT_SECS}"
  echo "runtime_plugin_mode=${RUNTIME_PLUGIN_MODE}"
  echo "token_present=${TOKEN_PRESENT}"
  echo "token_pool_guard=${TOKEN_POOL_GUARD}"
  echo "token_fingerprint=${TOKEN_FINGERPRINT}"
  echo "current_lane_bot=${CURRENT_LANE_BOT}"
  echo "runtime_token_source=${RUNTIME_TOKEN_SOURCE}"
  echo "token_origin_hint=${TOKEN_ORIGIN_HINT}"
  echo "assigned_bot_id=${ASSIGNED_BOT_ID}"
  echo "assigned_bot_username=${ASSIGNED_BOT_USERNAME}"
  echo "assigned_bot_name=${ASSIGNED_BOT_NAME}"
  echo "token_claim_count=${TOKEN_CLAIM_COUNT}"
  for claim_path in "${TOKEN_CLAIM_PATHS[@]}"; do
    echo "token_claim_path=${claim_path}"
  done
}

ensure_command() {
  resolve_profile

  if [[ -z "${BRANCH}" || "${BRANCH}" == "HEAD" ]]; then
    add_failure "branch_detached_head"
  fi

  ensure_tester_bot_claim
  prepare_isolated_runtime_config
  sync_runtime_auth_profiles

  resolve_runtime_owner

  if [[ -n "$RUNTIME_PID" && "$RUNTIME_OWNERSHIP" != "ok" ]]; then
    add_failure "runtime_owned_by_other_worktree_or_process"
  fi

  if [[ -z "$RUNTIME_PID" && "$FAIL" -eq 0 ]]; then
    start_isolated_runtime
  fi

  if [[ "$FAIL" -eq 0 ]]; then
    local waited=0
    # Cold isolated boots can take a couple of minutes on this repo because the
    # runtime still initializes bundled services before Telegram is ready.
    local startup_timeout="${OPENCLAW_TELEGRAM_LIVE_START_TIMEOUT_SECS:-240}"
    if [[ ! "$startup_timeout" =~ ^[0-9]+$ ]]; then
      startup_timeout=240
    fi
    RUNTIME_START_TIMEOUT_SECS="$startup_timeout"
    while [[ "$waited" -lt "$startup_timeout" ]]; do
      resolve_runtime_owner
      if [[ "$RUNTIME_OWNERSHIP" == "ok" ]]; then
        probe_runtime_health
        if [[ "$RUNTIME_HEALTH" == "ok" ]]; then
          break
        fi
      fi
      sleep 1
      waited=$((waited + 1))
    done
  fi

  if [[ "$RUNTIME_OWNERSHIP" != "ok" ]]; then
    add_failure "runtime_ownership_check_failed"
  fi
  if [[ "$RUNTIME_HEALTH" != "ok" ]]; then
    add_failure "runtime_health_check_failed"
  fi
  if [[ "${TOKEN_CLAIM_COUNT}" -gt 1 ]]; then
    add_failure "token_claim_count:${TOKEN_CLAIM_COUNT}"
  fi

  emit_ensure_proof_lines

  if [[ "$FAIL" -ne 0 ]]; then
    local reason
    for reason in "${FAIL_REASONS[@]-}"; do
      echo "error=${reason}" >&2
    done
    if [[ -n "$RUNTIME_LOG_PATH" ]]; then
      echo "runtime_log=${RUNTIME_LOG_PATH}" >&2
      emit_runtime_log_summary
    fi
    return 1
  fi
}

emit_handoff_proof_lines() {
  echo "handoff_worktree=${WORKTREE}"
  echo "handoff_runtime_port=${RUNTIME_PORT:-}"
  echo "handoff_stopped_pid=${STOPPED_RUNTIME_PID}"
  echo "handoff_runtime_stop=${RUNTIME_STOP_RESULT}"
}

handoff_main_command() {
  resolve_profile
  resolve_runtime_owner
  stop_owned_runtime
  emit_handoff_proof_lines

  local pre_health="fail"
  if openclaw gateway status --deep --require-rpc >/dev/null 2>&1; then
    pre_health="ok"
  fi

  local recover_result="fail"
  local main_health="fail"
  if [[ "$(uname -s)" != "Darwin" ]]; then
    recover_result="skip-non-darwin"
    main_health="skip-non-darwin"
  elif [[ ! -x "$MAIN_RECOVER_SCRIPT" ]]; then
    recover_result="fail-missing-script"
    add_failure "main_recover_script_missing"
  elif "$MAIN_RECOVER_SCRIPT"; then
    if [[ "$pre_health" == "ok" ]]; then
      recover_result="already-healthy"
    else
      recover_result="ok"
    fi
    if openclaw gateway status --deep --require-rpc >/dev/null 2>&1; then
      main_health="ok"
    else
      main_health="fail"
      add_failure "main_health_check_failed"
    fi
  else
    recover_result="fail"
    add_failure "main_recover_failed"
  fi

  echo "handoff_main_recover=${recover_result}"
  echo "handoff_main_health=${main_health}"

  if [[ "$recover_result" != "ok" && "$recover_result" != "already-healthy" && "$recover_result" != "skip-non-darwin" ]]; then
    return 1
  fi
  if [[ "$main_health" == "fail" ]]; then
    return 1
  fi
}

release_command() {
  resolve_profile
  resolve_runtime_owner

  local env_local="${REPO_ROOT}/.env.local"
  local release_token_present_before="no"
  local release_token_cleared="no"
  local release_token_fingerprint="none"
  local release_runtime_pid="${RUNTIME_PID:-}"
  local token_before=""

  if [[ -f "$env_local" ]]; then
    token_before="$(read_last_env_value "$env_local" "TELEGRAM_BOT_TOKEN")"
  fi

  if [[ -n "$token_before" ]]; then
    release_token_present_before="yes"
    release_token_fingerprint="$(mask_token "$token_before")"
  fi

  if [[ -n "$RUNTIME_PID" && "$RUNTIME_OWNERSHIP" != "ok" ]]; then
    add_failure "release_runtime_owned_by_other_worktree_or_process"
  fi

  if [[ "$FAIL" -eq 0 ]]; then
    stop_owned_runtime
  fi

  if [[ "$FAIL" -eq 0 && "$release_token_present_before" == "yes" ]]; then
    local clear_lines=""
    local removed=""
    if ! clear_lines="$(clear_env_assignment_file "$env_local" "TELEGRAM_BOT_TOKEN")"; then
      add_failure "release_token_clear_failed"
    else
      removed="$(printf '%s\n' "$clear_lines" | sed -n '1p')"
      if [[ "$removed" == "1" ]] && [[ -z "$(read_last_env_value "$env_local" "TELEGRAM_BOT_TOKEN")" ]]; then
        release_token_cleared="yes"
      else
        add_failure "release_token_clear_failed"
      fi
    fi
  fi

  echo "release_worktree=${WORKTREE}"
  echo "release_runtime_port=${RUNTIME_PORT:-}"
  echo "release_runtime_pid=${release_runtime_pid}"
  echo "release_runtime_stop=${RUNTIME_STOP_RESULT}"
  echo "release_token_present_before=${release_token_present_before}"
  echo "release_token_cleared=${release_token_cleared}"
  echo "release_token_fingerprint=${release_token_fingerprint}"

  if [[ "$FAIL" -ne 0 ]]; then
    local reason
    for reason in "${FAIL_REASONS[@]-}"; do
      echo "error=${reason}" >&2
    done
    return 1
  fi
}

usage() {
  cat <<'USAGE'
Usage:
  scripts/telegram-live-runtime.sh [ensure|handoff-main|release]

Commands:
  ensure       Validate and ensure isolated Telegram live runtime ownership for this worktree.
  handoff-main Stop isolated worktree runtime (if owned) and recover stable main runtime.
  release      Stop isolated worktree runtime (if owned) and clear this worktree tester bot claim.
USAGE
}

main() {
  local cmd="${1:-ensure}"
  case "$cmd" in
    ensure)
      ensure_command
      ;;
    handoff-main)
      handoff_main_command
      ;;
    release)
      release_command
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      echo "Unknown command: $cmd" >&2
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
