#!/usr/bin/env bash
set -euo pipefail

# Local preflight mirror for key CI lanes (fast fail).
# Not a full replacement for GitHub matrix (esp. Windows/macOS),
# but catches most drift before pushing.

echo "[1/7] format + lint + type checks"
pnpm check

echo "[2/7] protocol drift"
pnpm protocol:check

echo "[3/7] plugin-sdk import guard"
pnpm lint:plugins:no-monolithic-plugin-sdk-entry-imports

echo "[4/7] core unit tests"
pnpm test

echo "[5/7] bun lane equivalent (if bunx exists)"
if command -v bunx >/dev/null 2>&1; then
  pnpm canvas:a2ui:bundle
  bunx vitest run --config vitest.unit.config.ts
else
  echo "bunx not found; skipping bun lane"
fi

echo "[6/7] docs checks"
pnpm check-docs || true

echo "[7/7] targeted protocol/gateway tests"
pnpm exec vitest run src/gateway/server.ios-client-id.test.ts

echo "✅ Local preflight complete"
