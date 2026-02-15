# NFT Price Tracking Example

This guide shows how to use Money Maker Bot for NFT market analysis.

## Supported Collections

- Bored Ape Yacht Club (BAYC)
- Mutant Ape Yacht Club (MAYC)
- CryptoPunks
- Azuki
- Pudgy Penguins
- Doodles
- Clone X
- Moonbirds

## Basic Commands

### Check Floor Price

```
What's the current floor price for BAYC?
```

### Compare Collections

```
Compare the floor prices and 24h volume for BAYC, MAYC, and Azuki.
```

### Track Whale Activity

```
Show me the largest NFT sales in the last 24 hours across blue chip collections.
```

## API Examples

### Get Collection Stats

```bash
# BAYC floor price and volume
curl -s "https://api.reservoir.tools/collections/v6?slug=boredapeyachtclub" | jq '.collections[0] | {
  name: .name,
  floor: .floorAsk.price.amount.native,
  volume24h: .volume["1day"],
  volumeChange: .volumeChange["1day"]
}'
```

### Get Recent Sales

```bash
# Recent MAYC sales
curl -s "https://api.reservoir.tools/sales/v6?collection=0x60E4d786628Fea6478F785A6d7e704777c86a7c6&limit=10" | jq '.sales[] | {
  tokenId: .token.tokenId,
  price: .price.amount.native,
  timestamp: .timestamp
}'
```

### Get Top Bids

```bash
# Top bids on CryptoPunks
curl -s "https://api.reservoir.tools/orders/bids/v6?collection=0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB&sortBy=price" | jq '.orders[:5] | .[] | {
  price: .price.amount.native,
  maker: .maker
}'
```

## Setting Up Floor Alerts

Configure alerts for price movements:

```yaml
# In your workspace config
nft_alerts:
  collections:
    - slug: "mutantapeyachtclub"
      floor_below: 5.0 # Alert if floor drops below 5 ETH
      floor_above: 8.0 # Alert if floor rises above 8 ETH
  telegram:
    enabled: true
    chat_id: "your-chat-id"
```

## Example Prompts

### Market Analysis

```
Analyze the NFT market sentiment based on the last 7 days of trading volume
across the top 10 collections. Are we in accumulation or distribution?
```

### Arbitrage Opportunities

```
Find any NFTs listed significantly below floor price in the MAYC collection.
```

### Portfolio Tracking

```
I own BAYC #1234, MAYC #5678, and Azuki #9012.
What's my total portfolio value and how has it changed this week?
```

## Whale Watching

Track large wallet movements:

```
Monitor wallet 0x... for any NFT purchases over 10 ETH and alert me via Telegram.
```

## Data Visualization

Generate charts in your terminal:

```
Create a bar chart showing the floor prices of the top 10 NFT collections.
```

## Disclaimer

NFT markets are highly volatile. This tool is for informational purposes only. Always do your own research before making investment decisions.
