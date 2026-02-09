#!/bin/bash
# Verify ENS primary name is correctly set
# Usage: ./verify-primary.sh <address> [chain]
# Example: ./verify-primary.sh 0x1234... base

set -e

ADDRESS="${1:?Usage: verify-primary.sh <address> [chain]}"
CHAIN="${2:-base}"

# Normalize address to lowercase
ADDRESS=$(echo "$ADDRESS" | tr '[:upper:]' '[:lower:]')

# Chain configuration
case "$CHAIN" in
  base)
    RPC_URL="https://mainnet.base.org"
    CHAIN_ID=8453
    REVERSE_REGISTRAR="0x0000000000D8e504002cC26E3Ec46D81971C1664"
    IS_L2=true
    ;;
  arbitrum)
    RPC_URL="https://arb1.arbitrum.io/rpc"
    CHAIN_ID=42161
    REVERSE_REGISTRAR="0x0000000000D8e504002cC26E3Ec46D81971C1664"
    IS_L2=true
    ;;
  optimism)
    RPC_URL="https://mainnet.optimism.io"
    CHAIN_ID=10
    REVERSE_REGISTRAR="0x0000000000D8e504002cC26E3Ec46D81971C1664"
    IS_L2=true
    ;;
  ethereum|mainnet)
    RPC_URL="https://eth.publicnode.com"
    CHAIN_ID=1
    REVERSE_REGISTRAR="0x283F227c4Bd38ecE252C4Ae7ECE650B0e913f1f9"
    IS_L2=false
    ;;
  *)
    echo "Unsupported chain: $CHAIN" >&2
    exit 1
    ;;
esac

echo "=== ENS Primary Name Verification ===" >&2
echo "Address: $ADDRESS" >&2
echo "Chain: $CHAIN (ID: $CHAIN_ID)" >&2
echo "" >&2

# Step 1: Check reverse record (address → name)
echo "Checking reverse record..." >&2

if [ "$IS_L2" = "true" ]; then
  # L2: Use nameForAddr(address) on the Reverse Registrar
  # Selector: 0x4ec3bd23
  SELECTOR="0x4ec3bd23"
  ADDR_PADDED="000000000000000000000000${ADDRESS:2}"
  
  REVERSE_RESULT=$(curl -s --max-time 10 -X POST "$RPC_URL" \
    -H "Content-Type: application/json" \
    -d "{
      \"jsonrpc\": \"2.0\",
      \"id\": 1,
      \"method\": \"eth_call\",
      \"params\": [{
        \"to\": \"$REVERSE_REGISTRAR\",
        \"data\": \"${SELECTOR}${ADDR_PADDED}\"
      }, \"latest\"]
    }" | grep -oE '"result":"[^"]*"' | sed 's/"result":"//;s/"$//')
  
  # Decode the result (ABI-encoded string)
  if [ -z "$REVERSE_RESULT" ] || [ "$REVERSE_RESULT" = "0x" ]; then
    REVERSE_NAME=""
  else
    REVERSE_NAME=$(node -e "
      const hex = '$REVERSE_RESULT';
      if (hex === '0x' || hex.length < 130) {
        process.exit(0);
      }
      try {
        const length = parseInt(hex.slice(66, 130), 16);
        if (length === 0) process.exit(0);
        const data = hex.slice(130, 130 + length * 2);
        console.log(Buffer.from(data, 'hex').toString('utf8'));
      } catch (e) {}
    " 2>/dev/null)
  fi
else
  # L1 (Ethereum mainnet): Use viem's getEnsName
  REVERSE_NAME=$(timeout 15 node -e "
    const { createPublicClient, http } = require('viem');
    const { mainnet } = require('viem/chains');
    
    const client = createPublicClient({
      chain: mainnet,
      transport: http('$RPC_URL'),
    });
    
    (async () => {
      try {
        const name = await client.getEnsName({ address: '$ADDRESS' });
        if (name) console.log(name);
      } catch (e) {}
    })();
  " 2>/dev/null || echo "")
fi

if [ -n "$REVERSE_NAME" ]; then
  echo "✅ Reverse record: $ADDRESS → $REVERSE_NAME" >&2
else
  echo "❌ No reverse record found" >&2
fi

# Step 2: Check forward resolution (name → address)
if [ -n "$REVERSE_NAME" ]; then
  echo "" >&2
  echo "Checking forward resolution..." >&2
  
  # Query ENS subgraph for forward resolution
  ENS_DATA=$(curl -s --max-time 10 -X POST "https://api.thegraph.com/subgraphs/name/ensdomains/ens" \
    -H "Content-Type: application/json" \
    -d "{\"query\":\"{ domains(where:{name:\\\"$REVERSE_NAME\\\"}) { resolvedAddress { id } } }\"}")
  
  FORWARD_ADDR=$(echo "$ENS_DATA" | grep -oE '"id":"0x[a-fA-F0-9]{40}"' | head -1 | grep -oE '0x[a-fA-F0-9]{40}' | tr '[:upper:]' '[:lower:]')
  
  if [ "$FORWARD_ADDR" = "$ADDRESS" ]; then
    echo "✅ Forward resolution: $REVERSE_NAME → $FORWARD_ADDR" >&2
    echo "" >&2
    echo "🎉 PRIMARY NAME VERIFIED: $REVERSE_NAME" >&2
    echo "{\"verified\":true,\"name\":\"$REVERSE_NAME\",\"address\":\"$ADDRESS\",\"chain\":\"$CHAIN\"}"
  else
    echo "⚠️  Forward resolution: $REVERSE_NAME → ${FORWARD_ADDR:-(none)}" >&2
    echo "" >&2
    echo "⚠️  Primary name PARTIALLY set" >&2
    echo "{\"verified\":\"partial\",\"name\":\"$REVERSE_NAME\",\"address\":\"$ADDRESS\",\"chain\":\"$CHAIN\"}"
  fi
else
  echo "" >&2
  echo "❌ PRIMARY NAME NOT SET" >&2
  echo "   No reverse record found for $ADDRESS on $CHAIN" >&2
  echo "{\"verified\":false,\"address\":\"$ADDRESS\",\"chain\":\"$CHAIN\"}"
fi
