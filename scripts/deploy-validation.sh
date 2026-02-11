#!/usr/bin/env bash
set -euo pipefail

# Deployment Validation Script for OpenClaw
# Checks if the gateway container is running, healthy, and accessible.

CONTAINER_NAME="openclaw-gateway-1"
# Fallback to probable name if docker compose project name varies
if ! docker ps -q --filter "name=$CONTAINER_NAME" | grep -q .; then
  CONTAINER_NAME="claw-openclaw-gateway-1"
fi
# Final fallback: search by image/service label if possible, or just accept the first argument
if [[ "${1:-}" != "" ]]; then
  CONTAINER_NAME="$1"
fi

echo "==> Validating deployment for container: $CONTAINER_NAME"

# 1. Check Container Status
echo "1. Checking container status..."
if ! docker ps --filter "name=$CONTAINER_NAME" --format '{{.Status}}' | grep -q "Up"; then
  echo "❌ Container $CONTAINER_NAME is not running."
  echo "Current status: $(docker ps --filter "name=$CONTAINER_NAME" --format '{{.Status}}')"
  echo "Logs:"
  docker logs "$CONTAINER_NAME" | tail -n 10
  exit 1
fi
echo "✅ Container is running."

# 2. Check Port Accessibility (Local)
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
echo "2. Checking local port $PORT..."
if ! nc -z localhost "$PORT" >/dev/null 2>&1; then
   # Try 127.0.0.1 explicitly
   if ! nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; then
      echo "❌ Port $PORT is not accessible on localhost."
      exit 1
   fi
fi
echo "✅ Port $PORT is open."

# 3. Application Health Check
echo "3. Checking application health..."
# Retrieve token from environment or inspect container if not set locally
TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  echo "   (Attempting to retrieve token from container env...)"
  TOKEN=$(docker exec "$CONTAINER_NAME" env | grep OPENCLAW_GATEWAY_TOKEN | cut -d= -f2)
fi

if [[ -z "$TOKEN" ]]; then
  echo "⚠️  Could not find OPENCLAW_GATEWAY_TOKEN. Skipping authenticated health check."
else
  HEALTH_OUTPUT=$(docker exec "$CONTAINER_NAME" node dist/index.js health --token "$TOKEN")
  if echo "$HEALTH_OUTPUT" | grep -q "ok"; then
    echo "✅ Application health check passed."
  else
    echo "❌ Application health check failed."
    echo "Output: $HEALTH_OUTPUT"
    exit 1
  fi
fi

# 4. Log Scan for Errors
echo "4. Scanning logs for recent errors..."
if docker logs "$CONTAINER_NAME" --since 5m 2>&1 | grep -iE "error|exception|fail" | sort | uniq | head -n 5; then
  echo "⚠️  Found potential errors in recent logs (last 5 mins). Please review."
else
  echo "✅ No recent errors found in logs."
fi

echo ""
echo "Deployment validation complete. System appears healthy. 🚀"
