---
name: rain
description: Prompt-level guidance for the Rain prediction-market integration on Arbitrum. Covers market discovery, trading (buy/sell/claim), liquidity provision, portfolio + analytics reads, trade history, and runtime diagnostics. The actual capability surface is the `rain` MCP server (typed tools); this skill adds safety rules, preview discipline, market-state awareness, and address-vs-id conventions. Market creation lives in the separate opt-in `rain-create` skill.
homepage: https://app.agentglob.com
metadata:
  {
    "openclaw":
      {
        "emoji": "🌧️",
        "requires": { "env": ["AGENTGLOB_RUNTIME_URL", "AGENTGLOB_RUNTIME_TOKEN"] },
      },
  }
---

# Rain skill

This skill is **optional prompt-level guidance** for agents that have the
`rain` MCP server added (from the dashboard's Tools tab quick-setup). It
does not provide any capabilities by itself — the capabilities live in the
MCP tools. This document tells you how to use those tools safely.

If the `rain` MCP isn't present in the agent's tool list, this skill has
nothing to do — tell the user to add it from the dashboard's Tools tab.

## What the Rain MCP gives you

Discovery + trading:

- `rain_list_markets` — browse public Rain prediction markets on Arbitrum
- `rain_get_market` — full detail for one market (options, prices, liquidity, base token)
- `rain_build_buy` — build a buy-option transaction preview (returns `walletRequest` + `prerequisiteTxs[]`)
- `rain_build_sell` — build a sell-option (limit-order) transaction preview (returns `walletRequest`)
- `rain_build_claim` — build a claim transaction preview (returns `walletRequest`)
- `rain_build_add_liquidity` — build an add-liquidity transaction preview (returns `walletRequest` + `prerequisiteTxs[]`)
- `rain_get_price_history` — OHLCV candle data for one market option

Portfolio + analytics (read-only — see §"Portfolio & analytics" below):

- `rain_get_positions`, `rain_get_position_by_market`, `rain_get_lp_position`
- `rain_get_portfolio_value`, `rain_get_pnl`

Trade history + transactions (read-only — see §"Trade history & transactions"):

- `rain_get_trade_history`, `rain_get_transactions`, `rain_get_market_transactions`, `rain_get_transaction_details`

Utility + diagnostics (see §"Utility & diagnostics"):

- `rain_get_market_address`, `rain_resolve_market_id`, `rain_get_config`, `rain_get_health`

Introspection:

- `rain_get_capabilities` — list the current Rain MCP tool surface + capability version (use when asked "what can you do?" or to detect stale deploys)

Owned by another skill:

- `rain_build_create_market` → **owned by the `rain-create` skill**. Do not call this tool unless the agent has `rain-create` enabled. Market-creation flow guidance lives in that skill, not here.

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
  follow-up MCP tools.
- **Treat all build responses as previews.** They do not execute anything.
  Execution requires a separate user-approved wallet `sign-tx` call.

## Address-vs-id convention (load-bearing — read this once)

Rain tools take one of two market identifiers, depending on which subsystem they query. Mixing them up will produce 404s or empty results. Three groups:

- **`marketId` (subgraph/internal id):** `rain_get_market`, `rain_build_claim`, `rain_get_price_history`, `rain_get_position_by_market`, `rain_get_lp_position`, `rain_get_market_address`.
- **`marketContractAddress` (on-chain target of a build tx):** `rain_build_buy`, `rain_build_sell`, `rain_build_add_liquidity`. Sourced from `rain_get_market` → `details.contractAddress`.
- **`marketAddress` (on-chain target of an analytics query):** `rain_get_trade_history`, `rain_get_market_transactions`, `rain_get_pnl` (optional filter), `rain_resolve_market_id` (as input).

`marketContractAddress` and `marketAddress` are the **same value** — the parameter name varies by tool because the build-\* tools and the analytics tools were named independently. Use whichever name the tool's schema requires.

Conversion:

- `rain_get_market_address(marketId)` → on-chain address
- `rain_resolve_market_id(address)` → marketId

Call these silently as setup steps. Don't surface the conversion to the user unless they asked.

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

## Portfolio & analytics (read-only)

When the user asks "what do I own", "how am I doing", "show me my position in market X":

- **`rain_get_positions(walletAddress)`** — full position list across all Rain markets the wallet has participated in. Includes option shares, LP liquidity, and claim status per market. Use this for portfolio overviews.
- **`rain_get_position_by_market(marketId, walletAddress)`** — one market's position only. Same shape as a single entry from `rain_get_positions`.
- **`rain_get_lp_position(marketId, walletAddress)`** — just the LP portion (no option shares). Use when the user specifically asks about their liquidity.
- **`rain_get_portfolio_value(walletAddress, tokenAddresses[])`** — total portfolio value in dollar terms across all Rain positions plus the specified ERC-20 token balances. Use when the user wants a single "what am I worth" number.
- **`rain_get_pnl(walletAddress, marketAddress?)`** — realised + unrealised PnL. Optional `marketAddress` (note: on-chain address, NOT marketId — see §"Address-vs-id convention") filters to one market.

Surfacing rules:

- Convert wei → human units using the relevant market's `baseTokenDecimals`. **Never display raw wei to the user.**
- Show market title (from `rain_get_market.details.title`) rather than contract address.
- These tools are read-only — no signing, no preview, no confirmation required. Call them freely.

## Trade history & transactions

When the user asks for a trade log, audit trail, or to look up a specific transaction:

- **`rain_get_trade_history(walletAddress, marketAddress)`** — trade history for one wallet in one market. Both arguments required; `marketAddress` is the on-chain address.
- **`rain_get_transactions(walletAddress, {first?, skip?, orderDirection?})`** — paginated transaction history for one wallet across **all** Rain markets.
- **`rain_get_market_transactions(marketAddress, {first?})`** — all transactions for one market (no wallet filter). Use for market activity overviews.
- **`rain_get_transaction_details(txHash)`** — one transaction by hash: block number, timestamp, status, gas used, and decoded events.

These are read-only. Convert wei amounts to human units before displaying. If the user gave you a marketId but the tool wants `marketAddress`, convert silently with `rain_get_market_address`.

## Utility & diagnostics

Internal-use tools — call silently as setup or for troubleshooting:

- **`rain_get_market_address(marketId)`** / **`rain_resolve_market_id(address)`** — id↔address conversion. Use as a setup step for another tool when the user gave you the "wrong" form. Don't surface results.
- **`rain_get_config()`** — chain, environment, and whether server-side secrets are configured. Returns no secret values. Use when the user asks "which environment is this connected to?" or "is the Rain integration set up?"
- **`rain_get_health()`** — composite RPC + subgraph reachability check. **Call reactively, not as a pre-flight.** Surface only when the user asks about Rain availability, or when another tool returned a 5xx and you want to diagnose. Do not call before every `build_*` — the latency is not justified and a green health check does not guarantee the next build succeeds.

## Market creation

`rain_build_create_market` is **owned by the separate `rain-create` skill**. If the user asks to create a market, check whether the `rain-create` skill is enabled. If yes, follow that skill's flow. If no, tell the user to enable the `rain-create` skill from the dashboard's Tools tab — do not invoke `rain_build_create_market` without that skill's safety guidance, even though the tool may be technically callable.

## Capability introspection (`rain_get_capabilities`)

When the user asks "what Rain features do I have?" or "list everything you can do with Rain", call `rain_get_capabilities` and answer from its response. Do not answer from memory — the deployed tool surface is authoritative, and your training-time view may lag the current build.

The response includes a `capabilityVersion` and `phase` tag. If the user reports a missing feature that this skill claims should exist, compare these against the values documented here — a mismatch means the gateway image is stale and needs to be redeployed.

## Capabilities NOT in this version

Do not invent endpoints, do not claim these are "almost shipped" or
"close to deployed". If the user asks, say plainly: "That isn't a Rain
skill capability yet."

- Price quotes / slippage estimates — not shipped
- Real-time market events / push subscriptions — not shipped (use polling)
- Cancel open buy/sell orders — not shipped

## Response format for previews

```
Rain action preview
Chain:    arbitrum
Action:   buy_option | sell_option | claim | add_liquidity
Market:   <title or contract address>
Option:   <index and label>
Amount:   <human amount> <base token symbol>  (resolved from details.baseToken)
[Approval: <erc20_approve tx needed before action> | none required]
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
