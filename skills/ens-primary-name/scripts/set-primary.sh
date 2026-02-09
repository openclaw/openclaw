#!/bin/bash
# ENS Primary Name - Set your primary ENS name on Base (or other L2s)
# Usage: ./set-primary.sh <ens-name> [chain]
# Example: ./set-primary.sh myname.eth base

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENS_NAME="${1:?Usage: set-primary.sh <ens-name> [chain]}"
CHAIN="${2:-base}"

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

# Reverse Registrar addresses by chain
case "$CHAIN" in
  base)
    REVERSE_REGISTRAR="0x0000000000D8e504002cC26E3Ec46D81971C1664"
    RPC_URL="https://mainnet.base.org"
    CHAIN_ID=8453
    EXPLORER="basescan.org"
    ;;
  arbitrum)
    REVERSE_REGISTRAR="0x0000000000D8e504002cC26E3Ec46D81971C1664"
    RPC_URL="https://arb1.arbitrum.io/rpc"
    CHAIN_ID=42161
    EXPLORER="arbiscan.io"
    ;;
  optimism)
    REVERSE_REGISTRAR="0x0000000000D8e504002cC26E3Ec46D81971C1664"
    RPC_URL="https://mainnet.optimism.io"
    CHAIN_ID=10
    EXPLORER="optimistic.etherscan.io"
    ;;
  ethereum|mainnet)
    REVERSE_REGISTRAR="0x283F227c4Bd38ecE252C4Ae7ECE650B0e913f1f9"
    RPC_URL="https://eth.llamarpc.com"
    CHAIN_ID=1
    EXPLORER="etherscan.io"
    ;;
  *)
    echo "Unsupported chain: $CHAIN" >&2
    echo "Supported: base, arbitrum, optimism, ethereum" >&2
    exit 1
    ;;
esac

echo "=== ENS Primary Name Setup ===" >&2
echo "Name: $ENS_NAME" >&2
echo "Chain: $CHAIN (ID: $CHAIN_ID)" >&2
echo "Reverse Registrar: $REVERSE_REGISTRAR" >&2
echo "" >&2

# Step 1: Check forward resolution
echo "Step 1: Checking forward resolution..." >&2

# Query ENS subgraph for resolver and resolved address
ENS_DATA=$(curl -s -X POST "https://api.thegraph.com/subgraphs/name/ensdomains/ens" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"{ domains(where:{name:\\\"$ENS_NAME\\\"}) { name resolvedAddress { id } resolver { address } } }\"}")

RESOLVED_ADDR=$(echo "$ENS_DATA" | grep -oE '"id":"0x[a-fA-F0-9]{40}"' | head -1 | grep -oE '0x[a-fA-F0-9]{40}')
RESOLVER_ADDR=$(echo "$ENS_DATA" | grep -oE '"address":"0x[a-fA-F0-9]{40}"' | head -1 | grep -oE '0x[a-fA-F0-9]{40}')

if [ -z "$RESOLVED_ADDR" ]; then
  echo "ERROR: $ENS_NAME does not resolve to any address!" >&2
  echo "Please set the address for this name first via app.ens.domains" >&2
  exit 1
fi

echo "Forward resolution (default): $ENS_NAME → $RESOLVED_ADDR" >&2
echo "Resolver: $RESOLVER_ADDR" >&2

# Check chain-specific address if not mainnet
if [ "$CHAIN_ID" != "1" ] && [ -n "$RESOLVER_ADDR" ]; then
  # Compute namehash for the name
  NAMEHASH=$(node -e "
    const { namehash } = require('viem/ens');
    console.log(namehash('$ENS_NAME'));
  " 2>/dev/null || echo "")
  
  if [ -n "$NAMEHASH" ] && [ -n "${THIRDWEB_SECRET_KEY:-}" ]; then
    CHAIN_ADDR=$(curl -s "https://api.thirdweb.com/v1/contracts/read" \
      -H "x-secret-key: ${THIRDWEB_SECRET_KEY}" \
      -H "Content-Type: application/json" \
      -d "{
        \"chainId\": 1,
        \"calls\": [{
          \"contractAddress\": \"$RESOLVER_ADDR\",
          \"method\": \"function addr(bytes32 node, uint256 coinType) view returns (bytes)\",
          \"params\": [\"$NAMEHASH\", $CHAIN_ID]
        }]
      }" 2>/dev/null | grep -oE '"data":"0x[a-fA-F0-9]+"' | grep -oE '0x[a-fA-F0-9]+' | tail -1)
    
    if [ -z "$CHAIN_ADDR" ] || [ "$CHAIN_ADDR" = "0x" ]; then
      echo "" >&2
      echo "⚠️  WARNING: Chain-specific address (cointype $CHAIN_ID) is NOT set!" >&2
      echo "   For full L2 primary name verification, you may need to set the $CHAIN address" >&2
      echo "   for $ENS_NAME on the L1 resolver via app.ens.domains" >&2
      echo "" >&2
    else
      echo "Forward resolution ($CHAIN cointype): $ENS_NAME → $CHAIN_ADDR" >&2
    fi
  fi
fi

# Step 2: Set reverse record
echo "" >&2
echo "Step 2: Setting reverse record..." >&2

# Encode setName(string) calldata
CALLDATA=$(node -e "
const name = '$ENS_NAME';
const selector = '0xc47f0027';
const offset = '0000000000000000000000000000000000000000000000000000000000000020';
const len = name.length.toString(16).padStart(64, '0');
const data = Buffer.from(name, 'utf8').toString('hex').padEnd(Math.ceil(name.length / 32) * 64, '0');
console.log(selector + offset + len + data);
")

echo "Calldata: $CALLDATA" >&2
echo "Submitting transaction..." >&2

RESULT=$("$BANKR_SH" "Submit this transaction: {\"to\": \"$REVERSE_REGISTRAR\", \"data\": \"$CALLDATA\", \"value\": \"0\", \"chainId\": $CHAIN_ID}" 2>/dev/null)

if echo "$RESULT" | grep -q "$EXPLORER"; then
  TX_HASH=$(echo "$RESULT" | grep -oE "$EXPLORER/tx/0x[a-fA-F0-9]{64}" | grep -oE '0x[a-fA-F0-9]{64}')
  echo "" >&2
  echo "=== REVERSE RECORD SET ===" >&2
  echo "TX: https://$EXPLORER/tx/$TX_HASH" >&2
  
  # Step 3: Verify
  echo "" >&2
  echo "Step 3: Verifying primary name..." >&2
  sleep 3  # Wait for indexing
  
  "$SCRIPT_DIR/verify-primary.sh" "$RESOLVED_ADDR" "$CHAIN" 2>&1
  
  echo "{\"success\":true,\"name\":\"$ENS_NAME\",\"chain\":\"$CHAIN\",\"tx\":\"$TX_HASH\",\"address\":\"$RESOLVED_ADDR\"}"
elif echo "$RESULT" | grep -q "reverted"; then
  echo "Transaction reverted. Make sure:" >&2
  echo "1. The ENS name resolves to your address on $CHAIN" >&2
  echo "2. You own or control the name" >&2
  echo "Error: $RESULT" >&2
  exit 1
else
  echo "Failed: $RESULT" >&2
  exit 1
fi
