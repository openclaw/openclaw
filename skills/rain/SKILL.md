---
name: rain
description: Prompt-level guidance for the Rain prediction-market integration. The actual capability surface is the `rain` MCP server (typed tools); this skill adds safety rules, preview discipline, and market-state awareness.
metadata:
  openclaw:
    emoji: 🌧️
    requires:
      env: [AGENTGLOB_RUNTIME_URL, AGENTGLOB_RUNTIME_TOKEN]
---

# Rain skill (V2 Phase A)

This skill is **optional prompt-level guidance** for agents that have the
`rain` MCP server added (from the dashboard's Tools tab quick-setup). It
does not provide any capabilities by itself — the capabilities live in the
MCP tools. This document tells you how to use those tools safely.

If the `rain` MCP isn't present in the agent's tool list, this skill has
nothing to do — tell the user to add it from the dashboard's Tools tab.

## What the Rain MCP gives you

Core trading tools:

- `rain_list_markets` — browse public Rain prediction markets on Arbitrum
- `rain_get_market` — full detail for one market (options, prices, liquidity, base token)
- `rain_build_buy` — build a buy-option transaction preview (returns `walletRequest` + `prerequisiteTxs[]`)
- `rain_build_sell` — build a sell-option (limit-order) transaction preview (returns `walletRequest`)
- `rain_build_claim` — build a claim transaction preview (returns `walletRequest`)
- `rain_build_add_liquidity` — build an add-liquidity transaction preview (returns `walletRequest` + `prerequisiteTxs[]`)
- `rain_get_price_history` — OHLCV candle data for one market option

The MCP returns typed responses — call the tools directly. Do not construct
HTTP requests, do not invent endpoint URLs, do not call any Rain SDK or RPC
directly. The MCP is the only path.

## Safety rules (apply to every tool call)

- **Never display or request a private key.** Never put a wallet key in a
  tool argument.
- **Never invent recipient addresses or market identifiers.** Only use
  values that came from a previous `rain_list_markets` or `rain_get_market`
  response, or that the user explicitly provided in this conversation.
- **Never bypass the MCP.** If you need a Rain capability that the MCP
  doesn't expose, say so — do not improvise. New capabilities ship as
  follow-up MCP tools (V2 Phase A).
- **Treat all build responses as previews.** They do not execute anything.
  Execution requires a separate user-approved wallet `sign-tx` call.

## Read flow (`rain_list_markets`, `rain_get_market`)

1. Use `rain_list_markets` to find markets matching the user's interest.
   Filter by `status: Live` if you want only active markets.
2. Use `rain_get_market` to get full detail. Surface to the user: title,
   status, time to resolution, option list with current prices, and
   `details.baseToken` + `details.baseTokenDecimals`.
3. State risks plainly: slippage, resolution uncertainty, lock-up until
   resolution. Do not imply guaranteed outcomes.

## Buy flow (`rain_build_buy` → wallet sign-tx)

1. **Confirm the four inputs with the user** before calling the tool:
   - exact market contract address (from `rain_get_market` →
     `details.contractAddress`)
   - option index (`details.options[N].choiceIndex`)
   - amount in the market's base token (compute using
     `details.baseTokenDecimals` — do NOT assume USDT or 6 decimals)
   - agent wallet address (`ownerAddress`) — always pass this so the server
     can determine approval requirements deterministically
2. Call `rain_build_buy` with all four fields. The response includes:
   - `walletRequest` — the buy transaction
   - `prerequisiteTxs[]` — ordered list of transactions to execute first
     (empty if no approval needed); each entry has `action` and `walletRequest`
   - `approvalChecked` — true when the server successfully verified allowance
   - `approvalMayBeRequired` — true only when `approvalChecked` is false
     (server could not verify); in this case warn the user
3. **Show the user the full preview** before any signing:
   - market title, option label, amount in human terms, base token
   - if `prerequisiteTxs` is non-empty: explain that an ERC-20 approve tx
     must be signed first (two signing prompts)
   - if `approvalMayBeRequired` is true (fallback): warn that approval may
     be needed
4. Ask explicit confirmation. Never proceed on a vague instruction like
   "buy some" — get all parameters and an explicit "yes" first.
5. On confirmation: execute `prerequisiteTxs` in order via wallet `sign-tx`,
   then execute the main `walletRequest`. Report all transaction hashes.

## Sell flow (`rain_build_sell` → wallet sign-tx)

1. **Confirm the four inputs with the user** before calling the tool:
   - market contract address (from `rain_get_market` → `details.contractAddress`)
   - option index of the shares being sold
   - number of shares to sell — compute `sharesAmountWei` using `details.baseTokenDecimals`
   - limit price per share as a decimal 0–1 (e.g. `"0.55"`)
2. Call `rain_build_sell`. The response includes a `walletRequest`. No prerequisite approval is
   needed — the agent is receiving tokens, not spending them.
3. **Show the user the full preview** before signing:
   - market title, option label, shares in human terms, limit price
4. Ask explicit confirmation. On confirmation, execute the `walletRequest` via wallet `sign-tx`.
   Report the transaction hash.

**Note:** `rain_build_sell` places a limit order. The order fills when a counterparty matches at
or above your price. The transaction submits the order — it does not guarantee an immediate fill.

## Claim flow (`rain_build_claim` → wallet sign-tx)

1. Confirm the market is in a claimable state — `details.poolFinalized` is
   true, and `details.status` is `Closed` or resolved.
2. Confirm the wallet address (the address that holds the winning shares).
3. Call `rain_build_claim`. The response includes a `walletRequest`.
4. Show the preview to the user; on confirmation, pass to wallet `sign-tx`.

## Composite flow: claim and reinvest

When a user wants to claim winnings and immediately reinvest into a new market:

1. Run the standard claim flow (steps above). Wait for the claim tx hash.
2. After claim confirmation, check the wallet balance for the received base token
   (`rain_get_market` on the target market will give `baseToken` + `baseTokenDecimals`).
3. Run the standard buy flow for the new market using the claimed amount as `buyAmountInWei`.
   Pass `ownerAddress` so the server checks if a fresh approval is needed (the claim likely
   didn't create an allowance for the new market contract).
4. Show a single combined preview before any signing: "You claimed X [token] and will
   reinvest Y [token] into [market title] → [option]."
5. On user confirmation, execute any `prerequisiteTxs` then the buy `walletRequest`.

Never skip the combined preview — the user is approving two economic actions.

## Market state — refuse unsafe actions

Refuse to call `rain_build_buy` when `details.status` is not in
`{"Live", "Trading", "New", "ClosingSoon"}`. Tell the user the market
isn't tradable. Refuse `rain_build_claim` when `details.poolFinalized` is
false.

Warn prominently when `details.isDisputed` or `details.isAppealed` is true
— the outcome may still change.

Refuse trading after `details.endTime` has passed (current time > endTime).

## Add-liquidity flow (`rain_build_add_liquidity` → wallet sign-tx)

1. Confirm market address, amount (compute using `details.baseTokenDecimals`), and agent wallet address (`ownerAddress`).
2. Call `rain_build_add_liquidity`. Same approval pattern as buy: check `prerequisiteTxs[]` for an `erc20_approve` entry.
3. Show preview: market, amount in human terms, base token. Confirm with user.
4. Execute `prerequisiteTxs` in order, then the main `walletRequest`. Report all tx hashes.

LP shares are redeemable via `rain_build_claim` once the market finalises — there is no separate remove-liquidity action.

## Price history (`rain_get_price_history`)

Use to surface price charts or inform limit-sell price selection. Returns OHLCV candles — `open`, `high`, `low`, `close`, `volume`, `trades` per candle. All numeric fields are serialized as strings (bigint). Available intervals: `1m`, `5m`, `15m`, `1h`, `4h`, `1d`, `1w`.

## Capabilities NOT in this version

Do not invent endpoints, do not claim these are "almost shipped" or
"close to deployed". If the user asks, say plainly: "That isn't a Rain
skill capability yet."

- Creating markets — V2 Phase C (deferred)
- Price quotes / slippage estimates — V2 Phase C
- Real-time market events — V2 Phase C (polling)
- Cancel orders — V2 Phase C

## Response format for previews

```
Rain action preview
Chain:    arbitrum
Action:   buy_option | sell_option | claim
Market:   <title or contract address>
Option:   <index and label>
Amount:   <human amount> <base token symbol>  (resolved from details.baseToken)
[Approval: <erc20_approve tx needed before buy> | none required]
---
Approve and sign? Reply yes to proceed.
```

## Error handling

The MCP returns structured errors; surface them faithfully:

| MCP error / code            | What to say                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `missing_env`               | "This agent's runtime credentials aren't set up. Redeploy the agent from the dashboard so they get populated." |
| Status 400 / `bad_input`    | Show the `error` message verbatim — it's user-readable.                                                        |
| Status 401/403              | "Agent's runtime credentials are stale. Redeploy the agent and try again."                                     |
| 409 `market_not_tradable`   | "This market isn't in a tradable state right now. Check `details.status` with `rain_get_market`."              |
| 409 `expired`               | "This market has passed its end time and is no longer tradable."                                               |
| 409 `insufficient_position` | "You don't have enough shares to sell that amount."                                                            |
| Status 500                  | "Rain temporarily unavailable. Try again in a moment."                                                         |
| Status 502                  | Same as 500.                                                                                                   |

## Notes

- The Rain MCP wraps the dashboard's `/api/runtime/rain/*` endpoints —
  documented in `openclaw-dashboard/docs/api/rain-runtime.md` for
  reference. You should not call those endpoints directly; the MCP is the
  agent-facing surface.
- V2 Phase B will add add-liquidity, price-history, and real-time events.
