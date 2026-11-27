# Capability-aware prompt context optimization

Related: https://github.com/openclaw/openclaw/issues/206424

## The problem

OpenClaw spends model context on its own bookkeeping. Historical runtime-context snapshots accumulate even when a fresh snapshot already supplies the relevant information, and each snapshot contains redundant operational metadata. The two costs compound. Separate durable conversation and stable instructions from volatile per-turn information instead of making the model repeatedly process both.

## Two complementary solutions, demonstrated in live traffic

| Metric | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Sampled input tokens | 14,805 | 6,381 | 56.9% |
| Mean input growth per short exchange | 1,080 | 211 | 80.5% |
| Runtime metadata block (characters, subsequent experiment) | 405 | 57 | 85.9% |

- [Transient Turn Context v0.1 plugin](https://github.com/Animeleague/openclaw/tree/bank/transient-turn-context-v0.1-2026-11-27/live-bank/2026-11-27-transient-turn-context-v0.1): use the existing provider replay-policy hook to exclude historical typed runtime-context carriers while retaining the current carrier. Genuine conversation survives; recent-room recall passed.
- [Prompt optimization V3.1](https://github.com/Animeleague/openclaw/blob/bank/prompt-optimisation-v3.1-2026-11-27/live-bank/2026-11-27-prompt-optimisation-v3.1/README.md): reduce redundant metadata at its source and separate stable policy from changing facts.

The first limits accumulation; the second shrinks what remains. Preserve attribution, chronology, trust boundaries, tool permissions and checkpoint compatibility. No global removal of tool instructions or security policy is proposed.

## We had working solutions months ago

This is not hindsight. On August 10, 2026, we submitted [upstream PR #121683](https://github.com/openclaw/openclaw/pull/121683), addressing the fact that owner/non-owner tool permissions changed the durable registered-tool schema and destabilized Codex thread reuse. Our solution separated durable advertised tools from actual per-turn execution authority.

An equivalent live patch preserved the same native thread and registered-tool fingerprint over six turns, with 98.30–99.83% cache reuse; non-owner turns retained 99.24% and 98.94% without gaining privileged execution rights. The PR was closed without merging on September 3. On August 14 we also created the public [Transient Tools plugin](https://github.com/Animeleague/openclaw-plugin-transient-tools), addressing persistent tool-history accumulation.

### Upstream subsequently adopted the same principle

On October 17, 2026, **68 days after our submission**, upstream merged [PR #175309](https://github.com/openclaw/openclaw/pull/175309), explicitly addressing prompt-cache misses on non-owner turns. Its production telemetry identified owner/non-owner tool-list changes as the most frequent raw cause of cache drops. It kept tool definitions stable and enforced actual authority at execution time, the same architectural separation we demonstrated in August.

On November 26, 108 days after our submission, [upstream PR #206126](https://github.com/openclaw/openclaw/pull/206126) was opened to address remaining Codex native-thread rotation from tool catalog drift, again separating the durable catalog from per-turn execution authority. It was not merged as of November 27.

These public records establish the chronology and technical convergence, not code copying or identical implementations.

The point is not merely that we identified a problem in August. We had implemented solutions and published measured evidence more than three months before this proposal. Today's work applies the same architectural principle to another context surface: durable state should not be inflated or destabilized by transient information.

## Evidence boundaries

November tests used OpenClaw 2026.11.10, Windows, local Gemma, openai-completions and tool-free Discord. Warm-cache reuse decreased from 92.0% to 82.2% in the first experiment, and mean fresh tokens rose slightly from 1,092 to 1,216. Subsequent metadata-experiment first-token times were approximately 97, 5 and 40 seconds; history and cache changes confound those measurements. The reductions in the table are distinct measurements, not a combined speedup. No universal latency or cost guarantee is made.

The generic renamed transient-context package is locally tested but not independently live-installed. The V3.1 overlay is version-pinned. This draft changes no runtime behavior. Source integration, regression tests, tool-enabled and cross-provider validation, rollback and controlled combined benchmarks are still needed. Related cache investigation: https://github.com/openclaw/openclaw/issues/202001. This branch is based on upstream main and excludes unrelated fork changes and private recovery fixtures.

## In summary: we have solutions, not just suggestions

In August, we demonstrated a working solution to owner/non-owner cache instability. Sixty-eight days later, upstream merged a fix built on the same architectural principle. Today, we are presenting two further complementary optimizations backed by live results.

We've been using the general transient-turn approach in our Discord deployments for months, with an observed approximately threefold improvement in usage efficiency across our own operational experience, rather than a controlled benchmark of these two latest changes.

**We were ahead of upstream on this architectural principle in August. We have working solutions to share again today.**

If upstream chooses not to adopt them, that's fine. We will continue benefiting from and developing them ourselves. We're sharing this work because the wider OpenClaw community could benefit too.
