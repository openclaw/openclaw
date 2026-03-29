# Dmarket API: Order Types & JSON Structures

#v16_knowledge #dmarket #api #orders #json

## Table of Contents

- [API Base Endpoints](#api-base-endpoints)
- [Buy Order (CreateOffer)](#buy-order)
- [Sell Order (CreateTarget)](#sell-order)
- [Batch Orders](#batch-orders)
- [Order Status Response](#order-status-response)
- [Error Response Structure](#error-response-structure)

## API Base Endpoints

```
Base URL: https://api.dmarket.com
Rate Limit: 10 requests/second (per API key)
Auth: X-Api-Key + X-Request-Sign (HMAC-SHA256) + X-Sign-Date

Endpoints:
  POST /marketplace-api/v1/user-offers/create     → Sell (list item)
  POST /marketplace-api/v1/user-targets/create     → Buy (place buy order)
  GET  /marketplace-api/v1/user-offers              → My listings
  GET  /marketplace-api/v1/user-targets              → My buy orders
  DELETE /marketplace-api/v1/user-offers/{offerId}  → Cancel listing
  DELETE /marketplace-api/v1/user-targets/{targetId} → Cancel buy order
```

## Buy Order

```json
{
  "GameID": "a8db",
  "Targets": [
    {
      "Amount": 1,
      "Price": {
        "Currency": "USD",
        "Amount": 1542
      },
      "Title": "AK-47 | Redline (Field-Tested)",
      "Attrs": {
        "gameId": "a8db",
        "categoryPath": "rifle",
        "exterior": "field-tested",
        "quality": "normal"
      }
    }
  ]
}
```

> «Price.Amount is in cents (integer). $15.42 = 1542. Never use floating point for prices.» — Dmarket API Documentation

## Sell Order

```json
{
  "GameID": "a8db",
  "Offers": [
    {
      "AssetID": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "Price": {
        "Currency": "USD",
        "Amount": 2099
      }
    }
  ]
}
```

**Важно:**

- `AssetID` — уникальный ID предмета в инвентаре пользователя
- Нельзя выставить предмет, который уже в активном оффере
- Минимальная цена: 1 цент ($0.01 = Amount: 1)

## Batch Orders

До 100 ордеров в одном запросе:

```json
{
  "GameID": "a8db",
  "Offers": [
    { "AssetID": "uuid-1", "Price": { "Currency": "USD", "Amount": 1500 } },
    { "AssetID": "uuid-2", "Price": { "Currency": "USD", "Amount": 2000 } },
    { "AssetID": "uuid-3", "Price": { "Currency": "USD", "Amount": 2500 } }
  ]
}
```

**Response (partial success possible):**

```json
{
  "Result": [
    { "OfferID": "offer-uuid-1", "AssetID": "uuid-1", "Status": "active" },
    { "OfferID": "offer-uuid-2", "AssetID": "uuid-2", "Status": "active" },
    { "Error": { "Code": "AssetLocked", "Message": "Asset is in trade" }, "AssetID": "uuid-3" }
  ],
  "TotalCount": 3,
  "SuccessCount": 2,
  "ErrorCount": 1
}
```

## Order Status Response

```json
{
  "OfferID": "offer-uuid-123",
  "AssetID": "asset-uuid-456",
  "Price": { "Currency": "USD", "Amount": 2099 },
  "Status": "active",
  "CreatedDate": "2024-01-15T10:30:00Z",
  "GameID": "a8db",
  "Title": "AK-47 | Redline (Field-Tested)",
  "Image": "https://cdn.dmarket.com/..."
}
```

**Возможные статусы:** `active`, `sold`, `cancelled`, `expired`, `processing`

## Error Response Structure

```json
{
  "error": {
    "code": "InvalidSignature",
    "message": "Request signature is invalid",
    "details": "Expected signature for path /marketplace-api/v1/user-offers/create"
  }
}
```

**Типичные коды ошибок:**

| Code                | HTTP | Причина                        |
| ------------------- | ---- | ------------------------------ |
| InvalidSignature    | 401  | Неверная HMAC подпись          |
| RateLimitExceeded   | 429  | >10 req/sec                    |
| InsufficientBalance | 400  | Нет средств для покупки        |
| AssetLocked         | 400  | Предмет в трейде               |
| AssetNotFound       | 404  | AssetID не существует          |
| InvalidPrice        | 400  | Цена вне допустимого диапазона |

---

_Сгенерировано Knowledge Expansion v16.5_
