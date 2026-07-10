# Venice per-token pricing — make the usage/billing report see Venice spend

**Status:** Rev 1 — for Codex review
**Repo:** `cryptolir/openclaw` (gateway). No dashboard code changes in this plan.

## Problem (verified live, 2026-07-10)

Every Venice model is defined with `cost: 0`, so the gateway prices all Venice
inference at $0.00. Verified against the live `life` gateway ("Havaya.me",
workspace `NCVKknvHNnpNYjkUaMdH`) via its `usage.report` RPC, 7-day window:

| model                    | tokens    | reported cost |
| ------------------------ | --------- | ------------- |
| `venice/claude-opus-4-6` | 5,113,877 | **$0.00**     |
| `openai/gpt-4.1-mini`    | 14,599    | $0.006        |

~80% of the fleet runs Venice primaries (`qwen3-5-9b`, `claude-opus-4-6`,
`zai-org-glm-4.7`, …), so the daily usage email, the dashboard usage report,
and the `usage_monthly` spend accrual are blind to nearly all real inference
spend. `missingCostEntries` stays 0 — the zero is a _computed_ value, not a
flagged gap, so nothing warns.

## What exists (read, not remembered)

1. **The zero source** — `src/agents/venice-models.ts:7`:

   ```ts
   // Venice uses credit-based pricing, not per-token costs.
   // Set to 0 as costs vary by model and account type.
   export const VENICE_DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
   ```

   Used in exactly two places: `buildVeniceModelDefinition` (line 618, catalog
   models) and the non-catalog branch of `discoverVeniceModels` (line 737).

2. **The comment is outdated.** Venice's `GET /api/v1/models` returns per-token
   USD pricing today (verified live):

   ```json
   "pricing": { "input": {"usd": 6, "diem": 6}, "cache_input": {"usd": 0.6, ...},
                "cache_write": {"usd": 7.5, ...}, "output": {"usd": 30, ...} }
   ```

   Units are **USD per million tokens** (glm-5-2 at 1.4/4.4 matches Venice's
   published $/M prices). Some models omit fields: `qwen3-5-9b` has no
   `cache_input`/`cache_write`. `discoverVeniceModels` already fetches this
   endpoint (line ~690) but ignores `model_spec.pricing`; the
   `VeniceModelSpec` interface (line 630) doesn't declare it.

3. **Turn-time costing** — pi-ai `calculateCost`
   (`@mariozechner/pi-ai/dist/models.js:22`) computes
   `usage.cost.input = (model.cost.input / 1_000_000) * usage.input` etc.
   Same USD-per-million convention. The resulting `usage.cost` is persisted
   into the session transcript (`message.usage.cost`), which is what
   `usage.report` sums (`src/infra/session-cost-usage.ts:347-358`).

4. **Report-side fallback already exists** —
   `src/infra/session-cost-usage.ts:251` re-prices entries whose stored cost is
   _undefined_ via `resolveModelCostConfig` + `estimateUsageCost`
   (`src/utils/usage-format.ts:46,64` — also USD-per-million). Venice entries
   skip it because their stored cost is a **defined zero**. No change needed
   here; noted so review doesn't propose rebuilding it.

5. **models.json plumbing** — `ensureAgentModelsJson`
   (`src/agents/models-config.ts:85-150`) writes the discovered Venice models
   (including `cost`) to each agent's `models.json` in merge mode. Gotcha at
   line ~123: when discovery returns _fewer_ Venice models than the cached
   file, the cached (zero-cost) entries are **preserved** — see Risks.

6. **Discovery failure fallback** — `discoverVeniceModels` retries once, then
   falls back to the static `VENICE_MODEL_CATALOG` via
   `buildVeniceModelDefinition` (line ~774), which today hard-codes
   `VENICE_DEFAULT_COST`.

## Design

One pure function + threading. All in `src/agents/venice-models.ts`.

### 1. Pure mapping fn

```ts
export function veniceCostFromPricing(pricing?: VenicePricing): ModelCost {
  const input = pricing?.input?.usd ?? 0;
  return {
    input,
    output: pricing?.output?.usd ?? 0,
    // No cache_input price ⇒ bill cached reads at the input rate rather than
    // silently free (conservative: overstates ≤ input rate, never hides spend).
    cacheRead: pricing?.cache_input?.usd ?? input,
    cacheWrite: pricing?.cache_write?.usd ?? 0,
  };
}
```

- `pricing` absent entirely → all zeros (identical to today) **plus one
  `console.warn` per model id** naming the unpriced model. Fail-closed to $0,
  but loud — never a guessed price.
- Add `pricing?: VenicePricing` to the `VeniceModelSpec` interface
  (`{ input?: {usd?: number}; output?: {usd?: number}; cache_input?: {usd?: number}; cache_write?: {usd?: number} }`).
  All fields optional; non-finite/negative `usd` values are treated as absent
  (reuse the file's `coercePositiveNumber` shape — but allow fractional, so a
  small local guard, not `Math.floor`).

### 2. Thread it through discovery (both branches)

- Catalog-match branch (line ~718): `buildVeniceModelDefinition(catalogEntry)`
  currently bakes in `VENICE_DEFAULT_COST`; the discovery call site overrides
  with `cost: veniceCostFromPricing(apiModel.model_spec.pricing)` (same
  pattern as the existing `contextWindow`/`maxTokens` overrides).
- Non-catalog branch (line ~737): replace `cost: VENICE_DEFAULT_COST` with the
  same call.
- Static-catalog fallback (API down, line ~774): unchanged — stays $0 with the
  existing "using static catalog" warn. We do NOT hand-maintain ~40 price rows
  that Venice changes; the API is the source of truth.
- `VENICE_DEFAULT_COST` stays as the zero fallback constant; the stale comment
  at line 7 is updated to say pricing comes from the API and zero means
  "unpriced".

### Explicitly relying on (no changes)

- pi-ai `calculateCost` picks up `model.cost` from `models.json` → new turns
  persist real `usage.cost` into transcripts → `usage.report`, the dashboard
  report, the daily email, and `snapshot-usage` all show real numbers with
  **zero changes** to those layers.
- Unit consistency: Venice `usd` (per-M) → `ModelCost` (per-M) → pi-ai
  divides by 1M. No conversion constant anywhere.

## Trust-boundary impact (dashboard spend caps)

`openclaw-dashboard` `snapshotAllWorkspaces` feeds
`shouldSuspend(monthlyCostUsd, planLimitFor(plan).maxMonthlyUsd)`. Caps:
free **$5/mo**, builder **$100/mo**, scale/enterprise unlimited. Turning
pricing on makes these caps real for Venice workspaces for the first time.

- Measured: tal croll (builder) ≈ **$48/mo** at new prices (1.14M input×$6 +
  68k output×$30 + 3.9M cacheRead×$0.6 per week) → safely under $100.
- Risk: any Venice-primary **free** workspace burns its $5 cap fast →
  auto-suspend that reads as an outage.
- **Pre-rollout audit (required, blocking the fleet roll):** for each
  workspace, price its last-30-day `usage.report` tokens at the new rates and
  table it against its plan cap. Any workspace projected > 80% of cap goes to
  the owner for an explicit decision (plan bump, model change, or accept
  suspension) **before** the roll. This is an ops step in the impl PR
  checklist, not new code.
- Monthly accrual is delta-based per-day (`snapshotWorkspaceUsage` diffs
  today's report against today's earlier snapshot), so history stays $0 —
  no retroactive spend spike on roll day. Spend accrues at real rates only
  from post-roll turns.

## Invariants (attack these in review)

1. **Units:** every price is USD per million tokens end-to-end; a per-token or
   per-thousand mixup inflates costs 1,000,000× or 1,000×.
2. **Fail closed to zero, loudly:** missing/malformed pricing → cost 0 + warn.
   Never substitute a default or sibling-model price.
3. **Only `cost` changes.** No change to model ids, selection, fallbacks,
   `compat` (incl. `supportsUsageInStreaming`), context windows, or streaming
   behavior. A pricing fix must not be able to break inference.
4. **No retroactive billing:** stored transcript costs are never rewritten;
   monthly accrual only reflects post-roll turns.
5. **Suspension blast radius is enumerated before the roll**, not discovered
   after.

## Tests (vitest, extend `src/agents/venice-models.test.ts`)

- `veniceCostFromPricing`: full pricing → exact mapping (opus-4-6 fixture:
  6/30/0.6/7.5); missing `cache_input` → cacheRead = input rate (qwen3-5-9b
  fixture: 0.1/0.15/0.1/0); missing `cache_write` → 0; `pricing` absent →
  all-zero + warn called; negative/NaN/`usd` missing → treated as absent.
- Discovery (existing mocked-fetch tests): catalog-match model carries API
  pricing (not `VENICE_DEFAULT_COST`); non-catalog model likewise; API-failure
  fallback still returns catalog models with zero cost.
- Every hole Codex catches in review becomes a named case here (protocol §4).

## Deliberately NOT building

- **Historical re-pricing** of existing zero-cost transcript entries. The
  report-side fallback keys on `costTotal === undefined`; widening it to
  `=== 0` would also require a cost source in the report path (gateway
  `loadConfig()` doesn't include discovered implicit providers) and a
  breakdown-vs-total precedence change. Operator accepts $0 history.
- **Static catalog prices** (~40 hand-maintained rows that go stale).
- **DIEM/VCU credit accounting** — `usd` field only.
- **Dashboard daily-email window fix** (`days:1` = "UTC today so far", shows 0
  for yesterday-active agents) — separate one-line dashboard PR, different repo.
- **OB-16** (fallback on unresolvable primary) — tracked in bug_list.md.

## Sequencing

1. This plan PR → Codex adversarial review → fold revs → approve.
2. Impl PR: `venice-models.ts` + tests. Gate: vitest + typecheck + build.
3. Pre-rollout audit (ops step above); owner ack if any workspace > 80% cap.
4. Standard gateway image release; pin to `life` first, verify via a 1-turn
   smoke + `usage.report` probe (new turn shows `venice/... cost > 0`), then
   fleet roll.

## Risks

- **Stale-cache preservation:** `ensureAgentModelsJson` merge mode keeps the
  cached Venice provider when discovery returns fewer models than the file on
  disk (`models-config.ts:~123`) — a discovery timeout on boot leaves that
  agent's Venice costs at 0 until a later successful discovery. Accepted:
  self-heals on next good boot; post-roll verification on `life` catches it.
- **Venice reprices models:** costs update on every successful discovery, so
  they track the API automatically; between discoveries they can be briefly
  stale. Accepted for operator-visibility purposes.
- **`claude-opus-4-7-fast` is $36/$180 per M** — one EU agent (`onlyclaw`)
  runs it as primary. The audit in step 3 will price it precisely; expect this
  to be the workspace most likely to need an owner decision.
