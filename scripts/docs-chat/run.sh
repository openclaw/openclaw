#!/usr/bin/env bash
set -euo pipefail

: "${OPENAI_API_KEY:?OPENAI_API_KEY is required}"

pnpm docs:chat:index:vector
pnpm docs:chat:serve:vector
