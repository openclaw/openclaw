#!/usr/bin/env bash
set -euo pipefail

resolve_real_gh() {
  if [[ -n "${OPENCLAW_REAL_GH:-}" && -x "${OPENCLAW_REAL_GH}" ]]; then
    printf '%s' "${OPENCLAW_REAL_GH}"
    return 0
  fi
  for candidate in /usr/bin/gh /usr/local/bin/gh; do
    if [[ -x "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

read_github_token() {
  local token_file="${OPENCLAW_GITHUB_TOKEN_FILE:-$HOME/.openclaw/identity/github-token}"
  if [[ -f "$token_file" ]]; then
    local from_file=""
    from_file="$(tr -d '\r\n' < "$token_file" 2>/dev/null || true)"
    if [[ -n "$from_file" ]]; then
      printf '%s' "$from_file"
      return 0
    fi
  fi
  local token="${GH_TOKEN:-${GITHUB_TOKEN:-${COPILOT_GITHUB_TOKEN:-}}}"
  printf '%s' "$token"
}

sync_github_auth() {
  local token
  token="$(read_github_token)"
  if [[ -z "$token" ]]; then
    return 0
  fi

  export OPENCLAW_GITHUB_TOKEN_FILE="${OPENCLAW_GITHUB_TOKEN_FILE:-$HOME/.openclaw/identity/github-token}"
  export GH_TOKEN="$token"
  export GITHUB_TOKEN="$token"
  export COPILOT_GITHUB_TOKEN="${COPILOT_GITHUB_TOKEN:-$token}"

  if real_gh="$(resolve_real_gh)"; then
    export OPENCLAW_REAL_GH="$real_gh"
    export PATH="/app/scripts/wrappers:${PATH}"
  fi

  if ! command -v gh >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
    return 0
  fi

  gh auth setup-git >/dev/null 2>&1 || true
}

sync_github_auth
exec "$@"
