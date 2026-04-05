#!/usr/bin/env bash
set -euo pipefail

resolve_playwright_chromium() {
  find \
    /opt/openclaw/ms-playwright \
    /home/node/.cache/ms-playwright \
    -maxdepth 4 \
    -type f \
    -path '*/chromium-*/*' \
    -name chrome \
    2>/dev/null | sort -V | tail -n 1
}

chromium_path="$(resolve_playwright_chromium)"

if [[ -z "$chromium_path" ]]; then
  cat >&2 <<'EOF'
No Playwright Chromium binary found.
Rebuild with OPENCLAW_INSTALL_BROWSER=1 or run:
  node /app/node_modules/playwright-core/cli.js install chromium
EOF
  exit 1
fi

exec "$chromium_path" "$@"
