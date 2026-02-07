#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

SRC="${WA_AUTH_SOURCE:-}"
DST="${STACK_DIR}/state/wa-auth/default"

if [[ -z "${SRC}" ]]; then
  # WhatsApp is optional for this local stack. If no source is provided, keep an empty auth dir
  # so the mux-server won't start the WhatsApp listener.
  rm -rf "${DST}"
  mkdir -p "${DST}"
  echo "[local-mux-e2e] WA_AUTH_SOURCE not set; leaving WhatsApp auth empty (WhatsApp inbound disabled)"
  exit 0
fi

if [[ ! -d "${SRC}" ]]; then
  echo "[local-mux-e2e] WhatsApp auth source not found: ${SRC}" >&2
  echo "[local-mux-e2e] Set WA_AUTH_SOURCE to your local test bot auth directory and retry." >&2
  exit 1
fi

rm -rf "${DST}"
mkdir -p "${DST}"
cp -a "${SRC}/." "${DST}/"

echo "[local-mux-e2e] Copied WhatsApp auth snapshot to ${DST}"
