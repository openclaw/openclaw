# Dmarket API: Inventory & Balance Management

#v16_knowledge #dmarket #api #inventory #balance

## Table of Contents

- [Inventory Endpoints](#inventory-endpoints)
- [Inventory Response](#inventory-response)
- [Balance API](#balance-api)
- [Deposit & Withdrawal](#deposit--withdrawal)
- [Trade History](#trade-history)

## Inventory Endpoints

```
GET /marketplace-api/v1/user-inventory   → User's items (authenticated)
GET /marketplace-api/v1/user-balance     → Account balance
GET /marketplace-api/v1/user-offers      → Active sell orders
GET /marketplace-api/v1/user-targets     → Active buy orders
GET /marketplace-api/v1/user-history     → Trade history
```

## Inventory Response

```json
{
  "Items": [
    {
      "AssetID": "asset-uuid-12345",
      "VariantID": "variant-uuid-789",
      "Title": "AK-47 | Redline (Field-Tested)",
      "GameID": "a8db",
      "GameType": "csgo",
      "Image": "https://cdn.dmarket.com/...",
      "Status": "idle",
      "Tradable": true,
      "Deposited": true,
      "InMarket": false,
      "ExtraInfo": {
        "exterior": "field-tested",
        "floatValue": "0.2341",
        "paintSeed": 123,
        "stickers": [{ "name": "Natus Vincere | Paris 2023", "slot": 0 }]
      },
      "AcquiredDate": "2024-01-10T08:00:00Z",
      "SuggestedPrice": { "Amount": 1600, "Currency": "USD" }
    }
  ],
  "Total": 47,
  "Cursor": "abc123"
}
```

**Статусы Item:**

| Status          | Описание               | Можно продать?    |
| --------------- | ---------------------- | ----------------- |
| idle            | В инвентаре, свободен  | ✅                |
| in_offer        | Выставлен на продажу   | ❌ (cancel first) |
| in_trade        | В процессе обмена      | ❌                |
| trade_locked    | Steam trade lock       | ❌ (wait)         |
| pending_deposit | Ожидает деплоя Dmarket | ❌                |

## Balance API

```json
{
  "DMC": "15423",
  "USD": "15423",
  "Frozen": {
    "DMC": "2000",
    "USD": "2000"
  }
}
```

> «Balance.Frozen represents funds locked in active buy orders (targets). Available balance = DMC - Frozen.DMC.» — Dmarket API

**Расчёт доступного баланса:**

```python
def available_balance(balance: dict) -> int:
    """Returns available balance in cents."""
    total = int(balance.get("USD", "0"))
    frozen = int(balance.get("Frozen", {}).get("USD", "0"))
    return total - frozen
```

## Deposit & Withdrawal

### Deposit Items (Steam → Dmarket)

```json
POST /marketplace-api/v1/deposit-assets
{
  "GameID": "a8db",
  "AssetIDs": ["steam-asset-id-1", "steam-asset-id-2"]
}

Response:
{
  "TradeURL": "https://steamcommunity.com/tradeoffer/new/...",
  "DepositIDs": ["dep-uuid-1", "dep-uuid-2"],
  "ExpiresAt": "2024-01-15T11:00:00Z"
}
```

### Withdraw Items (Dmarket → Steam)

```json
POST /marketplace-api/v1/withdraw-assets
{
  "GameID": "a8db",
  "AssetIDs": ["dmarket-asset-uuid-1"]
}

Response:
{
  "WithdrawID": "wd-uuid-123",
  "Status": "pending",
  "EstimatedTime": "5-10 minutes"
}
```

## Trade History

```json
{
  "Trades": [
    {
      "TradeID": "trade-uuid-1",
      "Type": "sell",
      "Title": "AK-47 | Redline (Field-Tested)",
      "Price": { "Amount": 1542, "Currency": "USD" },
      "Fee": { "Amount": 77, "Currency": "USD" },
      "NetProceeds": { "Amount": 1465, "Currency": "USD" },
      "Date": "2024-01-15T10:30:00Z",
      "Status": "completed"
    }
  ],
  "Total": 156,
  "Period": "30d"
}
```

**Fee structure:** 5% на продажу (configurable по уровню продавца).

---

_Сгенерировано Knowledge Expansion v16.5_
