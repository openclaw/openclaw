#!/usr/bin/env bash
set -euo pipefail

die() {
  printf 'vercel-readonly:error %s\n' "$*" >&2
  exit 64
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

VERCEL_BIN="vercel"
require_cmd "$VERCEL_BIN"
require_cmd node

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ALLOWLIST_MESSAGE="read-only wrapper allows only: help, whoami, teams list, ls, inspect, logs, domains ls"
USAGE_MESSAGE="usage: $(basename "$0") COMMAND [FLAGS...] - $ALLOWLIST_MESSAGE"

[[ -n "${VERCEL_TOKEN:-}" ]] || die "missing VERCEL_TOKEN environment variable"
[[ -n "${1-}" ]] || die "$USAGE_MESSAGE"
[[ "$1" != -* ]] || die "put the allowed vercel command first; flags must follow the command"

for arg in "$@"; do
  case "$arg" in
    --token | --token=* | -t | -t=* | -t?*)
      die "do not pass --token; use VERCEL_TOKEN env"
      ;;
    --exec | --exec=* | --command | --command=*)
      die "command-execution flags are not allowed in read-only mode: $arg"
      ;;
  esac
done

case "$1" in
  help)
    ;;
  whoami | ls | inspect | logs)
    ;;
  teams)
    [[ "${2-}" == "list" ]] || die "read-only wrapper allows only: teams list"
    ;;
  domains)
    [[ "${2-}" == "ls" ]] || die "read-only wrapper allows only: domains ls"
    ;;
  *)
    die "$ALLOWLIST_MESSAGE"
    ;;
esac

# Run Vercel against an isolated temp home so the wrapper does not read from or
# write to the operator's real Vercel config, cache, or stored credentials.
tmp_home="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_home"
}
trap cleanup EXIT

case "$(uname -s)" in
  Darwin)
    auth_dir="$tmp_home/Library/Application Support/com.vercel.cli"
    cache_dir="$tmp_home/Library/Caches/com.vercel.cli/package-updates"
    ;;
  Linux)
    export XDG_CONFIG_HOME="$tmp_home/.config"
    export XDG_CACHE_HOME="$tmp_home/.cache"
    auth_dir="$XDG_CONFIG_HOME/com.vercel.cli"
    cache_dir="$XDG_CACHE_HOME/com.vercel.cli/package-updates"
    ;;
  *)
    die "unsupported OS: $(uname -s)"
    ;;
esac

mkdir -p "$auth_dir" "$cache_dir"
# Use a dedicated Node script to construct the auth JSON so tokens with
# quotes/backslashes stay valid without embedding dynamic values in JS source.
# Do not regex-restrict token characters here; Vercel may change token formats.
AUTH_JSON_PATH="$auth_dir/auth.json"
AUTH_JSON_PATH="$AUTH_JSON_PATH" TOKEN_TO_JSON="$VERCEL_TOKEN" node "$SCRIPT_DIR/write-auth-json.mjs" || die "failed to create auth file at $AUTH_JSON_PATH"
[[ -f "$AUTH_JSON_PATH" ]] || die "auth file was not created at expected path: $AUTH_JSON_PATH"

HOME="$tmp_home" "$VERCEL_BIN" "$@"
