#!/bin/bash
# IPv6 SSRF bypass detection tool
# Detects potentially dangerous IPv6 transition addresses in OpenClaw config

set -e

echo "🌐 IPv6 SSRF Bypass Detector"
echo "============================"
echo ""

CONFIG_FILE="${HOME}/.openclaw/openclaw.json"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ Config file not found: $CONFIG_FILE"
    exit 1
fi

echo "📄 Scanning: $CONFIG_FILE"
echo ""

ISSUES=0

# IPv6 transition address patterns that can bypass SSRF protection
DANGEROUS_PATTERNS=(
    "64:ff9b::"          # NAT64 - maps to IPv4
    "2002::"             # 6to4 tunnel - maps to IPv4
    "2001:0000::"        # Teredo - can map to internal addresses
    "2001:0::"           # Teredo (short form)
    "::ffff:"            # IPv4-mapped IPv6
)

echo "🔍 Checking for dangerous IPv6 addresses..."
echo ""

# Check cron webhooks
CRON_WEBHOOKS=$(jq -r '.cron.jobs // {} | .[] | select(.webhook.url) | .webhook.url' "$CONFIG_FILE" 2>/dev/null || echo "")

if [ -n "$CRON_WEBHOOKS" ]; then
    echo "Checking cron webhook URLs:"
    echo ""

    while IFS= read -r url; do
        for pattern in "${DANGEROUS_PATTERNS[@]}"; do
            if echo "$url" | grep -qi "\[$pattern"; then
                echo "⚠️  Suspicious IPv6 address in webhook:"
                echo "   URL: $url"
                echo "   Pattern: $pattern"
                echo "   Risk: Potential SSRF bypass"
                echo ""
                ((ISSUES++))
            fi
        done
    done <<< "$CRON_WEBHOOKS"
fi

# Check agent webhook configurations
AGENT_WEBHOOKS=$(jq -r '.agents.defaults.webhooks // {} | .[] | .url // empty' "$CONFIG_FILE" 2>/dev/null || echo "")

if [ -n "$AGENT_WEBHOOKS" ]; then
    echo "Checking agent webhook URLs:"
    echo ""

    while IFS= read -r url; do
        for pattern in "${DANGEROUS_PATTERNS[@]}"; do
            if echo "$url" | grep -qi "\[$pattern"; then
                echo "⚠️  Suspicious IPv6 address in agent webhook:"
                echo "   URL: $url"
                echo "   Pattern: $pattern"
                echo "   Risk: Potential SSRF bypass"
                echo ""
                ((ISSUES++))
            fi
        done
    done <<< "$AGENT_WEBHOOKS"
fi

# Check tool configurations (web_fetch, etc.)
TOOL_URLS=$(jq -r '.tools // {} | .. | .url? // empty' "$CONFIG_FILE" 2>/dev/null || echo "")

if [ -n "$TOOL_URLS" ]; then
    echo "Checking tool configurations:"
    echo ""

    while IFS= read -r url; do
        for pattern in "${DANGEROUS_PATTERNS[@]}"; do
            if echo "$url" | grep -qi "\[$pattern"; then
                echo "⚠️  Suspicious IPv6 address in tool config:"
                echo "   URL: $url"
                echo "   Pattern: $pattern"
                echo "   Risk: Potential SSRF bypass"
                echo ""
                ((ISSUES++))
            fi
        done
    done <<< "$TOOL_URLS"
fi

# Check external service configurations
EXTERNAL_SERVICES=$(jq -r '.services // {} | .. | .endpoint? // .url? // empty' "$CONFIG_FILE" 2>/dev/null || echo "")

if [ -n "$EXTERNAL_SERVICES" ]; then
    echo "Checking external service endpoints:"
    echo ""

    while IFS= read -r url; do
        for pattern in "${DANGEROUS_PATTERNS[@]}"; do
            if echo "$url" | grep -qi "\[$pattern"; then
                echo "⚠️  Suspicious IPv6 address in external service:"
                echo "   URL: $url"
                echo "   Pattern: $pattern"
                echo "   Risk: Potential SSRF bypass"
                echo ""
                ((ISSUES++))
            fi
        done
    done <<< "$EXTERNAL_SERVICES"
fi

echo "📊 Summary"
echo "=========="
echo ""

if [ "$ISSUES" -eq 0 ]; then
    echo "✅ No suspicious IPv6 addresses detected"
    echo ""
    echo "💡 Prevention tips:"
    echo "   - Always use DNS names instead of IPv6 addresses"
    echo "   - Validate URLs before adding to config"
    echo "   - Use firewall rules to block transition prefixes"
    echo ""
    exit 0
fi

echo "⚠️  Found $ISSUES potential SSRF bypass risk(s)"
echo ""
echo "⚠️  IPv6 SSRF Bypass Vulnerability"
echo ""
echo "IPv6 transition addresses can bypass SSRF protection by remapping"
echo "private IP addresses to IPv6 equivalents."
echo ""
echo "Dangerous IPv6 Prefixes"
echo "======================="
echo ""
echo "NAT64 (64:ff9b::/96):"
echo "  Example: http://[64:ff9b::c0a8:0101]/"
echo "  Maps to: 192.168.1.1 (private IP)"
echo "  Risk: Access to internal services"
echo ""
echo "6to4 (2002::/16):"
echo "  Example: http://[2002:c0a8:0101::]/"
echo "  Maps to: 192.168.1.1 (private IP)"
echo "  Risk: Tunnel to private networks"
echo ""
echo "Teredo (2001:0000::/32):"
echo "  Example: http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/"
echo "  Maps to: Internal addresses via tunneling"
echo "  Risk: Complex remapping attacks"
echo ""
echo "IPv4-mapped IPv6 (::ffff:0:0/96):"
echo "  Example: http://[::ffff:192.168.1.1]/"
echo "  Maps to: 192.168.1.1 (private IP)"
echo "  Risk: Direct private IP encoding"
echo ""
echo "🔧 Remediation"
echo "=============="
echo ""
echo "1. Remove suspicious IPv6 addresses from config:"
echo "   openclaw config unset <path-to-webhook>"
echo ""
echo "2. Use DNS names instead of IP addresses:"
echo "   ❌ http://[64:ff9b::c0a8:0101]/"
echo "   ✅ http://api.example.com/"
echo ""
echo "3. Add firewall rules to block transition prefixes:"
echo ""
cat <<'FIREWALL'
   # Block IPv6 transition prefixes
   sudo ip6tables -A OUTPUT -d 64:ff9b::/96 -j REJECT
   sudo ip6tables -A OUTPUT -d 2002::/16 -j REJECT
   sudo ip6tables -A OUTPUT -d 2001:0000::/32 -j REJECT
   sudo ip6tables -A OUTPUT -d ::ffff:0:0/96 -j REJECT
FIREWALL
echo ""
echo "4. Validate webhook URLs before deployment:"
echo ""
cat <<'VALIDATION'
   # Example validation
   if echo "$url" | grep -E '\[(64:ff9b::|2002::|2001:0::|::ffff:)'; then
     echo "Rejected: Suspicious IPv6 address"
     exit 1
   fi
VALIDATION
echo ""
echo "🛡️  Long-Term Protection"
echo "======================="
echo ""
echo "Required core changes (not yet implemented):"
echo ""
echo "1. Block IPv6 transition prefixes in SSRF protection"
echo "2. Fail closed on IPv6 parse errors"
echo "3. Validate all webhook/fetch URLs against comprehensive blocklist"
echo "4. Alert on suspicious URL patterns in config"
echo ""
echo "📚 Related Documentation"
echo "========================"
echo ""
echo "- Security Hardening: docs/troubleshooting/security-hardening.md"
echo "- Network Security: docs/gateway/network-security.md"
echo ""
echo "External Resources:"
echo "- IPv6 SSRF: https://blog.appsecco.com/exploiting-ssrf-in-ipv6-enabled-environments"
echo "- NAT64: https://tools.ietf.org/html/rfc6052"
echo ""

exit 1
