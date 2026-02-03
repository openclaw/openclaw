#!/bin/bash
# Proactive Agent Security Audit
# Run periodically to check for security issues

# Don't exit on error - we want to complete all checks
set +e

echo "🔒 Proactive Agent Security Audit"
echo "=================================="
echo ""

ISSUES=0
WARNINGS=0

# Colors
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

warn() {
    echo -e "${YELLOW}⚠️  WARNING: $1${NC}"
    ((WARNINGS++))
}

fail() {
    echo -e "${RED}❌ ISSUE: $1${NC}"
    ((ISSUES++))
}

pass() {
    echo -e "${GREEN}✅ $1${NC}"
}

# 1. Check credential file permissions
echo "📁 Checking credential files..."
if [ -d ".credentials" ]; then
    for f in .credentials/*; do
        if [ -f "$f" ]; then
            perms=$(stat -f "%Lp" "$f" 2>/dev/null || stat -c "%a" "$f" 2>/dev/null)
            if [ "$perms" != "600" ]; then
                fail "$f has permissions $perms (should be 600)"
            else
                pass "$f permissions OK (600)"
            fi
        fi
    done
else
    echo "   No .credentials directory found"
fi
echo ""

# 2. Check for exposed secrets in common files
echo "🔍 Scanning for exposed secrets..."
SECRET_PATTERNS="(api[_-]?key|apikey|secret|password|token|auth).*[=:].{10,}"
for f in $(ls *.md *.json *.yaml *.yml .env* 2>/dev/null || true); do
    if [ -f "$f" ]; then
        matches=$(grep -iE "$SECRET_PATTERNS" "$f" 2>/dev/null | grep -v "example\|template\|placeholder\|your-\|<\|TODO" || true)
        if [ -n "$matches" ]; then
            warn "Possible secret in $f - review manually"
        fi
    fi
done
pass "Secret scan complete"
echo ""

# 3. Check gateway security (if clawdbot config exists)
echo "🌐 Checking gateway configuration..."
CONFIG_FILE="$HOME/.clawdbot/clawdbot.json"
if [ -f "$CONFIG_FILE" ]; then
    # Check if gateway is bound to loopback
    if grep -q '"bind".*"loopback"' "$CONFIG_FILE"; then
        pass "Gateway bound to loopback (not exposed)"
    else
        warn "Gateway may not be bound to loopback - check config"
    fi
    
    # Check if Telegram uses pairing
    if grep -q '"dmPolicy".*"pairing"' "$CONFIG_FILE"; then
        pass "Telegram DM policy uses pairing"
    fi
else
    echo "   No clawdbot config found"
fi
echo ""

# 4. Check AGENTS.md for security rules
echo "📋 Checking AGENTS.md for security rules..."
if [ -f "AGENTS.md" ]; then
    if grep -qi "injection\|external content\|never execute" "AGENTS.md"; then
        pass "AGENTS.md contains injection defense rules"
    else
        warn "AGENTS.md may be missing prompt injection defense"
    fi
    
    if grep -qi "deletion\|confirm.*delet\|trash" "AGENTS.md"; then
        pass "AGENTS.md contains deletion confirmation rules"
    else
        warn "AGENTS.md may be missing deletion confirmation rules"
    fi
else
    warn "No AGENTS.md found"
fi
echo ""

# 5. Check for skills from untrusted sources
echo "📦 Checking installed skills..."
SKILL_DIR="skills"
if [ -d "$SKILL_DIR" ]; then
    skill_count=$(find "$SKILL_DIR" -maxdepth 1 -type d | wc -l)
    echo "   Found $((skill_count - 1)) installed skills"
    pass "Review skills manually for trustworthiness"
else
    echo "   No skills directory found"
fi
echo ""

# 6. Check .gitignore
echo "📄 Checking .gitignore..."
if [ -f ".gitignore" ]; then
    if grep -q "\.credentials" ".gitignore"; then
        pass ".credentials is gitignored"
    else
        fail ".credentials is NOT in .gitignore"
    fi
    
    if grep -q "\.env" ".gitignore"; then
        pass ".env files are gitignored"
    else
        warn ".env files may not be gitignored"
    fi
else
    warn "No .gitignore found"
fi
echo ""

# Summary
echo "=================================="
echo "📊 Summary"
echo "=================================="
if [ $ISSUES -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "${GREEN}All checks passed!${NC}"
elif [ $ISSUES -eq 0 ]; then
    echo -e "${YELLOW}$WARNINGS warning(s), 0 issues${NC}"
else
    echo -e "${RED}$ISSUES issue(s), $WARNINGS warning(s)${NC}"
fi
echo ""
echo "Run this audit periodically to maintain security."
