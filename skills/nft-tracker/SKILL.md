---
name: nft-tracker
description: "Track NFT collection prices, floor prices, and sales data. Supports Ethereum collections including BAYC, MAYC, CryptoPunks, and more."
homepage: https://docs.opensea.io/reference/api-overview
metadata:
  {
    "openclaw":
      {
        "emoji": "🖼️",
        "requires": { "bins": ["curl", "jq"] },
        "credentials":
          [
            {
              "id": "opensea-api-key",
              "name": "OpenSea API Key",
              "description": "API key from https://docs.opensea.io/reference/api-keys",
              "env": "OPENSEA_API_KEY",
            },
          ],
      },
  }
---

# NFT Price Tracker

Track NFT collection stats, floor prices, and recent sales using free APIs.

## Free APIs (No Key Required)

### Reservoir API (Recommended)

Get collection floor price:

```bash
curl -s "https://api.reservoir.tools/collections/v6?slug=boredapeyachtclub" | jq '.collections[0] | {name, floorAsk: .floorAsk.price.amount.native, volume24h: .volume["1day"], volumeChange: .volumeChange["1day"]}'
```

### Popular Collection Slugs

- `boredapeyachtclub` - Bored Ape Yacht Club (BAYC)
- `mutant-ape-yacht-club` - Mutant Ape Yacht Club (MAYC)
- `cryptopunks` - CryptoPunks
- `azuki` - Azuki
- `pudgypenguins` - Pudgy Penguins
- `doodles-official` - Doodles
- `clonex` - CloneX

## Collection Stats

Get detailed collection stats:

```bash
curl -s "https://api.reservoir.tools/collections/v6?slug=mutant-ape-yacht-club" | jq '.collections[0] | {
  name: .name,
  floor_eth: .floorAsk.price.amount.native,
  floor_usd: .floorAsk.price.amount.usd,
  volume_24h: .volume["1day"],
  volume_7d: .volume["7day"],
  volume_30d: .volume["30day"],
  owners: .ownerCount,
  supply: .tokenCount
}'
```

## Recent Sales

Get recent sales for a collection:

```bash
curl -s "https://api.reservoir.tools/sales/v6?collection=0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d&limit=10" | jq '.sales[] | {token_id: .token.tokenId, price_eth: .price.amount.native, timestamp: .timestamp, marketplace: .orderSource}'
```

Contract addresses:
- BAYC: `0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d`
- MAYC: `0x60e4d786628fea6478f785a6d7e704777c86a7c6`
- CryptoPunks: `0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb`

## Floor Price History

Get floor price over time:

```bash
curl -s "https://api.reservoir.tools/collections/daily-volumes/v1?collection=0x60e4d786628fea6478f785a6d7e704777c86a7c6&limit=30" | jq '.[] | {date: .timestamp, floor: .floorAskPrice, volume: .volume}'
```

## Top Collections

Get top collections by volume:

```bash
curl -s "https://api.reservoir.tools/collections/v6?sortBy=1DayVolume&limit=10" | jq '.collections[] | {name: .name, floor: .floorAsk.price.amount.native, volume_24h: .volume["1day"]}'
```

## Token Lookup

Get details for a specific NFT:

```bash
# MAYC #1234
curl -s "https://api.reservoir.tools/tokens/v7?tokens=0x60e4d786628fea6478f785a6d7e704777c86a7c6:1234" | jq '.tokens[0] | {name: .token.name, image: .token.image, lastSale: .token.lastSale.price.amount.native, owner: .token.owner}'
```

## Price Alerts (Script Example)

Monitor floor price and alert when below threshold:

```bash
#!/bin/bash
COLLECTION="mutant-ape-yacht-club"
THRESHOLD=5  # ETH

FLOOR=$(curl -s "https://api.reservoir.tools/collections/v6?slug=$COLLECTION" | jq -r '.collections[0].floorAsk.price.amount.native')

if (( $(echo "$FLOOR < $THRESHOLD" | bc -l) )); then
  echo "ALERT: $COLLECTION floor is $FLOOR ETH (below $THRESHOLD ETH)"
fi
```

## OpenSea API (With Key)

If you have an OpenSea API key:

```bash
curl -s "https://api.opensea.io/api/v2/collections/mutant-ape-yacht-club/stats" \
  -H "X-API-KEY: $OPENSEA_API_KEY" | jq '.'
```

## Tips

- Reservoir API is free and doesn't require authentication for basic queries
- Rate limits apply - cache responses when possible
- Prices are in ETH unless specified otherwise
- Use contract addresses for precise lookups, slugs for convenience
