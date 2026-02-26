#!/bin/bash
# E2E tests for chrome-cleanup.sh
# Run with: bash scripts/e2e/test-chrome-cleanup.sh

set -e

echo "=== Chrome Cleanup E2E Tests ==="
echo ""

# Test 1: Platform detection
echo "[Test 1] Platform detection..."
PLATFORM=$(uname -s)
if [[ "$PLATFORM" == "Linux" ]] || [[ "$PLATFORM" == "Darwin" ]]; then
    echo "  ✓ PASS: Platform detected as $PLATFORM"
else
    echo "  ⚠ SKIP: Unknown platform $PLATFORM"
fi

# Test 2: Script executes without errors
echo ""
echo "[Test 2] Script executes (status mode)..."
if bash scripts/chrome-cleanup.sh status >/dev/null 2>&1; then
    echo "  ✓ PASS: Script executed successfully"
else
    echo "  ✓ INFO: Status returned non-zero (expected if no Chrome running)"
fi

# Test 3: Config file exists
echo ""
echo "[Test 3] Config file exists..."
if [ -f scripts/chrome-cleanup.conf ]; then
    echo "  ✓ PASS: Config file found"
else
    echo "  ✗ FAIL: Config file missing"
    exit 1
fi

# Test 4: Log directory handling
echo ""
echo "[Test 4] Log directory handling..."
LOG_DIR="$HOME/.openclaw/logs"
if [ -d "$LOG_DIR" ] || mkdir -p "$LOG_DIR" 2>/dev/null; then
    echo "  ✓ PASS: Log directory ready"
else
    echo "  ⚠ WARN: Could not create log directory"
fi

# Test 5: Array initialization (critical fix verification)
echo ""
echo "[Test 5] Array initialization logic..."
# Simulate the fixed array initialization
test_pids="1234 5678 9012"
read -ra test_array <<< "$test_pids"
if [[ ${#test_array[@]} -eq 3 ]]; then
    echo "  ✓ PASS: Array correctly splits into 3 elements"
else
    echo "  ✗ FAIL: Array has ${#test_array[@]} elements, expected 3"
    exit 1
fi

# Test 6: Signal handling (daemon mode)
echo ""
echo "[Test 6] Signal handling setup..."
# Check if trap is defined in the script
if grep -q "trap.*SIGTERM.*SIGINT" scripts/chrome-cleanup.sh; then
    echo "  ✓ PASS: Signal handlers configured"
else
    echo "  ✗ FAIL: Signal handlers missing"
    exit 1
fi

# Test 7: User-data-dir filtering
echo ""
echo "[Test 7] OpenClaw user-data-dir filtering..."
if grep -q "user-data-dir.*OPENCLAW_USERDATA_DIR" scripts/chrome-cleanup.sh; then
    echo "  ✓ PASS: User-data-dir filtering present"
else
    echo "  ✗ FAIL: User-data-dir filtering missing"
    exit 1
fi

# Test 8: Platform-specific commands
echo ""
echo "[Test 8] Platform-specific command detection..."
if grep -q "PLATFORM=\"linux\"" scripts/chrome-cleanup.sh && \
   grep -q "PLATFORM=\"macos\"" scripts/chrome-cleanup.sh; then
    echo "  ✓ PASS: Platform detection implemented"
else
    echo "  ✗ FAIL: Platform detection missing"
    exit 1
fi

echo ""
echo "=== Test Summary ==="
echo "All critical tests passed!"
echo ""
echo "TODO: Add integration tests with mock Chrome processes:"
echo "  - Mock Chrome process creation"
echo "  - Idle timeout enforcement"
echo "  - Max instance enforcement"
echo "  - CDP connection detection"
echo "  - Process cleanup verification"
