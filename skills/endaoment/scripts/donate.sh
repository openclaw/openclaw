#!/bin/bash
# Donate USDC to an Endaoment charity on Base via Bankr arbitrary transactions
# Usage: ./donate.sh <ein> <amount_usdc>
#
# Example: ./donate.sh 11-1666852 1   (donates 1 USDC to North Shore Animal League)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BANKR_SCRIPT="${BANKR_SCRIPT:-$SCRIPT_DIR/../../bankr/scripts/bankr.sh}"

EIN="${1:-}"
AMOUNT="${2:-}"

if [[ -z "$EIN" ]] || [[ -z "$AMOUNT" ]]; then
  echo "Usage: $0 <ein> <amount_usdc>"
  echo ""
  echo "Examples:"
  echo "  $0 11-1666852 1      # North Shore Animal League America"
  echo "  $0 27-1661997 5      # GiveDirectly"
  echo "  $0 53-0196605 10     # American Red Cross"
  exit 1
fi

# Base chain addresses
FACTORY="0x10fd9348136dcea154f752fe0b6db45fc298a589"
USDC="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
CHAIN_ID=8453
RPC_URL="https://mainnet.base.org"

# Convert amount to USDC decimals (6)
AMOUNT_WEI=$(echo "$AMOUNT * 1000000" | bc | cut -d'.' -f1)
AMOUNT_HEX=$(printf '%064x' "$AMOUNT_WEI")

# Encode EIN as bytes32 (remove hyphens/spaces, digits only)
# IMPORTANT: Endaoment uses EIN WITHOUT hyphens (e.g., "111666852" not "11-1666852")
EIN_CLEAN=$(echo "$EIN" | tr -d ' -')
EIN_HEX=$(echo -n "$EIN_CLEAN" | xxd -p)
ORG_ID="${EIN_HEX}$(printf '%0*d' $((64 - ${#EIN_HEX})) 0)"

# Compute the deterministic contract address using computeOrgAddress(bytes32)
echo "🔍 Looking up charity contract address..."
COMPUTE_RESULT=$(curl -s -X POST "$RPC_URL" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_call\",\"params\":[{\"to\":\"$FACTORY\",\"data\":\"0x9fb8578d${ORG_ID}\"},\"latest\"],\"id\":1}" | jq -r '.result')

if [[ -z "$COMPUTE_RESULT" ]] || [[ "$COMPUTE_RESULT" == "null" ]]; then
  echo "❌ Failed to compute contract address for EIN: $EIN"
  exit 1
fi

# Extract address from padded result
ENTITY_ADDRESS="0x$(echo "$COMPUTE_RESULT" | tail -c 41 | head -c 40)"
echo "   Entity address: $ENTITY_ADDRESS"

# Check if contract is already deployed (eth_getCode)
CODE=$(curl -s -X POST "$RPC_URL" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getCode\",\"params\":[\"$ENTITY_ADDRESS\",\"latest\"],\"id\":1}" | jq -r '.result')

# Function selectors
APPROVE_SELECTOR="095ea7b3"  # approve(address,uint256)
DONATE_SELECTOR="f14faf6f"   # donate(uint256)
DEPLOY_SELECTOR="db9e30cc"   # deployOrgAndDonate(bytes32,uint256)

echo ""
echo "🎁 Endaoment Donation on Base"
echo "   EIN: $EIN"
echo "   Amount: $AMOUNT USDC"
echo ""

if [[ "$CODE" != "0x" ]] && [[ -n "$CODE" ]]; then
  # Contract already deployed - donate directly
  echo "✅ Contract already deployed, donating directly..."
  
  # Transaction 1: Approve USDC to entity
  APPROVE_DATA="0x${APPROVE_SELECTOR}000000000000000000000000${ENTITY_ADDRESS:2}${AMOUNT_HEX}"
  echo "📝 Step 1: Approving USDC..."
  APPROVE_TX="{\"to\": \"$USDC\", \"data\": \"$APPROVE_DATA\", \"value\": \"0\", \"chainId\": $CHAIN_ID}"
  
  APPROVE_RESULT=$("$BANKR_SCRIPT" "Submit this transaction: $APPROVE_TX" 2>&1)
  if echo "$APPROVE_RESULT" | grep -q "basescan.org/tx"; then
    APPROVE_HASH=$(echo "$APPROVE_RESULT" | grep -o 'https://basescan.org/tx/[^ "]*' | head -1)
    echo "   ✅ Approved: $APPROVE_HASH"
  else
    echo "   ❌ Approve failed: $APPROVE_RESULT"
    exit 1
  fi
  
  # Transaction 2: Donate directly to entity
  DONATE_DATA="0x${DONATE_SELECTOR}${AMOUNT_HEX}"
  echo "📝 Step 2: Donating..."
  DONATE_TX="{\"to\": \"$ENTITY_ADDRESS\", \"data\": \"$DONATE_DATA\", \"value\": \"0\", \"chainId\": $CHAIN_ID}"
  
  DONATE_RESULT=$("$BANKR_SCRIPT" "Submit this transaction: $DONATE_TX" 2>&1)
  if echo "$DONATE_RESULT" | grep -q "basescan.org/tx"; then
    DONATE_HASH=$(echo "$DONATE_RESULT" | grep -o 'https://basescan.org/tx/[^ "]*' | head -1)
    echo "   ✅ Donated: $DONATE_HASH"
  else
    echo "   ❌ Donation failed: $DONATE_RESULT"
    exit 1
  fi
else
  # Contract not deployed - use factory to deploy and donate
  echo "📦 Contract not deployed on Base, deploying via factory..."
  
  # Transaction 1: Approve USDC to factory
  APPROVE_DATA="0x${APPROVE_SELECTOR}000000000000000000000000${FACTORY:2}${AMOUNT_HEX}"
  echo "📝 Step 1: Approving USDC to factory..."
  APPROVE_TX="{\"to\": \"$USDC\", \"data\": \"$APPROVE_DATA\", \"value\": \"0\", \"chainId\": $CHAIN_ID}"
  
  APPROVE_RESULT=$("$BANKR_SCRIPT" "Submit this transaction: $APPROVE_TX" 2>&1)
  if echo "$APPROVE_RESULT" | grep -q "basescan.org/tx"; then
    APPROVE_HASH=$(echo "$APPROVE_RESULT" | grep -o 'https://basescan.org/tx/[^ "]*' | head -1)
    echo "   ✅ Approved: $APPROVE_HASH"
  else
    echo "   ❌ Approve failed: $APPROVE_RESULT"
    exit 1
  fi
  
  # Transaction 2: Deploy & Donate via factory
  DEPLOY_DATA="0x${DEPLOY_SELECTOR}${ORG_ID}${AMOUNT_HEX}"
  echo "📝 Step 2: Deploying & donating..."
  DEPLOY_TX="{\"to\": \"$FACTORY\", \"data\": \"$DEPLOY_DATA\", \"value\": \"0\", \"chainId\": $CHAIN_ID}"
  
  DEPLOY_RESULT=$("$BANKR_SCRIPT" "Submit this transaction: $DEPLOY_TX" 2>&1)
  if echo "$DEPLOY_RESULT" | grep -q "basescan.org/tx"; then
    DEPLOY_HASH=$(echo "$DEPLOY_RESULT" | grep -o 'https://basescan.org/tx/[^ "]*' | head -1)
    echo "   ✅ Deployed & Donated: $DEPLOY_HASH"
  else
    echo "   ❌ Deploy & Donate failed: $DEPLOY_RESULT"
    exit 1
  fi
fi

echo ""
echo "🎉 Success! Donated $AMOUNT USDC to charity (EIN: $EIN)"
echo "   Net to charity: ~\$$(echo "$AMOUNT * 0.985" | bc) (after 1.5% Endaoment fee)"
