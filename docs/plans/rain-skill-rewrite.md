# Plan — Rain skill rewrite + create-market split

> Status: **v2 — Codex review incorporated, ready for implementation**
> Author: Claude (handover-paired)
> Reviewer: Codex (see PR #44 comment thread)
> Target branch when implemented: `feat/rain-skill-split`
>
> **v2 changes:** §4.2 address-vs-id rule completed; §4.4 ownership clarified; §5.1 `requires.skills` removed (not loader-supported); §5.2 runtime prerequisite check added; §7 open questions resolved as decisions; §8.1 explicit 22-tool mapping added; §11 wallet-gate follow-up scoped out.

---

## 1. Background

The `rain` MCP server (`src/mcp/rain/`) currently exposes **22 tools** (see `RAIN_TOOLS` in `src/mcp/rain/tools.ts`). The companion skill at `skills/rain/SKILL.md` documents **9** of them. The other 13 are callable, return correct results, and have inline tool descriptions, but no flow guidance in the SKILL.

Concretely, the SKILL covers: `list_markets`, `get_market`, `build_buy`, `build_sell`, `build_claim`, `build_add_liquidity`, `build_create_market`, `get_price_history`, `get_capabilities`.

It does NOT cover:

| Group         | Tools                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Portfolio     | `rain_get_positions`, `rain_get_position_by_market`, `rain_get_lp_position`, `rain_get_portfolio_value`, `rain_get_pnl` |
| Trade history | `rain_get_trade_history`, `rain_get_transactions`, `rain_get_market_transactions`, `rain_get_transaction_details`       |
| Utility       | `rain_get_market_address`, `rain_resolve_market_id`                                                                     |
| Diagnostics   | `rain_get_config`, `rain_get_health`                                                                                    |

Separately, `rain_build_create_market` is bundled into the trading skill, but its risk profile (irreversible, gas-spending, deploys a new contract) and target persona (market creator, not trader) differ enough to justify a separate, opt-in skill.

## 2. Goals

1. **Expand** `skills/rain/SKILL.md` so it documents every read-only and trading tool the MCP exposes.
2. **Extract** create-market into a new opt-in skill `skills/rain-create/SKILL.md`.

Result: every deployed Rain MCP tool is covered by exactly one skill; no tool appears in two skills.

## 3. Non-goals

- No changes to the MCP server (`src/mcp/rain/**`). The tool surface is correct; only the prompt-level guidance changes.
- No dashboard UI changes (e.g. a "Skills tab"). That is a separate product decision.
- No changes to `rain_get_capabilities` — it remains the runtime source of truth.
- No new tests. SKILL.md content is markdown.
- No changes to wallet skill, runtime client, or HTTP routes.

## 4. Scope — Part 1: Expand `skills/rain/SKILL.md`

### 4.1 Add a "Portfolio & analytics" section (read-only)

When to call:

- User asks "what do I own", "what's my position in market X", "how am I doing"
- Use `rain_get_positions` for a wallet's full position list, `rain_get_position_by_market` or `rain_get_lp_position` for one market.
- Use `rain_get_portfolio_value` when the user wants a dollar-value total across markets + tracked tokens.
- Use `rain_get_pnl` for realised + unrealised PnL.

Surfacing rules:

- Convert wei → human units using the relevant market's `baseTokenDecimals`. Never display raw wei to the user.
- Show market title (`details.title` from `rain_get_market`) rather than contract address.
- Read-only — no signing, no preview, no confirmation required.

`rain_get_pnl` quirk:

- `marketAddress` (on-chain) — NOT `marketId`. Use `rain_get_market_address` to convert if the user gave you a marketId.

### 4.2 Add a "Trade history & transactions" section

When to call:

- User asks for a trade log, audit trail, or to look up a specific tx.
- `rain_get_trade_history` for one wallet + one market (both required, both as addresses).
- `rain_get_transactions` for one wallet across all markets (paginated).
- `rain_get_market_transactions` for one market's full activity (no wallet filter).
- `rain_get_transaction_details` for one tx hash — block number, status, gas, events.

Address-vs-id rule (call it out explicitly):

Three groups, verified against `RainRuntimeClient` method signatures:

- **`marketId` (subgraph/internal):** `rain_get_market`, `rain_build_claim`, `rain_get_price_history`, `rain_get_position_by_market`, `rain_get_lp_position`, `rain_get_market_address`.
- **`marketContractAddress` (on-chain target of a tx):** `rain_build_buy`, `rain_build_sell`, `rain_build_add_liquidity`.
- **`marketAddress` (on-chain target of an analytics query):** `rain_get_trade_history`, `rain_get_market_transactions`, `rain_get_pnl` (optional), `rain_resolve_market_id` (as input).

`marketContractAddress` and `marketAddress` are the same value — the parameter name varies by tool because the build-\* tools and the analytics tools were named independently. The SKILL should treat them as one concept ("the market's on-chain address") and use whichever name the tool's schema requires.

Conversion: `rain_get_market_address` (id → address) and `rain_resolve_market_id` (address → id).

### 4.3 Add a one-paragraph "Utility & diagnostics" section

- `rain_get_market_address` / `rain_resolve_market_id` — id↔address conversion; usually called silently as a setup step for another tool. Don't surface results to the user.
- `rain_get_config` — chain + env + secret presence. Useful when the user asks "which environment is this connected to?"
- `rain_get_health` — composite RPC + subgraph reachability check. Surface only if the user asks about Rain availability or if another tool returned a 5xx and you want to diagnose.

### 4.4 Remove the existing "Create-market flow" section

`rain_build_create_market` is **owned by the `rain-create` skill** — that's the only skill that contains its flow guidance. The `rain` skill's tool list mentions it once with the annotation _"→ owned by `rain-create` skill; do not call without that skill enabled"_, but the flow body lives only in `rain-create`. This is a cross-reference, not co-ownership — the acceptance criteria in §8 enforce exactly-one-skill ownership.

Replace the existing `## Create-market flow` section with a one-line pointer: _"Market creation is documented in the separate `rain-create` skill. Enable that skill if the agent should be able to deploy new markets."_

### 4.5 Update the header and version

- Title becomes `# Rain skill` (drop the "V2 Phase B" since we're past that classification).
- `description` in frontmatter updated to mention portfolio/analytics coverage.

## 5. Scope — Part 2: Create `skills/rain-create/SKILL.md`

New file. Opt-in, separate persona.

### 5.1 Frontmatter

```yaml
---
name: rain-create
description: Prompt-level guidance for creating new Rain prediction markets. Opt-in skill — high-stakes, irreversible, gas-spending. Pair with the `rain` skill (required for reading market state).
metadata:
  openclaw:
    emoji: 🆕
    requires:
      env: [AGENTGLOB_RUNTIME_URL, AGENTGLOB_RUNTIME_TOKEN]
---
```

**No `requires.skills` field** — Codex confirmed the dashboard loader (`lib/config-sync.ts`, `app/api/skills/route.ts`, `app/api/agents/[agentId]/skills/route.ts`) only parses `requires.env`. Adding `requires.skills` would be silently ignored.

**Implementation must verify**: the dashboard's frontmatter parser. If it expects JSON-style `"env": [...]`, the existing YAML `env: [...]` in `skills/rain/SKILL.md` may not be parsed as an env-requirement (visible in dashboard UI). Confirm during implementation; switch both files to whichever format the loader actually reads.

The dependency on the `rain` skill is enforced **in the skill body** instead, not via frontmatter (see §5.2).

### 5.2 Body

- Two-sentence preamble: "this skill enables the agent to deploy new Rain markets. Market creation is irreversible from the agent's side and locks the creator's seed liquidity until resolution."
- Add a **"Prerequisite check"** opener as the very first instruction (use plain quotes, not italics, to avoid the underscore-in-backtick spacing bug):

  > Before invoking `rain_build_create_market`, verify that the `rain_*` read tools are present in your tool list. If they are not, refuse: market creation requires the `rain` skill to be enabled for prerequisite reads. Tell the user to add the `rain` skill from the dashboard's Tools tab first.

  This is the runtime substitute for the unsupported `requires.skills` frontmatter.

- Move the existing `## Create-market flow` section from `skills/rain/SKILL.md` verbatim.
- Add **"When NOT to use"** subsection:
  - User has not named a clear, verifiable resolution data source
  - Wallet lacks sufficient base token for `inputAmountWei` + gas
  - User is hesitant or asking exploratory questions ("can I create one?") — answer questions first, then offer to walk them through creation
  - User asks for "test" or "throwaway" markets — explain that on-chain creation is real and costs gas
- Add **"After creation"** subsection: surface the new contract address from the final tx receipt logs, then suggest follow-ups (`rain_get_market` to verify, `rain_build_add_liquidity` to deepen the pool).

## 6. Files touched

| File                          | Change                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `skills/rain/SKILL.md`        | Add three sections (4.1, 4.2, 4.3), remove create-market section, header tweaks |
| `skills/rain-create/SKILL.md` | New file                                                                        |
| `STATUS.md`                   | Add branch ownership entry when implementation starts                           |

No code, no tests, no config.

## 7. Decisions (resolved by Codex review)

1. **`requires.skills`** — **NOT supported** by the dashboard loader. The plan uses a runtime/tool-list check inside `rain-create`'s body instead (see §5.2 "Prerequisite check").
2. **MCP server split** — `rain_build_create_market` **stays in the existing `rain` MCP server**. No tool migration, no new MCP wiring. The prompt-level guidance moves to `rain-create`, but the tool itself remains callable from any agent with the `rain` MCP attached. **Skill text is advisory and does not enforce gating** — see §11 for the wallet-level runtime gate this implies.
3. **`rain_get_health` pre-flight** — **reactive only**. Do not call before every `build_*`. Latency cost is not justified, and a health check passing does not guarantee the next build succeeds.
4. **`RAIN_CAPABILITY_PHASE`** — **do not bump**. The MCP tool surface and capability contract are unchanged. Bump only when the tool list changes.

## 8. Acceptance criteria

- [ ] Every tool name in `RAIN_TOOLS` (from `src/mcp/rain/tools.ts`) is the **flow-owner** of exactly one of `skills/rain/SKILL.md` or `skills/rain-create/SKILL.md` (see §8.1 mapping).
- [ ] `skills/rain/SKILL.md` and `skills/rain-create/SKILL.md` both have valid frontmatter that the dashboard loader actually parses (verify by checking the loader's parser format — JSON vs YAML).
- [ ] `rain-create` body opens with the prerequisite check from §5.2 (runtime substitute for `requires.skills`).
- [ ] No code changes outside `skills/` and `docs/`.
- [ ] No regressions in `rain_get_capabilities` output (still lists all 22 tools).
- [ ] PR description includes the §8.1 mapping so reviewers can audit coverage at a glance.

### 8.1 Tool → skill ownership mapping (load-bearing)

| Tool                           | Flow-owning skill | Notes                                              |
| ------------------------------ | ----------------- | -------------------------------------------------- |
| `rain_list_markets`            | `rain`            | Discovery                                          |
| `rain_get_market`              | `rain`            | Discovery                                          |
| `rain_build_buy`               | `rain`            | Trading                                            |
| `rain_build_sell`              | `rain`            | Trading                                            |
| `rain_build_claim`             | `rain`            | Trading                                            |
| `rain_build_add_liquidity`     | `rain`            | Liquidity                                          |
| `rain_get_price_history`       | `rain`            | Analytics                                          |
| `rain_get_capabilities`        | `rain`            | Introspection                                      |
| `rain_get_positions`           | `rain`            | Portfolio (§4.1)                                   |
| `rain_get_position_by_market`  | `rain`            | Portfolio (§4.1)                                   |
| `rain_get_lp_position`         | `rain`            | Portfolio (§4.1)                                   |
| `rain_get_portfolio_value`     | `rain`            | Portfolio (§4.1)                                   |
| `rain_get_pnl`                 | `rain`            | Portfolio (§4.1)                                   |
| `rain_get_trade_history`       | `rain`            | Trade history (§4.2)                               |
| `rain_get_transactions`        | `rain`            | Trade history (§4.2)                               |
| `rain_get_market_transactions` | `rain`            | Trade history (§4.2)                               |
| `rain_get_transaction_details` | `rain`            | Trade history (§4.2)                               |
| `rain_get_market_address`      | `rain`            | Utility (§4.3)                                     |
| `rain_resolve_market_id`       | `rain`            | Utility (§4.3)                                     |
| `rain_get_config`              | `rain`            | Diagnostics (§4.3)                                 |
| `rain_get_health`              | `rain`            | Diagnostics (§4.3)                                 |
| `rain_build_create_market`     | **`rain-create`** | Cross-referenced in `rain`, owned by `rain-create` |

**Total: 21 owned by `rain`, 1 owned by `rain-create`, 22 = `RAIN_TOOLS.length`.**

## 9. Implementation order (when approved)

1. Add `skills/rain-create/SKILL.md` (greenfield — easier to review independently).
2. Remove create-market section from `skills/rain/SKILL.md`, add pointer.
3. Add portfolio + analytics + utility sections to `skills/rain/SKILL.md`.
4. Update frontmatter + header.
5. Update `STATUS.md`.
6. Open PR titled `docs(skills/rain): expand coverage + split create-market`.

## 10. Out of scope / follow-ups

- Skills marketplace UI in the dashboard
- Skill-to-skill dependency enforcement in the dashboard loader (`requires.skills`)
- Splitting `rain_build_create_market` into its own MCP server
- Adding price-quote / slippage tools (still on the Phase B roadmap, but separate ticket)

## 11. Follow-up — wallet-level runtime gate for `rain_build_create_market`

Codex's risk-profile note (correct): the skill split is **advisory, not enforcing**. Because `rain_build_create_market` stays in the shared `rain` MCP server, any agent with the `rain` MCP attached can call it, regardless of whether the `rain-create` skill is enabled. Skill text shapes LLM behaviour but does not block tool invocation.

For a real gate, the **wallet sign-tx flow on the dashboard side** should refuse to sign a payload whose target is the Rain factory's `createMarket` selector unless one of:

- the agent has the `rain-create` skill enabled (read from agent config), **OR**
- a per-agent capability allowlist contains `rain.create-market`.

This is a follow-up ticket, **not part of this plan**. The plan ships the skill split now (low risk, prompt-only) and the runtime gate lands as a separate `feat/wallet-create-market-gate` PR. Until that ships, the recommendation to operators is: do not enable the `rain` MCP for untrusted agents.
