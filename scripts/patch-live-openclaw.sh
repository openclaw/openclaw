#!/usr/bin/env bash
set -euo pipefail

# Build this repo and install the resulting package globally,
# with a backup of the currently installed global openclaw package.
#
# Usage:
#   scripts/patch-live-openclaw.sh [--dry-run]
#
# Env overrides:
#   OPENCLAW_REPO_DIR=/path/to/openclaw.git
#   BACKUP_DIR=/path/to/backups

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

PATCH_NOTIFY_CHANNEL="${OPENCLAW_PATCH_NOTIFY_CHANNEL:-}"
PATCH_NOTIFY_TARGET="${OPENCLAW_PATCH_NOTIFY_TARGET:-}"
PATCH_NOTIFY_REPLY_TO="${OPENCLAW_PATCH_NOTIFY_REPLY_TO:-}"
PATCH_NOTIFY_ACCOUNT="${OPENCLAW_PATCH_NOTIFY_ACCOUNT:-}"
PATCH_RESTART_WARNING_TEXT="${OPENCLAW_PATCH_RESTART_WARNING_TEXT:-}"

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] %s\n' "$*"
  else
    eval "$@"
  fi
}

send_patch_notification() {
  local text="${1:-}"
  if [[ -z "$text" ]]; then
    return 0
  fi
  if [[ -z "$PATCH_NOTIFY_CHANNEL" || -z "$PATCH_NOTIFY_TARGET" ]]; then
    echo "warning: skipping patch notification (missing OPENCLAW_PATCH_NOTIFY_CHANNEL or OPENCLAW_PATCH_NOTIFY_TARGET)"
    return 0
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] openclaw message send --channel %q --target %q --message %q\n' \
      "$PATCH_NOTIFY_CHANNEL" "$PATCH_NOTIFY_TARGET" "$text"
    return 0
  fi

  local cmd=(openclaw message send --channel "$PATCH_NOTIFY_CHANNEL" --target "$PATCH_NOTIFY_TARGET" --message "$text")
  if [[ -n "$PATCH_NOTIFY_REPLY_TO" ]]; then
    cmd+=(--reply-to "$PATCH_NOTIFY_REPLY_TO")
  fi
  if [[ -n "$PATCH_NOTIFY_ACCOUNT" ]]; then
    cmd+=(--account "$PATCH_NOTIFY_ACCOUNT")
  fi

  if ! "${cmd[@]}" >/dev/null 2>&1; then
    echo "warning: failed to send patch notification"
  fi
}

resolve_npm_bin() {
  local openclaw_bin candidate
  openclaw_bin="$(command -v openclaw 2>/dev/null || true)"
  if [[ -n "$openclaw_bin" ]]; then
    candidate="$(dirname "$openclaw_bin")/npm"
    if [[ -x "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  fi
  command -v npm 2>/dev/null || true
}

parse_gateway_service_loaded() {
  node -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  try {
    const loaded = JSON.parse(raw)?.service?.loaded;
    process.stdout.write(loaded === true ? "1" : "0");
  } catch {
    process.stdout.write("0");
  }
});
'
}

has_systemd_gateway_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    return 1
  fi
  if systemctl --user --quiet is-enabled openclaw-gateway.service 2>/dev/null; then
    return 0
  fi
  if systemctl --user --quiet is-enabled "openclaw-gateway@*.service" 2>/dev/null; then
    return 0
  fi
  if systemctl --user --no-pager --no-legend list-unit-files 'openclaw-gateway*.service' 2>/dev/null \
    | awk 'NF{found=1} END{exit found?0:1}'; then
    return 0
  fi
  return 1
}

REPO_DIR="${OPENCLAW_REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_DIR/.patch-backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "error: REPO_DIR is not a git repo: $REPO_DIR" >&2
  exit 1
fi

cd "$REPO_DIR"

NPM_BIN="$(resolve_npm_bin)"
if [[ -z "$NPM_BIN" ]]; then
  echo "error: npm not found in PATH" >&2
  exit 1
fi

echo "info: using npm binary: $NPM_BIN"
PACKAGE_DIR="$("$NPM_BIN" root -g)/openclaw"
BACKUP_TGZ="$BACKUP_DIR/openclaw-global-backup-$TIMESTAMP.tgz"

if [[ -L "$PACKAGE_DIR" && "$(readlink -f "$PACKAGE_DIR")" == "$REPO_DIR" ]]; then
  echo "info: global openclaw is linked to this repo; Control UI assets must be rebuilt after each pnpm build"
fi

run "mkdir -p '$BACKUP_DIR'"

if [[ -d "$PACKAGE_DIR" ]]; then
  run "tar -czf '$BACKUP_TGZ' -C '$(dirname "$PACKAGE_DIR")' '$(basename "$PACKAGE_DIR")'"
  echo "backup: $BACKUP_TGZ"
else
  echo "warning: global openclaw package dir not found at $PACKAGE_DIR"
fi

run "pnpm install --frozen-lockfile"
run "pnpm build"
run "pnpm ui:build"

if [[ "$DRY_RUN" != "1" && ! -f "$REPO_DIR/dist/control-ui/index.html" ]]; then
  echo "error: missing Control UI assets after ui:build: $REPO_DIR/dist/control-ui/index.html" >&2
  exit 1
fi

run "pnpm test -- --run src/commands/models/auth.login-profiles.test.ts src/cli/models-cli.test.ts"

# Create tarball and install globally
run "rm -f ./openclaw-*.tgz"
run "'$NPM_BIN' pack"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[dry-run] would install latest ./openclaw-*.tgz globally"
  echo "done (dry-run)"
  exit 0
fi

PKG_TGZ="$(ls -1t ./openclaw-*.tgz | head -n1)"
if [[ -z "$PKG_TGZ" ]]; then
  echo "error: npm pack did not produce a tarball" >&2
  exit 1
fi

if ! tar -tf "$PKG_TGZ" | awk '$0=="package/dist/control-ui/index.html"{found=1} END{exit found?0:1}'; then
  echo "error: tarball is missing Control UI assets (package/dist/control-ui/index.html)" >&2
  exit 1
fi

run "'$NPM_BIN' i -g '$PKG_TGZ'"
run "openclaw --version"

GATEWAY_STATUS_JSON="$(openclaw gateway status --json 2>/dev/null || true)"
GATEWAY_SERVICE_LOADED="$(printf '%s' "$GATEWAY_STATUS_JSON" | parse_gateway_service_loaded)"
if [[ "$GATEWAY_SERVICE_LOADED" == "1" ]] || has_systemd_gateway_service; then
  echo "info: gateway service is loaded; refreshing service command path + restart"
  run "openclaw gateway install --force"
  send_patch_notification "$PATCH_RESTART_WARNING_TEXT"
  run "openclaw gateway restart"
fi

echo "done"
