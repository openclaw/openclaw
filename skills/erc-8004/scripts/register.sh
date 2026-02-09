#!/bin/bash
# ERC-8004 - Register agent on Ethereum Mainnet
# Usage: ./register.sh [--testnet]
# 
# Full registration flow:
# 1. Create registration JSON
# 2. Upload to IPFS via Pinata
# 3. Register on-chain via Bankr
#
# Environment variables:
#   PINATA_JWT - Required for IPFS upload
#   AGENT_NAME - Agent display name
#   AGENT_DESCRIPTION - Agent description  
#   AGENT_IMAGE - Avatar URL
#   AGENT_WEBSITE - Website URL
#   AGENT_A2A_ENDPOINT - A2A agent card URL
#   AGENT_MCP_ENDPOINT - MCP endpoint
#   AGENT_ENS - ENS name

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

# Check requirements
if [ -z "$PINATA_JWT" ]; then
  echo "Error: PINATA_JWT environment variable not set" >&2
  echo "Get your JWT from https://app.pinata.cloud/developers/api-keys" >&2
  exit 1
fi

echo "" >&2
echo "Chain: $CHAIN (ID: $CHAIN_ID)" >&2
echo "Registry: $IDENTITY_REGISTRY" >&2
echo "" >&2

# Step 1: Create registration file
echo "Step 1/3: Creating registration file..." >&2
REG_FILE=$("$SCRIPT_DIR/create-registration.sh" /tmp/agent-registration-$$.json)
echo "" >&2

# Step 2: Upload to IPFS
echo "Step 2/3: Uploading to IPFS..." >&2
IPFS_URI=$("$SCRIPT_DIR/upload-to-ipfs.sh" "$REG_FILE")
echo "" >&2

# Step 3: Register on-chain
echo "Step 3/3: Registering on-chain..." >&2

# Encode register(string) calldata
# Function selector for register(string): 0xf2c298be
# Note: register() returns uint256 agentId
CALLDATA=$(node -e "
const uri = '$IPFS_URI';
const selector = '0xf2c298be';

// String offset (0x20 for single string param)
const offset = '0000000000000000000000000000000000000000000000000000000000000020';

// String length
const len = uri.length.toString(16).padStart(64, '0');

// String data (UTF-8 bytes, padded to 32-byte boundary)
const data = Buffer.from(uri, 'utf8').toString('hex').padEnd(Math.ceil(uri.length / 32) * 64, '0');

console.log(selector + offset + len + data);
")

echo "Calldata: $CALLDATA" >&2

# Submit via Bankr
RESULT=$(~/clawd/skills/bankr/scripts/bankr.sh "Submit this transaction on $CHAIN: {\"to\": \"$IDENTITY_REGISTRY\", \"data\": \"$CALLDATA\", \"value\": \"0\", \"chainId\": $CHAIN_ID}" 2>/dev/null)

if echo "$RESULT" | grep -qE "$EXPLORER/tx/0x[a-fA-F0-9]{64}"; then
  TX_HASH=$(echo "$RESULT" | grep -oE "$EXPLORER/tx/0x[a-fA-F0-9]{64}" | grep -oE '0x[a-fA-F0-9]{64}' | head -1)
  
  echo "" >&2
  echo "======================================" >&2
  echo "=== REGISTRATION SUCCESSFUL! ===" >&2
  echo "======================================" >&2
  echo "" >&2
  echo "IPFS URI: $IPFS_URI" >&2
  echo "TX: https://$EXPLORER/tx/$TX_HASH" >&2
  echo "" >&2
  echo "Your agent ID will be visible in the transaction logs." >&2
  echo "View your agent at: https://www.8004.org" >&2
  echo "" >&2
  
  # Output JSON result
  echo "{\"success\":true,\"chain\":\"$CHAIN\",\"ipfsUri\":\"$IPFS_URI\",\"tx\":\"$TX_HASH\",\"registry\":\"$IDENTITY_REGISTRY\"}"
else
  echo "" >&2
  echo "Registration submitted. Check transaction status:" >&2
  echo "$RESULT" >&2
  
  # Try to extract any transaction info
  echo "{\"success\":\"pending\",\"chain\":\"$CHAIN\",\"ipfsUri\":\"$IPFS_URI\",\"result\":\"$RESULT\"}"
fi

# Cleanup
rm -f "$REG_FILE"
