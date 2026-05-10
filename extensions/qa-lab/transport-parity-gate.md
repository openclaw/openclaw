# Transport-parity & runtime-parity gate (design)

Tracks #80171 (Codex-vs-Pi runtime parity QA harness — RFC).

The existing model-axis parity gate (introduced in #74290, folded into
release validation by #74622, baseline kept current by #79347) compares
**two different models** — `gpt-5.5` vs `claude-opus-4-7` — answering
"do these flagships give equivalent answers". That's a product-level
question for users choosing between vendors.

This document covers two **orthogonal** gates that share most of the
existing parity machinery but answer different questions:

1. **Transport-parity** — `openai/gpt-5.5` (raw OpenAI HTTP, requires
   `OPENAI_API_KEY`) vs `openai-codex/gpt-5.5` (ChatGPT OAuth via the
   Responses WebSocket transport). Same model, completely different auth +
   transport + lineage code. Drift between the two is a transport-layer
   regression by definition.
2. **Runtime-parity** — `pi` native runtime vs `codex` CLI subprocess
   harness for the same model+provider. Different tool-loop, different
   streaming surface, different memory wiring. **This is the higher-value
   gate** because the announcement makes Codex the default for OpenAI
   turns, and the Pi-built tool surface has known regressions when the
   runtime axis flips (see #78055, #78060, #78407, #78499 cluster).

Together these two axes cover the regression class that produced
#78055 (stale `response.completed` lineage on the openai-codex WS path),
#78060 (implicit subagent fork on one runtime but not the other), and
#78407 (doctor `--fix` silently flipping installs from `openai-codex/*`
to `openai/*` without a working auth path).

Sibling proposal #78457 originally framed transport-parity alone; this
doc supersedes that scope by adding the runtime axis and the per-tool /
plugin-lifecycle / token-efficiency dimensions the maintainer thread
asked for.

## Matrix shape

```
scenarios × runtimes × plugin-states × auth-shapes × provider-mode
```

| Axis          | Values                                                                                 | Purpose                                            |
| ------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| scenarios     | per-tool fixtures (#80173) + jsonl replay (#80176) + existing agentic-parity scenarios | What the agent is asked to do                      |
| runtimes      | `pi`, `codex`                                                                          | The "primary subject" — same model, forced runtime |
| plugin-states | `codex-missing`, `codex-pinned-old`, `codex-current`, `codex-head`                     | Codex-as-plugin lifecycle (#80174)                 |
| auth-shapes   | `oauth-only`, `apikey-only`, `mixed-profiles`                                          | Catches auth-selection bugs (#78499 class)         |
| provider-mode | `mock-openai` (hermetic, default), `live-frontier` (real, gated)                       | Cost/speed vs realism trade-off                    |

Full Cartesian is huge. Hermetic on-PR runs use a small subset
(`mock-openai × current-codex × oauth-only` across the per-tool fixtures)
to keep `<5min` total. Full live matrix runs on schedule, gated behind
`OPENCLAW_BUILD_PRIVATE_QA=1`.

## Per-cell capture

For every cell:

- `transcript-bytes` — full JSONL of the turn chain.
- `tool-calls[]` — ordered list of `{ tool, argsHash, resultHash, errorClass? }`.
- `final-text` — assistant final answer text, normalized.
- `usage` — `{ inputTokens, outputTokens, totalTokens, cacheRead?, cacheWrite? }`,
  captured at the assistant-message level (not transport level — shapes differ).
- `wall-clock-ms`, `transport-error-class?`, `runtime-error-class?`.
- `boot-state` — `gateway.err.log` lines around `FailoverError`,
  `No API key found`, `Codex app-server`, etc.

## Drift classifier

When transcripts differ between the `pi` and `codex` cells of the same
scenario, classify into one of:

- `text-only` — final answers differ in wording but mean the same thing
  (within the same tolerance the existing
  `agentic-parity-report.test.ts` rubric uses).
- `tool-call-shape` — different tools called, different arg shapes,
  different ordering.
- `tool-result-shape` — same tool called but result interpreted
  differently.
- `structural` — different turn count or phase structure, missing/extra
  final answer.
- `failure-mode` — one cell errors, the other doesn't. Always blocking.

The drift category becomes the triage key — `failure-mode` is P1,
`structural` is P1-P2, `tool-call-shape` is P1-P2 by tool family,
`text-only` within tolerance is allowed.

## Implementation hooks

Reuse primitives already in this directory; the new code is additive:

- `src/providers/mock-openai/server.ts` — extend with a second profile
  variant exposing the openai-codex Responses surface alongside the
  existing raw OpenAI surface (#74290 left this single-variant). Mock
  both auth paths so the gate runs without external API calls.
- `src/providers/shared/mock-model-config.ts` — register
  `openai-codex/gpt-5.5` alongside the existing `openai/gpt-5.5-alt`
  catalog entry.
- `src/qa-gateway-config.test.ts` — extend the gateway-boot test pattern
  with the four-cell matrix; existing helpers already sandbox
  `OPENCLAW_HOME`.
- New `src/runtime-parity.ts` (Phase 1, #80172) — orchestrator that
  runs a scenario through both runtimes and produces a parity-report-
  style summary. Includes the drift classifier.
- New `qa/scenarios/runtime/tools/<tool>.md` (Phase 2, #80173) — one
  fixture per tool family; harness asserts per-tool drift, not just
  per-scenario.
- New `src/codex-plugin-fixture.ts` (Phase 3, #80174) — seeds the codex
  plugin to a known version (or absent) before each cell; codifies
  `@ai-hpc`'s manual 4-cell migration matrix.
- New `src/token-efficiency-report.ts` (Phase 4, #80175) — side-by-side
  per-runtime cost report. Live mode only.
- New `src/jsonl-replay.ts` (Phase 5, #80176) — replays curated real
  session transcripts through both runtimes; surfaces the earliest
  divergent turn per transcript.

## CI wiring

Add a step in `.github/workflows/openclaw-release-checks.yml` (the home
that #74622 folded the parity gate into), gated behind the same
`OPENCLAW_BUILD_PRIVATE_QA=1` build flag the existing parity tests use.
The runtime-parity lane runs in parallel with the existing model-axis
parity lane. Token-efficiency report wires into the nightly cron in
`.github/workflows/qa-live-transports-convex.yml` rather than every
release, since live-mode runs are slow and expensive.

## Out of scope (here; tracked elsewhere)

- Cross-vendor model parity stays in the existing model-axis gate
  (#74290 / #79347).
- CLI surface / message-clarity bugs like #77221.
- Real-customer transcript ingestion — the JSONL replay phase (#80176)
  ships with curated fixtures only.
- iOS / mobile replay parity — separate harness if needed.

## References

- Master RFC + tracking: #80171
- Phase 1 — Runtime axis: #80172
- Phase 2 — Per-tool fixture set: #80173
- Phase 3 — Codex-plugin lifecycle: #80174
- Phase 4 — Token-efficiency report: #80175
- Phase 5 — JSONL replay: #80176
- Sibling model-axis parity: #74290 → #79347
- Original transport-parity proposal: #78457
- Closed #78512 (this doc was originally drafted there; lifted forward)
- Bug cluster motivating: #78055, #78060, #78407, #78499
