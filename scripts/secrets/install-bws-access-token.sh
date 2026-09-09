#!/usr/bin/env bash
set -euo pipefail

env_path="${BWS_ENV_PATH:-/home/oc_admin/.openclaw/credentials/bitwarden-secrets/env}"
bws_bin="${BWS_BIN:-/home/oc_admin/.openclaw/credentials/bin/bws}"
default_project_id=""

if [[ -f "$env_path" ]]; then
  default_project_id="$(awk -F= '$1=="BWS_PROJECT_ID"{print substr($0, index($0,$2)); exit}' "$env_path")"
fi

if [[ ! -t 0 || ! -t 1 ]]; then
  printf 'error: run from an interactive terminal so token input can be hidden\n' >&2
  exit 2
fi

printf 'BWS access token: ' >&2
IFS= read -r -s token
printf '\n' >&2

if [[ -z "$token" ]]; then
  printf 'error: empty token refused\n' >&2
  exit 2
fi

printf 'BWS project id [%s]: ' "$default_project_id" >&2
IFS= read -r project_id
project_id="${project_id:-$default_project_id}"

if [[ -z "$project_id" ]]; then
  printf 'error: BWS project id is required\n' >&2
  exit 2
fi

tmp_env="$(mktemp "${env_path}.new.XXXXXX")"
trap 'if [[ -n "${tmp_env:-}" && -f "$tmp_env" ]]; then shred -u "$tmp_env" 2>/dev/null || :; fi' EXIT
umask 077
{
  printf 'BWS_ACCESS_TOKEN=%s\n' "$token"
  printf 'BWS_PROJECT_ID=%s\n' "$project_id"
} > "$tmp_env"
chmod 0600 "$tmp_env"

if ! env -i PATH="$PATH" HOME="$HOME" BWS_ACCESS_TOKEN="$token" "$bws_bin" project list >/dev/null; then
  printf 'error: BWS token validation failed; existing env left unchanged\n' >&2
  exit 1
fi

backup="${env_path}.pre-rotation-$(date -u +%Y%m%dT%H%M%SZ).bak"
if [[ -f "$env_path" ]]; then
  install -m 0600 "$env_path" "$backup"
fi
install -m 0600 "$tmp_env" "$env_path"
shred -u "$tmp_env" 2>/dev/null || :
tmp_env=""

printf 'BWS access token installed and validated by project metadata only.\n'
printf 'env_path=%s\n' "$env_path"
if [[ -f "${backup:-}" ]]; then
  printf 'backup_path=%s\n' "$backup"
fi
