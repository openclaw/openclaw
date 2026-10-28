#!/usr/bin/env bash
set -euo pipefail

gh_bin="${OPENCLAW_GH_CLI_PATH:-$(command -v gh || true)}"
if [[ -z "$gh_bin" || ! -x "$gh_bin" ]]; then
  echo "Set OPENCLAW_GH_CLI_PATH to an executable GitHub CLI." >&2
  exit 2
fi

export OPENCLAW_GH_CLI_PATH="$gh_bin"
if [[ -z "${OPENCLAW_GH_E2E_TRACE_FILE:-}" ]]; then
  OPENCLAW_GH_E2E_TRACE_FILE="$(mktemp "${TMPDIR:-/tmp}/openclaw-gh-publication-proof.XXXXXX")"
  export OPENCLAW_GH_E2E_TRACE_FILE
fi

pnpm exec vitest run src/gateway/github-publication-reconciliation.test.ts -t "real gh client"
cat "$OPENCLAW_GH_E2E_TRACE_FILE"
