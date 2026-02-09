#!/bin/bash
# ERC-8004 - Register agent with HTTP URL (no IPFS needed)
# Usage: REGISTRATION_URL="https://..." ./register-http.sh [--testnet]
# 
# The registration JSON must be hosted at the URL before calling this.

set -e

REGISTRATION_URL="${REGISTRATION_URL:?Error: REGISTRATION_URL environment variable required}"

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

echo "" >&2
echo "Registration URL: $REGISTRATION_URL" >&2
echo "Chain: $CHAIN (ID: $CHAIN_ID)" >&2
echo "Registry: $IDENTITY_REGISTRY" >&2
echo "" >&2

# Encode register(string) calldata
CALLDATA=$(node -e "
const uri = '$REGISTRATION_URL';
const selector = '0xf2c298be';
const offset = '0000000000000000000000000000000000000000000000000000000000000020';
const len = uri.length.toString(16).padStart(64, '0');
const data = Buffer.from(uri, 'utf8').toString('hex').padEnd(Math.ceil(uri.length / 32) * 64, '0');
console.log(selector + offset + len + data);
")

echo "Registering on-chain..." >&2

# Submit via Bankr
RESULT=$(~/clawd/skills/bankr/scripts/bankr.sh "Submit this transaction on $CHAIN: {\"to\": \"$IDENTITY_REGISTRY\", \"data\": \"$CALLDATA\", \"value\": \"0\", \"chainId\": $CHAIN_ID}" 2>/dev/null)

if echo "$RESULT" | grep -qE "$EXPLORER/tx/0x[a-fA-F0-9]{64}"; then
  TX_HASH=$(echo "$RESULT" | grep -oE "$EXPLORER/tx/0x[a-fA-F0-9]{64}" | grep -oE '0x[a-fA-F0-9]{64}' | head -1)
  
  echo "" >&2
  echo "=== REGISTRATION SUCCESSFUL! ===" >&2
  echo "URL: $REGISTRATION_URL" >&2
  echo "TX: https://$EXPLORER/tx/$TX_HASH" >&2
  echo "" >&2
  
  echo "{\"success\":true,\"chain\":\"$CHAIN\",\"url\":\"$REGISTRATION_URL\",\"tx\":\"$TX_HASH\"}"
else
  echo "Registration submitted. Result:" >&2
  echo "$RESULT" >&2
fi
