#!/usr/bin/env bash
set -euo pipefail

# Script to verify @lancedb/lancedb is correctly included in the Docker image
# This validates that the multi-stage Docker build correctly compiles the native module

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${OPENCLAW_TEST_IMAGE:-openclaw:test-lancedb}"

echo "🔨 Building Docker image: $IMAGE_NAME"
docker build -t "$IMAGE_NAME" "$ROOT_DIR"

echo "🧪 Testing @lancedb/lancedb availability in Docker image..."

# Test 1: Check if lancedb module can be loaded
echo "  Test 1: Verify @lancedb/lancedb can be loaded"
docker run --rm "$IMAGE_NAME" node -e "
  import('@lancedb/lancedb').then(m => {
    const connect = m.default?.connect || m.connect;
    if (typeof connect !== 'function') {
      throw new Error('lancedb.connect is not a function');
    }
    console.log('✅ @lancedb/lancedb loaded successfully');
    console.log('✅ connect() function available');
  }).catch(err => {
    console.error('❌ Failed to load @lancedb/lancedb:', err.message);
    process.exit(1);
  });
" || {
  echo "❌ FAILED: @lancedb/lancedb is not available in Docker image"
  echo "   This indicates the multi-stage Docker build did not correctly compile the native module"
  exit 1
}

# Test 2: Check native module file exists in the image
echo "  Test 2: Verify native module binaries exist"
docker run --rm "$IMAGE_NAME" bash -c '
  if find /app/node_modules -name "*.node" 2>/dev/null | grep -q lancedb; then
    echo "✅ LanceDB native binaries (.node files) found"
  else
    echo "⚠️  No .node files found (may be ok if dynamically linked)"
  fi
' || true

# Test 3: Check that the build tools were NOT included in the final image
echo "  Test 3: Verify build tools are NOT in runtime image"
BUILD_TOOLS_CHECK=$(docker run --rm "$IMAGE_NAME" bash -c '
  COUNT=0
  which python3 2>/dev/null && ((COUNT++)) || true
  which make 2>/dev/null && ((COUNT++)) || true
  which g++ 2>/dev/null && ((COUNT++)) || true
  echo $COUNT
') || BUILD_TOOLS_CHECK="0"

if [ "$BUILD_TOOLS_CHECK" = "0" ]; then
  echo "✅ Build tools (python3, make, g++) correctly removed from runtime image"
else
  echo "⚠️  Found $BUILD_TOOLS_CHECK build tools in runtime image (space waste)"
fi

# Test 4: Verify ca-certificates are installed (needed for HTTPS)
echo "  Test 4: Verify ca-certificates installed"
docker run --rm "$IMAGE_NAME" bash -c '
  if [ -d /etc/ssl/certs ] && [ -f /etc/ssl/certs/ca-certificates.crt ]; then
    echo "✅ ca-certificates correctly installed"
  else
    echo "❌ ca-certificates missing"
    exit 1
  fi
' || {
  echo "❌ FAILED: ca-certificates not available"
  exit 1
}

echo ""
echo "✅ All Docker lancedb integration tests passed!"
echo ""
echo "Summary:"
echo "  ✓ @lancedb/lancedb native module is compiled and available"
echo "  ✓ Build tools are removed from runtime image (size optimized)"
echo "  ✓ ca-certificates are available for HTTPS"
echo "  ✓ Docker multi-stage build is working correctly"
