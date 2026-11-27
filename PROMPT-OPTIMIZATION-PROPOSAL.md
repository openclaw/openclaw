# Capability-aware prompt context optimization

Related: https://github.com/openclaw/openclaw/issues/206424

## The problem

Our work focuses on optimizing OpenClaw for long-running, multi-user Discord conversations, particularly agents running local models with a 32k context window. Discord is our test environment, not a limit on the wider applicability of the architectural improvements. The measurements and performance targets below are specific to our conversational workload.

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

**The present work is more fundamental to context growth than our August owner/non-owner cache fix.** That earlier fix prevented avoidable cache invalidation when sender permissions changed. These two optimizations tackle unnecessary context accumulation on ordinary turns, even when the sender, permissions and tool catalog remain unchanged. A cache can be almost entirely warm and still contain thousands of redundant tokens occupying the context window. Unnecessary growth brings the agent to its context limit sooner, increasing pressure to compact, truncate or rebuild history and, depending on the harness, rotate or reset the session. These operations can disrupt cached prefixes and degrade conversational continuity. By preventing repeated snapshots from accumulating and shrinking the remaining metadata, we address both the size of the prompt and its rate of growth. This should also reduce avoidable context-limit interventions and associated cache rebuilds; their frequency has not yet been measured in a controlled long-running test. The August fix is evidence of our track record; the broader context-management improvements are the main contribution here. Their potential scope is greater, although comparative total usage savings across workloads have not been measured.

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

In August, we demonstrated a working solution to owner/non-owner cache instability. Sixty-eight days later, upstream merged a fix built on the same architectural principle. Today, we are presenting two complementary optimizations that go further: they address the growth and size of the context itself, rather than only cache invalidation triggered by changes in tool authority.

We've been using the general transient-turn approach in our Discord deployments for months, with an observed approximately threefold improvement in usage efficiency across our own operational experience, rather than a controlled benchmark of these two latest changes.

**We were ahead of upstream on this architectural principle in August. We have working solutions to share again today.**

If upstream chooses not to adopt them, that's fine. We will continue benefiting from and developing them ourselves. We're sharing this work because the wider OpenClaw community could benefit too.

## Our manifesto: human-level conversational intelligence and memory within 32k

Our goal is a capable OpenClaw agent participating in ordinary, multi-user Discord conversation on consumer hardware. These engineering targets are for short conversational exchanges, not coding, research or tool-heavy workflows. The broader context-optimization principles can benefit other OpenClaw deployments, but their token budgets will differ.

- **32,768-token context window:** remain useful within this budget, rather than relying on ever-larger windows.
- **Under 100 tokens of average net prompt growth per ordinary short chat exchange:** preserve genuine conversation, not repeated bookkeeping.
- **Under 500 fresh input tokens per typical warm short-chat request:** reuse stable context and minimize unnecessary prefill.
- **Remove the fluff from bootstraps:** omit redundant or irrelevant instructions and metadata when they are not needed, while preserving useful capabilities and security boundaries.
- **Long-term memory:** retrieve relevant facts and past interactions on demand rather than replaying the entire conversation.
- **Human-level conversational judgment:** remember relevant details, distinguish speakers, and know when to speak or stay silent.

These are proposed targets, not achieved benchmarks. Bigger context windows are not a substitute for better context engineering.
