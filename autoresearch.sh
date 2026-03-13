#!/usr/bin/env bash
# Autoresearch benchmark for OpenClaw bootstrap system prompt assembly.
# Outputs METRIC lines that pi-autoresearch captures.
#
# Metrics:
#   system_prompt_stable_chars — chars before first dynamic content (higher = better cache prefix)
#   system_prompt_total_chars  — total assembled system prompt length (lower = cheaper)

set -euo pipefail

# Run benchmark TypeScript directly with bun (no build step needed)
bun scripts/autoresearch-benchmark.ts 2>/dev/null
