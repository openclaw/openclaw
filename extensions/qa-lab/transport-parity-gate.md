# Transport-parity gate (proposed)

Sibling to the existing model-parity gate (introduced in #74290, folded into
release validation by #74622). Tracks openclaw/openclaw#78457.

The existing gate compares **two different models** (`openai/gpt-5.5-alt`
vs `anthropic/claude-opus-4-7`). It answers "do these two models give
equivalent answers" — a product-level question for users choosing between
flagships.

This gate proposes comparing **the same logical model** across:

1. **Provider parity** — `openai/gpt-5.5` (raw OpenAI HTTP, requires
   `OPENAI_API_KEY`) vs `openai-codex/gpt-5.5` (ChatGPT OAuth via
   Responses WebSocket transport). Same model, completely different auth +
   transport + lineage code. Drift between the two is a transport-layer
   regression by definition.
2. **Runtime parity** — `pi` native runtime vs `codex` CLI subprocess
   harness for the same model+provider. Different tool-loop, different
   streaming surface, different memory wiring.

Together these two axes cover the regression class that produced
[openclaw/openclaw#78055](https://github.com/openclaw/openclaw/issues/78055)
(stale `response.completed` lineage on the openai-codex WS path),
[openclaw/openclaw#78060](https://github.com/openclaw/openclaw/issues/78060)
(implicit subagent fork on one runtime but not the other), and
[openclaw/openclaw#78407](https://github.com/openclaw/openclaw/issues/78407)
(doctor `--fix` silently flipping installs from `openai-codex/*` to
`openai/*` without a working auth path).

## Matrix shape

```
fixtures × ( openai-api-http × openai-codex-ws ) × ( pi × codex )
```

Per cell, run the existing character-eval / agentic-parity scenario inputs
already exercised by the qa-lab suite. Per scenario, assert:

- Final answer text is equivalent across all four cells, within the same
  tolerance the existing parity-report.test.ts uses.
- Gateway boot succeeds — no `FailoverError: No API key found for provider`
  in `gateway.err.log`.
- Trajectory is free of stale-finalization markers (#78055-class —
  duplicate `response.completed`, replayed final answers).
- Auth resolution at boot succeeds against the fixture's
  `auth-profiles.json`.

## Implementation hooks (TODO — separate PRs)

Reuse primitives already in this directory:

- `src/providers/mock-openai/server.ts` — extend with a second profile
  variant exposing the openai-codex Responses surface alongside the existing
  raw OpenAI surface (#74290 left this single-variant). Mock both auth
  paths so the gate runs without external API calls.
- `src/providers/shared/mock-model-config.ts` — register
  `openai-codex/gpt-5.5` alongside the existing `openai/gpt-5.5-alt`
  catalog entry.
- `src/qa-gateway-config.test.ts` — extend the gateway-boot test pattern
  with the four-cell matrix; existing helpers already sandbox
  `OPENCLAW_HOME`.
- New `src/transport-parity.ts` + `src/transport-parity.test.ts` —
  orchestrator that runs the matrix per fixture and produces a
  parity-report-style summary for CI consumption.
- New `src/runtime-parity.ts` — codex CLI sandbox; mirror the transport
  sandboxing pattern used in `qa-live-transports-convex.yml`.

CI wiring: add a step in `.github/workflows/openclaw-release-checks.yml`
(the home that #74622 folded the parity gate into), gated behind the same
`OPENCLAW_BUILD_PRIVATE_QA=1` build flag the existing parity tests use.

## Out of scope

- Cross-vendor model parity stays in the existing gate (#74290) and is not
  duplicated here.
- CLI surface / message-clarity bugs (#77221) — different test family.
