---
name: rain
description: Prompt-level guidance for the Rain prediction-market integration. The actual capability surface is the `rain` MCP server (typed tools); this skill adds safety rules, preview discipline, and market-state awareness.
metadata:
  openclaw:
    emoji: 🌧️
    requires:
      env: [AGENTGLOB_RUNTIME_URL, AGENTGLOB_RUNTIME_TOKEN]
---

# Rain skill (V1.5)

This skill is **optional prompt-level guidance** for agents that have the
`rain` MCP server added (from the dashboard's Tools tab quick-setup). It
does not provide any capabilities by itself — the capabilities live in the
MCP tools. This document tells you how to use those tools safely.

If the `rain` MCP isn't present in the agent's tool list, this skill has
nothing to do — tell the user to add it from the dashboard's Tools tab.

## What the Rain MCP gives you

Four typed tools, available when the `rain` MCP is active:

- `rain_list_markets` — browse public Rain prediction markets on Arbitrum
- `rain_get_market` — full detail for one market (options, prices, liquidity, base token)
- `rain_build_buy` — build a buy-option transaction preview (returns `walletRequest`)
- `rain_build_claim` — build a claim transaction preview (returns `walletRequest`)

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

1. **Confirm the three inputs with the user** before calling the tool:
   - exact market contract address (from `rain_get_market` →
     `details.contractAddress`)
   - option index (`details.options[N].choiceIndex`)
   - amount in the market's base token (compute using
     `details.baseTokenDecimals` — do NOT assume USDT or 6 decimals)
2. Call `rain_build_buy`. The response includes a `walletRequest`.
3. **Show the user the full preview** before any signing:
   - market title, option label, amount in human terms, base token
   - `approvalMayBeRequired` — if true, an ERC-20 approve tx may precede
     the buy; warn the user that they'll see two signing prompts
4. Ask explicit confirmation. Never proceed on a vague instruction like
   "buy some" — get all three parameters and an explicit "yes" first.
5. On confirmation, pass `walletRequest` to the wallet skill's `sign-tx`
   tool. Report the transaction hash and an Arbiscan link.

## Claim flow (`rain_build_claim` → wallet sign-tx)

1. Confirm the market is in a claimable state — `details.poolFinalized` is
   true, and `details.status` is `Closed` or resolved.
2. Confirm the wallet address (the address that holds the winning shares).
3. Call `rain_build_claim`. The response includes a `walletRequest`.
4. Show the preview to the user; on confirmation, pass to wallet `sign-tx`.

## Market state — refuse unsafe actions

Refuse to call `rain_build_buy` when `details.status` is not in
`{"Live", "Trading", "New", "ClosingSoon"}`. Tell the user the market
isn't tradable. Refuse `rain_build_claim` when `details.poolFinalized` is
false.

Warn prominently when `details.isDisputed` or `details.isAppealed` is true
— the outcome may still change.

Refuse trading after `details.endTime` has passed (current time > endTime).

## Capabilities NOT in this version

Do not invent endpoints, do not claim these are "almost shipped" or
"close to deployed". If the user asks, say plainly: "This isn't a Rain
skill capability in V1.5. The V2 plan covers some of these but it has not
shipped."

- Selling positions (limit-order) — V2 Phase A
- Creating markets — V2 Phase C (deferred)
- Adding/removing liquidity — V2 Phase B (add only; remove via claim)
- Reading positions / portfolio / PnL — V2 Phase A
- Trade history — V2 Phase A
- Price quotes / slippage estimates — V2 Phase B (advisory only)
- Price history (candles) — V2 Phase B
- Real-time market events — V2 Phase B (polling)
- Cancel orders — V2 Phase C

## Response format for previews

```
Rain action preview
Chain:    arbitrum
Action:   buy_option | claim
Market:   <title or contract address>
Option:   <index and label>
Amount:   <human amount> <base token symbol>  (resolved from details.baseToken)
Approval: may be required before this transaction executes
---
Approve and sign? Reply yes to proceed.
```

## Error handling

The MCP returns structured errors; surface them faithfully:

| MCP error      | What to say                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `missing_env`  | "This agent's runtime credentials aren't set up. Redeploy the agent from the dashboard so they get populated." |
| Status 400     | Show the error message verbatim — it's user-readable.                                                          |
| Status 401/403 | "Agent's runtime credentials are stale. Redeploy the agent and try again."                                     |
| Status 500     | "Rain temporarily unavailable. Try again in a moment."                                                         |
| Status 502     | Same as 500.                                                                                                   |

## Notes

- The Rain MCP wraps the dashboard's `/api/runtime/rain/*` endpoints —
  documented in `openclaw-dashboard/docs/api/rain-runtime.md` for
  reference. You should not call those endpoints directly; the MCP is the
  agent-facing surface.
- V2 Phase A will add more MCP tools (sell, positions, PnL, trade history,
  add-liquidity). When those land, this skill will get a matching
  refresh — until then, stay within the four tools above.
