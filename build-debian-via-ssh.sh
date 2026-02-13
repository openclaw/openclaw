#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/build-debian-via-ssh.sh [options] [pnpm-command...]

Run OpenClaw build commands on Debian via SSH from macOS.

Default behavior:
  - SSH target: ronnie@debian.orb.local
  - Repo path:  /home/ronnie/openclaw
  - Command:    pnpm build

Options:
  --target <user@host>   SSH target (default: ronnie@debian.orb.local)
  --repo <path>          Remote repo path (default: /home/ronnie/openclaw)
  --install              Force reinstall dependencies (pnpm install --force) before build
  --ui                   Run pnpm ui:build after main command
  --doctor               Run openclaw doctor after build steps
  -h, --help             Show this help

Examples:
  scripts/build-debian-via-ssh.sh
  scripts/build-debian-via-ssh.sh --install
  scripts/build-debian-via-ssh.sh --ui --doctor
  scripts/build-debian-via-ssh.sh test:fast
EOF
}

TARGET="${OPENCLAW_DEBIAN_SSH:-ronnie@debian.orb.local}"
REMOTE_REPO="${OPENCLAW_DEBIAN_REPO:-/home/ronnie/openclaw}"
RUN_INSTALL=0
RUN_UI=0
RUN_DOCTOR=0
declare -a PNPM_ARGS=()

while (($# > 0)); do
  case "$1" in
    --target)
      [[ $# -ge 2 ]] || {
        echo "error: --target requires a value" >&2
        exit 2
      }
      TARGET="$2"
      shift 2
      ;;
    --repo)
      [[ $# -ge 2 ]] || {
        echo "error: --repo requires a value" >&2
        exit 2
      }
      REMOTE_REPO="$2"
      shift 2
      ;;
    --install)
      RUN_INSTALL=1
      shift
      ;;
    --ui)
      RUN_UI=1
      shift
      ;;
    --doctor)
      RUN_DOCTOR=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while (($# > 0)); do
        PNPM_ARGS+=("$1")
        shift
      done
      ;;
    *)
      PNPM_ARGS+=("$1")
      shift
      ;;
  esac
done

if ((${#PNPM_ARGS[@]} == 0)); then
  PNPM_ARGS=(build)
fi

echo "[local] target=$TARGET repo=$REMOTE_REPO command=pnpm ${PNPM_ARGS[*]}"

ssh "$TARGET" bash -s -- "$REMOTE_REPO" "$RUN_INSTALL" "$RUN_UI" "$RUN_DOCTOR" "${PNPM_ARGS[@]}" <<'EOF'
set -euo pipefail

repo="$1"
run_install="$2"
run_ui="$3"
run_doctor="$4"
shift 4
declare -a pnpm_args=("$@")

pnpm_exec() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
  else
    corepack pnpm "$@"
  fi
}

ensure_rollup_native() {
  local arch
  arch="$(uname -m)"
  if [[ "$arch" != "aarch64" && "$arch" != "arm64" ]]; then
    return 0
  fi
  if [[ ! -d node_modules/.pnpm ]]; then
    return 1
  fi
  ls node_modules/.pnpm 2>/dev/null | grep -q '^@rollup+rollup-linux-arm64-gnu@'
}

export PATH="$HOME/bin:$PATH"
cd "$repo"

echo "[remote] host=$(hostname) arch=$(uname -m) repo=$repo"
pnpm_exec -v >/dev/null

if [[ "$run_install" == "1" ]]; then
  echo "[remote] running dependency reinstall..."
  pnpm_exec install --force
elif ! ensure_rollup_native; then
  echo "[remote] linux rollup native package missing; auto-fixing with pnpm install --force..."
  pnpm_exec install --force
fi

echo "[remote] running: pnpm ${pnpm_args[*]}"
pnpm_exec "${pnpm_args[@]}"

if [[ "$run_ui" == "1" ]]; then
  echo "[remote] running: pnpm ui:build"
  pnpm_exec ui:build
fi

if [[ "$run_doctor" == "1" ]]; then
  echo "[remote] running: openclaw doctor"
  openclaw doctor
fi

echo "[remote] running: clawdbot gateway restart && clawdbot doctor --fix"
clawdbot gateway restart && clawdbot doctor --fix
EOF
