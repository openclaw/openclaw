#!/bin/sh
# Openclaw container entrypoint.
#
# Railway-managed persistent volumes are mounted with root ownership.
# Openclaw runs as the unprivileged `node` user (uid 1000) and needs
# write access to the state dir (config, sessions/memory, agent
# auth-profiles, logs). Without this script the gateway crashloops on
# EACCES at startup.
#
# Flow:
#   1. Run briefly as root.
#   2. Ensure the state dir exists and is owned by node:node.
#   3. Drop privileges via gosu and exec the original CMD as node.
set -e

STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"

# Idempotent: mkdir is a no-op if the dir exists; chown is cheap on
# already-owned trees and harmless on volumes that started root-owned.
mkdir -p "$STATE_DIR"
chown -R node:node "$STATE_DIR" 2>/dev/null || true

# Drop to node and exec the actual CMD (defaults to
# `node openclaw.mjs gateway --allow-unconfigured`).
# tini is preserved as PID 1 so signal forwarding + zombie reaping
# still work.
exec /usr/bin/tini -s -- gosu node "$@"
