#!/bin/bash
# ENS Avatar - Set avatar for your ENS name
# Usage: ./set-avatar.sh <ens-name> <avatar-url>
# Example: ./set-avatar.sh myname.eth https://example.com/avatar.png
#
# Avatar URL formats:
# - HTTPS: https://example.com/image.png
# - IPFS: ipfs://QmHash
# - NFT: eip155:1/erc721:0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d/1234

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENS_NAME="${1:?Usage: set-avatar.sh <ens-name> <avatar-url>}"
AVATAR_URL="${2:?Usage: set-avatar.sh <ens-name> <avatar-url>}"

# Find bankr.sh in common locations
# Bankr provides wallet/signing via the Bankr API
# If you don't have bankr, modify this function to use your own signer
find_bankr() {
  local locations=(
    "$SCRIPT_DIR/../../bankr/scripts/bankr.sh"
    "$SCRIPT_DIR/../../moltbot-skills/bankr/scripts/bankr.sh"
    "$(command -v bankr.sh 2>/dev/null)"
  )
  for loc in "${locations[@]}"; do
    if [ -x "$loc" ]; then
      echo "$loc"
      return 0
    fi
  done
  echo "ERROR: bankr.sh not found." >&2
  echo "" >&2
  echo "This skill requires a transaction signer. Options:" >&2
  echo "1. Install the bankr skill from https://github.com/BankrBot/openclaw-skills" >&2
  echo "2. Modify find_bankr() in this script to use your own wallet/signer" >&2
  echo "" >&2
  echo "The script needs to submit: {to, data, value, chainId} transactions" >&2
  exit 1
}

BANKR_SH=$(find_bankr)

# Avatars are text records stored on L1
RPC_URL="https://eth.publicnode.com"
CHAIN_ID=1
EXPLORER="etherscan.io"

echo "=== ENS Avatar Setup ===" >&2
echo "Name: $ENS_NAME" >&2
echo "Avatar: $AVATAR_URL" >&2

# Step 1: Look up the resolver for this ENS name
echo "Looking up resolver..." >&2
RESOLVER=$(curl -s -X POST "https://api.thegraph.com/subgraphs/name/ensdomains/ens" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"{ domains(where:{name:\\\"$ENS_NAME\\\"}) { resolver { address } } }\"}" | \
  grep -oE '"address":"0x[a-fA-F0-9]{40}"' | grep -oE '0x[a-fA-F0-9]{40}')

if [ -z "$RESOLVER" ]; then
  echo "ERROR: Could not find resolver for $ENS_NAME" >&2
  echo "Make sure the name exists and has a resolver set." >&2
  exit 1
fi

echo "Resolver: $RESOLVER" >&2

# Step 2: Calculate namehash and encode calldata
CALLDATA=$(node -e "
const { keccak256, toBytes, concat } = require('viem');

// Namehash calculation
function namehash(name) {
  if (!name) return new Uint8Array(32);
  const labels = name.split('.');
  let node = new Uint8Array(32);
  for (let i = labels.length - 1; i >= 0; i--) {
    const labelHash = keccak256(toBytes(labels[i]));
    node = keccak256(concat([node, labelHash]));
  }
  return node;
}

const name = '$ENS_NAME';
const avatar = '$AVATAR_URL';
const node = namehash(name).slice(2); // remove 0x
const key = 'avatar';

// setText(bytes32 node, string key, string value)
// Selector: 0x10f13a8c
const selector = '10f13a8c';

// Encode ABI for setText(bytes32, string, string)
const keyOffset = '0000000000000000000000000000000000000000000000000000000000000060';
const keyLen = key.length.toString(16).padStart(64, '0');
const keyData = Buffer.from(key, 'utf8').toString('hex').padEnd(64, '0');
const valueLen = avatar.length.toString(16).padStart(64, '0');
const valueData = Buffer.from(avatar, 'utf8').toString('hex').padEnd(Math.ceil(avatar.length / 32) * 64, '0');

// Value offset = 0x60 + 0x20 + 0x20 = 0xa0
const valueOffset = '00000000000000000000000000000000000000000000000000000000000000a0';

console.log('0x' + selector + node + keyOffset + valueOffset + keyLen + keyData + valueLen + valueData);
")

echo "Submitting to resolver on Ethereum mainnet..." >&2
echo "⚠️  Note: This requires ETH on mainnet for gas" >&2

# Submit transaction via Bankr
RESULT=$("$BANKR_SH" "Submit this transaction: {\"to\": \"$RESOLVER\", \"data\": \"$CALLDATA\", \"value\": \"0\", \"chainId\": $CHAIN_ID}" 2>/dev/null)

if echo "$RESULT" | grep -q "$EXPLORER"; then
  TX_HASH=$(echo "$RESULT" | grep -oE "$EXPLORER/tx/0x[a-fA-F0-9]{64}" | grep -oE '0x[a-fA-F0-9]{64}')
  echo "=== SUCCESS ===" >&2
  echo "Avatar set for: $ENS_NAME" >&2
  echo "TX: https://$EXPLORER/tx/$TX_HASH" >&2
  echo "{\"success\":true,\"name\":\"$ENS_NAME\",\"avatar\":\"$AVATAR_URL\",\"resolver\":\"$RESOLVER\",\"tx\":\"$TX_HASH\"}"
elif echo "$RESULT" | grep -q "reverted"; then
  echo "Transaction reverted. Make sure:" >&2
  echo "1. You own or control the ENS name" >&2
  echo "2. The resolver supports setText" >&2
  echo "3. You have permission to set records" >&2
  echo "Error: $RESULT" >&2
  exit 1
else
  echo "Failed: $RESULT" >&2
  exit 1
fi
