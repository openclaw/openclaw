#!/bin/bash
# Canva CLI Helper
# Usage: canva.sh <command> [args]

set -e

TOKEN_FILE="$HOME/.canva/tokens.json"

get_token() {
    if [ ! -f "$TOKEN_FILE" ]; then
        echo "❌ Not authenticated. Run: canva-auth.sh" >&2
        exit 1
    fi
    jq -r '.access_token' "$TOKEN_FILE"
}

api() {
    local method="$1"
    local endpoint="$2"
    local data="$3"
    local token=$(get_token)
    
    if [ -n "$data" ]; then
        curl -s -X "$method" "https://api.canva.com/rest/v1$endpoint" \
            -H "Authorization: Bearer $token" \
            -H "Content-Type: application/json" \
            -d "$data"
    else
        curl -s -X "$method" "https://api.canva.com/rest/v1$endpoint" \
            -H "Authorization: Bearer $token"
    fi
}

case "$1" in
    designs|list)
        echo "📋 Listing designs..."
        api GET "/designs" | jq '.items[] | {id, name: .title, created: .created_at}'
        ;;
    
    get)
        if [ -z "$2" ]; then
            echo "Usage: canva.sh get <design_id>"
            exit 1
        fi
        api GET "/designs/$2" | jq .
        ;;
    
    templates)
        echo "📋 Listing brand templates..."
        api GET "/brand-templates" | jq '.items[] | {id, name: .title}'
        ;;
    
    export)
        if [ -z "$2" ]; then
            echo "Usage: canva.sh export <design_id> [format: png|jpg|pdf]"
            exit 1
        fi
        FORMAT="${3:-png}"
        echo "📤 Starting export job..."
        RESULT=$(api POST "/exports" "{\"design_id\": \"$2\", \"format\": {\"type\": \"$FORMAT\"}}")
        JOB_ID=$(echo "$RESULT" | jq -r '.job.id')
        echo "Job ID: $JOB_ID"
        echo "Polling for completion..."
        
        for i in {1..30}; do
            sleep 2
            STATUS=$(api GET "/exports/$JOB_ID")
            STATE=$(echo "$STATUS" | jq -r '.job.status')
            
            if [ "$STATE" = "completed" ]; then
                URL=$(echo "$STATUS" | jq -r '.job.result.url')
                echo "✅ Export complete!"
                echo "Download URL: $URL"
                exit 0
            elif [ "$STATE" = "failed" ]; then
                echo "❌ Export failed"
                echo "$STATUS" | jq .
                exit 1
            fi
            echo "  Status: $STATE..."
        done
        echo "⏰ Timeout waiting for export"
        ;;
    
    autofill)
        if [ -z "$2" ] || [ -z "$3" ]; then
            echo "Usage: canva.sh autofill <template_id> '<json_data>'"
            echo "Example: canva.sh autofill TMPL_123 '{\"title\":{\"type\":\"text\",\"text\":\"Hello\"}}'"
            exit 1
        fi
        echo "🎨 Creating design from template..."
        api POST "/autofills" "{\"brand_template_id\": \"$2\", \"data\": $3}" | jq .
        ;;
    
    upload)
        if [ -z "$2" ]; then
            echo "Usage: canva.sh upload <file_path>"
            exit 1
        fi
        FILENAME=$(basename "$2")
        echo "📤 Uploading $FILENAME..."
        TOKEN=$(get_token)
        curl -s -X POST "https://api.canva.com/rest/v1/asset-uploads" \
            -H "Authorization: Bearer $TOKEN" \
            -H "Content-Type: application/octet-stream" \
            -H "Asset-Upload-Metadata: {\"name\": \"$FILENAME\"}" \
            --data-binary "@$2" | jq .
        ;;
    
    user)
        echo "👤 Getting user info..."
        api GET "/users/me" | jq .
        ;;
    
    *)
        echo "🎨 Canva CLI Helper"
        echo ""
        echo "Commands:"
        echo "  designs         List all designs"
        echo "  get <id>        Get design details"
        echo "  templates       List brand templates"
        echo "  export <id>     Export design (png/jpg/pdf)"
        echo "  autofill <template> <data>  Create from template"
        echo "  upload <file>   Upload asset"
        echo "  user            Get current user info"
        echo ""
        echo "First run: canva-auth.sh to authenticate"
        ;;
esac
