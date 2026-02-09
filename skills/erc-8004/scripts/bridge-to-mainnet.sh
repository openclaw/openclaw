#!/bin/bash
# ERC-8004 - Bridge ETH from Base to Ethereum Mainnet
# Usage: ./bridge-to-mainnet.sh <amount-in-eth>
# Example: ./bridge-to-mainnet.sh 0.01

set -e

AMOUNT="${1:?Usage: bridge-to-mainnet.sh <amount-in-eth>}"

echo "=== Bridging ETH to Mainnet ===" >&2
echo "Amount: $AMOUNT ETH" >&2
echo "From: Base" >&2
echo "To: Ethereum Mainnet" >&2

# Use Bankr to bridge
RESULT=$(~/clawd/skills/bankr/scripts/bankr.sh "Bridge $AMOUNT ETH from Base to Ethereum mainnet" 2>/dev/null)

if echo "$RESULT" | grep -qi "success\|bridge\|complete\|transaction"; then
  echo "=== SUCCESS ===" >&2
  echo "Bridged $AMOUNT ETH to Ethereum mainnet" >&2
  echo "Note: Bridge may take 10-30 minutes to complete" >&2
  echo "$RESULT"
else
  echo "Bridge request submitted. Check Bankr for status." >&2
  echo "$RESULT"
fi
