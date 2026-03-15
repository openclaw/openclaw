#!/usr/bin/env bash
# Authored by: cc (Claude Code) | 2026-03-15
# Alias for deploy-stable.sh — kept for backwards compatibility.
# Prefer: pnpm deploy:stable
exec "$(dirname "${BASH_SOURCE[0]}")/deploy-stable.sh" "$@"
