# Capability-aware prompt context optimization

Related: https://github.com/openclaw/openclaw/issues/206424

## What Problem This Solves

OpenClaw can spend a substantial portion of its context window on its own bookkeeping rather than the conversation. On the tested route, historical runtime-context snapshots accumulate even when the latest snapshot already supplies the relevant information. Each snapshot also contains unnecessary operational metadata.

This creates a compounding problem: **redundant context → faster context growth → earlier context exhaustion → more frequent compaction, history rebuilding or session resets → potential cache loss and increased inference usage.** A warm cache does not eliminate the context-window capacity consumed by redundant tokens. Depending on the harness and provider, rewriting or resetting the cached prefix can make those tokens expensive to process again.

We have working solutions for both the accumulation of redundant snapshots and the size of the context that remains.

## User Impact — the win

| Live observation | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Sampled input tokens | 14,805 | 6,381 | **56.9%** |
| Mean input growth per short exchange | 1,080 | 211 | **80.5%** |
| Runtime metadata block, characters (subsequent experiment) | 405 | 57 | **85.9%** |

The first experiment reclaimed 8,424 input tokens in an existing session without deleting genuine conversation history. Recent-room recall passed. At the measured average growth rates, an equivalent remaining context budget could accommodate approximately five times as many short exchanges before reaching its limit, assuming other inputs stay constant.

The second experiment reduces the overhead of the runtime context that remains. Together, they address both prompt size and its rate of growth.

The benefit is more room for meaningful conversation and task context, with fewer context-limit interventions, better continuity, and fewer associated cache rebuilds expected. This is particularly important for smaller local models, but relevant to hosted models too.

## Why This Change Was Made

Two complementary working proofs of concept form the basis of this proposal:

1. [Transient Turn Context v0.1 plugin](https://github.com/Animeleague/openclaw/tree/bank/transient-turn-context-v0.1-2026-11-27/live-bank/2026-11-27-transient-turn-context-v0.1): prevents redundant historical runtime-context carriers from accumulating by retaining the current carrier through the existing provider replay-policy hook. No transcript deletion is required.
2. [Prompt optimization V3.1](https://github.com/Animeleague/openclaw/blob/bank/prompt-optimisation-v3.1-2026-11-27/live-bank/2026-11-27-prompt-optimisation-v3.1/README.md): reduces redundant metadata at its source and separates stable policy from changing facts. This is a scoped, version-pinned runtime overlay.

**We recommend installing and evaluating the plugin alongside V3.1 on a compatible test deployment, and ultimately integrating both optimizations into OpenClaw itself.** The plugin is an integral part of this work, not an optional reference. Follow its documented compatibility and installation precautions, including avoiding simultaneous installation with the original provider plugin.

The objective is not to make agents remember less. It is to stop making them repeatedly read information they already have or cannot use, while preserving attribution, chronology, reply semantics, trust boundaries, execution permissions and checkpoint compatibility.

## Evidence and limitations

November testing used OpenClaw 2026.11.10, Windows, local Gemma via openai-completions and tool-free Discord. Historical carriers fell from 6–9 to one. Derived warm-cache reuse decreased from 92.0% to 82.2%, and mean fresh tokens increased slightly from 1,092 to 1,216 in the first experiment. Subsequent metadata-experiment first-token times were approximately 97, 5 and 40 seconds; history changes and cache behavior confound these observations.

Related cache investigation: https://github.com/openclaw/openclaw/issues/202001. The renamed transient-context package is locally tested but not independently live-installed; the overlay is tied to exact compiled bundles. Current upstream source integration, regression tests, tool-enabled and cross-provider validation, rollback and controlled combined benchmarks remain outstanding.

This is a design proposal.

## Our track record: working solutions months before upstream

On August 10, 2026, we submitted [upstream PR #121683](https://github.com/openclaw/openclaw/pull/121683), addressing a related defect: switching between an owner and a non-owner changed the registered dynamic-tool schema, destabilizing Codex native-thread reuse and prompt caching. We separated the stable advertised tool catalog from actual per-turn execution permissions.

Our published live evidence demonstrated the same native thread and registered-tool fingerprint across six turns, including ownership changes. Non-owner turns retained 99.24% and 98.94% cache reuse without gaining privileged execution rights; across all six turns, cache reuse ranged from 98.30% to 99.83%, including an image turn.

On August 14, we also created our public [Transient Tools plugin](https://github.com/Animeleague/openclaw-plugin-transient-tools) to address persistent tool-history accumulation. Our August PR was closed without merging on September 3. Its live evidence came from an equivalent deployed patch, not the exact PR checkout.

### Upstream subsequently adopted the same architectural principle

On October 17, 2026 — **68 days after our submission** — upstream merged [PR #175309: fix prompt cache misses on completion, heartbeat and non-owner turns](https://github.com/openclaw/openclaw/pull/175309). Its production telemetry identified owner/non-owner tool-list changes as the most frequent raw cause of cache drops. Across all measured causes over 14 days, it reported 925 drops involving 101 million cached tokens on one deployment and 247 drops involving 25.8 million on another.

Its solution? Keep advertised tool definitions stable and enforce actual authority at execution time — the same architectural separation we demonstrated in August.

On November 26 — 108 days after our submission — [upstream PR #206126](https://github.com/openclaw/openclaw/pull/206126) was opened to address remaining Codex native-thread rotation from internal-turn tool-catalog drift, again separating the durable catalog from per-turn execution authority. It was not merged as of November 27.

**We had implemented, live-tested and published a solution in August. Upstream merged a fix based on the same principle in October.**

### Why today's work goes further

Our August fix stopped avoidable cache loss when tool permissions changed. Today's work tackles something more fundamental: unnecessary context growth on ordinary turns.

**Even if cached tokens were "free" (they aren't), context space isn't.** The faster we fill the context window, the sooner we force compaction or resets, potentially dropping the cache and driving up fresh-token usage. We've demonstrated an 80.5% reduction in context growth per short exchange.

## In summary: we have solutions, not just suggestions

We were right about separating durable model state from transient per-turn information in August. Today's work goes further: reducing context growth should reduce cache resets and fresh-token consumption, regardless of cached-token pricing.

We've been using the general transient-turn approach in our Discord deployments for months, with approximately threefold improvement in usage efficiency reported from our operational experience.

**We were ahead of upstream on this architectural principle in August. We have working solutions to share again today.**

If upstream chooses not to adopt them, that's fine. We will continue benefiting from and developing them ourselves. We're sharing this work because the wider OpenClaw community could benefit too.
