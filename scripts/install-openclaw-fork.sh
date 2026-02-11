#!/usr/bin/env bash
set -euo pipefail

# Installs OpenClaw from a fork/tag (recommended) or branch and runs onboarding.
#
# Recommended release usage (immutable):
#   OPENCLAW_REF=v2026.2.9-dreamclaw.2
#
# Overrides:
#   OPENCLAW_REPO=https://github.com/<org>/<repo>.git
#   OPENCLAW_REF=<tag-or-commit>         # preferred (immutable)
#   OPENCLAW_BRANCH=<branch>             # fallback for development
#   OPENCLAW_INSTALLER=auto|npm|pnpm
#   OPENCLAW_BIN=openclaw|moltbot
#   OPENCLAW_RUN_ONBOARD=1|0
#   OPENCLAW_ONBOARD_ARGS="--install-daemon --auth-choice x402"
#   OPENCLAW_NPM_SCRIPT_SHELL=/path/to/bash  # optional npm lifecycle shell override

OPENCLAW_REPO="${OPENCLAW_REPO:-https://github.com/RedBeardEth/clawdbot.git}"
OPENCLAW_REF="${OPENCLAW_REF:-v2026.2.9-dreamclaw.2}"
OPENCLAW_BRANCH="${OPENCLAW_BRANCH:-}"
OPENCLAW_INSTALLER="${OPENCLAW_INSTALLER:-auto}"
OPENCLAW_BIN="${OPENCLAW_BIN:-}"
OPENCLAW_RUN_ONBOARD="${OPENCLAW_RUN_ONBOARD:-1}"
OPENCLAW_ONBOARD_ARGS="${OPENCLAW_ONBOARD_ARGS:---install-daemon --auth-choice x402}"
OPENCLAW_NPM_SCRIPT_SHELL="${OPENCLAW_NPM_SCRIPT_SHELL:-}"

if [[ -n "$OPENCLAW_REF" && -n "$OPENCLAW_BRANCH" ]]; then
  echo "ERROR: set only one of OPENCLAW_REF or OPENCLAW_BRANCH" >&2
  exit 1
fi

if [[ -n "$OPENCLAW_REF" ]]; then
  TARGET_REF="$OPENCLAW_REF"
  REF_KIND="ref"
elif [[ -n "$OPENCLAW_BRANCH" ]]; then
  TARGET_REF="$OPENCLAW_BRANCH"
  REF_KIND="branch"
else
  echo "ERROR: provide OPENCLAW_REF (recommended) or OPENCLAW_BRANCH" >&2
  exit 1
fi

SPEC="git+${OPENCLAW_REPO}#${TARGET_REF}"

echo "==> Installing from ${SPEC} (${REF_KIND})"

if [[ "$OPENCLAW_INSTALLER" == "pnpm" ]] || [[ "$OPENCLAW_INSTALLER" == "auto" && -x "$(command -v pnpm || true)" ]]; then
  echo "==> Using pnpm global install"
  pnpm add -g "$SPEC"
else
  if [[ "$OPENCLAW_INSTALLER" != "auto" && "$OPENCLAW_INSTALLER" != "npm" ]]; then
    echo "ERROR: unsupported OPENCLAW_INSTALLER='$OPENCLAW_INSTALLER' (expected auto|npm|pnpm)" >&2
    exit 1
  fi
  echo "==> Using npm global install"
  # npm lifecycle scripts assume a POSIX shell and standard system PATH entries.
  export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH}"
  if [[ -n "$OPENCLAW_NPM_SCRIPT_SHELL" ]]; then
    npm_config_script_shell="$OPENCLAW_NPM_SCRIPT_SHELL" npm install -g "$SPEC"
  elif command -v bash >/dev/null 2>&1; then
    npm_config_script_shell="$(command -v bash)" npm install -g "$SPEC"
  elif command -v sh >/dev/null 2>&1; then
    npm_config_script_shell="$(command -v sh)" npm install -g "$SPEC"
  else
    npm install -g "$SPEC"
  fi
fi

resolve_cli_bin() {
  if [[ -n "$OPENCLAW_BIN" ]]; then
    if command -v "$OPENCLAW_BIN" >/dev/null 2>&1; then
      command -v "$OPENCLAW_BIN"
      return 0
    fi
    echo "ERROR: OPENCLAW_BIN is set to '$OPENCLAW_BIN' but command was not found" >&2
    return 1
  fi

  local candidate
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

if [[ "$OPENCLAW_RUN_ONBOARD" == "1" ]]; then
  echo "==> Running onboarding: ${CLI_BIN_NAME} ${OPENCLAW_ONBOARD_ARGS}"
  # shellcheck disable=SC2086
  "$CLI_BIN_NAME" ${OPENCLAW_ONBOARD_ARGS}
else
  echo "==> Skipping onboarding (OPENCLAW_RUN_ONBOARD=${OPENCLAW_RUN_ONBOARD})"
  echo "    Run manually: ${CLI_BIN_NAME} ${OPENCLAW_ONBOARD_ARGS}"
fi
