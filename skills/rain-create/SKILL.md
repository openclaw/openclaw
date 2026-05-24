---
name: rain-create
description: Prompt-level guidance for creating new Rain prediction markets on Arbitrum. Opt-in skill — high-stakes, irreversible, gas-spending. Pair with the `rain` skill (required for reading market state and base-token details).
homepage: https://app.agentglob.com
metadata:
  {
    "openclaw":
      {
        "emoji": "🆕",
        "requires": { "env": ["AGENTGLOB_RUNTIME_URL", "AGENTGLOB_RUNTIME_TOKEN"] },
      },
  }
---

# Rain create-market skill

This skill enables the agent to deploy new Rain prediction markets. Market creation is **irreversible** from the agent's side and locks the creator's seed liquidity until the market resolves. It is intentionally a separate, opt-in skill from the main `rain` skill — enable it only when the agent's purpose includes launching markets.

## Prerequisite check (before any create-market call)

Before invoking `rain_build_create_market`, verify that the `rain_*` read tools are present in your tool list. If they are not, refuse: market creation requires the `rain` skill to be enabled for prerequisite reads (e.g. `rain_get_config` for the base-token address, `rain_get_market` to verify the new market post-creation). Tell the user to add the `rain` skill from the dashboard's Tools tab first.

This runtime check exists because the dashboard's skill loader does not currently enforce skill-to-skill dependencies via frontmatter — operators rely on the agent's behaviour here.

## What this skill gives you

One MCP tool, owned exclusively by this skill:

- `rain_build_create_market` — build a market-creation transaction sequence (returns ordered `prerequisiteTxs[]` + final `walletRequest`).

The tool lives in the shared `rain` MCP server (no separate server). The skill split is prompt-level; if an agent has the `rain` MCP attached but not this skill, the tool is still technically callable — but without this skill's flow guidance, it should not be invoked. A wallet-level runtime gate is planned as a follow-up (see `docs/plans/rain-skill-rewrite.md` §11).

## Create-market flow (`rain_build_create_market` → wallet sign-tx)

Creating a market is the heaviest Rain action — it deploys a new market contract, costs gas, and locks the creator's seed liquidity until the market resolves. **Always walk the user through every field and get explicit confirmation before calling the tool.**

1. **Required inputs to confirm with the user (in plain language, not jargon):**
   - **Question** — the exact resolution question, ≤ 500 chars. Should be unambiguous and time-bounded.
   - **Description** — long-form resolution criteria, ≤ 5000 chars. Spell out the data source and edge cases.
   - **Options** — at least 2 labels. Use simple `["Yes", "No"]` unless the user wants multi-outcome.
   - **End time** — unix seconds, must be in the future. Convert from user-friendly date to unix yourself.
   - **Creator wallet address** — the wallet that pays gas + seed liquidity.
   - **Initial liquidity** — `inputAmountWei`. Compute from a human amount using the base-token decimals (USDT = 6).
   - **Dispute window** — `disputeTimer` in seconds. 86400 (24h) is a common safe default.
   - **isPublic** — list it publicly, yes/no.
   - **isPublicPoolResolverAi** — use Rain's AI resolver, yes/no.

2. **Optional fields** — only set if the user asks. Defaults are sensible:
   - `marketTags` defaults to `[]`.
   - `startTime` defaults to now.
   - `baseToken` defaults to the environment's USDT.
   - `barValues` defaults to an equal probability split across options summing to 100.
   - `no_of_options` is derived from `marketOptions.length`.
   - `tokenDecimals`, `factoryContractAddress` — leave unset unless the user has a specific reason.

3. **Read back the full preview** before calling the tool — every field, in human-readable units. Get an explicit "yes".

4. **Call `rain_build_create_market`.** The response has:
   - `txCount` — total transactions in the sequence (usually 2: ERC-20 approve, then factory create)
   - `prerequisiteTxs[]` — all-but-last txs in order, each with `action` and `walletRequest`
   - `walletRequest` — the final tx (the factory create call)
   - `defaults` — the values actually used (echoes auto-defaulted fields so the user can verify)

5. **Show a final confirmation** including any defaults the tool filled in, then execute `prerequisiteTxs` in order via wallet `sign-tx`, then the final `walletRequest`. Report every tx hash.

## When NOT to use this skill

Refuse, and explain why, in any of these cases:

- **No clear, verifiable resolution data source.** "Will Bitcoin go up next week?" is not resolvable; "Will Bitcoin's USD price on Coinbase exceed $X at 2026-06-01 00:00 UTC?" is. The market is unusable if humans (or the AI resolver) cannot determine the outcome unambiguously.
- **User is hesitant or exploratory.** If the user asks "can I create a market?" or "how does this work?", answer the question first. Do not invoke the tool until the user has explicitly confirmed all the inputs.
- **User asks for a "test" or "throwaway" market.** On-chain creation is real, costs gas, and the market exists permanently. There is no testnet shortcut on this skill — point them at the Rain testnet directly if they want to experiment.
- **Wallet lacks sufficient base token.** If you know (or have just queried) that the creator wallet's base-token balance is below `inputAmountWei` + a gas buffer, stop and surface the gap.

Market creation is irreversible from the agent's side. Err on the side of refusing.

## After creation

When the final `walletRequest` is confirmed on-chain:

1. **Surface the new market's contract address** from the final tx receipt logs. Rain emits this in the factory event; the wallet sign-tx flow should return it. If it's not visible in the receipt, fall back to calling `rain_resolve_market_id` (if you have the address) or `rain_list_markets` filtered by the creator address.
2. **Verify the market is live** by calling `rain_get_market` with the new marketId. Confirm to the user that `details.status` is `Live` or `New`.
3. **Offer next steps:**
   - `rain_build_add_liquidity` — deepen the pool (requires the `rain` skill).
   - Share the market URL / contract address with the user so they can publish it.

## Safety rules

All rules from the `rain` skill apply. In addition:

- **Never invoke `rain_build_create_market` without the read-back and explicit "yes".** A vague "go ahead" or "create it" is not sufficient.
- **Never invent resolution criteria or default data sources.** The user must provide both, in plain language.
- **Never proceed past a prerequisite-tx failure.** If the ERC-20 approval transaction fails or reverts, stop. Do not retry blindly — diagnose first.

## Error handling

Inherits from the `rain` skill. Additional code:

| MCP error / code     | What to say                                                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400 `invalid_inputs` | Show the message verbatim — it usually names the specific field that failed validation (e.g. "endTime must be in the future", "marketOptions must have ≥ 2 entries"). Re-ask the user for a correct value. |
| 500 `factory_failed` | "The Rain factory rejected the creation call. This usually means a constraint was violated server-side. Try again with adjusted inputs or surface the message to the user."                                |

## Notes

- The `rain` MCP wraps the dashboard's `/api/runtime/rain/build-create-market` endpoint. You should not call it directly; the MCP is the agent-facing surface.
- A future `feat/wallet-create-market-gate` PR will add a wallet-level refusal when an agent without this skill enabled attempts to sign a factory-create transaction. Until that ships, this skill is **advisory, not enforcement**.
