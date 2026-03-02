#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${1:-openclaw-openclaw-gateway-1}"

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "container not running: ${CONTAINER}" >&2
  exit 1
fi

ALLOW_PREFIXES=(
  "/srv/openclaw"
  "/home/tjrgus/.openclaw"
  "/usr/local/sbin"
  "/var/run/docker.sock"
)

DENY_PREFIXES=(
  "/mnt"
  "/var/lib/docker"
  "/home/tjrgus/.ssh"
)

mapfile -t SOURCES < <(docker inspect -f '{{range .Mounts}}{{println .Source}}{{end}}' "${CONTAINER}" | sed '/^$/d')

violations=0
for src in "${SOURCES[@]}"; do
  for deny in "${DENY_PREFIXES[@]}"; do
    if [[ "${src}" == "${deny}"* ]]; then
      allowed=0
      for allow in "${ALLOW_PREFIXES[@]}"; do
        if [[ "${src}" == "${allow}"* ]]; then
          allowed=1
          break
        fi
      done
      if [ "${allowed}" -eq 0 ]; then
        echo "DENY mount detected: ${src}" >&2
        violations=$((violations + 1))
      fi
    fi
  done

  if [[ "${src}" == "/home/tjrgus/.openclaw" ]]; then
    echo "INFO: config mount present (allowed exception): ${src}"
  fi
done

if [ "${violations}" -gt 0 ]; then
  echo "sensitive mount check: FAIL (${violations} violations)" >&2
  exit 2
fi

echo "sensitive mount check: PASS"
