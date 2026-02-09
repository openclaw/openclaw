#!/bin/bash
# Search for Endaoment entities (charities) by name or EIN
# Usage: ./search.sh "charity name" or ./search.sh "12-3456789"

set -euo pipefail

QUERY="${1:-}"
CHAIN="${2:-base}"

if [[ -z "$QUERY" ]]; then
  echo "Usage: $0 <charity_name_or_ein> [chain]"
  echo ""
  echo "Examples:"
  echo "  $0 \"27-1661997\"          # EIN lookup (GiveDirectly)"
  echo "  $0 \"Red Cross\" base      # Name search"
  exit 1
fi

# Get chain index for deployments array
case "$CHAIN" in
  ethereum|mainnet) CHAIN_IDX=0 ;;
  optimism) CHAIN_IDX=1 ;;
  base) CHAIN_IDX=2 ;;
  *) CHAIN_IDX=2 ;;
esac

# Check if query looks like an EIN (XX-XXXXXXX or XXXXXXXXX)
CLEAN_EIN=$(echo "$QUERY" | tr -d '-')
if [[ "$CLEAN_EIN" =~ ^[0-9]{9}$ ]]; then
  echo "🔍 Looking up EIN: $QUERY"
  echo "---"
  
  RESPONSE=$(curl -s "https://api.endaoment.org/v1/orgs/ein/${CLEAN_EIN}" \
    -H "Accept: application/json")
  
  if [[ -z "$RESPONSE" ]] || [[ "$RESPONSE" == *"error"* ]] || [[ "$RESPONSE" == *"Not Found"* ]]; then
    echo "❌ No charity found with EIN: $QUERY"
    exit 1
  fi
  
  echo "$RESPONSE" | jq -r --argjson idx "$CHAIN_IDX" '
    "📛 Name: \(.name)
🆔 EIN: \(.ein)
📍 Contract: \(.deployments[$idx].contractAddress // "N/A")
✅ Deployed: \(.deployments[$idx].isDeployed // false)
💰 Lifetime Donations: $\(.lifetimeContributionsUsdc // "0")
🌐 Website: \(.website // "N/A")
📝 Description: \(.description // "N/A" | .[0:200])..."
  '
  exit 0
fi

# Name search
ENCODED=$(echo "$QUERY" | jq -sRr @uri)
echo "🔍 Searching for: $QUERY (on $CHAIN)"
echo "---"

RESPONSE=$(curl -s "https://api.endaoment.org/v1/orgs?search=${ENCODED}&limit=5" \
  -H "Accept: application/json")

if [[ -z "$RESPONSE" ]] || [[ "$RESPONSE" == "[]" ]]; then
  echo "No results found for: $QUERY"
  echo ""
  echo "💡 Tip: Try searching by EIN for exact match (e.g., 27-1661997)"
  exit 0
fi

echo "$RESPONSE" | jq -r --argjson idx "$CHAIN_IDX" '
  .[] | 
  "📛 Name: \(.name)
🆔 EIN: \(.ein)
📍 Contract: \(.deployments[$idx].contractAddress // "N/A")
✅ Deployed: \(.deployments[$idx].isDeployed // false)
---"
' 2>/dev/null || echo "Error parsing response"
