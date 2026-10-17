#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-build.sh"
source "$ROOT_DIR/scripts/lib/build-metadata.sh"
source "$ROOT_DIR/scripts/lib/host-timeout.sh"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
EXTRA_COMPOSE_FILE="$ROOT_DIR/docker-compose.extra.yml"
IMAGE_NAME="${OPENCLAW_IMAGE:-openclaw:local}"
EXTRA_MOUNTS="${OPENCLAW_EXTRA_MOUNTS:-}"
HOME_VOLUME_NAME="${OPENCLAW_HOME_VOLUME:-}"
RAW_SANDBOX_SETTING="${OPENCLAW_SANDBOX:-}"
SANDBOX_ENABLED=""
DOCKER_SOCKET_PATH="${OPENCLAW_DOCKER_SOCKET:-}"
TIMEZONE="${OPENCLAW_TZ:-}"
RAW_SKIP_ONBOARDING="${OPENCLAW_SKIP_ONBOARDING:-}"
SKIP_ONBOARDING=""
DOCKER_PULL_TIMEOUT="${OPENCLAW_DOCKER_SETUP_PULL_TIMEOUT:-600s}"
OFFLINE_MODE=""
DEFAULT_SANDBOX_IMAGE="openclaw-sandbox:bookworm-slim"
DEFAULT_SANDBOX_BROWSER_IMAGE="openclaw-sandbox-browser:bookworm-slim"
SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH="2026-05-12-cdp-relay-auth"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --offline)
      OFFLINE_MODE="1"
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
  shift
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

run_docker_pull() {
  local image="$1"
  openclaw_host_timeout_cmd "$DOCKER_PULL_TIMEOUT" docker pull "$image"
}

require_local_docker_image() {
  local image="$1"
  if docker image inspect "$image" >/dev/null 2>&1; then
    return 0
  fi
  fail "Offline Docker setup requires preloaded image $image. Load it with 'docker load -i <image.tar>' before running scripts/docker/setup.sh --offline."
}

is_truthy_value() {
  local raw="${1:-}"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    1 | true | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}

read_config_gateway_token() {
  local config_path="$OPENCLAW_CONFIG_DIR/openclaw.json"
  if [[ ! -f "$config_path" ]]; then
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$config_path" <<'PY'
import json
import sys

path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
except Exception:
    raise SystemExit(0)

gateway = cfg.get("gateway")
if not isinstance(gateway, dict):
    raise SystemExit(0)
auth = gateway.get("auth")
if not isinstance(auth, dict):
    raise SystemExit(0)
token = auth.get("token")
if isinstance(token, str):
    token = token.strip()
    if token:
        print(token)
PY
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    node - "$config_path" <<'NODE'
const fs = require("node:fs");
const configPath = process.argv[2];
try {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const token = cfg?.gateway?.auth?.token;
  if (typeof token === "string" && token.trim().length > 0) {
    process.stdout.write(token.trim());
  }
} catch {
  // Keep docker-setup resilient when config parsing fails.
}
NODE
  fi
}

read_env_value() {
  local env_path="$1"
  local key="$2"
  local line=""
  local value=""
  if [[ ! -f "$env_path" ]]; then
    return 0
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$line" == "$key="* ]]; then
      value="${line#*=}"
    fi
  done <"$env_path"
  if [[ -n "$value" ]]; then
    printf '%s' "$value"
  fi
}

sync_gateway_config() {
  local allowed_origin_json=""
  local current_allowed_origins=""
  local current_public_origin=""
  local batch_json=""

  if [[ "${OPENCLAW_GATEWAY_BIND}" != "loopback" ]]; then
    allowed_origin_json="$(printf '["http://localhost:%s","http://127.0.0.1:%s"]' "$OPENCLAW_GATEWAY_PORT" "$OPENCLAW_GATEWAY_PORT")"
    current_allowed_origins="$(
      run_prestart_cli config get gateway.controlUi.allowedOrigins 2>/dev/null || true
    )"
    current_allowed_origins="${current_allowed_origins//$'\r'/}"
    if [[ -z "$current_allowed_origins" ]]; then
      current_public_origin="$(run_prestart_cli config get gateway.publicOrigin 2>/dev/null || true)"
      if [[ -n "${current_public_origin//[[:space:]]/}" ]]; then
        allowed_origin_json=""
        echo "Control UI origins inherit gateway.publicOrigin; leaving allowedOrigins unset."
      fi
    fi
  fi

  batch_json="$(printf '[{"path":"gateway.mode","value":"local"},{"path":"gateway.bind","value":"%s"}' "$OPENCLAW_GATEWAY_BIND")"
  if [[ -n "$allowed_origin_json" ]]; then
    if [[ -n "$current_allowed_origins" && "$current_allowed_origins" != "null" && "$current_allowed_origins" != "[]" ]]; then
      echo "Control UI allowlist already configured; leaving gateway.controlUi.allowedOrigins unchanged."
    else
      batch_json+=",{\"path\":\"gateway.controlUi.allowedOrigins\",\"value\":$allowed_origin_json}"
    fi
  fi
  batch_json+="]"

  run_prestart_cli config set --batch-json "$batch_json" >/dev/null
  echo "Pinned gateway.mode=local and gateway.bind=$OPENCLAW_GATEWAY_BIND for Docker setup."
  if [[ -n "$allowed_origin_json" ]]; then
    if [[ -z "$current_allowed_origins" || "$current_allowed_origins" == "null" || "$current_allowed_origins" == "[]" ]]; then
      echo "Set gateway.controlUi.allowedOrigins to $allowed_origin_json for non-loopback bind."
    fi
  fi
}

run_compose_one_off() {
  local -a run_args=(run)
  if [[ -n "$OFFLINE_MODE" ]]; then
    run_args+=(--pull never)
  fi
  docker compose "${COMPOSE_ARGS[@]}" "${run_args[@]}" "$@"
}

run_prestart_gateway() {
  run_compose_one_off --rm --no-deps "$@"
}

run_prestart_cli() {
  # During setup, avoid the shared-network openclaw-cli service because it
  # requires the gateway container's network namespace to already exist. That
  # creates a circular dependency for config writes that are needed before the
  # gateway can start cleanly.
  # Host OPENCLAW_* paths are Compose bind-mount sources. Setup-time CLI writes
  # must still resolve state/config paths inside the container.
  run_prestart_gateway \
    -e HOME=/home/node \
    -e OPENCLAW_HOME=/home/node \
    -e OPENCLAW_STATE_DIR=/home/node/.openclaw \
    -e OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
    -e OPENCLAW_CONFIG_DIR=/home/node/.openclaw \
    -e OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace \
    --entrypoint node openclaw-gateway \
    dist/index.js "$@"
}

run_runtime_cli() {
  local compose_scope="${1:-current}"
  local deps_mode="${2:-with-deps}"
  shift 2

  local -a compose_args
  local -a run_args=(run)
  if [[ -n "$OFFLINE_MODE" ]]; then
    run_args+=(--pull never)
  fi
  run_args+=(--rm)

  case "$compose_scope" in
    current) compose_args=("${COMPOSE_ARGS[@]}") ;;
    base) compose_args=("${BASE_COMPOSE_ARGS[@]}") ;;
    *) fail "Unknown runtime CLI compose scope: $compose_scope" ;;
  esac

  case "$deps_mode" in
    with-deps) ;;
    no-deps) run_args+=(--no-deps) ;;
    *) fail "Unknown runtime CLI deps mode: $deps_mode" ;;
  esac

  docker compose "${compose_args[@]}" "${run_args[@]}" openclaw-cli "$@"
}

run_gateway_up() {
  local compose_scope="${1:-current}"
  shift

  local -a compose_args
  local -a up_args=(up -d)

  case "$compose_scope" in
    current) compose_args=("${COMPOSE_ARGS[@]}") ;;
    base) compose_args=("${BASE_COMPOSE_ARGS[@]}") ;;
    *) fail "Unknown gateway compose scope: $compose_scope" ;;
  esac

  if [[ -n "$OFFLINE_MODE" ]]; then
    up_args+=(--pull never --no-build)
  fi
  up_args+=("$@")

  docker compose "${compose_args[@]}" "${up_args[@]}" openclaw-gateway
}

resolve_offline_sandbox_images() {
  local agents_json sandbox_tools_json
  agents_json="$(run_prestart_cli config get agents --json 2>/dev/null || true)"
  if [[ -z "$agents_json" ]]; then
    agents_json="{}"
  fi
  sandbox_tools_json="$(
    run_prestart_cli config get tools.sandbox.tools --json 2>/dev/null || true
  )"
  if [[ -z "$sandbox_tools_json" ]]; then
    sandbox_tools_json="{}"
  fi

  printf '%s' "$agents_json" | run_prestart_gateway \
    -T --entrypoint node openclaw-gateway -e '
const fs = require("node:fs");
const agents = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const globalToolPolicy = JSON.parse(process.argv[3] || "{}");
const defaultSandbox = agents?.defaults?.sandbox ?? {};
const defaultDockerImage = defaultSandbox?.docker?.image ?? process.argv[1];
const defaultBrowserImage = defaultSandbox?.browser?.image ?? process.argv[2];
const images = new Set();
const configuredEntries = Object.values(agents?.entries ?? {}).filter(
  (entry) => entry !== null && typeof entry === "object",
);
const entries = configuredEntries.length > 0 ? configuredEntries : [{ sandbox: {} }];

const matchesBrowser = (rawPattern) => {
  const pattern = String(rawPattern ?? "").trim().toLowerCase();
  if (pattern === "group:openclaw" || pattern === "group:ui") {
    return true;
  }
  if (!pattern) {
    return false;
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`).test("browser");
};
const permitsBrowser = (entry) => {
  const agentPolicy = entry?.tools?.sandbox?.tools ?? {};
  const allow = Array.isArray(agentPolicy.allow)
    ? agentPolicy.allow
    : Array.isArray(globalToolPolicy?.allow)
      ? globalToolPolicy.allow
      : undefined;
  const alsoAllow = Array.isArray(agentPolicy.alsoAllow)
    ? agentPolicy.alsoAllow
    : Array.isArray(globalToolPolicy?.alsoAllow)
      ? globalToolPolicy.alsoAllow
      : undefined;
  const deny = Array.isArray(agentPolicy.deny)
    ? agentPolicy.deny
    : Array.isArray(globalToolPolicy?.deny)
      ? globalToolPolicy.deny
      : undefined;

  // Browser is absent from the default allowlist and present in the default
  // denylist. Explicit allow patterns re-enable it unless an explicit deny wins.
  const explicitAllows = [...(allow ?? []), ...(alsoAllow ?? [])];
  const allowedByAllowlist = Array.isArray(allow)
    ? allow.length === 0 || explicitAllows.some(matchesBrowser)
    : (alsoAllow ?? []).some(matchesBrowser);
  const denied = Array.isArray(deny)
    ? deny.some(matchesBrowser)
    : !explicitAllows.some(matchesBrowser);
  return allowedByAllowlist && !denied;
};

for (const entry of entries) {
  const sandbox = entry?.sandbox ?? {};
  const mode = sandbox.mode ?? "non-main";
  const backend = (
    sandbox.backend?.trim() ||
    defaultSandbox.backend?.trim() ||
    "docker"
  ).toLowerCase();
  if (mode === "off" || backend !== "docker") {
    continue;
  }

  // Setup writes defaults scope=agent. Explicit per-agent scope still wins,
  // and shared scope intentionally ignores per-agent Docker/browser overrides.
  const scope = sandbox.scope ?? "agent";
  const agentDocker = scope === "shared" ? undefined : sandbox.docker;
  images.add(`sandbox\t${agentDocker?.image ?? defaultDockerImage}`);

  const agentBrowser = scope === "shared" ? undefined : sandbox.browser;
  const browserEnabled = agentBrowser?.enabled ?? defaultSandbox?.browser?.enabled ?? false;
  if (browserEnabled && permitsBrowser(entry)) {
    images.add(`browser\t${agentBrowser?.image ?? defaultBrowserImage}`);
  }
}
process.stdout.write([...images].join("\n"));
' "$DEFAULT_SANDBOX_IMAGE" "$DEFAULT_SANDBOX_BROWSER_IMAGE" "$sandbox_tools_json"
}

validate_offline_sandbox_prerequisites() {
  if [[ ! -S "$DOCKER_SOCKET_PATH" ]]; then
    fail "Offline sandbox setup requires a Docker socket at $DOCKER_SOCKET_PATH."
  fi

  local sandbox_images
  sandbox_images="$(resolve_offline_sandbox_images)"
  local -a sandbox_image_errors=()
  local image_kind sandbox_image browser_contract
  while IFS=$'\t' read -r image_kind sandbox_image; do
    [[ -n "$image_kind" ]] || continue
    case "$image_kind" in
      sandbox)
        if ! docker --host "unix://$DOCKER_SOCKET_PATH" image inspect "$sandbox_image" >/dev/null 2>&1; then
          sandbox_image_errors+=("$sandbox_image (missing)")
        fi
        ;;
      browser)
        if ! browser_contract="$(
          docker --host "unix://$DOCKER_SOCKET_PATH" image inspect \
            -f '{{ index .Config.Labels "org.openclaw.sandbox-browser.contract" }}' \
            "$sandbox_image" 2>/dev/null
        )"; then
          sandbox_image_errors+=("$sandbox_image (missing)")
        elif [[ "$browser_contract" != "$SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH" ]]; then
          sandbox_image_errors+=(
            "$sandbox_image (browser contract=${browser_contract:-missing}, expected=$SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH)"
          )
        fi
        ;;
      *)
        fail "Unknown offline sandbox image kind: $image_kind"
        ;;
    esac
  done <<<"$sandbox_images"

  if [[ ${#sandbox_image_errors[@]} -gt 0 ]]; then
    echo "WARNING: offline Docker setup cannot use required sandbox images:" >&2
    local sandbox_image_error
    for sandbox_image_error in "${sandbox_image_errors[@]}"; do
      echo "  - $sandbox_image_error" >&2
    done
    echo "  Load them with 'docker load -i <sandbox-image.tar>' before enabling sandboxed agents." >&2
    fail "Offline sandbox prerequisites are incomplete; sandbox configuration was not changed."
  fi

  echo "Using preloaded sandbox images:"
  while IFS=$'\t' read -r _ sandbox_image; do
    if [[ -n "$sandbox_image" ]]; then
      echo "  - $sandbox_image"
    fi
  done <<<"$sandbox_images"

  if ! run_compose_one_off --rm --entrypoint docker openclaw-gateway --version >/dev/null 2>&1; then
    fail "Offline sandbox setup requires Docker CLI in $IMAGE_NAME."
  fi
}

contains_disallowed_chars() {
  local value="$1"
  [[ "$value" == *$'\n'* || "$value" == *$'\r'* || "$value" == *$'\t'* ]]
}

is_valid_timezone_in_image() {
  local value="$1"
  docker run --rm --network none --entrypoint node "$IMAGE_NAME" -e '
const timezone = process.argv[1];
try {
  new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
} catch {
  process.exit(1);
}
' "$value"
}

validate_mount_path_value() {
  local label="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    fail "$label cannot be empty."
  fi
  if contains_disallowed_chars "$value"; then
    fail "$label contains unsupported control characters."
  fi
}

validate_named_volume() {
  local value="$1"
  if [[ ! "$value" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
    fail "OPENCLAW_HOME_VOLUME must match [A-Za-z0-9][A-Za-z0-9_.-]* when using a named volume."
  fi
}

validate_mount_spec() {
  local mount="$1"
  if contains_disallowed_chars "$mount"; then
    fail "OPENCLAW_EXTRA_MOUNTS entries cannot contain control characters."
  fi
  # Keep mount specs strict to avoid YAML structure injection.
  # Expected format: source:target[:options]
  if [[ ! "$mount" =~ ^[^,:]+:[^,:]+(:[^,:]+)?$ ]]; then
    fail "Invalid mount format '$mount'. Expected source:target[:options] without commas or control characters."
  fi
}

quote_yaml_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

# Used both before host-side reads of retained state and after Compose mounts
# are ready. Pass IDs and excluded extra mounts as arguments, never shell code.
OWNERSHIP_REPAIR='
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH
owner=$1
repair_home=$2
shift 2
repair_tree() {
  tree=$1
  policy=$2
  shift 2
  [ -d "$tree" ] && [ ! -L "$tree" ] || return 0
  # Same-device bind mounts need explicit pruning. Also skip direct repairs of
  # metadata below an extra mount, rather than entering it through another root.
  for excluded in "$@"; do
    excluded="$(/usr/bin/realpath -m -s -- "$excluded")"
    [ "$excluded" != / ] || return 0
    case "$tree/" in "$excluded/"*) return 0 ;; esac
    excluded_pattern="$(printf "%s" "$excluded" | /usr/bin/sed "s/[][?*\\\\]/\\\\&/g")"
    set -- "$@" -path "$excluded_pattern" -prune -o
    shift
  done
  case "$policy" in
    point) set -- -maxdepth 0 "$@" ;;
    home) set -- "$@" -path /home/node/.openclaw -prune -o -path /home/node/.config/openclaw -prune -o ;;
    state) set -- "$@" \( ! -path /home/node/.openclaw/workspace -o -prune \) ;;
  esac
  /usr/bin/find -P "$tree" -xdev "$@" -execdir /usr/bin/chown -h "$owner" {} +
}
if [ "$repair_home" = home ]; then
  repair_tree /home/node point "$@"
  for home_tree in /home/node/.cache /home/node/.config /home/node/.local /home/node/.npm /home/node/.bun /home/node/.pnpm-store; do
    repair_tree "$home_tree" home "$@"
  done
fi
# Select the workspace mount point itself, but leave project descendants alone.
repair_tree /home/node/.openclaw state "$@"
repair_tree /home/node/.config/openclaw tree "$@"
repair_tree /home/node/.openclaw/workspace/.openclaw tree "$@"
'

resolve_container_identity() {
  local default_uid=1000 default_gid=1000 security_options
  HOST_UID="$(id -u)"
  HOST_GID="$(id -g)"
  HOST_IDENTITY_MAPPING=""
  if [[ "$(uname -s)" == Linux && "$HOST_UID" != 0 ]]; then
    # An unreadable daemon must not silently select a potentially unsafe mapping.
    security_options="$(docker info --format '{{json .SecurityOptions}}')" || fail "Cannot inspect Docker user namespace settings. Check access to the Docker daemon."
    if [[ "$security_options" != *rootless* && "$security_options" != *userns* ]]; then
      default_uid="$HOST_UID"
      default_gid="$HOST_GID"
      HOST_IDENTITY_MAPPING=1
    fi
  fi
  OPENCLAW_UID="${OPENCLAW_UID:-$(read_env_value "$ROOT_DIR/.env" OPENCLAW_UID)}"
  OPENCLAW_GID="${OPENCLAW_GID:-$(read_env_value "$ROOT_DIR/.env" OPENCLAW_GID)}"
  OPENCLAW_UID="${OPENCLAW_UID:-$default_uid}"
  OPENCLAW_GID="${OPENCLAW_GID:-$default_gid}"
  local key value
  for key in OPENCLAW_UID OPENCLAW_GID; do
    value="${!key}"
    if [[ ! "$value" =~ ^(0|[1-9][0-9]{0,9})$ ]] || ((value > 4294967294)); then
      fail "$key must be a decimal ID between 0 and 4294967294."
    fi
  done
  export OPENCLAW_UID OPENCLAW_GID
  if [[ -z "${OPENCLAW_HOME_VOLUME+x}" ]]; then
    HOME_VOLUME_NAME="$(read_env_value "$ROOT_DIR/.env" OPENCLAW_HOME_VOLUME)"
  fi
  if [[ -z "$HOME_VOLUME_NAME" && "$OPENCLAW_UID:$OPENCLAW_GID" != 1000:1000 ]]; then
    local checkout_checksum
    checkout_checksum="$(printf '%s' "$ROOT_DIR" | cksum)"
    HOME_VOLUME_NAME="openclaw-home-${checkout_checksum%% *}"
  fi
  echo "==> Container identity: $OPENCLAW_UID:$OPENCLAW_GID"
}

recover_host_directories() {
  # Docker namespace remapping does not expose host IDs directly. Keep its
  # existing ownership policy instead of chowning to unmapped host IDs.
  [[ -n "$HOST_IDENTITY_MAPPING" ]] || return 0
  local source destination
  local -a mounts=()
  for destination in /home/node/.openclaw /home/node/.openclaw/workspace /home/node/.config/openclaw; do
    case "$destination" in
      /home/node/.openclaw) source="$OPENCLAW_CONFIG_DIR" ;;
      /home/node/.openclaw/workspace) source="$OPENCLAW_WORKSPACE_DIR" ;;
      *) source="$OPENCLAW_AUTH_PROFILE_SECRET_DIR" ;;
    esac
    if [[ -d "$source" ]]; then
      mounts+=(--mount "type=bind,\"source=${source//\"/\"\"}\",target=$destination")
    fi
  done
  [[ ${#mounts[@]} -gt 0 ]] || return 0
  echo "==> Restoring host access to retained OpenClaw data"
  if ! docker run --rm --pull never --network none --user root \
    "${mounts[@]}" --entrypoint sh "$IMAGE_NAME" -c "$OWNERSHIP_REPAIR" \
    ownership-repair "$HOST_UID:$HOST_GID" "" ${OWNERSHIP_EXCLUSIONS[@]+"${OWNERSHIP_EXCLUSIONS[@]}"}; then
    fail "Cannot restore host access to $OPENCLAW_CONFIG_DIR, $OPENCLAW_WORKSPACE_DIR, or $OPENCLAW_AUTH_PROFILE_SECRET_DIR. Check bind-mount access and Docker permissions, then rerun setup."
  fi
}

require_cmd docker
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose not available (try: docker compose version)" >&2
  exit 1
fi

resolve_container_identity

OWNERSHIP_EXCLUSIONS=()
VALID_MOUNTS=()
if contains_disallowed_chars "$EXTRA_MOUNTS"; then
  fail "OPENCLAW_EXTRA_MOUNTS cannot contain control characters."
fi
if [[ -n "$EXTRA_MOUNTS" ]]; then
  IFS=',' read -r -a identity_mounts <<<"$EXTRA_MOUNTS"
  for identity_mount in "${identity_mounts[@]}"; do
    identity_mount="${identity_mount#"${identity_mount%%[![:space:]]*}"}"
    identity_mount="${identity_mount%"${identity_mount##*[![:space:]]}"}"
    [[ -n "$identity_mount" ]] || continue
    validate_mount_spec "$identity_mount"
    VALID_MOUNTS+=("$identity_mount")
    identity_destination="${identity_mount#*:}"
    OWNERSHIP_EXCLUSIONS+=("${identity_destination%%:*}")
  done
fi

if [[ -z "$DOCKER_SOCKET_PATH" && "${DOCKER_HOST:-}" == unix://* ]]; then
  DOCKER_SOCKET_PATH="${DOCKER_HOST#unix://}"
fi
if [[ -z "$DOCKER_SOCKET_PATH" ]]; then
  DOCKER_SOCKET_PATH="/var/run/docker.sock"
fi
if is_truthy_value "$RAW_SANDBOX_SETTING"; then
  SANDBOX_ENABLED="1"
fi
if is_truthy_value "$RAW_SKIP_ONBOARDING"; then
  SKIP_ONBOARDING="1"
fi

OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}"
OPENCLAW_AUTH_PROFILE_SECRET_DIR="${OPENCLAW_AUTH_PROFILE_SECRET_DIR:-$HOME/.openclaw-auth-profile-secrets}"

validate_mount_path_value "OPENCLAW_CONFIG_DIR" "$OPENCLAW_CONFIG_DIR"
validate_mount_path_value "OPENCLAW_WORKSPACE_DIR" "$OPENCLAW_WORKSPACE_DIR"
validate_mount_path_value "OPENCLAW_AUTH_PROFILE_SECRET_DIR" "$OPENCLAW_AUTH_PROFILE_SECRET_DIR"
# A custom workspace nested in config is also visible at its original path,
# in addition to the canonical workspace bind mount. Protect that alias too.
if [[ "$OPENCLAW_WORKSPACE_DIR" == "$OPENCLAW_CONFIG_DIR/"* && "$OPENCLAW_WORKSPACE_DIR" != "$OPENCLAW_CONFIG_DIR/workspace" ]]; then
  OWNERSHIP_EXCLUSIONS+=("/home/node/.openclaw/${OPENCLAW_WORKSPACE_DIR#"$OPENCLAW_CONFIG_DIR/"}")
fi
if [[ -n "$HOME_VOLUME_NAME" ]]; then
  if [[ "$HOME_VOLUME_NAME" == *"/"* ]]; then
    validate_mount_path_value "OPENCLAW_HOME_VOLUME" "$HOME_VOLUME_NAME"
  else
    validate_named_volume "$HOME_VOLUME_NAME"
  fi
fi
if [[ -n "$SANDBOX_ENABLED" ]]; then
  validate_mount_path_value "OPENCLAW_DOCKER_SOCKET" "$DOCKER_SOCKET_PATH"
fi
if [[ -n "$TIMEZONE" ]]; then
  if contains_disallowed_chars "$TIMEZONE"; then
    fail "OPENCLAW_TZ contains unsupported control characters."
  fi
  if [[ ! "$TIMEZONE" =~ ^[A-Za-z0-9/_+\-]+$ ]]; then
    fail "OPENCLAW_TZ must be a valid IANA timezone string (e.g. Asia/Shanghai)."
  fi
fi

export OPENCLAW_CONFIG_DIR
export OPENCLAW_WORKSPACE_DIR
export OPENCLAW_AUTH_PROFILE_SECRET_DIR
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
export OPENCLAW_BRIDGE_PORT="${OPENCLAW_BRIDGE_PORT:-18790}"
export OPENCLAW_GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-lan}"
export OPENCLAW_DISABLE_BONJOUR="${OPENCLAW_DISABLE_BONJOUR:-}"
export OPENCLAW_IMAGE="$IMAGE_NAME"
export OPENCLAW_IMAGE_APT_PACKAGES="${OPENCLAW_IMAGE_APT_PACKAGES-${OPENCLAW_DOCKER_APT_PACKAGES:-}}"
export OPENCLAW_IMAGE_PIP_PACKAGES="${OPENCLAW_IMAGE_PIP_PACKAGES:-}"
export OPENCLAW_EXTENSIONS="${OPENCLAW_EXTENSIONS:-}"
export OPENCLAW_DOCKER_BUILD_NODE_OPTIONS="${OPENCLAW_DOCKER_BUILD_NODE_OPTIONS---max-old-space-size=8192}"
export OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB="${OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB:-}"
export OPENCLAW_DOCKER_BUILD_SKIP_DTS="${OPENCLAW_DOCKER_BUILD_SKIP_DTS:-1}"
export OPENCLAW_INSTALL_BROWSER="${OPENCLAW_INSTALL_BROWSER:-}"
export OPENCLAW_EXTRA_MOUNTS="$EXTRA_MOUNTS"
export OPENCLAW_HOME_VOLUME="$HOME_VOLUME_NAME"
export OPENCLAW_ALLOW_INSECURE_PRIVATE_WS="${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-}"
export OPENCLAW_SANDBOX="$SANDBOX_ENABLED"
export OPENCLAW_DOCKER_SOCKET="$DOCKER_SOCKET_PATH"
export OPENCLAW_DOCKER_SETUP=1
export OPENCLAW_TZ="$TIMEZONE"
export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-}"
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:-}"
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT="${OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:-}"
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT="${OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:-}"
export OTEL_EXPORTER_OTLP_PROTOCOL="${OTEL_EXPORTER_OTLP_PROTOCOL:-}"
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL="${OTEL_EXPORTER_OTLP_TRACES_PROTOCOL:-}"
export OTEL_EXPORTER_OTLP_METRICS_PROTOCOL="${OTEL_EXPORTER_OTLP_METRICS_PROTOCOL:-}"
export OTEL_EXPORTER_OTLP_LOGS_PROTOCOL="${OTEL_EXPORTER_OTLP_LOGS_PROTOCOL:-}"
export OTEL_SERVICE_NAME="${OTEL_SERVICE_NAME:-}"
export OTEL_SEMCONV_STABILITY_OPT_IN="${OTEL_SEMCONV_STABILITY_OPT_IN:-}"
export OPENCLAW_OTEL_PRELOADED="${OPENCLAW_OTEL_PRELOADED:-}"
export OPENCLAW_SKIP_ONBOARDING="$SKIP_ONBOARDING"

DOCKER_GID=""
if [[ -n "$SANDBOX_ENABLED" && -S "$DOCKER_SOCKET_PATH" ]]; then
  DOCKER_GID="$(stat -c '%g' "$DOCKER_SOCKET_PATH" 2>/dev/null || stat -f '%g' "$DOCKER_SOCKET_PATH" 2>/dev/null || echo "")"
fi
export DOCKER_GID

# When sandbox is requested, ensure Docker CLI build arg is set for local builds.
# Docker socket mount is deferred until sandbox prerequisites are verified.
if [[ -n "$SANDBOX_ENABLED" ]]; then
  if [[ -z "${OPENCLAW_INSTALL_DOCKER_CLI:-}" ]]; then
    export OPENCLAW_INSTALL_DOCKER_CLI=1
  fi
fi

if [[ -n "$OFFLINE_MODE" ]]; then
  require_local_docker_image "$IMAGE_NAME"
  echo "==> Using preloaded Docker image: $IMAGE_NAME"
elif [[ "$IMAGE_NAME" == "openclaw:local" ]]; then
  echo "==> Building Docker image: $IMAGE_NAME"
  BUILD_GIT_COMMIT="$(openclaw_resolve_git_commit "$ROOT_DIR")"
  BUILD_TIMESTAMP="$(openclaw_resolve_build_timestamp)"
  PROVENANCE_BUILD_ARGS=(--build-arg "OPENCLAW_BUILD_TIMESTAMP=${BUILD_TIMESTAMP}")
  if [[ "$BUILD_GIT_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]]; then
    PROVENANCE_BUILD_ARGS+=(--build-arg "GIT_COMMIT=${BUILD_GIT_COMMIT}")
  fi
  docker_build_exec \
    "${PROVENANCE_BUILD_ARGS[@]}" \
    --build-arg "OPENCLAW_IMAGE_APT_PACKAGES=${OPENCLAW_IMAGE_APT_PACKAGES}" \
    --build-arg "OPENCLAW_IMAGE_PIP_PACKAGES=${OPENCLAW_IMAGE_PIP_PACKAGES}" \
    --build-arg "OPENCLAW_EXTENSIONS=${OPENCLAW_EXTENSIONS}" \
    --build-arg "OPENCLAW_DOCKER_BUILD_NODE_OPTIONS=${OPENCLAW_DOCKER_BUILD_NODE_OPTIONS}" \
    --build-arg "OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB=${OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB}" \
    --build-arg "OPENCLAW_DOCKER_BUILD_SKIP_DTS=${OPENCLAW_DOCKER_BUILD_SKIP_DTS}" \
    --build-arg "OPENCLAW_INSTALL_BROWSER=${OPENCLAW_INSTALL_BROWSER}" \
    --build-arg "OPENCLAW_INSTALL_DOCKER_CLI=${OPENCLAW_INSTALL_DOCKER_CLI:-}" \
    -t "$IMAGE_NAME" \
    -f "$ROOT_DIR/Dockerfile" \
    "$ROOT_DIR"
else
  echo "==> Pulling Docker image: $IMAGE_NAME"
  if ! run_docker_pull "$IMAGE_NAME"; then
    echo "ERROR: Failed to pull image $IMAGE_NAME. Please check the image name and your access permissions." >&2
    exit 1
  fi
fi

if [[ -n "$TIMEZONE" ]] && ! is_valid_timezone_in_image "$TIMEZONE"; then
  fail "OPENCLAW_TZ must be supported by $IMAGE_NAME (e.g. Asia/Shanghai)."
fi

recover_host_directories

mkdir -p "$OPENCLAW_CONFIG_DIR"
mkdir -p "$OPENCLAW_WORKSPACE_DIR"
mkdir -p "$OPENCLAW_AUTH_PROFILE_SECRET_DIR"
# Seed directory tree eagerly so bind mounts work even on Docker Desktop/Windows
# where the container (even as root) cannot create new host subdirectories.
mkdir -p "$OPENCLAW_CONFIG_DIR/identity"
mkdir -p "$OPENCLAW_CONFIG_DIR/agents/main/agent"
mkdir -p "$OPENCLAW_CONFIG_DIR/agents/main/sessions"

if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  EXISTING_CONFIG_TOKEN="$(read_config_gateway_token || true)"
  if [[ -n "$EXISTING_CONFIG_TOKEN" ]]; then
    OPENCLAW_GATEWAY_TOKEN="$EXISTING_CONFIG_TOKEN"
    echo "Reusing gateway token from $OPENCLAW_CONFIG_DIR/openclaw.json"
  else
    DOTENV_GATEWAY_TOKEN="$(read_env_value "$ROOT_DIR/.env" OPENCLAW_GATEWAY_TOKEN || true)"
    if [[ -n "$DOTENV_GATEWAY_TOKEN" ]]; then
      OPENCLAW_GATEWAY_TOKEN="$DOTENV_GATEWAY_TOKEN"
      echo "Reusing gateway token from $ROOT_DIR/.env"
    elif command -v openssl >/dev/null 2>&1; then
      OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 32)"
    else
      OPENCLAW_GATEWAY_TOKEN="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
    fi
  fi
fi
export OPENCLAW_GATEWAY_TOKEN

COMPOSE_FILES=("$COMPOSE_FILE")
COMPOSE_ARGS=()

write_extra_compose() {
  local home_volume="$1"
  shift
  local mount service
  local home_mounts=()

  if [[ -n "$home_volume" ]]; then
    home_mounts=(
      "${home_volume}:/home/node"
      "${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw"
      "${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace"
      "${OPENCLAW_AUTH_PROFILE_SECRET_DIR}:/home/node/.config/openclaw"
    )
  fi

  printf 'services:\n' >"$EXTRA_COMPOSE_FILE"
  for service in openclaw-gateway openclaw-cli; do
    printf '  %s:\n    volumes:\n' "$service" >>"$EXTRA_COMPOSE_FILE"
    if [[ -n "$home_volume" ]]; then
      if [[ "$service" == "openclaw-gateway" ]]; then
        for mount in "${home_mounts[@]}"; do
          validate_mount_spec "$mount"
        done
      fi
      for mount in "${home_mounts[@]}"; do
        printf '      - %s\n' "$(quote_yaml_string "$mount")" >>"$EXTRA_COMPOSE_FILE"
      done
    fi
    for mount in "$@"; do
      validate_mount_spec "$mount"
      printf '      - %s\n' "$(quote_yaml_string "$mount")" >>"$EXTRA_COMPOSE_FILE"
    done
  done

  if [[ -n "$home_volume" && "$home_volume" != *"/"* ]]; then
    validate_named_volume "$home_volume"
    cat >>"$EXTRA_COMPOSE_FILE" <<YAML
volumes:
  ${home_volume}:
YAML
  fi
}

if [[ -n "$HOME_VOLUME_NAME" || ${#VALID_MOUNTS[@]} -gt 0 ]]; then
  # Bash 3.2 + nounset treats "${array[@]}" on an empty array as unbound.
  if [[ ${#VALID_MOUNTS[@]} -gt 0 ]]; then
    write_extra_compose "$HOME_VOLUME_NAME" "${VALID_MOUNTS[@]}"
  else
    write_extra_compose "$HOME_VOLUME_NAME"
  fi
  COMPOSE_FILES+=("$EXTRA_COMPOSE_FILE")
fi
for compose_file in "${COMPOSE_FILES[@]}"; do
  COMPOSE_ARGS+=("-f" "$compose_file")
done
# Keep a base compose arg set without sandbox overlay so rollback paths can
# force a known-safe gateway service definition (no docker.sock mount).
BASE_COMPOSE_ARGS=("${COMPOSE_ARGS[@]}")
COMPOSE_HINT="docker compose"
for compose_file in "${COMPOSE_FILES[@]}"; do
  COMPOSE_HINT+=" -f ${compose_file}"
done

ENV_FILE="$ROOT_DIR/.env"
upsert_env() {
  local file="$1"
  shift
  local -a keys=("$@")
  local tmp
  tmp="$(mktemp)"
  # Use a delimited string instead of an associative array so the script
  # works with Bash 3.2 (macOS default) which lacks `declare -A`.
  local seen=" "

  if [[ -f "$file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      local key="${line%%=*}"
      local replaced=false
      for k in "${keys[@]}"; do
        if [[ "$key" == "$k" ]]; then
          printf '%s=%s\n' "$k" "${!k-}" >>"$tmp"
          seen="$seen$k "
          replaced=true
          break
        fi
      done
      if [[ "$replaced" == false ]]; then
        printf '%s\n' "$line" >>"$tmp"
      fi
    done <"$file"
  fi

  for k in "${keys[@]}"; do
    if [[ "$seen" != *" $k "* ]]; then
      printf '%s=%s\n' "$k" "${!k-}" >>"$tmp"
    fi
  done

  mv "$tmp" "$file"
}

upsert_env "$ENV_FILE" \
  OPENCLAW_UID \
  OPENCLAW_GID \
  OPENCLAW_CONFIG_DIR \
  OPENCLAW_WORKSPACE_DIR \
  OPENCLAW_AUTH_PROFILE_SECRET_DIR \
  OPENCLAW_GATEWAY_PORT \
  OPENCLAW_BRIDGE_PORT \
  OPENCLAW_GATEWAY_BIND \
  OPENCLAW_DISABLE_BONJOUR \
  OPENCLAW_GATEWAY_TOKEN \
  OPENCLAW_IMAGE \
  OPENCLAW_EXTRA_MOUNTS \
  OPENCLAW_HOME_VOLUME \
  OPENCLAW_IMAGE_APT_PACKAGES \
  OPENCLAW_IMAGE_PIP_PACKAGES \
  OPENCLAW_EXTENSIONS \
  OPENCLAW_DOCKER_BUILD_NODE_OPTIONS \
  OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB \
  OPENCLAW_DOCKER_BUILD_SKIP_DTS \
  OPENCLAW_INSTALL_BROWSER \
  OPENCLAW_SANDBOX \
  OPENCLAW_DOCKER_SOCKET \
  DOCKER_GID \
  OPENCLAW_INSTALL_DOCKER_CLI \
  OPENCLAW_ALLOW_INSECURE_PRIVATE_WS \
  OPENCLAW_TZ \
  OTEL_EXPORTER_OTLP_ENDPOINT \
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT \
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT \
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT \
  OTEL_EXPORTER_OTLP_PROTOCOL \
  OTEL_EXPORTER_OTLP_TRACES_PROTOCOL \
  OTEL_EXPORTER_OTLP_METRICS_PROTOCOL \
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL \
  OTEL_SERVICE_NAME \
  OTEL_SEMCONV_STABILITY_OPT_IN \
  OPENCLAW_OTEL_PRELOADED \
  OPENCLAW_SKIP_ONBOARDING

echo ""
echo "==> Fixing data-directory permissions"
if ! run_prestart_gateway --user root --entrypoint sh openclaw-gateway -c "$OWNERSHIP_REPAIR" \
  ownership-repair "$OPENCLAW_UID:$OPENCLAW_GID" "${HOME_VOLUME_NAME:+home}" ${OWNERSHIP_EXCLUSIONS[@]+"${OWNERSHIP_EXCLUSIONS[@]}"}; then
  fail "Cannot repair OpenClaw data-directory permissions for $OPENCLAW_UID:$OPENCLAW_GID. Check bind mounts and Docker permissions, then rerun setup."
fi

echo ""
if [[ -n "$SKIP_ONBOARDING" ]]; then
  echo "==> Skipping onboarding (OPENCLAW_SKIP_ONBOARDING is set)"
else
  echo "==> Onboarding (interactive)"
  echo "Docker setup pins Gateway mode to local."
  echo "Gateway runtime bind comes from OPENCLAW_GATEWAY_BIND (default: lan)."
  echo "Current runtime bind: $OPENCLAW_GATEWAY_BIND"
  if is_truthy_value "$OPENCLAW_DISABLE_BONJOUR"; then
    echo "Bonjour/mDNS advertising: force disabled (OPENCLAW_DISABLE_BONJOUR=$OPENCLAW_DISABLE_BONJOUR)."
  elif [[ -z "$OPENCLAW_DISABLE_BONJOUR" ]]; then
    echo "Bonjour/mDNS advertising: auto (disabled inside the Gateway container unless explicitly enabled)."
  else
    echo "Bonjour/mDNS advertising: explicitly enabled (OPENCLAW_DISABLE_BONJOUR=$OPENCLAW_DISABLE_BONJOUR)."
  fi
  echo "Gateway token: stored in Docker environment/config (not printed)."
  echo "Tailscale exposure: Off (use host-level tailnet/Tailscale setup separately)."
  echo "Install Gateway daemon: No (managed by Docker Compose)"
  echo ""
  run_prestart_cli onboard \
    --mode local \
    --no-install-daemon \
    --gateway-auth token \
    --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
    --skip-ui \
    --suppress-gateway-token-output
fi

echo ""
echo "==> Docker gateway defaults"
sync_gateway_config

echo ""
echo "==> Provider setup (optional)"
echo "WhatsApp (QR):"
echo "  ${COMPOSE_HINT} run --rm openclaw-cli channels login"
echo "Telegram (bot token):"
echo "  ${COMPOSE_HINT} run --rm openclaw-cli channels add --channel telegram --token <token>"
echo "Discord (bot token):"
echo "  ${COMPOSE_HINT} run --rm openclaw-cli channels add --channel discord --token <token>"
echo "Docs: https://docs.openclaw.ai/channels"

if [[ -n "$SANDBOX_ENABLED" && -n "$OFFLINE_MODE" ]]; then
  echo ""
  echo "==> Sandbox preflight"
  validate_offline_sandbox_prerequisites
fi

echo ""
echo "==> Starting gateway"
run_gateway_up current

if [[ -n "$SANDBOX_ENABLED" ]]; then
  echo ""
  echo "==> Sandbox setup"

  sandbox_dockerfile="$ROOT_DIR/scripts/docker/sandbox/Dockerfile"
  if [[ -z "$OFFLINE_MODE" && ! -S "$DOCKER_SOCKET_PATH" ]]; then
    echo "WARNING: OPENCLAW_SANDBOX enabled but Docker socket not found at $DOCKER_SOCKET_PATH." >&2
    echo "  Sandbox requires Docker socket access. Skipping sandbox setup." >&2
    SANDBOX_ENABLED=""
  fi

  if [[ -n "$SANDBOX_ENABLED" && -z "$OFFLINE_MODE" && -f "$sandbox_dockerfile" ]]; then
    echo "Building sandbox image: $DEFAULT_SANDBOX_IMAGE"
    docker_build_exec \
      -t "$DEFAULT_SANDBOX_IMAGE" \
      -f "$sandbox_dockerfile" \
      "$ROOT_DIR"
  elif [[ -n "$SANDBOX_ENABLED" && -z "$OFFLINE_MODE" ]]; then
    echo "WARNING: sandbox Dockerfile not found at $sandbox_dockerfile" >&2
    echo "  Sandbox config will be applied but no sandbox image will be built." >&2
    echo "  Agent exec may fail if the configured sandbox image does not exist." >&2
  fi

  # Defense-in-depth: verify Docker CLI in the running image before enabling
  # sandbox. This avoids claiming sandbox is enabled when the image cannot
  # launch sandbox containers.
  if [[ -n "$SANDBOX_ENABLED" && -z "$OFFLINE_MODE" ]] &&
    ! run_compose_one_off --rm --entrypoint docker openclaw-gateway --version >/dev/null 2>&1; then
    echo "WARNING: Docker CLI not found inside the container image." >&2
    echo "  Sandbox requires Docker CLI. Rebuild with --build-arg OPENCLAW_INSTALL_DOCKER_CLI=1" >&2
    echo "  or use a local build (OPENCLAW_IMAGE=openclaw:local). Skipping sandbox setup." >&2
    SANDBOX_ENABLED=""
  fi
fi

# Apply sandbox config only if prerequisites are met.
if [[ -n "$SANDBOX_ENABLED" ]]; then
  # Mount Docker socket via a dedicated compose overlay. This overlay is
  # created only after sandbox prerequisites pass, so the socket is never
  # exposed when sandbox cannot actually run.
  SANDBOX_COMPOSE_FILE="$ROOT_DIR/docker-compose.sandbox.yml"
  cat >"$SANDBOX_COMPOSE_FILE" <<YAML
services:
  openclaw-gateway:
    volumes:
      - $(quote_yaml_string "${DOCKER_SOCKET_PATH}:/var/run/docker.sock")
YAML
  if [[ -n "${DOCKER_GID:-}" ]]; then
    cat >>"$SANDBOX_COMPOSE_FILE" <<YAML
    group_add:
      - "${DOCKER_GID}"
YAML
  fi
  COMPOSE_ARGS+=("-f" "$SANDBOX_COMPOSE_FILE")
  echo "==> Sandbox: added Docker socket mount"
fi

if [[ -n "$SANDBOX_ENABLED" ]]; then
  sandbox_config_ok=true
  for sandbox_setting in mode:non-main scope:agent workspaceAccess:none; do
    sandbox_path="agents.defaults.sandbox.${sandbox_setting%%:*}"
    if ! run_runtime_cli current no-deps \
      config set "$sandbox_path" "${sandbox_setting#*:}" >/dev/null; then
      echo "WARNING: Failed to set $sandbox_path" >&2
      sandbox_config_ok=false
    fi
  done

  if [[ "$sandbox_config_ok" == true ]]; then
    echo "Sandbox enabled: mode=non-main, scope=agent, workspaceAccess=none"
    echo "Docs: https://docs.openclaw.ai/gateway/sandboxing"
    # Restart gateway with sandbox compose overlay to pick up socket mount + config.
    run_gateway_up current
  else
    echo "WARNING: Sandbox config was partially applied. Check errors above." >&2
    echo "  Skipping gateway restart to avoid exposing Docker socket without a full sandbox policy." >&2
    if ! run_runtime_cli base no-deps \
      config set agents.defaults.sandbox.mode "off" >/dev/null; then
      echo "WARNING: Failed to roll back agents.defaults.sandbox.mode to off" >&2
    else
      echo "Sandbox mode rolled back to off due to partial sandbox config failure."
    fi
    if [[ -n "${SANDBOX_COMPOSE_FILE:-}" ]]; then
      rm -f "$SANDBOX_COMPOSE_FILE"
    fi
    # Ensure gateway service definition is reset without sandbox overlay mount.
    run_gateway_up base --force-recreate
  fi
else
  # Keep reruns deterministic: if sandbox is not active for this run, reset
  # persisted sandbox mode so future execs do not require docker.sock by stale
  # config alone.
  if ! run_runtime_cli current with-deps \
    config set agents.defaults.sandbox.mode "off" >/dev/null; then
    echo "WARNING: Failed to reset agents.defaults.sandbox.mode to off" >&2
  fi
  if [[ -f "$ROOT_DIR/docker-compose.sandbox.yml" ]]; then
    rm -f "$ROOT_DIR/docker-compose.sandbox.yml"
  fi
fi

echo ""
echo "Gateway running with host port mapping."
echo "Access from tailnet devices via the host's tailnet IP."
echo "Config: $OPENCLAW_CONFIG_DIR"
echo "Workspace: $OPENCLAW_WORKSPACE_DIR"
echo "Token: stored in Docker environment/config (not printed)."
echo ""
echo "Commands:"
echo "  ${COMPOSE_HINT} logs -f openclaw-gateway"
echo "  ${COMPOSE_HINT} exec openclaw-gateway sh -lc 'node dist/index.js gateway health --token \"\$OPENCLAW_GATEWAY_TOKEN\"'"
