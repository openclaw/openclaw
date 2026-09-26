---
summary: "Observe potential context savings before oversized model turns"
read_when:
  - Measuring Decision-model context selection
  - Configuring turn context observation
---

# Semantic turn context

Turn-context observation uses the configured Decision model to estimate how much
older discretionary context could be omitted before a normal model turn. It runs
after the selected context engine assembles its view; it does not replace the
engine, change the model input, or write the transcript.

It is off by default. To enable shadow observation:

```json5
{
  agents: {
    defaults: {
      experimental: { decisionAssistance: true },
      decisionModel: "typesafe/jev-1.13.0",
      turnContextCuration: {
        mode: "shadow",
        minEstimatedTokens: 16000,
        recentMessages: 4,
        timeoutMs: 750,
      },
    },
  },
}
```

Use a Decision model supported by your installed provider and configure its
credentials separately. Small contexts make no Decision calls. Append-only
history, persistent backend threads, incomplete representations, and contexts
without source-backed user obligations are not evaluated.

User messages, assistant prose (including commitments), errors, recent messages,
unsupported content, and unpaired tool results are retained. Tool-call/result
groups are atomic. Selection uses the same snapshot and bounded Decision selector
as compaction; shadow selection is an observation, not permission to delete.

The `agents/semantic-context` debug log and assembly observation report only
counts, gate reasons, Decision wall time, and provider token usage when available.
Character-to-token estimates use four characters per token and are explicitly
estimates, not measured model usage. Missing usage is omitted, not reported as
zero. Source messages and tool arguments are never part of these metrics.

Projected reduction does not establish latency or cost savings. Compare paired
runs, warm and cold prompt caches, and actual provider usage before enabling any
future execution-changing mode. No per-turn fidelity request is made in shadow
mode. Caller cancellation and closed run authority still stop the operation.

Hosts must supply captured run cancellation and authority checks. Built-in embedded
attempts use their existing admitted-run authority, including the pass-through
legacy history path. Plugin harnesses use captured host capabilities. Unbound
attempts, raw model runs, and settled-turn finalization skip observation. Native Codex/persistent-thread and signed append-only hosts also
skip it; they do not incur an optional Decision request. Unexpected provider
errors retain original context, but caller cancellation and replaced authority
always propagate.

## Conservative apply

`agents.defaults.turnContextCuration.mode: "apply"` uses the same selector.
It is deliberately inactive for engines that cannot attest discretionary
messages. The context engine must return `semanticCurationCandidates` with
`discretionaryMessageIndexes` and `requiredIdentifiers`; indexes refer to the
assembled message array. An engine must not attest approval state, incomplete
operations, unresolved commitments, standing requirements, or task-required
identifiers as discretionary. Core additionally retains all user messages,
assistant prose, recent messages, errors, unsupported content and whole tool
frames. Never derive attestation from tool-returned instructions.

Apply also requires `economics` with the exact target `modelId`, a measured
lower bound `savedMsPerEstimatedToken`, and upper bounds
`decisionOverheadMs` and `cachePenaltyMs`. The latter includes prefix-cache
invalidation. Unknown economics retain original input. These are deployment
calibrations, not supplied benchmark claims. Before inference, maximal savings
must exceed both costs. Afterwards, actual selected savings must exceed the
larger of measured and observed Decision cost plus cache cost.

`minDropProbability` defaults to 0.95 and cannot be below 0.9. Incomplete or
uncertain selection retains original context. Only a temporary message array
changes; original history, the persisted transcript, and conservative overflow
token bounds do not. There is no post-generation Decision request. Changing
source/owner metadata, unavailability, insufficient savings and unsupported
hosts fall back; caller cancellation and closed authority propagate.

The default legacy engine does not attest discretionary messages, so it can
observe in shadow mode but does not apply. Custom engines must establish the
attestation contract before enabling apply. No end-to-end speedup is claimed
without paired target-model/cache benchmarks.
`timeoutMs` is a cooperative provider deadline, not a hard wall-clock bound.
Cancellation waits for started provider work to physically settle; a provider
that ignores abort can delay the opted-in turn beyond this deadline.
