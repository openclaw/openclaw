#!/bin/bash
# git-credential-rockie — credential helper that fetches a short-lived
# GitHub App installation token from platform-context for the current
# tenant + git_repo source, so `git push` / `git fetch` against a
# git_repo resource works without any long-lived token in the runtime.
#
# Wired up by Dockerfile.multitenant via:
#   git config --system credential.helper /usr/local/bin/git-credential-rockie.sh
#
# git invokes credential helpers with one of three actions on stdin
# (per `man gitcredentials`): `get`, `store`, `erase`. We only implement
# `get`; the platform-context backend owns token lifecycle, so there's
# nothing to store/erase locally.
#
# Required env on the tenant runtime:
#   ROCKIELAB_API_URL          — e.g. https://api.rockielab.com
#   ROCKIELAB_TENANT_TOKEN     — internal token for the X-Tenant-Token header
#   ROCKIELAB_SOURCE_ID        — the git_repo source.id whose install token
#                                we want (set per-shell by mcp-rockie when
#                                it spawns a git command)
#
# Output format (per `man gitcredentials`):
#   protocol=https
#   host=github.com
#   username=x-access-token
#   password=<installation token>
#
# Fails silent (empty stdout) if anything is missing — git falls back
# to its usual credential resolution chain (HTTPS prompt / SSH). That
# keeps the runtime usable for ad-hoc clones that aren't backed by a
# git_repo source row.

set -euo pipefail

action="${1:-}"
if [ "$action" != "get" ]; then
  exit 0
fi

# Read git's stdin (key=value lines) so we don't 'hang' the protocol —
# we discard it; the answer comes from platform-context, not the URL.
while IFS= read -r _line; do
  if [ -z "$_line" ]; then
    break
  fi
done

# Bail silently if any required env is missing. The platform side fills
# these for any shell mcp-rockie spawns; running `git` from a free shell
# without them is allowed but unauthed.
if [ -z "${ROCKIELAB_API_URL:-}" ] \
   || [ -z "${ROCKIELAB_TENANT_TOKEN:-}" ] \
   || [ -z "${ROCKIELAB_SOURCE_ID:-}" ]; then
  exit 0
fi

# Hit the internal-only endpoint. Failure here is non-fatal — git
# falls back to its own credential UI. `-f` makes curl exit non-zero
# on HTTP 4xx/5xx so we can suppress noisy responses.
token=$(curl -fsSL \
  -H "X-Tenant-Token: ${ROCKIELAB_TENANT_TOKEN}" \
  "${ROCKIELAB_API_URL%/}/api/internal/git-token?source_id=${ROCKIELAB_SOURCE_ID}" \
  2>/dev/null \
  | jq -r '.token // empty' 2>/dev/null) || token=""

if [ -z "$token" ]; then
  exit 0
fi

printf 'protocol=https\n'
printf 'host=github.com\n'
printf 'username=x-access-token\n'
printf 'password=%s\n' "$token"
