#!/bin/sh
set -e

PROXY_HOST="${DOCKER_PROXY_HOST:-docker-socket-proxy}"

# Get container ID - try multiple methods for cgroup v1/v2 compatibility
# Assumes: running inside a Docker container with default hostname behavior
# (Docker sets hostname to short container ID unless explicitly overridden)

CONTAINER_ID=""

# Method 1: cgroup v2 (systemd-based, e.g., Docker Desktop, modern Linux)
# Path format: 0::/docker/<container-id> or 0::/system.slice/docker-<id>.scope
if [ -z "$CONTAINER_ID" ]; then
  CONTAINER_ID=$(cat /proc/self/cgroup 2>/dev/null | grep -oE 'docker[/-][0-9a-f]{64}' | grep -oE '[0-9a-f]{64}' | head -1)
fi

# Method 2: cgroup v1 (long container ID in cgroup path)
if [ -z "$CONTAINER_ID" ]; then
  CONTAINER_ID=$(cat /proc/self/cgroup 2>/dev/null | grep -oE '[0-9a-f]{64}' | head -1)
fi

# Method 3: cpuset (works on some cgroup v2 setups)
if [ -z "$CONTAINER_ID" ]; then
  CONTAINER_ID=$(cat /proc/1/cpuset 2>/dev/null | grep -oE '[0-9a-f]{64}' | head -1)
fi

# Method 4: hostname fallback (Docker sets hostname to short container ID by default)
# Note: This won't work if hostname is explicitly set in compose/run
if [ -z "$CONTAINER_ID" ]; then
  CONTAINER_ID=$(hostname 2>/dev/null)
fi

if [ -z "$CONTAINER_ID" ]; then
  echo "Error: Could not determine container ID" >&2
  exit 1
fi

echo "Requesting restart for container $CONTAINER_ID..."
curl -sf -X POST "http://${PROXY_HOST}:2375/containers/${CONTAINER_ID}/restart" || {
  echo "Error: Failed to restart container. Is docker-socket-proxy running?" >&2
  exit 1
}
