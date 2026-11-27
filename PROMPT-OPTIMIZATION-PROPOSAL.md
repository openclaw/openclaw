# Capability-aware prompt context optimization

Related: https://github.com/openclaw/openclaw/issues/206424

## The problem

Our focus is optimizing long-running, multi-user Discord conversations in OpenClaw, particularly with 32k local models on consumer hardware. The principles apply more broadly.

Historical runtime-context snapshots accumulate unnecessarily, and each contains redundant metadata. Even when cached tokens are free, they occupy valuable context space.

**Unnecessary context growth → earlier compaction or resets → potential cache loss → increased fresh-token consumption.**

## The win

| Live observation | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Sampled input tokens | 14,805 | 6,381 | **56.9%** |
| Mean input growth per short exchange | 1,080 | 211 | **80.5%** |
| Runtime metadata characters (separate experiment) | 405 | 57 | **85.9%** |

We reclaimed 8,424 input tokens without deleting genuine conversation history; recent-room recall passed. At the observed growth rates, the same remaining context budget could accommodate approximately five times as many short exchanges, assuming other inputs stay constant.

## Two working solutions

1. [Transient Turn Context v0.1](https://github.com/Animeleague/openclaw/tree/bank/transient-turn-context-v0.1-2026-11-27/live-bank/2026-11-27-transient-turn-context-v0.1): retains the current runtime-context carrier instead of replaying obsolete snapshots, using the existing provider replay-policy hook.
2. [Prompt optimization V3.1](https://github.com/Animeleague/openclaw/blob/bank/prompt-optimisation-v3.1-2026-11-27/live-bank/2026-11-27-prompt-optimisation-v3.1/README.md): reduces redundant metadata at its source and separates stable policy from volatile facts.

**We recommend installing and evaluating the plugin alongside V3.1 on a compatible test deployment, with the aim of integrating both into OpenClaw upstream.** Follow the documented installation precautions; do not install competing provider plugins together.

Preserve genuine conversation, attribution, chronology, reply semantics, trust boundaries, execution permissions and checkpoint compatibility. Remove unnecessary context, not useful capabilities.

## Our track record

- **August 10, 2026:** We submitted [PR #121683](https://github.com/openclaw/openclaw/pull/121683), separating stable advertised tools from per-turn execution permissions. An equivalent live patch preserved the native thread across six turns, with 98.30–99.83% cache reuse, including owner/non-owner transitions and an image turn. The PR was closed without merging on September 3.
- **August 14:** We published our [Transient Tools plugin](https://github.com/Animeleague/openclaw-plugin-transient-tools), addressing persistent tool-history accumulation.
- **October 17:** Upstream merged [PR #175309](https://github.com/openclaw/openclaw/pull/175309), adopting the same separation of advertised tools from execution authority, **68 days after our submission.** Its telemetry identified owner/non-owner tool-list changes as the most frequent raw cause of cache drops. Across all measured causes over 14 days, two deployments reported 925 and 247 drops involving 101 million and 25.8 million cached tokens respectively.
- **November 26:** [PR #206126](https://github.com/openclaw/openclaw/pull/206126) applied the same principle to remaining Codex thread-rotation issues; it was unmerged as of November 27.

The public records establish technical convergence, not code copying or identical implementations.

## Why today's work goes further

Our August fix addressed cache invalidation when tool authority changed. Today's optimizations address context growth even when nothing changes in the tool catalog. Slower growth should mean fewer context-limit interventions, fewer cache rebuilds and lower fresh-token consumption, even where cached tokens are free.

We've used the general transient-turn approach in our Discord deployments for months, with approximately threefold improvement in usage efficiency reported from operational experience. This is not a controlled benchmark of the two November changes.

## Evidence and limitations

November tests used OpenClaw 2026.11.10, Windows, local Gemma (openai-completions) and tool-free Discord. Historical carriers fell from 6–9 to one. In the first experiment, derived warm-cache reuse fell from 92.0% to 82.2%, while mean fresh tokens rose from 1,092 to 1,216. The separate V3.1 experiment had variable first-token times (approximately 97, 5 and 40 seconds). Combined latency, reset frequency and long-term fresh-token savings remain unmeasured.

The renamed plugin passed local tests but has not been independently live-installed; V3.1 is version-pinned. Upstream integration, cross-provider and tool-enabled regression tests, and rollback validation remain necessary. Related: https://github.com/openclaw/openclaw/issues/202001.

## Conclusion

**We demonstrated a working solution in August, 68 days before upstream merged a fix based on the same principle. Today we have two further working optimizations targeting a more fundamental problem: unnecessary context growth and its impact on token consumption.**

We're sharing these solutions because the wider OpenClaw community could benefit. We'll continue developing and using them regardless of upstream adoption.

This is a draft design proposal, not a merge-ready runtime patch. The branch contains only the proposal document, based on upstream main.
