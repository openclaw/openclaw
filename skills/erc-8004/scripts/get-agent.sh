#!/bin/bash
# ERC-8004 - Get agent info by ID
# Usage: ./get-agent.sh <agent-id> [--testnet]
# Example: ./get-agent.sh 123

set -e

AGENT_ID="${1:?Usage: get-agent.sh <agent-id> [--testnet]}"

# Check for testnet flag
if [ "$2" = "--testnet" ] || [ "$2" = "-t" ]; then
  CHAIN_ID=11155111
  IDENTITY_REGISTRY="0x8004A818BFB912233c491871b3d84c89A494BD9e"
  RPC_URL="https://eth-sepolia.g.alchemy.com/v2/demo"
  echo "=== TESTNET MODE (Sepolia) ===" >&2
else
  CHAIN_ID=1
  IDENTITY_REGISTRY="0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"
  RPC_URL="https://eth.llamarpc.com"
  echo "=== MAINNET MODE ===" >&2
fi

echo "" >&2
echo "Agent ID: $AGENT_ID" >&2
echo "Chain ID: $CHAIN_ID" >&2
echo "" >&2

# Get tokenURI (agentURI) - function selector: 0xc87b56dd
TOKEN_URI_DATA=$(printf '0xc87b56dd%064x' "$AGENT_ID")

RESPONSE=$(curl -s -X POST "$RPC_URL" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_call\",\"params\":[{\"to\":\"$IDENTITY_REGISTRY\",\"data\":\"$TOKEN_URI_DATA\"},\"latest\"],\"id\":1}")

RESULT=$(echo "$RESPONSE" | jq -r '.result // empty')

if [ -z "$RESULT" ] || [ "$RESULT" = "0x" ]; then
  echo "Error: Agent $AGENT_ID not found" >&2
  exit 1
fi

# Decode the string from the result
URI=$(node -e "
const hex = '$RESULT'.slice(2);
// Skip offset (32 bytes) and get length (32 bytes)
const lenHex = hex.slice(64, 128);
const len = parseInt(lenHex, 16);
// Get string data
const dataHex = hex.slice(128, 128 + len * 2);
const uri = Buffer.from(dataHex, 'hex').toString('utf8');
console.log(uri);
")

echo "Agent URI: $URI" >&2

# If it's an IPFS URI, try to fetch the content
if [[ "$URI" == ipfs://* ]]; then
  CID="${URI#ipfs://}"
  echo "Fetching from IPFS..." >&2
  CONTENT=$(curl -s "https://gateway.pinata.cloud/ipfs/$CID" 2>/dev/null || curl -s "https://ipfs.io/ipfs/$CID" 2>/dev/null || echo "")
  
  if [ -n "$CONTENT" ]; then
    echo "" >&2
    echo "=== Agent Profile ===" >&2
    echo "$CONTENT" | jq . 2>/dev/null || echo "$CONTENT" >&2
    echo ""
    echo "$CONTENT"
  else
    echo "{\"agentId\":\"$AGENT_ID\",\"uri\":\"$URI\"}"
  fi
elif [[ "$URI" == https://* ]]; then
  echo "Fetching from HTTP..." >&2
  CONTENT=$(curl -s "$URI" 2>/dev/null || echo "")
  
  if [ -n "$CONTENT" ]; then
    echo "" >&2
    echo "=== Agent Profile ===" >&2
    echo "$CONTENT" | jq . 2>/dev/null || echo "$CONTENT" >&2
    echo ""
    echo "$CONTENT"
  else
    echo "{\"agentId\":\"$AGENT_ID\",\"uri\":\"$URI\"}"
  fi
else
  echo "{\"agentId\":\"$AGENT_ID\",\"uri\":\"$URI\"}"
fi
