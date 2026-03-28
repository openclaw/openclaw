#!/usr/bin/env bash
# One-time host setup for rootless OpenClaw in Podman. By default, uses the
# current non-root user throughout, builds or pulls the image into that user's
# Podman store, writes config under ~/.openclaw, and uses the repo-local
# launch script at ./scripts/run-openclaw-podman.sh.
#
# With --runas, creates a dedicated service user (default: openclaw), builds
# the image, exports/loads it into that user's Podman store, and installs the
# launch script into their home directory.
#
# Usage: ./scripts/podman/setup.sh [--quadlet|--container] [--runas [username]]
#   --quadlet   Install as an auto-start service (systemd Quadlet on Linux, launchd on macOS)
#   --container Only install image + config; you start the container manually (default)
#   --runas [u] Create/use a dedicated service user (default: openclaw) instead of $USER
#   Or set OPENCLAW_PODMAN_QUADLET=1 (or 0) to choose without a flag.
#
# After this, start the gateway manually:
#   ./scripts/run-openclaw-podman.sh launch
#   ./scripts/run-openclaw-podman.sh launch setup   # onboarding wizard
# Or, if you used --quadlet:
#   systemctl --user start openclaw.service
# With --runas:
#   Linux: sudo -u openclaw /home/openclaw/run-openclaw-podman.sh
#   macOS: sudo -u openclaw /Users/openclaw/run-openclaw-podman.sh
#   Quadlet (Linux): sudo systemctl --machine openclaw@ --user start openclaw.service
#   Quadlet (macOS): sudo launchctl kickstart system/ai.openclaw.podman
set -euo pipefail

REPO_PATH="${OPENCLAW_REPO_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
RUN_SCRIPT_SRC="$REPO_PATH/scripts/run-openclaw-podman.sh"
QUADLET_TEMPLATE="$REPO_PATH/scripts/podman/openclaw.container.in"
OPENCLAW_USER="$(id -un)"
OPENCLAW_HOME="${HOME:-}"
OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-}"
OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-}"
OPENCLAW_IMAGE="${OPENCLAW_PODMAN_IMAGE:-${OPENCLAW_IMAGE:-openclaw:local}}"
OPENCLAW_CONTAINER_NAME="${OPENCLAW_PODMAN_CONTAINER:-openclaw}"
HOST_GATEWAY_PORT="${OPENCLAW_PODMAN_GATEWAY_HOST_PORT:-${OPENCLAW_GATEWAY_PORT:-18789}}"
QUADLET_GATEWAY_PORT="18789"

OS_NAME="$(uname -s 2>/dev/null || echo unknown)"
is_macos() { [[ "$OS_NAME" == "Darwin" ]]; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

is_writable_dir() {
  local dir="$1"
  [[ -n "$dir" && -d "$dir" && ! -L "$dir" && -w "$dir" && -x "$dir" ]]
}

stat_octal_mode() {
  if is_macos; then
    stat -f '%Lp' "$1" 2>/dev/null || true
  else
    stat -Lc '%a' "$1" 2>/dev/null || true
  fi
}

stat_owner_uid() {
  if is_macos; then
    stat -f '%u' "$1" 2>/dev/null || true
  else
    stat -Lc '%u' "$1" 2>/dev/null || true
  fi
}

is_root() { [[ "$(id -u)" -eq 0 ]]; }

is_safe_tmp_base() {
  local dir="$1"
  local mode=""
  local owner=""
  is_writable_dir "$dir" || return 1
  mode="$(stat_octal_mode "$dir")"
  if [[ -n "$mode" ]]; then
    local perm=$((8#$mode))
    if (( (perm & 0022) != 0 && (perm & 01000) == 0 )); then
      return 1
    fi
  fi
  if is_root; then
    owner="$(stat_owner_uid "$dir")"
    if [[ -n "$owner" && "$owner" != "0" ]]; then
      return 1
    fi
  fi
  return 0
}

resolve_image_tmp_dir() {
  if ! is_root && is_safe_tmp_base "${TMPDIR:-}"; then
    printf '%s' "$TMPDIR"
    return 0
  fi
  if is_safe_tmp_base "/var/tmp"; then
    printf '%s' "/var/tmp"
    return 0
  fi
  if is_safe_tmp_base "/tmp"; then
    printf '%s' "/tmp"
    return 0
  fi
  printf '%s' "/tmp"
}

fail() {
  echo "$*" >&2
  exit 1
}

validate_single_line_value() {
  local label="$1"
  local value="$2"
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    fail "Invalid $label: control characters are not allowed."
  fi
}

validate_absolute_path() {
  local label="$1"
  local value="$2"
  validate_single_line_value "$label" "$value"
  [[ "$value" == /* ]] || fail "Invalid $label: expected an absolute path."
  [[ "$value" != *"//"* ]] || fail "Invalid $label: repeated slashes are not allowed."
  [[ "$value" != *"/./"* && "$value" != */. && "$value" != *"/../"* && "$value" != */.. ]] ||
    fail "Invalid $label: dot path segments are not allowed."
}

validate_mount_source_path() {
  local label="$1"
  local value="$2"
  validate_absolute_path "$label" "$value"
  [[ "$value" != *:* ]] || fail "Invalid $label: ':' is not allowed in Podman bind-mount source paths."
}

validate_container_name() {
  local value="$1"
  validate_single_line_value "container name" "$value"
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] ||
    fail "Invalid container name: $value"
}

validate_image_name() {
  local value="$1"
  validate_single_line_value "image name" "$value"
  case "$value" in
    oci-archive:*|docker-archive:*|dir:*|oci:*|containers-storage:*|docker-daemon:*|archive:* )
      fail "Invalid image name: transport prefixes are not allowed: $value"
      ;;
  esac
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] ||
    fail "Invalid image name: $value"
}

ensure_safe_existing_dir() {
  local label="$1"
  local dir="$2"
  validate_absolute_path "$label" "$dir"
  [[ -d "$dir" ]] || fail "Missing $label: $dir"
  [[ ! -L "$dir" ]] || fail "Unsafe $label: symlinks are not allowed ($dir)"
}

stat_uid() {
  local path="$1"
  if stat -f '%u' "$path" >/dev/null 2>&1; then
    stat -f '%u' "$path"
  else
    stat -Lc '%u' "$path"
  fi
}

stat_mode() {
  local path="$1"
  if stat -f '%Lp' "$path" >/dev/null 2>&1; then
    stat -f '%Lp' "$path"
  else
    stat -Lc '%a' "$path"
  fi
}

ensure_private_existing_dir_owned_by_user() {
  local label="$1"
  local dir="$2"
  local uid=""
  local mode=""
  ensure_safe_existing_dir "$label" "$dir"
  uid="$(stat_uid "$dir")"
  [[ "$uid" == "$(id -u)" ]] || fail "Unsafe $label: not owned by current user ($dir)"
  mode="$(stat_mode "$dir")"
  (( (8#$mode & 0022) == 0 )) || fail "Unsafe $label: group/other writable ($dir)"
}

ensure_safe_write_file_path() {
  local label="$1"
  local file="$2"
  local dir
  validate_absolute_path "$label" "$file"
  if [[ -e "$file" ]]; then
    [[ ! -L "$file" ]] || fail "Unsafe $label: symlinks are not allowed ($file)"
    [[ -f "$file" ]] || fail "Unsafe $label: expected a regular file ($file)"
  fi
  dir="$(dirname "$file")"
  ensure_safe_existing_dir "${label} parent directory" "$dir"
}

write_file_atomically() {
  local file="$1"
  local mode="$2"
  local dir=""
  local tmp=""
  ensure_safe_write_file_path "output file" "$file"
  dir="$(dirname "$file")"
  tmp="$(mktemp "$dir/.tmp.XXXXXX")"
  cat >"$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$file"
}

validate_port() {
  local label="$1"
  local value="$2"
  local numeric=""
  [[ "$value" =~ ^[0-9]{1,5}$ ]] || fail "Invalid $label: must be numeric."
  numeric=$((10#$value))
  (( numeric >= 1 && numeric <= 65535 )) || fail "Invalid $label: out of range."
}

escape_sed_replacement_pipe_delim() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

resolve_user_home() {
  local user="$1"
  local home=""
  if is_macos; then
    home="$(dscl . -read "/Users/$user" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || true)"
  elif command -v getent >/dev/null 2>&1; then
    home="$(getent passwd "$user" 2>/dev/null | cut -d: -f6 || true)"
  fi
  if [[ -z "$home" && -f /etc/passwd ]]; then
    home="$(awk -F: -v u="$user" '$1==u {print $6}' /etc/passwd 2>/dev/null || true)"
  fi
  if [[ -z "$home" ]]; then
    if is_macos; then
      home="/Users/$user"
    else
      home="/home/$user"
    fi
  fi
  printf '%s' "$home"
}

generate_token_hex_32() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
    return 0
  fi
  if command -v od >/dev/null 2>&1; then
    od -An -N32 -tx1 /dev/urandom | tr -d " \n"
    return 0
  fi
  echo "Missing dependency: need openssl or python3 (or od) to generate OPENCLAW_GATEWAY_TOKEN." >&2
  exit 1
}

seed_local_control_ui_origins() {
  local file="$1"
  local port="$2"
  local dir=""
  local tmp=""
  ensure_safe_write_file_path "config file" "$file"
  if ! command -v python3 >/dev/null 2>&1; then
    echo "Warning: python3 not found; unable to seed gateway.controlUi.allowedOrigins in $file." >&2
    return 0
  fi
  dir="$(dirname "$file")"
  tmp="$(mktemp "$dir/.config.tmp.XXXXXX")"
  if ! python3 - "$file" "$port" "$tmp" <<'PY'
import json
import sys

path = sys.argv[1]
port = sys.argv[2]
tmp = sys.argv[3]
try:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
except json.JSONDecodeError as exc:
    print(
        f"Warning: unable to seed gateway.controlUi.allowedOrigins in {path}: existing config is not strict JSON ({exc}). Leaving file unchanged.",
        file=sys.stderr,
    )
    raise SystemExit(1)
if not isinstance(data, dict):
    raise SystemExit(f"{path}: expected top-level object")
gateway = data.setdefault("gateway", {})
if not isinstance(gateway, dict):
    raise SystemExit(f"{path}: expected gateway object")
gateway.setdefault("mode", "local")
control_ui = gateway.setdefault("controlUi", {})
if not isinstance(control_ui, dict):
    raise SystemExit(f"{path}: expected gateway.controlUi object")
allowed = control_ui.get("allowedOrigins")
managed_localhosts = {"127.0.0.1", "localhost"}
desired = [
    f"http://127.0.0.1:{port}",
    f"http://localhost:{port}",
]
if not isinstance(allowed, list):
    allowed = []
cleaned = []
for origin in allowed:
    if not isinstance(origin, str):
        continue
    normalized = origin.strip()
    if not normalized:
        continue
    if normalized.startswith("http://"):
        host_port = normalized[len("http://") :]
        host = host_port.split(":", 1)[0]
        if host in managed_localhosts:
            continue
    cleaned.append(normalized)
control_ui["allowedOrigins"] = cleaned + desired
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
PY
  then
    rm -f "$tmp"
    return 0
  fi
  [[ -s "$tmp" ]] || {
    rm -f "$tmp"
    return 0
  }
  chmod 600 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$file"
}

upsert_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp
  local dir
  ensure_safe_write_file_path "env file" "$file"
  dir="$(dirname "$file")"
  tmp="$(mktemp "$dir/.env.tmp.XXXXXX")"
  if [[ -f "$file" ]]; then
    awk -v k="$key" -v v="$value" '
      BEGIN { found = 0 }
      $0 ~ ("^" k "=") { print k "=" v; found = 1; next }
      { print }
      END { if (!found) print k "=" v }
    ' "$file" >"$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >"$tmp"
  fi
  mv "$tmp" "$file"
  chmod 600 "$file" 2>/dev/null || true
}

# --- --runas helpers (only used when a dedicated service user is requested) ---

run_root() {
  if is_root; then
    "$@"
  else
    sudo "$@"
  fi
}

run_as_user() {
  local user="$1"
  shift
  if command -v sudo >/dev/null 2>&1; then
    ( cd /tmp 2>/dev/null || cd /; sudo -u "$user" "$@" )
  elif is_root && command -v runuser >/dev/null 2>&1; then
    ( cd /tmp 2>/dev/null || cd /; runuser -u "$user" -- "$@" )
  else
    echo "Need sudo (or root+runuser) to run commands as $user." >&2
    exit 1
  fi
}

run_as_service_user() {
  run_as_user "$OPENCLAW_USER" env HOME="$OPENCLAW_HOME" "$@"
}

user_exists() {
  local user="$1"
  if command -v getent >/dev/null 2>&1; then
    getent passwd "$user" >/dev/null 2>&1 && return 0
  fi
  id -u "$user" >/dev/null 2>&1
}

resolve_nologin_shell() {
  for cand in /usr/bin/false /usr/sbin/nologin /sbin/nologin /usr/bin/nologin /bin/false; do
    if [[ -x "$cand" ]]; then
      printf '%s' "$cand"
      return 0
    fi
  done
  printf '%s' "/usr/sbin/nologin"
}

ensure_subid_entry() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    return 1
  fi
  grep -q "^${OPENCLAW_USER}:" "$file" 2>/dev/null
}

# --- Parse arguments ---

INSTALL_QUADLET=false
RUNAS_MODE=false
RUNAS_USER="openclaw"
args=("$@")
i=0
while (( i < ${#args[@]} )); do
  case "${args[$i]}" in
    --quadlet)   INSTALL_QUADLET=true ;;
    --container) INSTALL_QUADLET=false ;;
    --runas)
      RUNAS_MODE=true
      # If next arg exists and doesn't start with --, treat it as username
      if (( i+1 < ${#args[@]} )) && [[ "${args[$((i+1))]}" != --* ]]; then
        RUNAS_USER="${args[$((i+1))]}"
        ((i++))
      fi
      ;;
  esac
  ((i++))
done
if [[ -n "${OPENCLAW_PODMAN_QUADLET:-}" ]]; then
  case "${OPENCLAW_PODMAN_QUADLET,,}" in
    1|yes|true) INSTALL_QUADLET=true ;;
    0|no|false) INSTALL_QUADLET=false ;;
  esac
fi

# Override user when --runas is active
if [[ "$RUNAS_MODE" == true ]]; then
  OPENCLAW_USER="$RUNAS_USER"
fi

# Quadlet guard: without --runas, only Linux systemd is supported.
# With --runas, macOS uses launchd and Linux uses systemd.
if [[ "$INSTALL_QUADLET" == true && "$RUNAS_MODE" == false ]]; then
  if ! [[ "$OS_NAME" == "Linux" ]]; then
    fail "--quadlet without --runas is only supported on Linux with systemd user services."
  fi
fi

SEED_GATEWAY_PORT="$HOST_GATEWAY_PORT"
if [[ "$INSTALL_QUADLET" == true ]]; then
  SEED_GATEWAY_PORT="$QUADLET_GATEWAY_PORT"
fi

# --- Pre-flight checks ---

require_cmd podman

if [[ "$RUNAS_MODE" == false ]]; then
  if is_root; then
    echo "Run scripts/podman/setup.sh as your normal user so Podman stays rootless." >&2
    exit 1
  fi
else
  if ! is_root; then
    require_cmd sudo
  fi
fi

if [[ "$OPENCLAW_IMAGE" == "openclaw:local" ]] && [[ ! -f "$REPO_PATH/Dockerfile" ]]; then
  echo "Dockerfile not found at $REPO_PATH. Set OPENCLAW_REPO_PATH to the repo root." >&2
  exit 1
fi
if [[ ! -f "$RUN_SCRIPT_SRC" ]]; then
  echo "Launch script not found at $RUN_SCRIPT_SRC." >&2
  exit 1
fi

# --- --runas: create dedicated service user if needed ---

if [[ "$RUNAS_MODE" == true ]]; then
  if ! user_exists "$OPENCLAW_USER"; then
    NOLOGIN_SHELL="$(resolve_nologin_shell)"
    echo "Creating user $OPENCLAW_USER ($NOLOGIN_SHELL, with home)..."
    if is_macos; then
      MACOS_UID=""
      EXISTING_UIDS="$(dscl . -list /Users UniqueID 2>/dev/null | awk '{print $2}')"
      for candidate_uid in $(seq 400 499); do
        if ! printf '%s\n' "$EXISTING_UIDS" | grep -qx "$candidate_uid"; then
          MACOS_UID="$candidate_uid"
          break
        fi
      done
      if [[ -z "$MACOS_UID" ]]; then
        echo "Could not find a free system UID (400-499) on macOS." >&2
        exit 1
      fi
      MACOS_HOME="/Users/$OPENCLAW_USER"
      run_root dscl . -create "/Users/$OPENCLAW_USER"
      run_root dscl . -create "/Users/$OPENCLAW_USER" UserShell "$NOLOGIN_SHELL"
      run_root dscl . -create "/Users/$OPENCLAW_USER" UniqueID "$MACOS_UID"
      run_root dscl . -create "/Users/$OPENCLAW_USER" PrimaryGroupID "$MACOS_UID"
      run_root dscl . -create "/Users/$OPENCLAW_USER" NFSHomeDirectory "$MACOS_HOME"
      run_root dscl . -create "/Users/$OPENCLAW_USER" RealName "OpenClaw Service"
      if ! dscl . -read "/Groups/$OPENCLAW_USER" PrimaryGroupID &>/dev/null; then
        run_root dscl . -create "/Groups/$OPENCLAW_USER"
        run_root dscl . -create "/Groups/$OPENCLAW_USER" PrimaryGroupID "$MACOS_UID"
        run_root dscl . -append "/Groups/$OPENCLAW_USER" GroupMembership "$OPENCLAW_USER"
      fi
      run_root mkdir -p "$MACOS_HOME"
      run_root chown "$MACOS_UID:$MACOS_UID" "$MACOS_HOME"
      run_root chmod 700 "$MACOS_HOME"
      run_root dscl . -create "/Users/$OPENCLAW_USER" IsHidden 1
    elif command -v useradd >/dev/null 2>&1; then
      run_root useradd -m -s "$NOLOGIN_SHELL" "$OPENCLAW_USER"
    elif command -v adduser >/dev/null 2>&1; then
      run_root adduser --disabled-password --gecos "" --shell "$NOLOGIN_SHELL" "$OPENCLAW_USER"
    else
      echo "Neither useradd nor adduser found, cannot create user $OPENCLAW_USER." >&2
      exit 1
    fi
  else
    echo "User $OPENCLAW_USER already exists."
  fi
fi

# --- Resolve home/config paths ---

# In --runas mode, always resolve home from the service user, not the invoker.
if [[ "$RUNAS_MODE" == true ]]; then
  OPENCLAW_HOME="$(resolve_user_home "$OPENCLAW_USER")"
elif [[ -z "$OPENCLAW_HOME" ]]; then
  OPENCLAW_HOME="$(resolve_user_home "$OPENCLAW_USER")"
fi
if [[ -z "$OPENCLAW_HOME" ]]; then
  echo "Unable to resolve HOME for user $OPENCLAW_USER." >&2
  exit 1
fi
if [[ -z "$OPENCLAW_CONFIG_DIR" ]]; then
  OPENCLAW_CONFIG_DIR="$OPENCLAW_HOME/.openclaw"
fi
if [[ -z "$OPENCLAW_WORKSPACE_DIR" ]]; then
  OPENCLAW_WORKSPACE_DIR="$OPENCLAW_CONFIG_DIR/workspace"
fi
validate_absolute_path "home directory" "$OPENCLAW_HOME"
validate_mount_source_path "config directory" "$OPENCLAW_CONFIG_DIR"
validate_mount_source_path "workspace directory" "$OPENCLAW_WORKSPACE_DIR"
validate_container_name "$OPENCLAW_CONTAINER_NAME"
validate_image_name "$OPENCLAW_IMAGE"
validate_port "gateway host port" "$HOST_GATEWAY_PORT"
validate_port "seed gateway port" "$SEED_GATEWAY_PORT"

# --- --runas: Linux lingering, subuid/subgid, create dirs as service user ---

if [[ "$RUNAS_MODE" == true ]]; then
  OPENCLAW_UID="$(id -u "$OPENCLAW_USER" 2>/dev/null || true)"

  # Linux: enable systemd lingering and prepare /run/user runtime dirs
  if ! is_macos; then
    if command -v loginctl &>/dev/null; then
      run_root loginctl enable-linger "$OPENCLAW_USER" 2>/dev/null || true
    fi
    if [[ -n "${OPENCLAW_UID:-}" && -d /run/user ]] && command -v systemctl &>/dev/null; then
      if [[ ! -d "/run/user/$OPENCLAW_UID" ]]; then
        run_root install -d -m 700 -o "$OPENCLAW_UID" -g "$OPENCLAW_UID" "/run/user/$OPENCLAW_UID" || true
      fi
      run_root mkdir -p "/run/user/$OPENCLAW_UID/containers" || true
      run_root chown "$OPENCLAW_UID:$OPENCLAW_UID" "/run/user/$OPENCLAW_UID/containers" || true
      run_root chmod 700 "/run/user/$OPENCLAW_UID/containers" || true
    fi
  fi

  # Linux: check subuid/subgid (macOS Podman uses a VM)
  if ! is_macos; then
    if ! ensure_subid_entry /etc/subuid || ! ensure_subid_entry /etc/subgid; then
      echo "WARNING: ${OPENCLAW_USER} may not have subuid/subgid ranges configured." >&2
      echo "If rootless Podman fails, add '${OPENCLAW_USER}:100000:65536' to both /etc/subuid and /etc/subgid." >&2
    fi
  fi

  # Create dirs owned by service user
  run_root install -d -m 700 -o "$OPENCLAW_UID" -g "$OPENCLAW_UID" "$OPENCLAW_HOME" "$OPENCLAW_CONFIG_DIR"
  run_root install -d -m 700 -o "$OPENCLAW_UID" -g "$OPENCLAW_UID" "$OPENCLAW_WORKSPACE_DIR"
else
  install -d -m 700 "$OPENCLAW_CONFIG_DIR" "$OPENCLAW_WORKSPACE_DIR"
  ensure_private_existing_dir_owned_by_user "config directory" "$OPENCLAW_CONFIG_DIR"
  ensure_private_existing_dir_owned_by_user "workspace directory" "$OPENCLAW_WORKSPACE_DIR"
fi

# --- Build / pull image ---

BUILD_ARGS=()
if [[ -n "${OPENCLAW_DOCKER_APT_PACKAGES:-}" ]]; then
  BUILD_ARGS+=(--build-arg "OPENCLAW_DOCKER_APT_PACKAGES=${OPENCLAW_DOCKER_APT_PACKAGES}")
fi
if [[ -n "${OPENCLAW_EXTENSIONS:-}" ]]; then
  BUILD_ARGS+=(--build-arg "OPENCLAW_EXTENSIONS=${OPENCLAW_EXTENSIONS}")
fi

if [[ "$RUNAS_MODE" == true ]]; then
  # Build or pull as current user, export to tar, load into service user's store
  IMAGE_TMP_BASE="$(resolve_image_tmp_dir)"
  echo "Using temp base for image export: $IMAGE_TMP_BASE"
  IMAGE_TAR_DIR="$(mktemp -d "${IMAGE_TMP_BASE%/}/openclaw-podman-image.XXXXXX")"
  chmod 711 "$IMAGE_TAR_DIR"
  IMAGE_TAR="$IMAGE_TAR_DIR/openclaw-image.tar"
  cleanup_image_tar() {
    rm -rf "$IMAGE_TAR_DIR"
  }
  trap cleanup_image_tar EXIT

  if [[ "$OPENCLAW_IMAGE" == "openclaw:local" ]]; then
    echo "Building image $OPENCLAW_IMAGE ..."
    podman build -t "$OPENCLAW_IMAGE" -f "$REPO_PATH/Dockerfile" "${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}" "$REPO_PATH"
  else
    if podman image exists "$OPENCLAW_IMAGE" >/dev/null 2>&1; then
      echo "Using existing image $OPENCLAW_IMAGE"
    else
      echo "Pulling image $OPENCLAW_IMAGE ..."
      podman pull "$OPENCLAW_IMAGE"
    fi
  fi
  echo "Saving image to $IMAGE_TAR ..."
  podman save -o "$IMAGE_TAR" "$OPENCLAW_IMAGE"
  chmod 644 "$IMAGE_TAR"

  echo "Loading image into $OPENCLAW_USER Podman store..."
  run_as_service_user podman load -i "$IMAGE_TAR"

  # Install launch script into service user's home
  LAUNCH_SCRIPT_DST="$OPENCLAW_HOME/run-openclaw-podman.sh"
  echo "Installing launch script to $LAUNCH_SCRIPT_DST ..."
  run_root install -m 0755 -o "$OPENCLAW_UID" -g "$OPENCLAW_UID" "$RUN_SCRIPT_SRC" "$LAUNCH_SCRIPT_DST"
else
  if [[ "$OPENCLAW_IMAGE" == "openclaw:local" ]]; then
    echo "Building image $OPENCLAW_IMAGE ..."
    podman build -t "$OPENCLAW_IMAGE" -f "$REPO_PATH/Dockerfile" "${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}" "$REPO_PATH"
  else
    if podman image exists "$OPENCLAW_IMAGE" >/dev/null 2>&1; then
      echo "Using existing image $OPENCLAW_IMAGE"
    else
      echo "Pulling image $OPENCLAW_IMAGE ..."
      podman pull "$OPENCLAW_IMAGE"
    fi
  fi
fi

# --- Env file + config ---

ENV_FILE="$OPENCLAW_CONFIG_DIR/.env"
if [[ "$RUNAS_MODE" == true ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    TOKEN="$(generate_token_hex_32)"
    run_as_service_user sh -lc "umask 077 && printf '%s\n' 'OPENCLAW_GATEWAY_TOKEN=$TOKEN' > '$ENV_FILE'"
    echo "Generated OPENCLAW_GATEWAY_TOKEN and wrote it to $ENV_FILE"
  fi
  # Persist image/container names so the launch script uses the same values.
  # Use the host-side upsert_env_var via run_root since the env file is owned
  # by the service user and we already have elevated privileges in --runas mode.
  run_root sh -c "chmod 600 '$ENV_FILE' 2>/dev/null || true"
  upsert_env_var "$ENV_FILE" "OPENCLAW_PODMAN_CONTAINER" "$OPENCLAW_CONTAINER_NAME"
  upsert_env_var "$ENV_FILE" "OPENCLAW_PODMAN_IMAGE" "$OPENCLAW_IMAGE"
  run_root chown "$OPENCLAW_UID:$OPENCLAW_UID" "$ENV_FILE"

  CONFIG_JSON="$OPENCLAW_CONFIG_DIR/openclaw.json"
  if [[ ! -f "$CONFIG_JSON" ]]; then
    run_as_service_user sh -lc "umask 077 && cat > '$CONFIG_JSON' <<'JSON'
{ \"gateway\": { \"mode\": \"local\" } }
JSON"
    echo "Wrote minimal config to $CONFIG_JSON"
  fi
else
  if [[ ! -f "$ENV_FILE" ]]; then
    TOKEN="$(generate_token_hex_32)"
    (
      umask 077
      write_file_atomically "$ENV_FILE" 600 <<EOF
OPENCLAW_GATEWAY_TOKEN=$TOKEN
EOF
    )
    echo "Generated OPENCLAW_GATEWAY_TOKEN and wrote it to $ENV_FILE"
  fi
  upsert_env_var "$ENV_FILE" "OPENCLAW_PODMAN_CONTAINER" "$OPENCLAW_CONTAINER_NAME"
  upsert_env_var "$ENV_FILE" "OPENCLAW_PODMAN_IMAGE" "$OPENCLAW_IMAGE"

  CONFIG_JSON="$OPENCLAW_CONFIG_DIR/openclaw.json"
  if [[ ! -f "$CONFIG_JSON" ]]; then
    (
      umask 077
      write_file_atomically "$CONFIG_JSON" 600 <<JSON
{
  "gateway": {
    "mode": "local",
        "controlUi": {
          "allowedOrigins": [
        "http://127.0.0.1:${SEED_GATEWAY_PORT}",
        "http://localhost:${SEED_GATEWAY_PORT}"
      ]
    }
  }
}
JSON
    )
    echo "Wrote minimal config to $CONFIG_JSON"
  fi
  seed_local_control_ui_origins "$CONFIG_JSON" "$SEED_GATEWAY_PORT"
fi

# --- Quadlet / service installation ---

if [[ "$INSTALL_QUADLET" == true ]]; then
  if [[ "$RUNAS_MODE" == true ]]; then
    if is_macos; then
      # macOS: install a LaunchDaemon so it starts at boot without requiring
      # the service user to have a GUI session. UserName drops privileges.
      LAUNCHD_PLIST_DIR="/Library/LaunchDaemons"
      LAUNCHD_PLIST_DST="$LAUNCHD_PLIST_DIR/ai.openclaw.podman.plist"
      LAUNCH_SCRIPT_DST="$OPENCLAW_HOME/run-openclaw-podman.sh"
      PLIST_TMP="$(mktemp "/tmp/ai.openclaw.podman.plist.XXXXXX")"
      echo "Installing launchd plist to $LAUNCHD_PLIST_DST ..."
      cat > "$PLIST_TMP" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.openclaw.podman</string>
  <key>ProgramArguments</key>
  <array>
    <string>${LAUNCH_SCRIPT_DST}</string>
    <string>launch</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>UserName</key>
  <string>${OPENCLAW_USER}</string>
  <key>StandardOutPath</key>
  <string>${OPENCLAW_HOME}/.openclaw/openclaw-podman.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${OPENCLAW_HOME}/.openclaw/openclaw-podman.stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${OPENCLAW_HOME}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST
      run_root install -m 0644 -o root -g wheel "$PLIST_TMP" "$LAUNCHD_PLIST_DST"
      rm -f "$PLIST_TMP"
      echo "Loading launchd service..."
      run_root launchctl bootstrap system/ "$LAUNCHD_PLIST_DST" 2>/dev/null || \
        run_root launchctl load "$LAUNCHD_PLIST_DST" 2>/dev/null || true
      echo "launchd daemon installed and service loaded."
    else
      # Linux --runas: install quadlet for the service user
      QUADLET_DIR="$OPENCLAW_HOME/.config/containers/systemd"
      QUADLET_DST="$QUADLET_DIR/openclaw.container"
      echo "Installing Quadlet to $QUADLET_DST ..."
      run_as_service_user mkdir -p "$QUADLET_DIR"
      OPENCLAW_HOME_ESCAPED="$(escape_sed_replacement_pipe_delim "$OPENCLAW_HOME")"
      OPENCLAW_CONFIG_ESCAPED="$(escape_sed_replacement_pipe_delim "$OPENCLAW_CONFIG_DIR")"
      OPENCLAW_WORKSPACE_ESCAPED="$(escape_sed_replacement_pipe_delim "$OPENCLAW_WORKSPACE_DIR")"
      OPENCLAW_IMAGE_ESCAPED="$(escape_sed_replacement_pipe_delim "$OPENCLAW_IMAGE")"
      OPENCLAW_CONTAINER_ESCAPED="$(escape_sed_replacement_pipe_delim "$OPENCLAW_CONTAINER_NAME")"
      sed \
        -e "s|{{OPENCLAW_HOME}}|$OPENCLAW_HOME_ESCAPED|g" \
        -e "s|{{OPENCLAW_CONFIG_DIR}}|$OPENCLAW_CONFIG_ESCAPED|g" \
        -e "s|{{OPENCLAW_WORKSPACE_DIR}}|$OPENCLAW_WORKSPACE_ESCAPED|g" \
        -e "s|{{IMAGE_NAME}}|$OPENCLAW_IMAGE_ESCAPED|g" \
        -e "s|{{CONTAINER_NAME}}|$OPENCLAW_CONTAINER_ESCAPED|g" \
        "$QUADLET_TEMPLATE" | \
        run_as_service_user sh -lc "cat > '$QUADLET_DST'"
      run_as_service_user chmod 0644 "$QUADLET_DST"

      echo "Reloading and enabling user service..."
      run_root systemctl --machine "${OPENCLAW_USER}@" --user daemon-reload
      run_root systemctl --machine "${OPENCLAW_USER}@" --user enable --now openclaw.service
      echo "Quadlet installed and service started."
    fi
  else
    # Default path: install quadlet as current user's systemd service
    QUADLET_DIR="$OPENCLAW_HOME/.config/containers/systemd"
    QUADLET_DST="$QUADLET_DIR/openclaw.container"
    echo "Installing Quadlet to $QUADLET_DST ..."
    mkdir -p "$QUADLET_DIR"
    ensure_safe_existing_dir "quadlet directory" "$QUADLET_DIR"
    OPENCLAW_HOME_ESCAPED="$(escape_sed_replacement_pipe_delim "$OPENCLAW_HOME")"
    OPENCLAW_CONFIG_ESCAPED="$(escape_sed_replacement_pipe_delim "$OPENCLAW_CONFIG_DIR")"
    OPENCLAW_WORKSPACE_ESCAPED="$(escape_sed_replacement_pipe_delim "$OPENCLAW_WORKSPACE_DIR")"
    OPENCLAW_IMAGE_ESCAPED="$(escape_sed_replacement_pipe_delim "$OPENCLAW_IMAGE")"
    OPENCLAW_CONTAINER_ESCAPED="$(escape_sed_replacement_pipe_delim "$OPENCLAW_CONTAINER_NAME")"
    sed \
      -e "s|{{OPENCLAW_HOME}}|$OPENCLAW_HOME_ESCAPED|g" \
      -e "s|{{OPENCLAW_CONFIG_DIR}}|$OPENCLAW_CONFIG_ESCAPED|g" \
      -e "s|{{OPENCLAW_WORKSPACE_DIR}}|$OPENCLAW_WORKSPACE_ESCAPED|g" \
      -e "s|{{IMAGE_NAME}}|$OPENCLAW_IMAGE_ESCAPED|g" \
      -e "s|{{CONTAINER_NAME}}|$OPENCLAW_CONTAINER_ESCAPED|g" \
      "$QUADLET_TEMPLATE" | write_file_atomically "$QUADLET_DST" 644

    if command -v systemctl >/dev/null 2>&1; then
      echo "Reloading and starting user service..."
      if systemctl --user daemon-reload && systemctl --user start openclaw.service; then
        echo "Quadlet installed and service started."
      else
        echo "Quadlet installed, but automatic start failed." >&2
        echo "Try: systemctl --user daemon-reload && systemctl --user start openclaw.service" >&2
        if command -v loginctl >/dev/null 2>&1; then
          echo "For boot persistence on headless hosts, you may also need: sudo loginctl enable-linger $(whoami)" >&2
        fi
      fi
    else
      echo "systemctl not found; Quadlet installed but not started." >&2
    fi
  fi
else
  if [[ "$RUNAS_MODE" == true ]]; then
    echo "Container + launch script installed."
  else
    echo "Container setup complete."
  fi
fi

echo
echo "Next:"
echo "  ./scripts/run-openclaw-podman.sh launch"
echo "  ./scripts/run-openclaw-podman.sh launch setup"
echo "  openclaw --container $OPENCLAW_CONTAINER_NAME dashboard --no-open"
if is_macos; then
  echo "  For auto-start: ./scripts/podman/setup.sh --quadlet --runas (installs a launchd plist)."
fi
