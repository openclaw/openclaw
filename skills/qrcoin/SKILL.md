---
name: qrcoin
description: Interact with QR Coin auctions on Base. Use when the user wants to participate in qrcoin.fun QR code auctions — check auction status, view current bids, create new bids, or contribute to existing bids. QR Coin lets you bid to display URLs on QR codes; the highest bidder's URL gets encoded.
metadata: {"openclaw":{"emoji":"📱","homepage":"https://qrcoin.fun","requires":{"bins":["curl","jq"]}}}
---

# QR Coin Auction

Participate in [QR Coin](https://qrcoin.fun) auctions on Base blockchain. QR Coin lets you bid to display URLs on QR codes — the highest bidder's URL gets encoded when the auction ends.

## Contracts (Base Mainnet)

| Contract | Address |
|----------|---------|
| QR Auction | `0x7309779122069EFa06ef71a45AE0DB55A259A176` |
| USDC | `0x833589fCD6eDb6E08f4c7c32D4f71b54bdA02913` |

## How It Works

1. Each auction runs for a fixed period (~24h)
2. Bidders submit URLs with USDC (6 decimals — 1 USDC = 1000000 units)
3. Creating a new bid costs ~11.11 USDC (createBidReserve)
4. Contributing to an existing bid costs ~1.00 USDC (contributeReserve)
5. Highest bid wins; winner's URL is encoded in the QR code
6. Losers get refunded; winners receive QR tokens

## Auction Status Queries

> **Note**: The examples below use `https://mainnet.base.org` (public RPC). You can substitute your own RPC endpoint if preferred.

### Get Current Token ID

Always query this first to get the active auction ID before bidding.

```bash
curl -s -X POST https://mainnet.base.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x7309779122069EFa06ef71a45AE0DB55A259A176","data":"0x7d9f6db5"},"latest"],"id":1}' \
  | jq -r '.result' | xargs printf "%d\n"
```

### Get Auction End Time

```bash
# First get the current token ID, then use it here
TOKEN_ID=329  # Replace with result from currentTokenId()
TOKEN_ID_HEX=$(printf '%064x' $TOKEN_ID)

curl -s -X POST https://mainnet.base.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x7309779122069EFa06ef71a45AE0DB55A259A176","data":"0xa4d0a17e'"$TOKEN_ID_HEX"'"},"latest"],"id":1}' \
  | jq -r '.result' | xargs printf "%d\n"
```

### Get Reserve Prices

```bash
# Create bid reserve (~11.11 USDC)
curl -s -X POST https://mainnet.base.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x7309779122069EFa06ef71a45AE0DB55A259A176","data":"0x5b3bec22"},"latest"],"id":1}' \
  | jq -r '.result' | xargs printf "%d\n" | awk '{print $1/1000000 " USDC"}'

# Contribute reserve (~1.00 USDC)
curl -s -X POST https://mainnet.base.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x7309779122069EFa06ef71a45AE0DB55A259A176","data":"0xda5a5cf3"},"latest"],"id":1}' \
  | jq -r '.result' | xargs printf "%d\n" | awk '{print $1/1000000 " USDC"}'
```

## Transactions via Bankr

QR Coin auctions require USDC transactions on Base. Use Bankr to execute these — Bankr handles:
- Function signature parsing and parameter encoding
- Gas estimation
- Transaction signing and submission
- Confirmation monitoring

### Step 1: Approve USDC (One-Time)

Before bidding, approve the auction contract to spend USDC:

```
Approve 50 USDC to 0x7309779122069EFa06ef71a45AE0DB55A259A176 on Base
```

### Step 2: Create a New Bid

To start a new bid for your URL:

**Function**: `createBid(uint256 tokenId, string url, string name)`
**Contract**: `0x7309779122069EFa06ef71a45AE0DB55A259A176`
**Cost**: ~11.11 USDC

> **Important**: Always query `currentTokenId()` first to get the active auction ID.

Example prompt for Bankr:
```
Send transaction to 0x7309779122069EFa06ef71a45AE0DB55A259A176 on Base
calling createBid(329, "https://example.com", "MyName")
```

### Step 3: Contribute to Existing Bid

To add funds to an existing URL's bid:

**Function**: `contributeToBid(uint256 tokenId, string url, string name)`
**Contract**: `0x7309779122069EFa06ef71a45AE0DB55A259A176`
**Cost**: ~1.00 USDC per contribution

Example prompt for Bankr:
```
Send transaction to 0x7309779122069EFa06ef71a45AE0DB55A259A176 on Base
calling contributeToBid(329, "https://grokipedia.com/page/debtreliefbot", "MerkleMoltBot")
```

## Function Selectors

| Function | Selector | Parameters |
|----------|----------|------------|
| `currentTokenId()` | `0x7d9f6db5` | — |
| `auctionEndTime(uint256)` | `0xa4d0a17e` | tokenId |
| `createBidReserve()` | `0x5b3bec22` | — |
| `contributeReserve()` | `0xda5a5cf3` | — |
| `createBid(uint256,string,string)` | `0xf7842286` | tokenId, url, name |
| `contributeToBid(uint256,string,string)` | `0x7ce28d02` | tokenId, url, name |
| `approve(address,uint256)` | `0x095ea7b3` | spender, amount |

## Error Codes

| Error | Meaning | Solution |
|-------|---------|----------|
| `RESERVE_PRICE_NOT_MET` | Bid amount below minimum | Check reserve prices |
| `URL_ALREADY_HAS_BID` | URL already has a bid | Use `contributeToBid` instead |
| `BID_NOT_FOUND` | URL doesn't have existing bid | Use `createBid` instead |
| `AUCTION_OVER` | Current auction has ended | Wait for next auction |
| `AUCTION_NOT_STARTED` | Auction hasn't begun | Wait for auction to start |
| `INSUFFICIENT_ALLOWANCE` | USDC not approved | Approve USDC first |

## Typical Workflow

1. **Query `currentTokenId()`** — Get the active auction ID
2. **Check auction status** — Verify time remaining
3. **Approve USDC** — One-time approval for the auction contract
4. **Decide action**:
   - **New URL**: Use `createBid` (~11.11 USDC)
   - **Support existing URL**: Use `contributeToBid` (~1.00 USDC)
5. **Monitor** — Watch for outbids and contribute more if needed
6. **Claim** — Winners receive QR tokens; losers get refunds

## Links

- **Platform**: https://qrcoin.fun
- **Auction Contract**: [BaseScan](https://basescan.org/address/0x7309779122069EFa06ef71a45AE0DB55A259A176)
- **USDC on Base**: [BaseScan](https://basescan.org/token/0x833589fCD6eDb6E08f4c7c32D4f71b54bdA02913)

## Tips

- **Start small**: Contribute to existing bids (~1 USDC) to learn the flow
- **Check timing**: Auctions have fixed end times; plan accordingly
- **Monitor bids**: Others can outbid you; watch the auction
- **Use Bankr**: Let Bankr handle transaction signing and execution
- **Specify Base**: Always include "on Base" when using Bankr

---

**💡 Pro Tip**: Contributing to an existing bid is cheaper than creating a new one. Check if someone already bid for your URL before creating a new bid.
