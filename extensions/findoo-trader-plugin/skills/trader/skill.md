---
name: fin-trader
description: "Live and paper trading — place orders, check positions, view K-line charts, and manage order book. Use when: user wants to buy, sell, check positions, or view market depth."
metadata: { "openclaw": { "emoji": "📊", "requires": { "extensions": ["findoo-trader-plugin"] } } }
---

# Trader Skill

Place orders, manage positions, and view market data (K-line, order book) for live and paper trading.

## When to Use

**USE this skill when:**

- "买入BTC" / "buy BTC" / "市价买入"
- "卖出ETH" / "sell all my SOL"
- "查看持仓" / "show positions"
- "BTC K线" / "show me candles"
- "买卖盘" / "order book" / "盘口"
- "取消订单" / "cancel order"
- "设置止损" / "set stop loss"
- "查看订单" / "open orders"
- "place order" / "limit order BTC at 60k"
- "cancel all orders"

## When NOT to Use

**DON'T use this skill when:**

- User wants to create or manage strategies -- use fin-strategy
- User wants overall account overview -- use fin-overview
- User wants to configure exchanges -- use fin-setting

## CRITICAL: Confirmation Required

**NEVER execute a live trade without explicit user confirmation.** Always:

1. Show the order details (symbol, side, amount, price, estimated cost).
2. Show current market price for context.
3. Ask: "Confirm this order? (yes/no)"
4. Only call the execution tool after receiving "yes".

## Tools

### fin_place_order

Place a live order on a connected exchange.

```
fin_place_order({
  symbol: "BTC/USDT",
  side: "buy",
  type: "limit",
  amount: 0.01,
  price: 65000,
  exchange: "binance",
  stopLoss: 62000,
  takeProfit: 70000
})
```

### fin_cancel_order

Cancel an open order.

```
fin_cancel_order({
  orderId: "order-abc123",
  symbol: "BTC/USDT",
  exchange: "binance"
})
```

### fin_modify_order

Modify an existing order (price or amount).

```
fin_modify_order({
  orderId: "order-abc123",
  symbol: "BTC/USDT",
  price: 64500,
  amount: 0.02
})
```

### fin_set_stop_loss / fin_set_take_profit

Set protective orders.

```
fin_set_stop_loss({ symbol: "BTC/USDT", price: 62000, exchange: "binance" })
fin_set_take_profit({ symbol: "BTC/USDT", price: 70000, exchange: "binance" })
```

### fin_paper_order

Place an order on a paper (simulated) account.

```
fin_paper_order({
  accountId: "acct-1",
  symbol: "BTC/USDT",
  side: "buy",
  amount: 0.1,
  price: 65000
})
```

### fin_paper_positions

View paper account positions.

```
fin_paper_positions({ accountId: "acct-1" })
```

## Dashboard & API Endpoints

- Trader page: `/dashboard/trader`
- K-line (OHLCV): `/api/v1/finance/ohlcv?symbol=BTC/USDT&timeframe=1h`
- Order book: `/api/v1/finance/orderbook?symbol=BTC/USDT`
- Live orders: `/api/v1/finance/orders`
- Trading SSE: `/api/v1/finance/trading/stream`

## Response Guidelines

- Always fetch and show the current price before placing an order.
- Show estimated total cost/proceeds including fees.
- For limit orders, show distance from current market price.
- After order placement, show order ID and status.
- If rejected (insufficient balance, risk limits), explain why clearly.
- For "sell all" requests, first check positions, then confirm exact amount.
- Never assume the user wants a market order -- if unspecified, ask whether they prefer market or limit.
