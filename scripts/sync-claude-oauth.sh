#!/usr/bin/env bash
# Sync Claude Code OAuth credentials into OpenClaw auth-profiles.json
# Usage: ./scripts/sync-claude-oauth.sh

set -euo pipefail

exec node --import tsx "$(dirname "$0")/sync-claude-oauth.ts"
