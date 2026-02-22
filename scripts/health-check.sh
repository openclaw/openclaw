#!/bin/bash
# OpenClaw health check script
# Verifies all components are working correctly

set -e

echo "🏥 OpenClaw Health Check"
echo "========================"
echo ""

CHECKS_PASSED=0
CHECKS_FAILED=0
WARNINGS=0

# Function to report results
check_pass() {
    echo "   ✅ $1"
    ((CHECKS_PASSED++))
}

check_fail() {
    echo "   ❌ $1"
    ((CHECKS_FAILED++))
}

check_warn() {
    echo "   ⚠️  $1"
    ((WARNINGS++))
}

# Check 1: OpenClaw installed
echo "1️⃣  OpenClaw Installation"
if command -v openclaw &> /dev/null; then
    VERSION=$(openclaw --version 2>&1)
    check_pass "OpenClaw installed: $VERSION"
else
    check_fail "OpenClaw not found in PATH"
fi
echo ""

# Check 2: Gateway status
echo "2️⃣  Gateway Service"
if systemctl --user is-active openclaw-gateway.service &> /dev/null; then
    UPTIME=$(systemctl --user show openclaw-gateway.service --property=ActiveEnterTimestamp | cut -d'=' -f2)
    check_pass "Gateway running since $UPTIME"
elif systemctl --user is-enabled openclaw-gateway.service &> /dev/null; then
    check_warn "Gateway installed but not running"
    echo "      Start with: systemctl --user start openclaw-gateway.service"
else
    check_warn "Gateway not installed as service"
    echo "      Install with: openclaw onboard --install-daemon"
fi
echo ""

# Check 3: Configuration
echo "3️⃣  Configuration"
if [ -f ~/.openclaw/openclaw.json ]; then
    check_pass "Config file exists"

    # Check model configuration
    if openclaw config get agents.defaults.model.primary &> /dev/null; then
        MODEL=$(openclaw config get agents.defaults.model.primary | tr -d '"')
        check_pass "Primary model: $MODEL"
    else
        check_warn "No primary model configured"
    fi
else
    check_fail "Config file not found"
    echo "      Run: openclaw onboard"
fi
echo ""

# Check 4: Channels
echo "4️⃣  Channels"
if command -v openclaw &> /dev/null; then
    # Telegram
    if openclaw config get channels.telegram.botToken &> /dev/null; then
        TOKEN=$(openclaw config get channels.telegram.botToken | tr -d '"')
        if [ -n "$TOKEN" ] && [ "$TOKEN" != "null" ]; then
            check_pass "Telegram configured"
        else
            check_warn "Telegram token not set"
        fi
    else
        check_warn "Telegram not configured"
    fi

    # Slack
    if openclaw config get channels.slack.botToken &> /dev/null; then
        TOKEN=$(openclaw config get channels.slack.botToken | tr -d '"')
        if [ -n "$TOKEN" ] && [ "$TOKEN" != "null" ]; then
            check_pass "Slack configured"
        else
            check_warn "Slack not configured"
        fi
    else
        check_warn "Slack not configured"
    fi
fi
echo ""

# Check 5: AWS Bedrock (if used)
echo "5️⃣  AWS Bedrock (if configured)"
if openclaw config get models.providers.amazon-bedrock &> /dev/null; then
    if command -v aws &> /dev/null; then
        check_pass "AWS CLI installed"

        if aws sts get-caller-identity &> /dev/null 2>&1; then
            ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
            check_pass "AWS credentials valid (Account: $ACCOUNT)"

            # Test Bedrock access
            if aws bedrock list-foundation-models --region us-east-1 &> /dev/null 2>&1; then
                check_pass "Bedrock access working"
            else
                check_warn "Bedrock ListFoundationModels failed"
                echo "      Check IAM permissions and model access"
            fi
        else
            check_fail "AWS credentials not configured or invalid"
            echo "      Run: aws configure"
        fi
    else
        check_fail "AWS CLI not installed"
        echo "      Bedrock provider configured but AWS CLI missing"
    fi
else
    check_warn "Bedrock not configured (OK if using other providers)"
fi
echo ""

# Check 6: System resources (if on Linux)
if [ -f /proc/meminfo ]; then
    echo "6️⃣  System Resources"

    TOTAL_MEM=$(free -m | awk '/^Mem:/{print $2}')
    AVAIL_MEM=$(free -m | awk '/^Mem:/{print $7}')
    MEM_PERCENT=$((100 * AVAIL_MEM / TOTAL_MEM))

    if [ $MEM_PERCENT -gt 30 ]; then
        check_pass "Memory: ${AVAIL_MEM}MB available (${MEM_PERCENT}%)"
    elif [ $MEM_PERCENT -gt 15 ]; then
        check_warn "Memory: ${AVAIL_MEM}MB available (${MEM_PERCENT}%)"
        echo "      Consider reducing concurrent agents"
    else
        check_fail "Memory critically low: ${AVAIL_MEM}MB (${MEM_PERCENT}%)"
        echo "      Add swap or reduce workload"
    fi

    # Check disk space
    DISK_AVAIL=$(df -h ~ | tail -1 | awk '{print $4}')
    DISK_PERCENT=$(df -h ~ | tail -1 | awk '{print $5}' | tr -d '%')

    if [ $DISK_PERCENT -lt 80 ]; then
        check_pass "Disk: $DISK_AVAIL available"
    elif [ $DISK_PERCENT -lt 90 ]; then
        check_warn "Disk: $DISK_AVAIL available (${DISK_PERCENT}% used)"
    else
        check_fail "Disk critically low: $DISK_AVAIL (${DISK_PERCENT}% used)"
    fi

    echo ""
fi

# Check 7: Network connectivity
echo "7️⃣  Network"
if ping -c 1 -W 2 8.8.8.8 &> /dev/null; then
    check_pass "Internet connectivity"
else
    check_fail "No internet connection"
fi
echo ""

# Summary
echo "📊 Summary"
echo "=========="
echo "   ✅ Passed: $CHECKS_PASSED"
echo "   ⚠️  Warnings: $WARNINGS"
echo "   ❌ Failed: $CHECKS_FAILED"
echo ""

if [ $CHECKS_FAILED -eq 0 ]; then
    if [ $WARNINGS -eq 0 ]; then
        echo "🎉 All checks passed! OpenClaw is healthy."
        exit 0
    else
        echo "⚠️  Some warnings detected. Review above."
        exit 0
    fi
else
    echo "❌ Some checks failed. Please fix the issues above."
    exit 1
fi
