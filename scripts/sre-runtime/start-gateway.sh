#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"
# shellcheck source=./lib-prompts.sh
. "${SCRIPT_DIR}/lib-prompts.sh"

trim_env_var() {
  var_name="$1"
  if ! [[ "$var_name" =~ ^[A-Z0-9_]+$ ]]; then
    echo "trim-env:warning invalid variable name: $var_name" >&2
    return 0
  fi
  if [ "${!var_name+x}" = x ]; then
    raw_value="${!var_name}"
  else
    raw_value=""
  fi
  trimmed_value="$(printf '%s' "$raw_value" | tr -d '\r')"
  export "${var_name}=${trimmed_value}"
}

for var in \
  ARGOCD_BASE_URL \
  ARGOCD_TOKEN \
  ARGOCD_AUTH_TOKEN \
  ANTHROPIC_API_KEY \
  ANTHROPIC_OAUTH_TOKEN \
  OPENAI_ACCESS_TOKEN \
  OPENAI_API_KEY \
  OPENAI_AUTH_BOOTSTRAP_TOKEN \
  OPENCLAW_GATEWAY_TOKEN \
  OPENCLAW_SRE_SLACK_INCIDENT_CHANNELS \
  GITHUB_APP_ID \
  GITHUB_APP_INSTALLATION_ID \
  GITHUB_APP_PRIVATE_KEY \
  GITHUB_REQUIRED_REPO \
  GITHUB_REQUIRED_ACTIONS_REPO \
  GITHUB_AUTH_STRICT \
  GITHUB_TOKEN \
  GH_TOKEN \
  BOUNDARY_ADDR \
  BOUNDARY_INTERNAL_ADDR \
  BOUNDARY_AUTH_METHOD_ID \
  BOUNDARY_LOGIN_NAME \
  BOUNDARY_PASSWORD \
  BOUNDARY_AUTH_STRICT \
  POSTHOG_HOST_DEV \
  POSTHOG_HOST_PRD \
  POSTHOG_PERSONAL_API_KEY_DEV \
  POSTHOG_PERSONAL_API_KEY_PRD \
  POSTHOG_PROJECT_ID_DEV \
  POSTHOG_PROJECT_ID_PRD \
  POSTHOG_PROJECT_MAP_DEV \
  POSTHOG_PROJECT_MAP_PRD \
  SENTRY_BASE_URL_DEV \
  SENTRY_BASE_URL_PRD \
  SENTRY_AUTH_TOKEN_DEV \
  SENTRY_AUTH_TOKEN_PRD \
  SENTRY_ORG_SLUG_DEV \
  SENTRY_ORG_SLUG_PRD \
  SENTRY_PROJECT_SLUGS_DEV \
  SENTRY_PROJECT_SLUGS_PRD \
  SENTRY_PROJECT_MAP_DEV \
  SENTRY_PROJECT_MAP_PRD \
  WIZ_CLIENT_ID \
  WIZ_CLIENT_SECRET \
  WIZ_CLIENT_ENDPOINT \
  WIZ_DATA_CENTER \
  WIZ_MCP_CLIENT_ID \
  WIZ_MCP_CLIENT_SECRET \
  WIZ_MCP_CLIENT_ENDPOINT \
  WIZ_MCP_DATA_CENTER; do
  trim_env_var "$var"
done

"${SCRIPT_DIR}/seed-state.sh"

mkdir -p /home/node/.kube
cat >/home/node/.kube/config <<EOF
apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
    server: https://${KUBERNETES_SERVICE_HOST:-kubernetes.default.svc}:${KUBERNETES_SERVICE_PORT_HTTPS:-443}
  name: in-cluster
contexts:
- context:
    cluster: in-cluster
    namespace: ${OPENCLAW_K8S_NAMESPACE:-monitoring}
    user: ${OPENCLAW_SERVICE_ACCOUNT_NAME:-incident-readonly-agent}
  name: in-cluster
current-context: in-cluster
users:
- name: ${OPENCLAW_SERVICE_ACCOUNT_NAME:-incident-readonly-agent}
  user:
    tokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
EOF

if [ -z "${VAULT_TOKEN:-}" ] && [ -n "${VAULT_ADDR:-}" ] && command -v curl >/dev/null 2>&1; then
  ROLE="${VAULT_KUBERNETES_ROLE:-${OPENCLAW_SERVICE_ACCOUNT_NAME:-incident-readonly-agent}}"
  AUTH_PATH="${VAULT_KUBERNETES_AUTH_PATH:-kubernetes}"
  JWT="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)"
  LOGIN_BODY="$(jq -nc --arg role "$ROLE" --arg jwt "$JWT" '{role:$role,jwt:$jwt}')"
  VAULT_TOKEN="$(
    curl -sS -X POST "${VAULT_ADDR}/v1/auth/${AUTH_PATH}/login" \
      -H "Content-Type: application/json" \
      --data "$LOGIN_BODY" | jq -r '.auth.client_token // empty'
  )"
  if [ -z "${VAULT_TOKEN:-}" ]; then
    echo "vault-login:warning token empty after login attempt" >&2
  fi
  export VAULT_TOKEN
fi

bootstrap_github_cli_wrappers() {
  wrapper_dir="${OPENCLAW_WRAPPER_BIN_DIR:-/home/node/.openclaw/bin}"
  [ -n "$wrapper_dir" ] || wrapper_dir="/home/node/.openclaw/bin"
  cache_dir="${OPENCLAW_GITHUB_CACHE_DIR:-/home/node/.openclaw/state/github}"
  mkdir -p "$wrapper_dir" "$cache_dir"

  cat >"${wrapper_dir}/github-app-token.sh" <<'EOF'
#!/bin/sh
set -eu
umask 077

cache_dir="${OPENCLAW_GITHUB_CACHE_DIR:-/home/node/.openclaw/state/github}"
cache_file="${cache_dir}/token.json"

if [ -f "$cache_file" ]; then
  if token="$(jq -r '.token // empty' "$cache_file" 2>/dev/null)"; then
    expires_at="$(jq -r '.expires_at // 0' "$cache_file" 2>/dev/null)"
    now="$(date +%s)"
    if [ -n "$token" ] && [ "$expires_at" -gt "$now" ]; then
      printf '%s\n' "$token"
      exit 0
    fi
  fi
fi

app_id="${GITHUB_APP_ID:-}"
installation_id="${GITHUB_APP_INSTALLATION_ID:-}"
private_key="${GITHUB_APP_PRIVATE_KEY:-}"

if [ -z "$app_id" ] || [ -z "$installation_id" ] || [ -z "$private_key" ]; then
  key_len="${#private_key}"
  echo "github-app-token:error missing app credentials (GITHUB_APP_ID=${app_id:+set} GITHUB_APP_INSTALLATION_ID=${installation_id:+set} GITHUB_APP_PRIVATE_KEY=${private_key:+set}, key_len=${key_len})" >&2
  exit 1
fi

header_b64="$(printf '{"alg":"RS256","typ":"JWT"}' | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
now="$(date +%s)"
iat="$((now - 60))"
exp="$((now + 540))"
payload_b64="$(
  printf '{"iat":%s,"exp":%s,"iss":"%s"}' "$iat" "$exp" "$app_id" \
    | openssl base64 -A | tr '+/' '-_' | tr -d '='
)"
unsigned_token="${header_b64}.${payload_b64}"
private_key_file="$(mktemp)"
trap 'rm -f "$private_key_file"' EXIT HUP INT TERM

case "$private_key" in
  *\\n*)
    if ! printf '%s' "$private_key" | awk 'BEGIN { ORS = "" } { while ((i = index($0, "\\n")) > 0) { printf "%s\n", substr($0, 1, i - 1); $0 = substr($0, i + 2) } printf "%s", $0 }' >"$private_key_file"; then
      echo "github-app-token:error failed to process PEM key format" >&2
      exit 1
    fi
    ;;
  *)
    if ! printf '%s' "$private_key" >"$private_key_file"; then
      echo "github-app-token:error failed to process PEM key format" >&2
      exit 1
    fi
    ;;
esac

if ! grep -q '^-----BEGIN ' "$private_key_file"; then
  echo "github-app-token:error PEM key missing BEGIN marker" >&2
  exit 1
fi

if ! grep -q '^-----END ' "$private_key_file"; then
  echo "github-app-token:error PEM key missing END marker" >&2
  exit 1
fi
chmod 600 "$private_key_file"
if ! signature_b64="$(
  printf '%s' "$unsigned_token" \
    | openssl dgst -binary -sha256 -sign "$private_key_file" \
    | openssl base64 -A | tr '+/' '-_' | tr -d '='
)"; then
  echo "github-app-token:error openssl signature generation failed" >&2
  exit 1
fi
rm -f "$private_key_file"
trap - EXIT HUP INT TERM
jwt="${unsigned_token}.${signature_b64}"

if ! response="$(
  curl -fsSL -X POST \
    -H "Authorization: Bearer ${jwt}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/app/installations/${installation_id}/access_tokens"
)"; then
  echo "github-app-token:error GitHub API installation token request failed" >&2
  exit 1
fi

if ! token="$(printf '%s\n' "$response" | jq -r '.token // empty')"; then
  echo "github-app-token:error failed to parse token from GitHub API response" >&2
  exit 1
fi
if ! expires_at_iso="$(printf '%s\n' "$response" | jq -r '.expires_at // empty')"; then
  echo "github-app-token:error failed to parse expires_at from GitHub API response" >&2
  exit 1
fi

if [ -z "$token" ]; then
  echo "github-app-token:error API response missing token" >&2
  exit 1
fi
if [ -z "$expires_at_iso" ]; then
  echo "github-app-token:error API response missing expires_at" >&2
  exit 1
fi

if ! expires_epoch="$(date -d "$expires_at_iso" +%s)"; then
  echo "github-app-token:error failed to parse expires_at timestamp" >&2
  exit 1
fi

if ! jq -n --arg token "$token" --argjson expires_at "$expires_epoch" \
  '{token:$token,expires_at:$expires_at}' >"$cache_file"; then
  echo "github-app-token:warning failed to write token cache" >&2
else
  chmod 600 "$cache_file"
fi
printf '%s\n' "$token"
EOF
  chmod +x "${wrapper_dir}/github-app-token.sh"

cat >"${wrapper_dir}/gh" <<'EOF'
#!/bin/sh
set -eu
wrapper_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if token="$("${wrapper_dir}/github-app-token.sh")"; then
  export GH_TOKEN="$token"
  export GITHUB_TOKEN="$token"
else
  echo 'gh-wrapper:error github app token unavailable' >&2
  exit 1
fi
exec /usr/bin/gh "$@"
EOF
  chmod +x "${wrapper_dir}/gh"

cat >"${wrapper_dir}/git" <<'EOF'
#!/bin/sh
set -eu
wrapper_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
git_cmd=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env)
      shift
      [ "$#" -gt 0 ] && shift || break
      ;;
    --help)
      git_cmd="help"
      break
      ;;
    --version)
      git_cmd="version"
      break
      ;;
    --)
      shift
      [ "$#" -gt 0 ] && git_cmd="$1"
      break
      ;;
    -*)
      shift
      ;;
    *)
      git_cmd="$1"
      break
      ;;
  esac
done

if [ -z "$git_cmd" ]; then
  exec /usr/bin/git "$@"
fi

case "$git_cmd" in
  add|branch|checkout|commit|config|diff|help|log|merge|rebase|reset|restore|rev-parse|show|stash|status|tag|version)
    require_token=0
    ;;
  *)
    require_token=1
    ;;
esac

if token="$("${wrapper_dir}/github-app-token.sh")"; then
  git_auth_basic="$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
  exec /usr/bin/git \
    -c credential.helper= \
    -c core.askPass= \
    -c "http.https://github.com/.extraHeader=Authorization: Basic ${git_auth_basic}" \
    "$@"
fi

if [ "${require_token}" = 1 ]; then
  echo 'git-wrapper:error github app token unavailable' >&2
  exit 1
fi

echo 'git-wrapper:warning github app token unavailable, falling back to unauthenticated git' >&2
exec /usr/bin/git "$@"
EOF
  chmod +x "${wrapper_dir}/git"
}

bootstrap_pg_client() {
  client_dir="/home/node/.openclaw/tools/pgclient"
  module_path="${client_dir}/node_modules/pg"

  if [ -d "$module_path" ]; then
    export OPENCLAW_PG_CLIENT_AVAILABLE=1
    ln -sfn "$client_dir" /tmp/pgclient
    return 0
  fi

  mkdir -p "$client_dir"
  if [ ! -f "$client_dir/package.json" ]; then
    printf '{"name":"openclaw-sre-pgclient","private":true}\n' >"$client_dir/package.json"
  fi

  if npm --prefix "$client_dir" install --no-audit --no-fund --silent pg@8 >/tmp/pg-install.log 2>&1; then
    export OPENCLAW_PG_CLIENT_AVAILABLE=1
    ln -sfn "$client_dir" /tmp/pgclient
    return 0
  fi

  export OPENCLAW_PG_CLIENT_AVAILABLE=0
  echo "pg-client:warning install failed" >&2
  sed -n '1,20p' /tmp/pg-install.log >&2 || true
  echo "pg-client:warning db fallback helpers will be unavailable until pg installs cleanly" >&2
  return 0
}

bootstrap_github_cli_wrappers
bootstrap_pg_client

config_path="${OPENCLAW_CONFIG_PATH:-/home/node/.openclaw/openclaw.json}"
tmp_config="$(mktemp)"

bool_from_env() {
  case "${1:-0}" in
    1|true|TRUE|True|yes|YES|on|ON)
      printf 'true'
      ;;
    *)
      printf 'false'
      ;;
  esac
}

monitoring_prompt="$(build_monitoring_incident_prompt)"
monitoring_prompt_marker="$(monitoring_incident_prompt_marker)"

jq \
  --arg heartbeat_target "${OPENCLAW_HEARTBEAT_ROUTE_TARGET:-}" \
  --arg monitoring_prompt "$monitoring_prompt" \
  --arg monitoring_prompt_marker "$monitoring_prompt_marker" \
  --arg graph_dir "${OPENCLAW_SRE_GRAPH_DIR:-/home/node/.openclaw/state/sre-graph}" \
  --arg dossiers_dir "${OPENCLAW_SRE_DOSSIERS_DIR:-/home/node/.openclaw/state/sre-dossiers}" \
  --arg index_dir "${OPENCLAW_SRE_INDEX_DIR:-/home/node/.openclaw/state/sre-index}" \
  --arg plans_dir "${OPENCLAW_SRE_PLANS_DIR:-/home/node/.openclaw/state/sre-plans}" \
  --arg repo_root "${OPENCLAW_SRE_REPO_ROOT:-/srv/openclaw/repos}" \
  --arg ownership_file "${OPENCLAW_SRE_REPO_OWNERSHIP_FILE:-/home/node/.openclaw/state/sre-index/repo-ownership.json}" \
  --arg wrapper_bin_dir "${OPENCLAW_WRAPPER_BIN_DIR:-/home/node/.openclaw/bin}" \
  --argjson gateway_env_token_enabled "$(bool_from_env "${OPENCLAW_GATEWAY_TOKEN:+1}")" \
  --argjson fallback_enabled "$(bool_from_env "${OPENCLAW_CONTROL_UI_HOST_HEADER_ORIGIN_FALLBACK:-0}")" \
  --argjson insecure_auth_enabled "$(bool_from_env "${OPENCLAW_CONTROL_UI_ALLOW_INSECURE_AUTH:-0}")" \
  --argjson disable_device_auth_enabled "$(bool_from_env "${OPENCLAW_CONTROL_UI_DISABLE_DEVICE_AUTH:-0}")" \
  --argjson provenance_enabled "$(bool_from_env "${OPENCLAW_SRE_PROVENANCE_ENABLED:-0}")" \
  --argjson structured_evidence_enabled "$(bool_from_env "${OPENCLAW_SRE_STRUCTURED_EVIDENCE_ENABLED:-0}")" \
  --argjson incident_dossier_enabled "$(bool_from_env "${OPENCLAW_SRE_INCIDENT_DOSSIER_ENABLED:-0}")" \
  --argjson context_broker_enabled "$(bool_from_env "${OPENCLAW_SRE_CONTEXT_BROKER_ENABLED:-0}")" \
  --argjson repo_ownership_enabled "$(bool_from_env "${OPENCLAW_SRE_REPO_OWNERSHIP_ENABLED:-0}")" \
  --argjson multi_repo_planning_enabled "$(bool_from_env "${OPENCLAW_SRE_MULTI_REPO_PLANNING_ENABLED:-0}")" \
  --argjson multi_repo_pr_enabled "$(bool_from_env "${OPENCLAW_SRE_MULTI_REPO_PR_ENABLED:-0}")" \
  --argjson change_intel_enabled "$(bool_from_env "${OPENCLAW_SRE_CHANGE_INTEL_ENABLED:-0}")" \
  --argjson relationship_index_enabled "$(bool_from_env "${OPENCLAW_SRE_RELATIONSHIP_INDEX_ENABLED:-0}")" \
  '
    def prepend_unique($entry; $existing):
      reduce ([$entry] + $existing)[] as $item
        ([];
          if ($item | type) != "string" or ($item | length) == 0 or index($item) != null then
            .
          else
            . + [$item]
          end
        );
    .tools = (.tools // {})
    | .tools.exec = (
        if ((.tools.exec // null) | type) == "object" then
          .tools.exec
        else
          {}
        end
      )
    | .gateway = (.gateway // {})
    | .gateway.auth = (
        (.gateway.auth // {})
        + (if $gateway_env_token_enabled then {mode: "token"} else {} end)
        | del(.token)
      )
    | .gateway.controlUi = (
        (.gateway.controlUi // {})
        + (if $fallback_enabled then {dangerouslyAllowHostHeaderOriginFallback: true} else {} end)
        + (if $insecure_auth_enabled then {allowInsecureAuth: true} else {} end)
        + (if $disable_device_auth_enabled then {dangerouslyDisableDeviceAuth: true} else {} end)
      )
    | .agents = (.agents // {})
    | .agents.defaults = (.agents.defaults // {})
    | .agents.defaults.heartbeat = (
        (.agents.defaults.heartbeat // {})
        + (if ($heartbeat_target | length) > 0 then {to: $heartbeat_target} else {} end)
      )
    | .agents.defaults.heartbeat.routeAllowlist = (
        (
          (.agents.defaults.heartbeat.routeAllowlist // [])
          | if type == "array" then . else [] end
          | map(select(type == "string"))
        )
        + (if ($heartbeat_target | length) > 0 then [$heartbeat_target] else [] end)
        | unique
      )
    | .agents.list = (
        (.agents.list // [])
        | map(
            .id as $agent_id
            # Inject wrapper bin directory for SRE agents and SRE subagents only.
            | if (["sre", "sre-k8s", "sre-observability", "sre-release", "sre-repo-runtime", "sre-repo-helm", "sre-verifier"] | index($agent_id)) != null then
              .tools = (.tools // {})
              | .tools.exec = (
                  if ((.tools.exec // null) | type) == "object" then
                    .tools.exec
                  else
                    {}
                  end
                )
              | .tools.exec.pathPrepend = prepend_unique(
                  $wrapper_bin_dir;
                  (
                    (.tools.exec.pathPrepend // [])
                    | if type == "array" then . else [] end
                  )
                )
            else
              .
            end
          )
      )
    | .channels.slack.channels["#platform-monitoring"].systemPrompt = $monitoring_prompt
    | .channels.slack.channels["#staging-infra-monitoring"].systemPrompt =
        ($monitoring_prompt
          | sub("^Monitoring incident intake mode:"; "Staging monitoring incident intake mode:")
        )
    | .channels.slack.channels["#public-api-monitoring"].systemPrompt =
        ($monitoring_prompt
          | sub("^Monitoring incident intake mode:"; "Public API monitoring incident intake mode:")
        )
    | .sre = (.sre // {})
    | .sre.provenance = ((.sre.provenance // {}) + {enabled: $provenance_enabled})
    | .sre.structuredEvidence = ((.sre.structuredEvidence // {}) + {enabled: $structured_evidence_enabled})
    | .sre.incidentDossier = ((.sre.incidentDossier // {}) + {enabled: $incident_dossier_enabled})
    | .sre.contextBroker = ((.sre.contextBroker // {}) + {enabled: $context_broker_enabled})
    | .sre.repoOwnership = ((.sre.repoOwnership // {}) + {enabled: $repo_ownership_enabled, filePath: $ownership_file})
    | .sre.multiRepoPlanning = ((.sre.multiRepoPlanning // {}) + {enabled: $multi_repo_planning_enabled})
    | .sre.multiRepoPr = ((.sre.multiRepoPr // {}) + {enabled: $multi_repo_pr_enabled})
    | .sre.changeIntel = ((.sre.changeIntel // {}) + {enabled: $change_intel_enabled})
    | .sre.relationshipIndex = ((.sre.relationshipIndex // {}) + {enabled: $relationship_index_enabled})
    | .sre.stateRoots = (
        (.sre.stateRoots // {})
        + {
          graphDir: $graph_dir,
          dossiersDir: $dossiers_dir,
          indexDir: $index_dir,
          plansDir: $plans_dir
        }
      )
    | .sre.repoBootstrap = ((.sre.repoBootstrap // {}) + {rootDir: $repo_root})
  ' \
  "$config_path" >"$tmp_config"

mv "$tmp_config" "$config_path"
chmod 600 "$config_path" || true

exec openclaw gateway --bind lan --port 18789 --allow-unconfigured
