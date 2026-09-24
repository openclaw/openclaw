#!/bin/bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="$ROOT/apps/ios/build/TestTLS/GatewayIngressIdentity.p12"
SCRATCH=""
finish() {
  result=$?
  trap - EXIT
  if [[ -n "$SCRATCH" ]] && ! rm -rf "$SCRATCH"; then result=1; fi
  if [[ $result -ne 0 ]]; then
    echo "[ios-test-tls] FAILED (exit $result)" >&2
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

check_identity() {
  /usr/bin/openssl pkcs12 -in "$1" -passin pass:fixture -noout
  /usr/bin/openssl pkcs12 -in "$1" -passin pass:fixture -clcerts -nokeys |
    /usr/bin/openssl x509 -checkend 0 -noout
}

if [[ "${1:-}" == "--check" && $# -eq 1 ]]; then
  check_identity "$OUTPUT"
  exit 0
fi
if [[ $# -ne 0 ]]; then
  echo "usage: $0 [--check]" >&2
  exit 2
fi

mkdir -p "$(dirname "$OUTPUT")"
SCRATCH="$(mktemp -d "$(dirname "$OUTPUT")/.identity.XXXXXX")"
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost \
  -keyout "$SCRATCH/key.pem" -out "$SCRATCH/cert.pem" 2>"$SCRATCH/generation.log"
/usr/bin/openssl pkcs12 -export -inkey "$SCRATCH/key.pem" -in "$SCRATCH/cert.pem" \
  -out "$SCRATCH/identity.p12" -passout pass:fixture \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
check_identity "$SCRATCH/identity.p12"
mv "$SCRATCH/identity.p12" "$OUTPUT"
echo "[ios-test-tls] generated the test-only listener identity"
