#!/usr/bin/env bash
set -euo pipefail

# Installs OpenClaw from a fork/tag (recommended) or branch and runs onboarding.
#
# Recommended release usage (immutable):
#   OPENCLAW_REF=v2026.2.9-dreamclaw.7
#
# When OPENCLAW_REF is a tag, the script automatically checks for a prebuilt
# release tarball at GitHub Releases. If found, it installs from the tarball
# (fast, no build tools needed). Otherwise it falls back to git+https://
# which triggers a source build (requires pnpm + all devDeps).
#
# Overrides:
#   OPENCLAW_SPEC=<npm-install-spec>       # optional direct spec (e.g. file:/path, git+https://...)
#   OPENCLAW_RELEASE_REPO=<github-url>     # repo URL for release tarballs (default: RedBeardEth/clawdbot)
#   OPENCLAW_REPO=https://github.com/<org>/<repo>.git  # for git+https:// fallback
#   OPENCLAW_REF=<tag-or-commit>         # preferred (immutable)
#   OPENCLAW_BRANCH=<branch>             # fallback for development
#   OPENCLAW_INSTALLER=npm|pnpm|auto
#   OPENCLAW_BIN=openclaw|moltbot
#   OPENCLAW_RUN_ONBOARD=1|0
#   OPENCLAW_ONBOARD_ARGS="--install-daemon --auth-choice x402"
#   OPENCLAW_NPM_SCRIPT_SHELL=/path/to/sh  # optional npm lifecycle shell override

OPENCLAW_SPEC="${OPENCLAW_SPEC:-}"
OPENCLAW_REPO="${OPENCLAW_REPO:-https://github.com/RedBeardEth/clawdbot.git}"
OPENCLAW_REF="${OPENCLAW_REF:-}"
OPENCLAW_BRANCH="${OPENCLAW_BRANCH:-}"
OPENCLAW_INSTALLER="${OPENCLAW_INSTALLER:-npm}"
OPENCLAW_BIN="${OPENCLAW_BIN:-}"
OPENCLAW_RUN_ONBOARD="${OPENCLAW_RUN_ONBOARD:-1}"
OPENCLAW_ONBOARD_ARGS="${OPENCLAW_ONBOARD_ARGS:---install-daemon --auth-choice x402}"
OPENCLAW_NPM_SCRIPT_SHELL="${OPENCLAW_NPM_SCRIPT_SHELL:-}"

if [[ -z "$OPENCLAW_SPEC" && -z "$OPENCLAW_REF" && -z "$OPENCLAW_BRANCH" ]]; then
  OPENCLAW_REF="v2026.2.9-dreamclaw.7"
fi

if [[ -n "$OPENCLAW_SPEC" && ( -n "$OPENCLAW_REF" || -n "$OPENCLAW_BRANCH" ) ]]; then
  echo "ERROR: set OPENCLAW_SPEC or OPENCLAW_REF/OPENCLAW_BRANCH, not both" >&2
  exit 1
fi

if [[ -n "$OPENCLAW_REF" && -n "$OPENCLAW_BRANCH" ]]; then
  echo "ERROR: set only one of OPENCLAW_REF or OPENCLAW_BRANCH" >&2
  exit 1
fi

OPENCLAW_RELEASE_REPO="${OPENCLAW_RELEASE_REPO:-https://github.com/RedBeardEth/clawdbot}"

resolve_release_tarball_url() {
  local tag="$1"
  local repo_url="${OPENCLAW_RELEASE_REPO%.git}"
  local tarball_url="${repo_url}/releases/download/${tag}/openclaw-${tag}.tgz"
  # Check if the tarball exists (HEAD request, follow redirects)
  if curl -fsSL --head --connect-timeout 5 "$tarball_url" >/dev/null 2>&1; then
    printf '%s\n' "$tarball_url"
    return 0
  fi
  return 1
}

if [[ -n "$OPENCLAW_SPEC" ]]; then
  SPEC="$OPENCLAW_SPEC"
  REF_KIND="spec"
elif [[ -n "$OPENCLAW_REF" ]]; then
  # Prefer prebuilt release tarball; fall back to git+https:// (triggers source build)
  tarball_url="$(resolve_release_tarball_url "$OPENCLAW_REF" || true)"
  if [[ -n "$tarball_url" ]]; then
    SPEC="$tarball_url"
    REF_KIND="release-tarball"
    echo "==> Found prebuilt release tarball for ${OPENCLAW_REF}"
  else
    SPEC="git+${OPENCLAW_REPO}#${OPENCLAW_REF}"
    REF_KIND="ref"
    echo "==> No prebuilt tarball found; falling back to git source install (requires pnpm + build tools)"
  fi
elif [[ -n "$OPENCLAW_BRANCH" ]]; then
  SPEC="git+${OPENCLAW_REPO}#${OPENCLAW_BRANCH}"
  REF_KIND="branch"
else
  echo "ERROR: provide OPENCLAW_REF (recommended) or OPENCLAW_BRANCH" >&2
  exit 1
fi

echo "==> Installing from ${SPEC} (${REF_KIND})"

resolve_npm_script_shell() {
  shell_works() {
    local candidate="$1"
    [[ -n "$candidate" && -x "$candidate" ]] || return 1
    "$candidate" -c "exit 0" >/dev/null 2>&1
  }

  if [[ -n "$OPENCLAW_NPM_SCRIPT_SHELL" ]]; then
    shell_works "$OPENCLAW_NPM_SCRIPT_SHELL" || {
      echo "ERROR: OPENCLAW_NPM_SCRIPT_SHELL is not executable/usable: $OPENCLAW_NPM_SCRIPT_SHELL" >&2
      return 1
    }
    printf '%s\n' "$OPENCLAW_NPM_SCRIPT_SHELL"
    return 0
  fi

  local c
  if shell_works "${BASH:-}"; then
    printf '%s\n' "$BASH"
    return 0
  fi

  # Prefer stable absolute paths to avoid bad shell hashes/aliases.
  for c in /bin/sh /usr/bin/sh /bin/bash /usr/bin/bash; do
    if shell_works "$c"; then
      printf '%s\n' "$c"
      return 0
    fi
  done

  c="$(command -v sh || command -v bash || true)"
  if shell_works "$c"; then
    printf '%s\n' "$c"
    return 0
  fi
  c="$(command -v bash || true)"
  if shell_works "$c"; then
    printf '%s\n' "$c"
    return 0
  fi

  return 1
}

resolve_path() {
  local input="$1"
  readlink -f "$input" 2>/dev/null || realpath "$input" 2>/dev/null || printf '%s\n' ""
}

run_npm() {
  local npm_bin npm_bin_dir npm_cli npm_node
  npm_bin="$(command -v npm || true)"
  if [[ -z "$npm_bin" ]]; then
    echo "ERROR: npm is not available in PATH" >&2
    return 1
  fi

  npm_bin_dir="$(dirname "$npm_bin")"
  npm_cli="$(resolve_path "$npm_bin")"
  npm_node="${npm_bin_dir}/node"

  if [[ -n "$npm_cli" && -f "$npm_cli" && -x "$npm_node" ]]; then
    "$npm_node" "$npm_cli" "$@"
    return 0
  fi

  "$npm_bin" "$@"
}

GLOBAL_BIN_HINT=""

if [[ "$OPENCLAW_INSTALLER" == "pnpm" ]] || [[ "$OPENCLAW_INSTALLER" == "auto" && -x "$(command -v pnpm || true)" ]]; then
  echo "==> Using pnpm global install"
  pnpm add -g "$SPEC"
  GLOBAL_BIN_HINT="$(pnpm bin -g 2>/dev/null || true)"
else
  if [[ "$OPENCLAW_INSTALLER" != "auto" && "$OPENCLAW_INSTALLER" != "npm" ]]; then
    echo "ERROR: unsupported OPENCLAW_INSTALLER='$OPENCLAW_INSTALLER' (expected auto|npm|pnpm)" >&2
    exit 1
  fi
  echo "==> Using npm global install"
  # Keep the caller's PATH order to avoid Node/npm version mismatches.
  npm_shell="$(resolve_npm_script_shell || true)"
  if [[ -z "${npm_shell:-}" ]]; then
    echo "ERROR: could not find a usable shell for npm lifecycle scripts." >&2
    echo "Set OPENCLAW_NPM_SCRIPT_SHELL to a valid shell path (example: command -v bash)." >&2
    exit 1
  fi
  echo "==> npm script shell: ${npm_shell}"
  npm_config_script_shell="$npm_shell" run_npm install -g "$SPEC"
  npm_prefix="$(run_npm prefix -g 2>/dev/null || true)"
  if [[ -n "${npm_prefix:-}" ]]; then
    GLOBAL_BIN_HINT="${npm_prefix}/bin"
  fi
fi

resolve_cli_bin() {
  local candidate hinted_path
  if [[ -n "$GLOBAL_BIN_HINT" ]]; then
    for candidate in openclaw moltbot; do
      hinted_path="${GLOBAL_BIN_HINT}/${candidate}"
      if [[ -x "$hinted_path" ]]; then
        printf '%s\n' "$hinted_path"
        return 0
      fi
    done
  fi

  if [[ -n "$OPENCLAW_BIN" ]]; then
    if command -v "$OPENCLAW_BIN" >/dev/null 2>&1; then
      command -v "$OPENCLAW_BIN"
      return 0
    fi
    echo "ERROR: OPENCLAW_BIN is set to '$OPENCLAW_BIN' but command was not found" >&2
    return 1
  fi

  for candidate in openclaw moltbot; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done

  echo "ERROR: could not find installed CLI command (tried: openclaw, moltbot)" >&2
  return 1
}

CLI_BIN_PATH="$(resolve_cli_bin)"
CLI_BIN_NAME="$(basename "$CLI_BIN_PATH")"

echo "==> Installed CLI: ${CLI_BIN_NAME} (${CLI_BIN_PATH})"
INSTALLED_VERSION="$("$CLI_BIN_PATH" --version 2>/dev/null || true)"
echo "==> Installed version: ${INSTALLED_VERSION:-unknown}"

if [[ "$OPENCLAW_RUN_ONBOARD" == "1" ]]; then
  echo "==> Running onboarding: ${CLI_BIN_PATH} ${OPENCLAW_ONBOARD_ARGS}"
  # shellcheck disable=SC2086
  "$CLI_BIN_PATH" ${OPENCLAW_ONBOARD_ARGS}
else
  echo "==> Skipping onboarding (OPENCLAW_RUN_ONBOARD=${OPENCLAW_RUN_ONBOARD})"
  echo "    Run manually: ${CLI_BIN_PATH} ${OPENCLAW_ONBOARD_ARGS}"
fi
