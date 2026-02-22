#!/bin/bash
# Reverse proxy configuration checker
# Validates OpenClaw is properly configured for reverse proxy use

set -e

echo "🔍 Reverse Proxy Configuration Checker"
echo "======================================"
echo ""

ISSUES=0

# Check OpenClaw is installed
if ! command -v openclaw &> /dev/null; then
    echo "❌ openclaw command not found"
    exit 1
fi

# Check gateway configuration
echo "1️⃣  Gateway Configuration"
echo "------------------------"
echo ""

# Check bind address
BIND=$(openclaw config get gateway.bind 2>/dev/null | tr -d '"' || echo "")

if [ -z "$BIND" ] || [ "$BIND" = "null" ]; then
    echo "⚠️  Bind address not set (defaults to loopback)"
    echo "   For reverse proxy access, set to 'lan' or '0.0.0.0'"
    echo ""
    echo "   Fix:"
    echo "     openclaw config set gateway.bind \"lan\""
    echo ""
    ((ISSUES++))
elif [ "$BIND" = "loopback" ] || [ "$BIND" = "127.0.0.1" ]; then
    echo "✅ Bind: $BIND (localhost only)"
    echo "   Good for reverse proxy on same machine"
elif [ "$BIND" = "lan" ] || [ "$BIND" = "0.0.0.0" ]; then
    echo "✅ Bind: $BIND (network accessible)"
    echo "   Make sure firewall blocks direct access!"
else
    echo "⚠️  Bind: $BIND (uncommon value)"
fi

echo ""

# Check allowInsecureAuth
ALLOW_INSECURE=$(openclaw config get gateway.controlUi.allowInsecureAuth 2>/dev/null || echo "false")

if [ "$ALLOW_INSECURE" = "true" ]; then
    echo "✅ allowInsecureAuth: true"
    echo "   Correctly configured for reverse proxy"
else
    echo "❌ allowInsecureAuth: $ALLOW_INSECURE"
    echo ""
    echo "   When using a reverse proxy that terminates TLS,"
    echo "   you MUST set allowInsecureAuth to true."
    echo ""
    echo "   Why: The reverse proxy terminates HTTPS, so OpenClaw"
    echo "   sees the connection as HTTP (insecure). This setting"
    echo "   tells OpenClaw to trust auth over HTTP from the proxy."
    echo ""
    echo "   Fix:"
    echo "     openclaw config set gateway.controlUi.allowInsecureAuth true"
    echo "     systemctl --user restart openclaw-gateway.service"
    echo ""
    ((ISSUES++))
fi

echo ""

# Check trustedProxies
TRUSTED_PROXIES=$(openclaw config get gateway.trustedProxies 2>/dev/null || echo "[]")

if [ "$TRUSTED_PROXIES" = "[]" ] || [ -z "$TRUSTED_PROXIES" ]; then
    echo "⚠️  trustedProxies: not set"
    echo ""
    echo "   This means OpenClaw won't see the real client IP,"
    echo "   only the proxy's IP address."
    echo ""
    echo "   Recommended:"
    echo "     openclaw config set gateway.trustedProxies '[\"127.0.0.1\",\"::1\"]'"
    echo ""
    ((ISSUES++))
else
    echo "✅ trustedProxies: $TRUSTED_PROXIES"
    echo "   OpenClaw will trust X-Forwarded-For from these IPs"
fi

echo ""
echo ""

# Check security
echo "2️⃣  Security Checks"
echo "------------------"
echo ""

# Check if gateway port is exposed
GATEWAY_PORT=$(openclaw config get gateway.port 2>/dev/null | tr -d '"' || echo "3030")

if command -v ss &> /dev/null; then
    if ss -tln | grep -q ":$GATEWAY_PORT "; then
        echo "✅ Gateway listening on port $GATEWAY_PORT"

        # Check if port is accessible externally
        LISTEN_ADDR=$(ss -tln | grep ":$GATEWAY_PORT " | awk '{print $4}' | head -1)
        if [[ "$LISTEN_ADDR" == "0.0.0.0:"* ]] || [[ "$LISTEN_ADDR" == "[::]:"* ]]; then
            echo "⚠️  Port $GATEWAY_PORT is accessible from network"
            echo ""
            echo "   IMPORTANT: Ensure your firewall blocks direct access!"
            echo ""
            echo "   Check firewall:"
            echo "     sudo ufw status | grep $GATEWAY_PORT"
            echo "     sudo iptables -L INPUT -n | grep $GATEWAY_PORT"
            echo ""
            echo "   Block direct access:"
            echo "     sudo ufw deny $GATEWAY_PORT"
            echo ""
            ((ISSUES++))
        else
            echo "✅ Port accessible only from: $LISTEN_ADDR"
        fi
    else
        echo "⚠️  Gateway not running or port different from config"
    fi
else
    echo "⚠️  'ss' command not available - skipping port check"
fi

echo ""

# Check authentication mode
AUTH_MODE=$(openclaw config get gateway.auth.mode 2>/dev/null | tr -d '"' || echo "")

if [ "$AUTH_MODE" = "token" ]; then
    echo "✅ Auth mode: token"

    AUTH_TOKEN=$(openclaw config get gateway.auth.token 2>/dev/null | tr -d '"' || echo "")
    TOKEN_LENGTH=${#AUTH_TOKEN}

    if [ $TOKEN_LENGTH -lt 16 ]; then
        echo "⚠️  Auth token is short ($TOKEN_LENGTH characters)"
        echo "   Recommended: Use at least 32 characters"
        echo ""
        echo "   Generate strong token:"
        echo "     TOKEN=\$(openssl rand -base64 32)"
        echo "     openclaw config set gateway.auth.token \"\$TOKEN\""
        echo ""
        ((ISSUES++))
    else
        echo "✅ Auth token length: $TOKEN_LENGTH characters"
    fi
elif [ "$AUTH_MODE" = "password" ]; then
    echo "✅ Auth mode: password"
elif [ "$AUTH_MODE" = "none" ]; then
    echo "❌ Auth mode: none (NO AUTHENTICATION!)"
    echo ""
    echo "   This is EXTREMELY DANGEROUS with a reverse proxy!"
    echo "   Anyone who can access your domain can control OpenClaw."
    echo ""
    echo "   Fix immediately:"
    echo "     TOKEN=\$(openssl rand -base64 32)"
    echo "     openclaw config set gateway.auth.mode \"token\""
    echo "     openclaw config set gateway.auth.token \"\$TOKEN\""
    echo "     systemctl --user restart openclaw-gateway.service"
    echo ""
    ((ISSUES++))
else
    echo "⚠️  Auth mode: $AUTH_MODE (unknown)"
fi

echo ""
echo ""

# Check reverse proxy detection
echo "3️⃣  Reverse Proxy Detection"
echo "-------------------------"
echo ""

# Try to detect common reverse proxies
DETECTED_PROXIES=""

if pgrep -x "nginx" > /dev/null; then
    DETECTED_PROXIES="${DETECTED_PROXIES}nginx "
    echo "✅ Detected: nginx"
fi

if pgrep -x "caddy" > /dev/null; then
    DETECTED_PROXIES="${DETECTED_PROXIES}caddy "
    echo "✅ Detected: Caddy"
fi

if pgrep -x "cloudflared" > /dev/null; then
    DETECTED_PROXIES="${DETECTED_PROXIES}cloudflared "
    echo "✅ Detected: Cloudflare Tunnel"
fi

if pgrep -x "traefik" > /dev/null; then
    DETECTED_PROXIES="${DETECTED_PROXIES}traefik "
    echo "✅ Detected: Traefik"
fi

if [ -z "$DETECTED_PROXIES" ]; then
    echo "⚠️  No reverse proxy detected"
    echo "   If you're using a reverse proxy, make sure it's running"
else
    echo ""
    echo "💡 Detected proxies: $DETECTED_PROXIES"
fi

echo ""
echo ""

# Summary
echo "📊 Summary"
echo "=========="
echo ""

if [ $ISSUES -eq 0 ]; then
    echo "✅ Configuration looks good!"
    echo ""
    echo "💡 Next steps:"
    echo "   1. Test dashboard access through reverse proxy"
    echo "   2. Verify WebSocket connections work"
    echo "   3. Check logs for any auth errors"
    echo ""
    echo "   Logs:"
    echo "     journalctl --user -u openclaw-gateway -f"
    echo ""
    exit 0
else
    echo "❌ Found $ISSUES issue(s) - please review and fix above"
    echo ""
    echo "📚 Documentation:"
    echo "   See: docs/gateway/reverse-proxy.md"
    echo ""
    echo "   GitHub issue: https://github.com/openclaw/openclaw/issues/20524"
    echo ""
    exit 1
fi
