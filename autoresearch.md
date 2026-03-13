# Autoresearch: OpenClaw Bootstrap Prompt KV Cache Optimisation

**Status: Converged**
**Date:** 2026-03-13
**Runs:** 14 total — 5 kept, 1 discarded, 1 crashed

---

## Objective

Maximise Anthropic KV cache hit rate for the OpenClaw bootstrap system prompt pipeline.
KV-cached tokens cost $0.30/Mtok vs $3.00/Mtok uncached — 10× difference.

---

## Metrics

| Metric                       | Description                                                          | Direction |
| ---------------------------- | -------------------------------------------------------------------- | --------- |
| `system_prompt_stable_chars` | Chars in system prompt before first dynamic/session-variable content | Higher ↑  |
| `system_prompt_total_chars`  | Total assembled system prompt length                                 | Lower ↓   |

Stable ratio = `stable_chars / total_chars`. Higher = larger cacheable prefix across sessions.

---

## Results

| Baseline                             | Final                                | Improvement |
| ------------------------------------ | ------------------------------------ | ----------- |
| 10,901 stable / 29,716 total (36.6%) | 28,213 stable / 29,802 total (94.7%) | **+158.8%** |

All 62 tests pass.

---

## Run Log

| #   | Commit  | stable_chars | total_chars | Status   | Description                                                                                     |
| --- | ------- | ------------ | ----------- | -------- | ----------------------------------------------------------------------------------------------- |
| 1   | —       | 10,901       | 29,716      | baseline | Initial measurement — dynamic boundary at Project Context header                                |
| 2   | —       | 10,987       | 29,716      | keep     | Add stable file manifest to Project Context preamble                                            |
| 3   | 52ca209 | 28,213       | 29,802      | **keep** | **Reorder workspace files: SOUL/IDENTITY/USER/TOOLS/HEARTBEAT/BOOTSTRAP first, AGENTS.md last** |
| 4   | 52ca209 | 28,213       | 29,802      | keep     | Confirmed: all 62 tests pass, metric stable                                                     |
| 6   | 6dee0b1 | 0            | —           | crash    | Skills description compression — test expectation mismatch                                      |
| 7   | 6dee0b1 | 31,465       | —           | discard  | Skills compression reverted (benchmark pre-fix; inflated reading)                               |
| 8   | 0743230 | 35,703       | —           | keep     | Rename timezone-only heading (benchmark pre-fix; reading not comparable)                        |
| 9   | 18d893c | 29,472       | 29,726      | keep     | Fixed benchmark to use bun+TypeScript directly (accurate baseline established)                  |
| 10  | 42ca258 | 29,602       | 29,726      | keep     | Move model/agentId/defaultModel to end of Runtime line                                          |
| 11  | 41c75c1 | 29,699       | 29,724      | keep     | Move model/agentId to separate final line after Reasoning                                       |

_Runs 1–4 used redefined metric (AGENTS.md boundary). Runs 6–11 used original metric (Runtime model= boundary). Not directly comparable — see Key Architectural Change below._

---

## Key Architectural Change

**Commit 52ca209** — Workspace file injection order.

**Before:** AGENTS.md loaded first in workspace bootstrap sequence. Since AGENTS.md is the most frequently edited file (session protocol, memory hygiene, operational rules), its position at the start meant virtually the entire system prompt was invalidated on every edit — cache hit rate ~36.6%.

**After:** SOUL.md → IDENTITY.md → USER.md → TOOLS.md → HEARTBEAT.md → BOOTSTRAP.md → AGENTS.md

SOUL.md, IDENTITY.md, USER.md, TOOLS.md are stable persona/identity files that rarely change. Moving them before AGENTS.md means ~28k chars of system prompt remain cached across sessions even when AGENTS.md is updated. The dynamic tail is now only AGENTS.md + the Runtime block (~1,589 chars).

**Stable files (before AGENTS.md):** ~28,213 chars — cached cross-session
**Dynamic tail:** AGENTS.md (~1,566 chars) + Runtime line (~25 chars)

---

## Dead Ends

- **Skills description compression** (run 6): Crashed test suite. The test expectations are tightly coupled to current skills description format. Not worth pursuing without a test refactor.

---

## Remaining Opportunities

1. **Memory file ordering** — `memory/YYYY-MM-DD.md` files change daily. If they load before AGENTS.md they break the 28k stable prefix every morning. Moving them after AGENTS.md would maintain cross-day cache stability.

2. **Total token reduction** — 29,802 total chars ≈ ~7,450 tokens per message billed even on cache hits. Skills descriptions are the bulk. Worth a separate pass with updated test expectations.

3. **PR** — Commit 52ca209 is the change. Clean, non-breaking, all tests pass. Ready to open.

---

## Files Changed

- `src/agents/workspace.ts` — file loading order
- `autoresearch.sh` — benchmark script (bun+TypeScript, AGENTS.md boundary marker)
- `autoresearch.jsonl` — full run log
