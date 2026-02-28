---
name: ostium
description: "Use the Ostium tool for Arbitrum market reads and live trade writes (open/close/update)."
user-invocable: true
command-dispatch: tool
command-tool: ostium
command-arg-mode: raw
metadata: { "openclaw": { "requires": { "bins": ["python3"], "env": ["RPC_URL"] } } }
---

# Ostium Skill

Use the `ostium` tool for both read and write operations.

## Read actions

- `get_pairs`
- `get_open_trades`
- `get_open_trade_metrics`
- `get_target_funding_rate`
- `get_pair_max_leverage`
- `get_pair_overnight_max_leverage`
- `get_rollover_rate`
- `get_funding_rate`

## Write actions

- `open_trade`
- `close_trade`
- `cancel_limit_order`
- `update_tp`
- `update_sl`

## Slash command usage

Pass a JSON object after `/ostium`. The tool parses it directly.

Examples:

```text
/ostium {"action":"get_pairs","network":"mainnet"}
/ostium {"action":"get_open_trades","network":"mainnet","traderAddress":"0xabc..."}
/ostium {"action":"close_trade","network":"mainnet","pairId":0,"tradeIndex":1,"marketPrice":98000,"closePercentage":100}
```

`open_trade` example:

```text
/ostium {"action":"open_trade","network":"mainnet","atPrice":98000,"tradeParams":{"collateral":10,"leverage":5,"asset_type":0,"direction":true}}
```

## Notes

- `RPC_URL` is required for all actions.
- `PRIVATE_KEY` is required for write actions.
- `network` must be `mainnet` or `testnet`.
