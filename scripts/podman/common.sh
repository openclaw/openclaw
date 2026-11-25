#!/usr/bin/env bash

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

resolve_user_home() {
  local user="$1"
  local home=""
  if command -v getent >/dev/null 2>&1; then
    home="$(getent passwd "$user" 2>/dev/null | cut -d: -f6 || true)"
  fi
  if [[ -z "$home" && -f /etc/passwd ]]; then
    home="$(awk -F: -v u="$user" '$1==u {print $6}' /etc/passwd 2>/dev/null || true)"
  fi
  if [[ -z "$home" ]]; then
    home="/home/$user"
  fi
  printf '%s' "$home"
}

generate_token_hex_32() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return $?
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
    return $?
  fi
  if command -v od >/dev/null 2>&1; then
    od -An -N32 -tx1 /dev/urandom | tr -d " \n"
    return $?
  fi
  echo "Missing dependency: need openssl or python3 (or od) to generate OPENCLAW_GATEWAY_TOKEN." >&2
  exit 1
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

# Keep local deployment mode initialization separate from operator-owned origins.
ensure_local_gateway_mode() {
  local file="$1"
  local legacy_port="${2:-}"
  local published_port="${3:-}"
  local tmp=""
  ensure_safe_write_file_path "config file" "$file"
  if ! command -v python3 >/dev/null 2>&1; then
    echo "Warning: python3 not found; unable to initialize gateway.mode in $file." >&2
    return 0
  fi
  tmp="$(mktemp "$(dirname "$file")/.config.tmp.XXXXXX")"
  if ! python3 - "$file" "$tmp" "$legacy_port" "$published_port" <<'PYTHON'
import json
import sys

path, tmp, legacy_port, published_port = sys.argv[1:]
try:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
except json.JSONDecodeError as exc:
    print(f"Warning: unable to initialize gateway.mode in {path}: existing config is not strict JSON ({exc}). Skipping direct JSON rewrite.", file=sys.stderr)
    raise SystemExit(1)
if not isinstance(data, dict):
    raise SystemExit(f"{path}: expected top-level object")
gateway = data.setdefault("gateway", {})
if not isinstance(gateway, dict):
    raise SystemExit(f"{path}: expected gateway object")
changed = "mode" not in gateway
if changed:
    gateway["mode"] = "local"
# Stable images ignore launch metadata. Preserve their omitted-policy setup only.
control_ui = gateway.get("controlUi", {})
if legacy_port and not gateway.get("publicOrigin") and isinstance(control_ui, dict) and "allowedOrigins" not in control_ui:
    control_ui["allowedOrigins"] = [f"http://localhost:{legacy_port}", f"http://127.0.0.1:{legacy_port}"]
    gateway["controlUi"] = control_ui
    changed = True
origins = control_ui.get("allowedOrigins") if isinstance(control_ui, dict) else None
if published_port and isinstance(origins, list):
    desired = [f"http://localhost:{published_port}", f"http://127.0.0.1:{published_port}"]
    has_loopback = any(isinstance(value, str) and value.startswith(("http://localhost:", "http://127.0.0.1:")) for value in origins)
    # Authored policy wins: warn before replacement, never invent a launch permission gate.
    if has_loopback and not any(value in origins for value in desired):
        print(f"Warning: published Gateway port {published_port} does not match the saved loopback gateway.controlUi.allowedOrigins. Dashboard access may be refused. Update that list explicitly, or remove the field to inherit current-image launch defaults. Existing policy is unchanged.", file=sys.stderr)
if changed:
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
PYTHON
  then
    rm -f "$tmp"
    # The canonical CLI reads valid JSON5. Only seed legacy omitted policy; never merge lists.
    if [[ -n "$legacy_port" ]] && command -v openclaw >/dev/null 2>&1; then
      local gateway_json="" seed_origins=""
      if gateway_json="$(OPENCLAW_CONTAINER="" OPENCLAW_CONFIG_DIR="$(dirname "$file")" OPENCLAW_CONFIG_PATH="$file" openclaw config get gateway --json 2>/dev/null)"; then
        if seed_origins="$(printf '%s' "$gateway_json" | python3 -c '
import json, sys
gateway = json.load(sys.stdin)
control_ui = gateway.get("controlUi", {})
if not gateway.get("publicOrigin") and isinstance(control_ui, dict) and "allowedOrigins" not in control_ui:
    port = sys.argv[1]
    print(json.dumps([f"http://localhost:{port}", f"http://127.0.0.1:{port}"]))
' "$legacy_port")" && [[ -n "$seed_origins" ]]; then
          OPENCLAW_CONTAINER="" OPENCLAW_CONFIG_DIR="$(dirname "$file")" OPENCLAW_CONFIG_PATH="$file" \
            openclaw config set gateway.controlUi.allowedOrigins "$seed_origins" --strict-json >/dev/null
        fi
      else
        echo "Warning: canonical config read failed; set gateway.controlUi.allowedOrigins explicitly for the selected legacy image." >&2
      fi
    fi
    return 0
  fi
  if [[ -s "$tmp" ]]; then
    chmod 600 "$tmp"
    mv -f "$tmp" "$file"
  else
    rm -f "$tmp"
  fi
}
