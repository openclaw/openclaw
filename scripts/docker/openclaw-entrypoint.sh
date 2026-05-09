#!/bin/sh
# Openclaw container entrypoint.
#
# Runs as root and stays as root for the workload. The upstream
# Dockerfile drops to the `node` user for defense-in-depth, but on
# Railway the persistent volume is mounted root-owned and chown
# inside the container is silently denied — leaving the gateway
# unable to read or write its state dir as `node`. Single-tenant
# Railway services already isolate the container from the host, so
# root-in-container is an acceptable trade. tini stays PID 1 for
# signal forwarding + zombie reaping.
set -e

STATE_DIR="${OPENCLAW_STATE_DIR:-/root/.openclaw}"
mkdir -p "$STATE_DIR"

exec /usr/bin/tini -s -- "$@"
