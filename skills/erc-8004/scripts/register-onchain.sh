#!/bin/bash
# ERC-8004 - Register agent with on-chain data URI (no external hosting)
# Usage: ./register-onchain.sh [--testnet]
#
# Creates a base64-encoded data URI so the entire registration is on-chain.
# No IPFS or HTTP hosting required!
#
# Environment variables:
#   AGENT_NAME - Agent display name
#   AGENT_DESCRIPTION - Agent description  
#   AGENT_IMAGE - Avatar URL (optional)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check for testnet flag
if [ "$1" = "--testnet" ] || [ "$1" = "-t" ]; then
  CHAIN="sepolia"
  CHAIN_ID=11155111
  IDENTITY_REGISTRY="0x8004A818BFB912233c491871b3d84c89A494BD9e"
  EXPLORER="sepolia.etherscan.io"
  echo "=== TESTNET MODE (Sepolia) ===" >&2
else
  CHAIN="ethereum"
  CHAIN_ID=1
  IDENTITY_REGISTRY="0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"
  EXPLORER="etherscan.io"
  echo "=== MAINNET MODE ===" >&2
fi

# Create registration file
"$SCRIPT_DIR/create-registration.sh" /tmp/agent-reg-$$.json >/dev/null

# Read and base64 encode
JSON_CONTENT=$(cat /tmp/agent-reg-$$.json)
BASE64_CONTENT=$(echo -n "$JSON_CONTENT" | base64 -w 0)
DATA_URI="data:application/json;base64,$BASE64_CONTENT"

echo "" >&2
echo "Chain: $CHAIN (ID: $CHAIN_ID)" >&2
echo "Data URI length: ${#DATA_URI} bytes" >&2
echo "" >&2

# Encode register(string) calldata
CALLDATA=$(node -e "
const uri = '$DATA_URI';
const selector = '0xf2c298be';
const offset = '0000000000000000000000000000000000000000000000000000000000000020';
const len = uri.length.toString(16).padStart(64, '0');
const data = Buffer.from(uri, 'utf8').toString('hex').padEnd(Math.ceil(uri.length / 32) * 64, '0');
console.log(selector + offset + len + data);
")

echo "Registering on-chain (data URI)..." >&2
echo "Note: This will cost more gas than IPFS/HTTP due to larger calldata" >&2

# Submit via Bankr
RESULT=$(~/clawd/skills/bankr/scripts/bankr.sh "Submit this transaction on $CHAIN: {\"to\": \"$IDENTITY_REGISTRY\", \"data\": \"$CALLDATA\", \"value\": \"0\", \"chainId\": $CHAIN_ID}" 2>/dev/null)

if echo "$RESULT" | grep -qE "$EXPLORER/tx/0x[a-fA-F0-9]{64}"; then
  TX_HASH=$(echo "$RESULT" | grep -oE "$EXPLORER/tx/0x[a-fA-F0-9]{64}" | grep -oE '0x[a-fA-F0-9]{64}' | head -1)
  
  echo "" >&2
  echo "=== REGISTRATION SUCCESSFUL! ===" >&2
  echo "TX: https://$EXPLORER/tx/$TX_HASH" >&2
  echo "Data is fully on-chain!" >&2
  echo "" >&2
  
  echo "{\"success\":true,\"chain\":\"$CHAIN\",\"dataUri\":true,\"tx\":\"$TX_HASH\"}"
else
  echo "Registration submitted. Result:" >&2
  echo "$RESULT" >&2
fi

# Cleanup
rm -f /tmp/agent-reg-$$.json
