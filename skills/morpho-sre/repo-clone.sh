#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  repo-clone.sh --repo <owner/repo|https://github.com/owner/repo.git> [--ref <branch-or-sha>]
  repo-clone.sh --image <substring> [--ref <branch-or-sha>]

Options:
  --repo      GitHub repo slug or URL.
  --image     Resolve repo from running workload image via image-repo-map.sh output.
  --ref       Optional branch, tag, or commit to checkout after clone/fetch.
  --dest-root Clone destination root (default: /home/node/.openclaw/repos).
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

for cmd in awk bash git sed base64; do
  require_cmd "$cmd"
done

REPO_INPUT=""
IMAGE_FILTER=""
REF=""
DEST_ROOT="${DEST_ROOT:-/home/node/.openclaw/repos}"

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
    --ref)
      REF="${2:-}"
      shift 2
      ;;
    --dest-root)
      DEST_ROOT="${2:-}"
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

resolve_repo_url_from_image() {
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
    (q == "" || index($3, q) > 0 || index($4, q) > 0) && $6 != "" {
      print $6
      exit
    }
  ' "$map_file"
}

normalize_repo_url() {
  local input="$1"
  if [[ "$input" =~ ^https?://github\.com/[^[:space:]]+(\.git)?$ ]]; then
    printf '%s\n' "$input"
    return 0
  fi
  if [[ "$input" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]]; then
    printf 'https://github.com/%s.git\n' "$input"
    return 0
  fi
  return 1
}

if [[ -n "$IMAGE_FILTER" ]]; then
  REPO_INPUT="$(resolve_repo_url_from_image "$IMAGE_FILTER")"
fi

if [[ -z "$REPO_INPUT" ]]; then
  echo "failed to resolve repository input" >&2
  exit 1
fi

REPO_URL="$(normalize_repo_url "$REPO_INPUT" || true)"
if [[ -z "$REPO_URL" ]]; then
  echo "invalid repo input: $REPO_INPUT" >&2
  exit 1
fi

SLUG="$(printf '%s' "$REPO_URL" | sed -E 's#^https?://github\.com/##; s#\.git$##')"
if [[ -z "$SLUG" || "$SLUG" == "$REPO_URL" ]]; then
  echo "failed to derive repo slug from: $REPO_URL" >&2
  exit 1
fi

DEST_PATH="${DEST_ROOT%/}/${SLUG}"
AUTH_URL="$REPO_URL"

mint_github_app_token() {
  require_cmd curl
  require_cmd jq
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

github_repo_access_ok() {
  local token="${1:-}"
  local repo="${2:-}"
  local probe_json probe_code

  GITHUB_REPO_ACCESS_LAST_CODE=""
  if [[ -z "$token" || -z "$repo" ]]; then
    return 1
  fi

  probe_json="$(mktemp)"
  probe_code="$(curl -sS -o "$probe_json" -w '%{http_code}' \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${repo}" || true)"
  rm -f "$probe_json"
  GITHUB_REPO_ACCESS_LAST_CODE="$probe_code"

  [[ "$probe_code" == "200" ]]
}

resolve_auth_token_for_repo() {
  local repo="${1:-}"
  local env_token app_token env_probe_code app_probe_code

  env_token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  if [[ -n "$env_token" ]] && github_repo_access_ok "$env_token" "$repo"; then
    printf '%s\n' "$env_token"
    return 0
  fi
  env_probe_code="${GITHUB_REPO_ACCESS_LAST_CODE:-}"

  app_token="$(mint_github_app_token || true)"
  if [[ -n "$app_token" ]] && github_repo_access_ok "$app_token" "$repo"; then
    printf '%s\n' "$app_token"
    return 0
  fi
  app_probe_code="${GITHUB_REPO_ACCESS_LAST_CODE:-}"

  # Best-effort fallback only when probe failure is not an explicit auth/access rejection.
  if [[ -n "$env_token" && "$env_probe_code" != "401" && "$env_probe_code" != "403" && "$env_probe_code" != "404" ]]; then
    printf '%s\n' "$env_token"
    return 0
  fi
  if [[ -n "$app_token" && "$app_probe_code" != "401" && "$app_probe_code" != "403" && "$app_probe_code" != "404" ]]; then
    printf '%s\n' "$app_token"
    return 0
  fi

  return 1
}

resolve_checkout_ref() {
  local repo_path="${1:-}"
  local requested_ref="${2:-}"
  local origin_head first_origin_ref

  if [[ -n "$requested_ref" ]]; then
    printf '%s\n' "$requested_ref"
    return 0
  fi

  origin_head="$(git -C "$repo_path" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [[ "$origin_head" == origin/* ]]; then
    printf '%s\n' "$origin_head"
    return 0
  fi

  first_origin_ref="$(git -C "$repo_path" for-each-ref --format='%(refname:short)' refs/remotes/origin | awk '$0 != "origin/HEAD" { print; exit }')"
  if [[ -n "$first_origin_ref" ]]; then
    printf '%s\n' "$first_origin_ref"
    return 0
  fi

  return 1
}

checkout_clean_slate() {
  local repo_path="${1:-}"
  local requested_ref="${2:-}"
  local checkout_ref

  if [[ -z "$repo_path" ]]; then
    echo "checkout_clean_slate requires repo_path" >&2
    return 1
  fi

  checkout_ref="$(resolve_checkout_ref "$repo_path" "$requested_ref" || true)"
  if [[ -z "$checkout_ref" ]]; then
    echo "failed to resolve checkout ref for clean slate" >&2
    return 1
  fi

  git -C "$repo_path" checkout --detach "$checkout_ref"
  git -C "$repo_path" reset --hard "$checkout_ref"
  git -C "$repo_path" clean -fdx
}

AUTH_TOKEN="$(resolve_auth_token_for_repo "$SLUG" || true)"
if [[ -n "$AUTH_TOKEN" ]]; then
  export GITHUB_TOKEN="$AUTH_TOKEN"
  export GH_TOKEN="$AUTH_TOKEN"
fi

mkdir -p "$(dirname "$DEST_PATH")"

if [[ -d "$DEST_PATH/.git" ]]; then
  git -C "$DEST_PATH" remote set-url origin "$REPO_URL" >/dev/null 2>&1 || true
  if [[ -n "$AUTH_TOKEN" ]]; then
    git_auth_basic="$(printf 'x-access-token:%s' "$AUTH_TOKEN" | base64 | tr -d '\n')"
    git -C "$DEST_PATH" \
      -c credential.helper= \
      -c core.askPass= \
      -c "http.extraHeader=Authorization: Basic ${git_auth_basic}" \
      fetch --quiet --all --prune
  else
    git -C "$DEST_PATH" fetch --quiet --all --prune
  fi
else
  if [[ -n "$AUTH_TOKEN" ]]; then
    git_auth_basic="$(printf 'x-access-token:%s' "$AUTH_TOKEN" | base64 | tr -d '\n')"
    git -c credential.helper= \
      -c core.askPass= \
      -c "http.extraHeader=Authorization: Basic ${git_auth_basic}" \
      clone --quiet --filter=blob:none "$AUTH_URL" "$DEST_PATH"
  else
    git clone --quiet --filter=blob:none "$AUTH_URL" "$DEST_PATH"
  fi
fi

checkout_clean_slate "$DEST_PATH" "$REF"

printf 'repo=%s\n' "$SLUG"
printf 'path=%s\n' "$DEST_PATH"
if [[ -n "$REF" ]]; then
  printf 'ref=%s\n' "$REF"
fi
