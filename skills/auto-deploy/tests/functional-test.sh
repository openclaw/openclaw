#!/bin/bash

# Functional Test Script for Auto-Deployment Skill
# Tests all components without requiring unit test framework

echo "═════════════════════════════════════════"
echo "🧪 Auto-Deploy Skill Functional Tests"
echo "═════════════════════════════════════════"
echo ""

# Test counters
PASSED=0
FAILED=0

# Test function
test() {
    local name="$1"
    local command="$2"
    
    echo -n "Testing: $name ... "
    
    if eval "$command" > /dev/null 2>&1; then
        echo "✅ PASS"
        ((PASSED++))
    else
        echo "❌ FAIL"
        ((FAILED++))
    fi
}

# Change to skill directory
cd /usr/local/lib/node_modules/openclaw/skills/auto-deploy || exit 1

echo "1. File Structure Tests"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
test "SKILL.md exists" "[ -f SKILL.md ]"
test "README.md exists" "[ -f README.md ]"
test "index.js exists" "[ -f index.js ]"
test "lib/detector.cjs exists" "[ -f lib/detector.cjs ]"
test "lib/installer.cjs exists" "[ -f lib/installer.cjs ]"
test "lib/configurator.cjs exists" "[ -f lib/configurator.cjs ]"
test "lib/validator.cjs exists" "[ -f lib/validator.cjs ]"
test "lib/troubleshooter.cjs exists" "[ -f lib/troubleshooter.cjs ]"
echo ""

echo "2. Module Execution Tests"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
test "detector.cjs runs" "node lib/detector.cjs"
test "troubleshooter.cjs runs" "node lib/troubleshooter.cjs"
echo ""

echo "3. Environment Detection"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
OUTPUT=$(node lib/detector.cjs)
if echo "$OUTPUT" | grep -q "OS:"; then
    echo "Testing: OS detection ... ✅ PASS"
    ((PASSED++))
else
    echo "Testing: OS detection ... ❌ FAIL"
    ((FAILED++))
fi

if echo "$OUTPUT" | grep -q "Node.js:"; then
    echo "Testing: Node.js detection ... ✅ PASS"
    ((PASSED++))
else
    echo "Testing: Node.js detection ... ❌ FAIL"
    ((FAILED++))
fi
echo ""

echo "4. Troubleshooting"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
OUTPUT=$(node lib/troubleshooter.cjs 2>&1)
if echo "$OUTPUT" | grep -q "Running Diagnostics"; then
    echo "Testing: Diagnostics runs ... ✅ PASS"
    ((PASSED++))
else
    echo "Testing: Diagnostics runs ... ❌ FAIL"
    ((FAILED++))
fi
echo ""

echo "═════════════════════════════════════════"
echo "Test Summary"
echo "═════════════════════════════════════════"
echo "Passed: $PASSED"
echo "Failed: $FAILED"
echo "Total:  $((PASSED + FAILED))"
echo "═════════════════════════════════════════"
echo ""

if [ $FAILED -eq 0 ]; then
    echo "✅ All tests passed!"
    exit 0
else
    echo "❌ Some tests failed"
    exit 1
fi
