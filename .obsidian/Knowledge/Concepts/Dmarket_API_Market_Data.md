# Dmarket API: Market Data & Price Feeds

#v16_knowledge #dmarket #api #market_data #prices

## Table of Contents

- [Price Endpoints](#price-endpoints)
- [Market Items Response](#market-items-response)
- [Price History](#price-history)
- [Aggregated Sales Data](#aggregated-sales-data)
- [WebSocket Real-Time Feed](#websocket-real-time-feed)
- [Pagination & Filtering](#pagination--filtering)

## Price Endpoints

```
GET /exchange/v1/market/items     → Browse market listings (public)
GET /exchange/v1/market/items/{itemId}/sales-history → Recent sales
GET /marketplace-api/v1/items     → Detailed item search
GET /price-aggregator/v1/avg-sales-price → Avg price by title
```

## Market Items Response

```json
{
  "objects": [
    {
      "itemId": "abc-def-123",
      "title": "AK-47 | Redline (Field-Tested)",
      "gameId": "a8db",
      "gameType": "csgo",
      "price": {
        "DMC": "1542",
        "USD": "1542"
      },
      "suggestedPrice": {
        "DMC": "1600",
        "USD": "1600"
      },
      "instantPrice": {
        "DMC": "1480",
        "USD": "1480"
      },
      "image": "https://cdn.dmarket.com/images/item/abc-def-123.png",
      "extra": {
        "exterior": "field-tested",
        "quality": "normal",
        "category": "Rifle",
        "floatValue": 0.2341,
        "inspectInGame": "steam://rungame/..."
      },
      "inMarket": true,
      "lockStatus": false,
      "owner": "user-uuid-owner"
    }
  ],
  "total": { "items": 15432, "offers": 892, "targets": 234 },
  "cursor": "eyJza2lwIjoxMDB9"
}
```

> «Price values are always in cents (integer). Float values for item wear are separate from price — never confuse `floatValue` (wear 0.0-1.0) with `price` (cents integer).» — Dmarket Dev Docs

## Price History

```json
{
  "sales": [
    {
      "date": "2024-01-15T10:00:00Z",
      "price": { "Amount": 1520, "Currency": "USD" },
      "quantity": 3
    },
    {
      "date": "2024-01-14T10:00:00Z",
      "price": { "Amount": 1580, "Currency": "USD" },
      "quantity": 7
    }
  ],
  "period": "7d",
  "avgPrice": { "Amount": 1545, "Currency": "USD" },
  "minPrice": { "Amount": 1400, "Currency": "USD" },
  "maxPrice": { "Amount": 1700, "Currency": "USD" },
  "totalSales": 42
}
```

## Aggregated Sales Data

```json
{
  "AggregatedTitles": [
    {
      "Title": "AK-47 | Redline (Field-Tested)",
      "AvgSalesPrice": { "Amount": 1545, "Currency": "USD" },
      "SalesCount": 42,
      "AvgSalesPriceLast7d": { "Amount": 1560, "Currency": "USD" },
      "AvgSalesPriceLast30d": { "Amount": 1500, "Currency": "USD" }
    }
  ]
}
```

## WebSocket Real-Time Feed

```
Endpoint: wss://ws.dmarket.com/ws
Subscribe: {"type": "subscribe", "channel": "market_csgo_items", "filters": {"title": "AK-47*"}}
```

**Event format:**

```json
{
  "type": "item_listed",
  "data": {
    "itemId": "new-item-uuid",
    "title": "AK-47 | Redline (Field-Tested)",
    "price": { "Amount": 1450, "Currency": "USD" },
    "timestamp": "2024-01-15T10:30:15.123Z"
  }
}
```

**Event types:** `item_listed`, `item_sold`, `item_delisted`, `price_changed`

## Pagination & Filtering

```
GET /exchange/v1/market/items?
    gameId=a8db&
    title=AK-47&
    priceFrom=1000&        # $10.00 minimum
    priceTo=5000&          # $50.00 maximum
    orderBy=price&
    orderDir=asc&
    limit=100&
    cursor=eyJza2lwIjoxMDB9
```

**Лимиты:**

- `limit`: 1-100 (default 20)
- Cursor-based pagination (не offset)
- Rate limit: 10 req/sec

---

_Сгенерировано Knowledge Expansion v16.5_
