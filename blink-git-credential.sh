#!/bin/sh
# Blink git credential helper.
#
# `git` calls this with an operation name ("get", "store", "erase") on argv[1]
# and the host context on stdin, e.g.
#
#   protocol=https
#   host=github.com
#   path=blink-new/auto-engineer.git     # present when useHttpPath=true
#
# For GitHub hosts we print short-lived installation-access-token credentials
# minted by blink-apis (/v1/github/mint-token). For anything else we exit 0
# without output so git falls through to the default credential chain.
#
# Multi-account: when `path=OWNER/repo` is available we attach
# `repository_owner=<OWNER>` to the mint call so the right workspace_connections
# row is picked (workspaces can have multiple GitHub installations — personal,
# employer orgs, etc.). Without a path we fall back to the agent's primary
# link and then to the workspace's most-recently-updated installation.
#
# Wiring (set once in Dockerfile):
#   git config --system credential.helper /usr/local/bin/blink-git-credential
#   git config --system 'credential.https://github.com.useHttpPath' true
#
# Requires:
#   - $BLINK_API_KEY            workspace API key (blnk_ak_...). Always set on Claw machines.
#   - $BLINK_AGENT_ID           agent id (for per-agent primary link resolution).
#   - $BLINK_APIS_URL           base URL of blink-apis (default: https://core.blink.new).
#
# Safe-by-design: no stored secrets on disk, 1h TTL, token never written anywhere.
# If the mint fails we exit 0 with no output — git will then prompt or fail
# with a clean auth error instead of hanging.

set -eu

op="${1:-get}"
[ "$op" = "get" ] || exit 0

host=""
protocol=""
path_input=""
while IFS= read -r line; do
  [ -z "$line" ] && break
  case "$line" in
    host=*)     host="${line#host=}" ;;
    protocol=*) protocol="${line#protocol=}" ;;
    path=*)     path_input="${line#path=}" ;;
  esac
done

# Only intercept github.com over https. Anything else, stay silent so the
# next credential helper in the chain (or manual prompt) can handle it.
case "$host" in
  github.com) ;;
  *)          exit 0 ;;
esac
[ "$protocol" = "https" ] || exit 0

if [ -z "${BLINK_API_KEY:-}" ]; then
  # No API key = not a Blink Claw environment. Stay silent.
  exit 0
fi

# Extract the repo OWNER from `path=OWNER/repo[/...]` if git sent it
# (requires `credential.https://github.com.useHttpPath = true`). Fallback
# path is empty — mint endpoint picks primary.
#
# We use POSIX shell parameter expansion (portable across BSD/GNU sh,
# dash, busybox) instead of sed regex to stay compatible on any image.
# `${path_input%%/*}` strips everything from the first `/` to the end,
# leaving just the first path segment (i.e. the repo owner).
owner=""
if [ -n "$path_input" ]; then
  owner="${path_input%%/*}"
fi

api_base="${BLINK_APIS_URL:-https://core.blink.new}"
url="${api_base}/v1/github/mint-token"
if [ -n "$owner" ]; then
  # GitHub usernames/orgs are `[A-Za-z0-9-]` (hyphens only, no leading /
  # trailing hyphen). Strip anything else so a crafted remote URL like
  # `https://github.com/../../../etc/passwd` can only ever produce a
  # harmless lookup — pathological characters are removed, and values
  # that degenerate to empty are simply omitted (server falls back to
  # primary).
  enc_owner="$(printf '%s' "$owner" | sed 's/[^A-Za-z0-9-]//g')"
  # Also reject values that start/end with `-` (GitHub doesn't issue these).
  case "$enc_owner" in
    -*|*-) enc_owner="" ;;
  esac
  if [ -n "$enc_owner" ]; then
    url="${url}?repository_owner=${enc_owner}"
  fi
fi

# Issue the mint request. 8s timeout so git operations don't hang if
# blink-apis is slow. --fail so we get a non-zero on HTTP 4xx/5xx without
# printing HTML.
#
# Branching on BLINK_AGENT_ID (rather than building one `agent_hdr` variable
# and splatting it unquoted) is deliberate: POSIX word-splitting on
# `-H "x-blink-agent-id: clw_..."` would produce three tokens
# [-H] [x-blink-agent-id:] [clw_...], making curl treat the agent id as an
# extra URL. Passing -H as a properly-quoted single arg is the only
# portable way to get a header through.
if [ -n "${BLINK_AGENT_ID:-}" ]; then
  response="$(curl -fsS --max-time 8 \
    -H "Authorization: Bearer ${BLINK_API_KEY}" \
    -H "Content-Type: application/json" \
    -H "x-blink-agent-id: ${BLINK_AGENT_ID}" \
    -X POST "$url" \
    -d '{}' 2>/dev/null || true)"
else
  response="$(curl -fsS --max-time 8 \
    -H "Authorization: Bearer ${BLINK_API_KEY}" \
    -H "Content-Type: application/json" \
    -X POST "$url" \
    -d '{}' 2>/dev/null || true)"
fi

if [ -z "$response" ]; then
  exit 0
fi

# Extract .token without a jq dependency (jq not guaranteed on slim image).
# Tolerates whitespace in the JSON. Installation tokens are always ASCII
# `[A-Za-z0-9_]{40,255}` so this regex is safe.
token="$(printf '%s' "$response" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"

if [ -z "$token" ]; then
  exit 0
fi

printf 'username=x-access-token\n'
printf 'password=%s\n' "$token"
