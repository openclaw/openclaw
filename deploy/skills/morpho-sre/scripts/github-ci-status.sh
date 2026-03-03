#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  github-ci-status.sh --repo <owner/repo|https://github.com/owner/repo.git> [--limit 5]
  github-ci-status.sh --image <substring> [--limit 5]

Outputs tab-separated rows:
  repo  workflow  run_number  status  conclusion  branch  sha  updated_at  url
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

for cmd in awk bash curl jq sed sort uniq; do
  require_cmd "$cmd"
done

REPO_INPUT=""
IMAGE_FILTER=""
LIMIT="${LIMIT:-5}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO_INPUT="${2:-}"
      shift 2
      ;;
    --image)
      IMAGE_FILTER="${2:-}"
      shift 2
      ;;
    --limit)
      LIMIT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -n "$REPO_INPUT" && -n "$IMAGE_FILTER" ]]; then
  echo "use one of --repo or --image" >&2
  exit 1
fi

if [[ -z "$REPO_INPUT" && -z "$IMAGE_FILTER" ]]; then
  usage
  exit 1
fi

if ! [[ "$LIMIT" =~ ^[0-9]+$ ]] || [[ "$LIMIT" -lt 1 ]]; then
  echo "--limit must be a positive integer" >&2
  exit 1
fi

to_repo_slug() {
  local value="$1"
  value="$(printf '%s' "$value" | sed -E 's#^https?://github\.com/##; s#\.git$##')"
  printf '%s\n' "$value"
}

collect_repos_from_image() {
  local filter="$1"
  local map_script="/home/node/.openclaw/skills/morpho-sre/scripts/image-repo-map.sh"
  local map_file="/tmp/openclaw-image-repo/workload-image-repo.tsv"

  if [[ ! -x "$map_script" ]]; then
    echo "missing executable map script: $map_script" >&2
    exit 1
  fi

  if [[ -n "$filter" ]]; then
    bash "$map_script" --image "$filter" >/dev/null
  else
    bash "$map_script" >/dev/null
  fi

  if [[ ! -f "$map_file" ]]; then
    echo "map output missing: $map_file" >&2
    exit 1
  fi

  awk -F'\t' -v q="$filter" '
    NR == 1 { next }
    (q == "" || index($3, q) > 0 || index($4, q) > 0) && $6 != "" { print $6 }
  ' "$map_file" \
    | sed -E 's#^https?://github\.com/##; s#\.git$##' \
    | awk 'NF > 0 { print }' \
    | sort -u
}

collect_repos_from_input() {
  local input="$1"
  local slug
  slug="$(to_repo_slug "$input")"
  if [[ "$slug" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]]; then
    printf '%s\n' "$slug"
    return 0
  fi
  echo "invalid repo input: $input" >&2
  return 1
}

mint_github_app_token() {
  require_cmd node
  local app_id="${GITHUB_APP_ID:-}"
  local private_key="${GITHUB_APP_PRIVATE_KEY:-}"
  local install_id="${GITHUB_APP_INSTALLATION_ID:-}"
  local install_owner="${GITHUB_APP_OWNER:-morpho-org}"
  local app_jwt install_json install_code token_json token_code token

  if [[ -z "$app_id" || -z "$private_key" ]]; then
    return 1
  fi

  app_jwt="$(GITHUB_APP_ID="$app_id" GITHUB_APP_PRIVATE_KEY="$private_key" node - <<'NODE'
const crypto = require('crypto');
const appId = process.env.GITHUB_APP_ID;
const keyRaw = process.env.GITHUB_APP_PRIVATE_KEY || '';
const key = keyRaw.replace(/\\n/g, '\n');
const now = Math.floor(Date.now() / 1000);
const header = { alg: 'RS256', typ: 'JWT' };
const payload = { iat: now - 60, exp: now + 540, iss: appId };
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const input = `${b64(header)}.${b64(payload)}`;
const signature = crypto.createSign('RSA-SHA256').update(input).sign(key, 'base64url');
process.stdout.write(`${input}.${signature}`);
NODE
  )" || return 1

  if [[ -z "$install_id" ]]; then
    install_json="$(mktemp)"
    install_code="$(curl -sS -o "$install_json" -w '%{http_code}' \
      -H "Authorization: Bearer ${app_jwt}" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/app/installations" || true)"
    if [[ "$install_code" != "200" ]]; then
      rm -f "$install_json"
      return 1
    fi
    install_id="$(jq -r --arg owner "$install_owner" '.[] | select(.account.login==$owner) | .id' "$install_json" | head -n1)"
    rm -f "$install_json"
  fi

  if [[ -z "$install_id" ]]; then
    return 1
  fi

  token_json="$(mktemp)"
  token_code="$(curl -sS -o "$token_json" -w '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${app_jwt}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/app/installations/${install_id}/access_tokens" || true)"
  if [[ "$token_code" != "201" && "$token_code" != "200" ]]; then
    rm -f "$token_json"
    return 1
  fi

  token="$(jq -r '.token // empty' "$token_json")"
  rm -f "$token_json"
  if [[ -z "$token" ]]; then
    return 1
  fi

  printf '%s\n' "$token"
}

AUTH_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [[ -z "$AUTH_TOKEN" ]]; then
  AUTH_TOKEN="$(mint_github_app_token || true)"
fi
STRICT_MODE="${GITHUB_CI_STRICT:-1}"

REPOS=()
if [[ -n "$IMAGE_FILTER" ]]; then
  while IFS= read -r repo; do
    [[ -n "$repo" ]] && REPOS+=("$repo")
  done < <(collect_repos_from_image "$IMAGE_FILTER")
else
  while IFS= read -r repo; do
    [[ -n "$repo" ]] && REPOS+=("$repo")
  done < <(collect_repos_from_input "$REPO_INPUT")
fi

if [[ "${#REPOS[@]}" -eq 0 ]]; then
  echo "no repositories found" >&2
  exit 1
fi

echo -e "repo\tworkflow\trun_number\tstatus\tconclusion\tbranch\tsha\tupdated_at\turl"

failures=0
successes=0
for repo in "${REPOS[@]}"; do
  tmp_json="$(mktemp)"
  if [[ -n "$AUTH_TOKEN" ]]; then
    http_code="$(curl -sS \
      -H "Authorization: Bearer ${AUTH_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/${repo}/actions/runs?per_page=${LIMIT}" \
      -o "$tmp_json" \
      -w '%{http_code}')"
  else
    http_code="$(curl -sS \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/${repo}/actions/runs?per_page=${LIMIT}" \
      -o "$tmp_json" \
      -w '%{http_code}')"
  fi

  if [[ "$http_code" != "200" ]]; then
    message="$(jq -r '.message // "unknown error"' "$tmp_json" 2>/dev/null || echo "unknown error")"
    echo "repo=${repo} error=http_${http_code} message=${message}" >&2
    failures=$((failures + 1))
    rm -f "$tmp_json"
    continue
  fi
  successes=$((successes + 1))

  jq -r --arg repo "$repo" '
    .workflow_runs[]
    | [
        $repo,
        (.name // "-"),
        (.run_number | tostring),
        (.status // "-"),
        (.conclusion // "-"),
        (.head_branch // "-"),
        ((.head_sha // "-")[0:12]),
        (.updated_at // "-"),
        (.html_url // "-")
      ]
    | @tsv
  ' "$tmp_json"
  rm -f "$tmp_json"
done

if [[ "$successes" -eq 0 ]]; then
  echo "no successful GitHub Actions queries" >&2
  exit 1
fi

if [[ "$failures" -gt 0 && "$STRICT_MODE" == "1" ]]; then
  echo "one or more GitHub Actions queries failed (strict mode)" >&2
  exit 1
fi
