#!/usr/bin/env bash
# UFW helpers for ClaWorks white-label (optional). Requires sudo.
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo $0 apply" >&2
  exit 1
fi

case "${1:-apply}" in
  apply)
    ufw allow 443/tcp comment 'ClaWorks HTTPS'
    ufw allow 80/tcp comment 'ClaWorks HTTP redirect'
    ufw deny 18789/tcp comment 'Block OpenClaw Gateway'
    ufw deny 8000/tcp comment 'Block ClaWorks Platform direct'
    ufw deny 8001/tcp comment 'Block ClaWorks ops direct'
    echo "Rules added. Review with: ufw status numbered"
    ;;
  status)
    ufw status numbered
    ;;
  *)
    echo "Usage: sudo $0 [apply|status]" >&2
    exit 1
    ;;
esac
