#!/bin/bash
# Canva OAuth Authentication Helper
# Usage: ./canva-auth.sh

set -e

if [ -z "$CANVA_CLIENT_ID" ] || [ -z "$CANVA_CLIENT_SECRET" ]; then
    echo "❌ Error: Set CANVA_CLIENT_ID and CANVA_CLIENT_SECRET environment variables"
    exit 1
fi

TOKEN_FILE="$HOME/.canva/tokens.json"
mkdir -p "$HOME/.canva"

# Check if we have a refresh token
if [ -f "$TOKEN_FILE" ]; then
    REFRESH_TOKEN=$(jq -r '.refresh_token // empty' "$TOKEN_FILE" 2>/dev/null)
    
    if [ -n "$REFRESH_TOKEN" ]; then
        echo "🔄 Refreshing access token..."
        
        RESPONSE=$(curl -s -X POST "https://api.canva.com/rest/v1/oauth/token" \
            -H "Content-Type: application/x-www-form-urlencoded" \
            -d "grant_type=refresh_token" \
            -d "client_id=$CANVA_CLIENT_ID" \
            -d "client_secret=$CANVA_CLIENT_SECRET" \
            -d "refresh_token=$REFRESH_TOKEN")
        
        if echo "$RESPONSE" | jq -e '.access_token' > /dev/null 2>&1; then
            echo "$RESPONSE" > "$TOKEN_FILE"
            echo "✅ Token refreshed successfully!"
            echo "Access token saved to: $TOKEN_FILE"
            exit 0
        else
            echo "⚠️ Refresh failed, need to re-authenticate"
        fi
    fi
fi

# Generate authorization URL
REDIRECT_URI="http://localhost:8765/callback"
SCOPES="design:content:read design:content:write asset:read asset:write brandtemplate:content:read"
SCOPES_ENCODED=$(echo "$SCOPES" | sed 's/ /%20/g')
STATE=$(openssl rand -hex 16)

AUTH_URL="https://www.canva.com/api/oauth/authorize?client_id=$CANVA_CLIENT_ID&redirect_uri=$REDIRECT_URI&response_type=code&scope=$SCOPES_ENCODED&state=$STATE"

echo ""
echo "🎨 Canva Authentication"
echo "======================="
echo ""
echo "1. Open this URL in your browser:"
echo ""
echo "$AUTH_URL"
echo ""
echo "2. Authorize the app"
echo ""
echo "3. You'll be redirected to localhost:8765/callback?code=XXX"
echo "   Copy the 'code' parameter from the URL"
echo ""
read -p "4. Paste the code here: " AUTH_CODE

if [ -z "$AUTH_CODE" ]; then
    echo "❌ No code provided"
    exit 1
fi

echo ""
echo "🔄 Exchanging code for tokens..."

RESPONSE=$(curl -s -X POST "https://api.canva.com/rest/v1/oauth/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=authorization_code" \
    -d "client_id=$CANVA_CLIENT_ID" \
    -d "client_secret=$CANVA_CLIENT_SECRET" \
    -d "code=$AUTH_CODE" \
    -d "redirect_uri=$REDIRECT_URI")

if echo "$RESPONSE" | jq -e '.access_token' > /dev/null 2>&1; then
    echo "$RESPONSE" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    echo ""
    echo "✅ Authentication successful!"
    echo "Tokens saved to: $TOKEN_FILE"
    echo ""
    echo "You can now use the Canva API!"
else
    echo "❌ Authentication failed:"
    echo "$RESPONSE" | jq .
    exit 1
fi
