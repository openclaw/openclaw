#!/usr/bin/env bash

db_target_kubectl() {
  if [[ -n "${K8S_CONTEXT:-}" ]]; then
    if kubectl --context "$K8S_CONTEXT" "$@" 2>/dev/null; then
      return
    fi
    printf 'warning: kubectl context %s failed, falling back to serviceaccount auth\n' "$K8S_CONTEXT" >&2
  fi
  if [[ -f /var/run/secrets/kubernetes.io/serviceaccount/token ]]; then
    local token ca server
    token="/var/run/secrets/kubernetes.io/serviceaccount/token"
    ca="/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
    server="https://${KUBERNETES_SERVICE_HOST:-kubernetes.default.svc}:${KUBERNETES_SERVICE_PORT_HTTPS:-443}"
    (
      umask 077
      kubeconfig="$(mktemp)"
      trap 'rm -f "$kubeconfig"' EXIT
      cat >"$kubeconfig" <<EOF
apiVersion: v1
kind: Config
clusters:
- name: in-cluster
  cluster:
    server: ${server}
    certificate-authority: ${ca}
contexts:
- name: in-cluster
  context:
    cluster: in-cluster
    user: sa-user
current-context: in-cluster
users:
- name: sa-user
  user:
    token: $(cat "$token")
EOF
      chmod 600 "$kubeconfig"
      kubectl --kubeconfig "$kubeconfig" "$@"
    )
    return $?
  fi
  kubectl "$@"
}

db_target_infer_from_service() {
  local service="${1:-}"
  service="$(printf '%s' "$service" | tr '[:upper:]' '[:lower:]')"
  case "$service" in
    *indexer* )
      printf 'indexer\n'
      ;;
    *realtime* )
      printf 'realtime\n'
      ;;
    *historical* )
      printf 'historical\n'
      ;;
    *processor* )
      printf 'processor\n'
      ;;
    *blue-api* | *blue_api* | *blueapi* )
      printf 'blue_api\n'
      ;;
    * )
      printf 'unknown\n'
      ;;
  esac
}

db_target_name_regex() {
  local alias="${1:-unknown}"
  case "$alias" in
    indexer)
      printf '(?i)indexer|blue-api.*processor|realtime-processor'
      ;;
    realtime)
      printf '(?i)realtime|blue-api.*realtime|morpho-realtime-api'
      ;;
    historical)
      printf '(?i)historical|snapshot|backfill'
      ;;
    processor)
      printf '(?i)processor'
      ;;
    blue_api)
      printf '(?i)blue-api|blue_api|public|partner|app'
      ;;
    *)
      printf '(?i)(blue|indexer|postgres|pg|realtime|historical|processor)'
      ;;
  esac
}

db_target_key_regex() {
  printf '(?i)(database_url|indexer_database_url|postgres_url|pg(host|port|user|password|database)|db(host|port|user|password|name))'
}

db_target_find_secret() {
  local namespace="${1:?namespace required}"
  local alias="${2:-unknown}"
  local name_regex key_regex
  name_regex="$(db_target_name_regex "$alias")"
  key_regex="$(db_target_key_regex)"

  db_target_kubectl -n "$namespace" get secret -o json \
    | jq -r --arg name_regex "$name_regex" --arg key_regex "$key_regex" '
        .items[]
        | select(
            (.metadata.name | test($name_regex))
            and (
              (.data // {})
              | keys
              | map(test($key_regex))
              | any
            )
          )
        | .metadata.name
      ' \
    | head -n1
}

db_target_parse_url() {
  local raw_url="${1:-}"
  [[ -n "$raw_url" ]] || return 1

  node - "$raw_url" <<'NODE'
const raw = process.argv[2];
if (!raw) process.exit(1);
let url;
try {
  url = new URL(raw);
} catch {
  process.exit(1);
}
const out = {
  PGHOST: url.hostname || "",
  PGPORT: url.port || "5432",
  PGUSER: decodeURIComponent(url.username || ""),
  PGPASSWORD: decodeURIComponent(url.password || ""),
  PGDATABASE: (url.pathname || "").replace(/^\/+/, ""),
};
for (const [key, value] of Object.entries(out)) {
  if (value) {
    console.log(`${key}=${value}`);
  }
}
NODE
}

db_target_qualify_host() {
  local namespace="${1:-}"
  local host="${2:-}"
  if [[ -z "$namespace" || -z "$host" ]]; then
    printf '%s\n' "$host"
    return
  fi
  if [[ "$host" == *.* || "$host" == "localhost" ]]; then
    printf '%s\n' "$host"
    return
  fi
  printf '%s.%s.svc.cluster.local\n' "$host" "$namespace"
}

db_target_normalize_env() {
  local namespace="${1:?namespace required}"
  local input="${2:-}"
  local host="" port="" user="" password="" database=""
  while IFS='=' read -r key value; do
    [[ -n "$key" ]] || continue
    case "$key" in
      PGHOST) host="$value" ;;
      PGPORT) port="$value" ;;
      PGUSER) user="$value" ;;
      PGPASSWORD) password="$value" ;;
      PGDATABASE) database="$value" ;;
    esac
  done <<<"$input"

  [[ -n "$host" ]] && printf 'PGHOST=%s\n' "$(db_target_qualify_host "$namespace" "$host")"
  [[ -n "$port" ]] && printf 'PGPORT=%s\n' "$port"
  [[ -n "$user" ]] && printf 'PGUSER=%s\n' "$user"
  [[ -n "$password" ]] && printf 'PGPASSWORD=%s\n' "$password"
  [[ -n "$database" ]] && printf 'PGDATABASE=%s\n' "$database"
}

db_target_decode_secret() {
  local namespace="${1:?namespace required}"
  local secret_name="${2:?secret_name required}"
  local secret_json keys key decoded

  secret_json="$(
    db_target_kubectl -n "$namespace" get secret "$secret_name" -o json
  )" || return 1

  keys="$(printf '%s\n' "$secret_json" | jq -r '(.data // {}) | keys[]')"
  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    decoded="$(printf '%s\n' "$secret_json" | jq -r --arg key "$key" '.data[$key] | @base64d')"
    case "$key" in
      DATABASE_URL | database_url | POSTGRES_URL | postgres_url | INDEXER_DATABASE_URL | indexer_database_url)
        db_target_parse_url "$decoded"
        ;;
      PGHOST | pghost | DB_HOST | db_host)
        printf 'PGHOST=%s\n' "$decoded"
        ;;
      PGPORT | pgport | DB_PORT | db_port)
        printf 'PGPORT=%s\n' "$decoded"
        ;;
      PGUSER | pguser | DB_USER | db_user)
        printf 'PGUSER=%s\n' "$decoded"
        ;;
      PGPASSWORD | pgpassword | DB_PASSWORD | db_password)
        printf 'PGPASSWORD=%s\n' "$decoded"
        ;;
      PGDATABASE | pgdatabase | DB_NAME | db_name)
        printf 'PGDATABASE=%s\n' "$decoded"
        ;;
    esac
  done <<<"$keys"
}

db_target_resolve_env() {
  local namespace="${1:?namespace required}"
  local alias="${2:-unknown}"
  local secret_name resolved

  if [[ -n "${DATABASE_URL:-}" ]]; then
    db_target_normalize_env "$namespace" "$(db_target_parse_url "${DATABASE_URL}")"
    return 0
  fi
  if [[ -n "${INDEXER_DATABASE_URL:-}" ]]; then
    db_target_normalize_env "$namespace" "$(db_target_parse_url "${INDEXER_DATABASE_URL}")"
    return 0
  fi
  if [[ -n "${PGHOST:-}" && -n "${PGUSER:-}" && -n "${PGDATABASE:-}" ]]; then
    printf 'PGHOST=%s\n' "$(db_target_qualify_host "$namespace" "$PGHOST")"
    printf 'PGPORT=%s\n' "${PGPORT:-5432}"
    printf 'PGUSER=%s\n' "$PGUSER"
    [[ -n "${PGPASSWORD:-}" ]] && printf 'PGPASSWORD=%s\n' "$PGPASSWORD"
    printf 'PGDATABASE=%s\n' "$PGDATABASE"
    return 0
  fi

  secret_name="$(db_target_find_secret "$namespace" "$alias")" || return 1
  [[ -n "$secret_name" ]] || return 1
  resolved="$(db_target_decode_secret "$namespace" "$secret_name")" || return 1
  [[ -n "$resolved" ]] || return 1
  db_target_normalize_env "$namespace" "$resolved"
}
