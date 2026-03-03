#!/usr/bin/env bash
set -euo pipefail

SCOPE_NAMESPACES="${SCOPE_NAMESPACES:-morpho-dev,monitoring}"
SECRET_STALE_DAYS="${SECRET_STALE_DAYS:-90}"
SECRET_AGE_SCAN_ENABLED="${SECRET_AGE_SCAN_ENABLED:-0}"
KUBECTL_TIMEOUT="${KUBECTL_TIMEOUT:-8s}"

echo -e "resource_type\tname\tnamespace\texpiry_or_age\tdays_remaining\tstatus"

if ! command -v kubectl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1 || ! command -v date >/dev/null 2>&1; then
  echo -e "collector\tdeps\t-\tn/a\tn/a\tunknown"
  exit 0
fi

have_openssl=1
have_base64=1
command -v openssl >/dev/null 2>&1 || have_openssl=0
command -v base64 >/dev/null 2>&1 || have_base64=0

kctl() {
  kubectl --request-timeout="$KUBECTL_TIMEOUT" "$@"
}

epoch_from_date() {
  local value="$1"
  if [[ -z "$value" || "$value" == "n/a" || "$value" == "null" ]]; then
    echo ""
    return
  fi
  date -u -d "$value" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$value" +%s 2>/dev/null || echo ""
}

days_between_now() {
  local target_epoch="$1"
  local now_epoch
  now_epoch="$(date -u +%s)"
  awk -v t="$target_epoch" -v n="$now_epoch" 'BEGIN { if (t == "") print "n/a"; else printf "%d", int((t-n)/86400) }'
}

status_for_days_remaining() {
  local days="$1"
  if [[ "$days" == "n/a" ]]; then
    echo "unknown"
    return
  fi
  if (( days <= 7 )); then
    echo "critical"
  elif (( days <= 14 )); then
    echo "warning"
  elif (( days <= 30 )); then
    echo "info"
  else
    echo "ok"
  fi
}

ns_allowed() {
  local ns="$1"
  local entry
  IFS=',' read -r -a items <<<"$SCOPE_NAMESPACES"
  for entry in "${items[@]}"; do
    entry="$(printf '%s' "$entry" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
    [[ -z "$entry" ]] && continue
    if [[ "$entry" == "$ns" ]]; then
      return 0
    fi
  done
  return 1
}

emit_cert_rows() {
  local ingress_json secret_rows
  ingress_json="$(kctl get ingress -A -o json 2>/dev/null || printf '{"items":[]}')"
  secret_rows="$(printf '%s\n' "$ingress_json" | jq -r '
    .items[]?
    | .metadata.namespace as $ns
    | .spec.tls[]?.secretName as $secret
    | select($secret != null and $secret != "")
    | [$secret, $ns]
    | @tsv
  ' | sort -u)"

  if [[ -z "$secret_rows" ]]; then
    return
  fi

  while IFS=$'\t' read -r secret ns; do
    [[ -z "$secret" || -z "$ns" ]] && continue
    if ! ns_allowed "$ns"; then
      continue
    fi

    secret_json="$(kctl -n "$ns" get secret "$secret" -o json 2>/dev/null || true)"
    if [[ -z "$secret_json" ]]; then
      echo -e "cert\t${secret}\t${ns}\tn/a\tn/a\tunknown"
      continue
    fi

    cert_b64="$(printf '%s\n' "$secret_json" | jq -r '.data["tls.crt"] // empty')"
    if [[ -z "$cert_b64" || "$have_openssl" -ne 1 || "$have_base64" -ne 1 ]]; then
      echo -e "cert\t${secret}\t${ns}\tn/a\tn/a\tunknown"
      continue
    fi

    cert_end_raw="$(printf '%s' "$cert_b64" | base64 --decode 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null || printf '')"
    if [[ -z "$cert_end_raw" ]]; then
      cert_end_raw="$(printf '%s' "$cert_b64" | base64 -d 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null || printf '')"
    fi

    cert_end="${cert_end_raw#notAfter=}"
    cert_epoch="$(epoch_from_date "$cert_end")"
    days_remaining="$(days_between_now "$cert_epoch")"
    status="$(status_for_days_remaining "$days_remaining")"

    expiry_field="n/a"
    if [[ -n "$cert_end" ]]; then
      expiry_field="$cert_end"
    fi

    echo -e "cert\t${secret}\t${ns}\t${expiry_field}\t${days_remaining}\t${status}"
  done <<<"$secret_rows"
}

emit_secret_age_rows() {
  local secrets_json
  secrets_json="$(kctl get secret -A -o json 2>/dev/null || printf '{"items":[]}')"
  while IFS=$'\t' read -r ns name created; do
    [[ -z "$ns" || -z "$name" || -z "$created" ]] && continue
    if ! ns_allowed "$ns"; then
      continue
    fi
    created_epoch="$(epoch_from_date "$created")"
    [[ -z "$created_epoch" ]] && continue
    age_days="$(awk -v c="$created_epoch" -v n="$(date -u +%s)" 'BEGIN { printf "%d", int((n-c)/86400) }')"
    if (( age_days > SECRET_STALE_DAYS )); then
      echo -e "k8s-secret\t${name}\t${ns}\t${age_days}d\tn/a\tinfo"
    fi
  done < <(
    printf '%s\n' "$secrets_json" | jq -r '.items[]? | [.metadata.namespace, .metadata.name, (.metadata.creationTimestamp // "")] | @tsv'
  )
}

emit_vault_rows() {
  if [[ -z "${VAULT_ADDR:-}" ]]; then
    return
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo -e "vault-lease\tlookup\tvault\tn/a\tn/a\tunknown"
    return
  fi
  if [[ -z "${VAULT_TOKEN:-}" ]]; then
    echo -e "vault-lease\tauth\tvault\tn/a\tn/a\tunknown"
    return
  fi

  list_json="$(curl -fsS -X LIST -H "X-Vault-Token: ${VAULT_TOKEN}" "${VAULT_ADDR%/}/v1/sys/leases/lookup" 2>/dev/null || true)"
  if [[ -z "$list_json" ]]; then
    echo -e "vault-lease\tlookup\tvault\tn/a\tn/a\tunknown"
    return
  fi

  lease_count=0
  while IFS= read -r lease_id; do
    [[ -z "$lease_id" ]] && continue
    lease_json="$(curl -fsS -X POST -H "X-Vault-Token: ${VAULT_TOKEN}" -H 'Content-Type: application/json' \
      -d "{\"lease_id\":\"${lease_id}\"}" "${VAULT_ADDR%/}/v1/sys/leases/lookup" 2>/dev/null || true)"
    ttl="$(printf '%s\n' "$lease_json" | jq -r '.data.ttl // empty' 2>/dev/null || true)"
    [[ -z "$ttl" ]] && continue

    days_remaining="$(awk -v t="$ttl" 'BEGIN { printf "%d", int(t/86400) }')"
    status="ok"
    if (( ttl < 3600 )); then
      status="critical"
    elif (( ttl < 21600 )); then
      status="warning"
    fi

    echo -e "vault-lease\t${lease_id}\tvault\t${ttl}s\t${days_remaining}\t${status}"
    lease_count=$((lease_count + 1))
    if (( lease_count >= 20 )); then
      break
    fi
  done < <(printf '%s\n' "$list_json" | jq -r '.data.keys[]? // empty')

  if (( lease_count == 0 )); then
    echo -e "vault-lease\tnone\tvault\tn/a\tn/a\tok"
  fi
}

emit_cert_rows || true
if [[ "$SECRET_AGE_SCAN_ENABLED" == "1" ]]; then
  emit_secret_age_rows || true
fi
emit_vault_rows || true
