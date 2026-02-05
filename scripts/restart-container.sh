#!/bin/sh
set -e

PROXY_HOST="${DOCKER_PROXY_HOST:-docker-socket-proxy}"

# Get container ID - try multiple methods
# Method 1: cgroup v1 (long container ID in cgroup path)
CONTAINER_ID=$(cat /proc/self/cgroup 2>/dev/null | grep -oE '[0-9a-f]{64}' | head -1)

# Method 2: hostname (Docker sets hostname to short container ID by default)
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
