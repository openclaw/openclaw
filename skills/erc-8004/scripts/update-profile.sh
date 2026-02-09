#!/bin/bash
# ERC-8004 - Update agent profile URI
# Usage: ./update-profile.sh <agent-id> <new-ipfs-uri> [--testnet]
# Example: ./update-profile.sh 123 ipfs://QmXxx...

set -e

AGENT_ID="${1:?Usage: update-profile.sh <agent-id> <new-ipfs-uri> [--testnet]}"
NEW_URI="${2:?Usage: update-profile.sh <agent-id> <new-ipfs-uri> [--testnet]}"

# Check for testnet flag
if [ "$3" = "--testnet" ] || [ "$3" = "-t" ]; then
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
echo "Agent ID: $AGENT_ID" >&2
echo "New URI: $NEW_URI" >&2
echo "Chain: $CHAIN" >&2
echo "" >&2

# Encode setAgentURI(uint256,string) calldata
# Function selector: 0x862440e2 (setAgentURI(uint256,string))
CALLDATA=$(node -e "
const agentId = BigInt('$AGENT_ID');
const uri = '$NEW_URI';

const selector = '0x862440e2';

// uint256 agentId (32 bytes)
const id = agentId.toString(16).padStart(64, '0');

// String offset (0x40 = 64 bytes from start of params)
const offset = '0000000000000000000000000000000000000000000000000000000000000040';

// String length
const len = uri.length.toString(16).padStart(64, '0');

// String data (UTF-8 bytes, padded to 32-byte boundary)
const data = Buffer.from(uri, 'utf8').toString('hex').padEnd(Math.ceil(uri.length / 32) * 64, '0');

console.log(selector + id + offset + len + data);
")

echo "Calldata: $CALLDATA" >&2

# Submit via Bankr
RESULT=$(~/clawd/skills/bankr/scripts/bankr.sh "Submit this transaction on $CHAIN: {\"to\": \"$IDENTITY_REGISTRY\", \"data\": \"$CALLDATA\", \"value\": \"0\", \"chainId\": $CHAIN_ID}" 2>/dev/null)

if echo "$RESULT" | grep -qE "$EXPLORER/tx/0x[a-fA-F0-9]{64}"; then
  TX_HASH=$(echo "$RESULT" | grep -oE "$EXPLORER/tx/0x[a-fA-F0-9]{64}" | grep -oE '0x[a-fA-F0-9]{64}' | head -1)
  
  echo "=== SUCCESS ===" >&2
  echo "Agent $AGENT_ID profile updated!" >&2
  echo "New URI: $NEW_URI" >&2
  echo "TX: https://$EXPLORER/tx/$TX_HASH" >&2
  
  echo "{\"success\":true,\"agentId\":\"$AGENT_ID\",\"newUri\":\"$NEW_URI\",\"tx\":\"$TX_HASH\"}"
else
  echo "Update submitted. Check transaction status:" >&2
  echo "$RESULT" >&2
  exit 1
fi
