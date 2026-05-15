# Runtime, Harness, and Tool Parity Gate

This document is the implementation-facing contract for the QA-lab parity axis
that compares OpenClaw runtime behavior across Pi, Codex, prompt harnesses, and
tool surfaces. It is intentionally separate from the existing model-axis
agentic parity gate.

## Runtime Suites

`qa suite --runtime-pair pi,codex --runtime-suite <name>` expands stable suites
from `extensions/qa-lab/src/runtime-suite.ts`:

- `first-hour`: standard first-hour behavior coverage across channel replies,
  approval followthrough, model switching, memory, subagents, config restart,
  auth-profile selection, and Codex plugin lifecycle fixtures.
- `first-hour-20`: `first-hour` plus a required 20-turn same-session depth
  scenario for the maintainer release gate.
- `tool-defaults`: the 20 runtime tool fixtures under
  `qa/scenarios/runtime/tools/`, split into required default tools and
  optional/plugin-dependent tools by the tool coverage report.
- `openclaw-dynamic-tools`: the OpenClaw-owned dynamic integration tool subset
  used as the hard gate for Codex dynamic tool parity.
- `codex-native-live`: live/OAuth proof for Codex-owned workspace behaviors
  such as file reads/writes, edits, patches, exec, approval followthrough,
  compaction retry, and final-message streaming integrity.
- `fault-injection-mock`: mock-only retry/recovery rows for empty responses,
  reasoning-only responses, and deterministic Codex plugin install ordering.
- `fault-injection-live`: live gateway/config/cron/plugin/MCP/memory/channel
  recovery rows that require a real gateway process.
- `first-hour-live`: a live first-hour capability slice combining the standard
  first-hour rows with gateway restart, config restart, cron, plugin hot reload,
  MCP, memory fallback, and threaded follow-up coverage.
- `soak-100`: an optional 100-turn same-session soak for Testbox, scheduled, or
  manual runs only.

Every suite scenario declares `runtimeParityTier` in its `qa-scenario`
metadata. The resolver rejects missing or invalid tier membership so the gate
cannot silently drift.

## Confidence Gate

`qa confidence-report --manifest <profile.json> --artifact-root <dir>
--strict-zero-unknowns` classifies an uploaded proof bundle. The default profile
is `extensions/qa-lab/confidence-profiles/codex-100.json`.

Each lane must either pass or carry an explicit verdict:

- `pass`
- `product-bug`
- `qa-harness-bug`
- `fixture-bug`
- `optional-gap`
- `mock-limitation`
- `environment-blocked`

Strict mode fails on missing or failing artifacts that lack a verdict. This is
the "100% confidence" rule: zero unknowns in the defined matrix, not a claim
that every possible OpenClaw behavior was exhaustively proven.

`qa confidence-self-test` writes seeded negative-control canaries for prompt
drift, tool description/schema drift, tool-call drops, tool-result mismatch,
failure-mode drift, token-efficiency regression, and JSONL replay ordering
drift. These canaries prove the gate can catch issues without filing fake
product bugs.

## Harness Parity

`qa harness-parity` compares two harness profiles for the same model/scenario:

- `current`
- `prompt-overlay`
- `pi`
- `codex`

Each cell captures the runtime transcript, tool calls/results, normalized final
text, assistant-message usage, wall-clock time, and the session system prompt
report when present. The classifier distinguishes system prompt drift, tool
description drift, tool schema drift, tool-call drift, tool-result drift,
structural drift, text-only drift, and failure-mode drift.

`qa parity-report --harness-axis --summary <qa-harness-parity-summary.json>`
re-renders a saved harness-axis summary without rerunning the suite.

## Token Efficiency

Runtime and harness reports include token efficiency for every row:

- Live runs use `AssistantMessage.usage` captured into the normalized runtime
  cell.
- Mock runs emit algorithmic estimates from prompt, tool description/schema,
  transcript, and output byte counts. These rows are labeled `mock-estimate`
  and must not be treated as live token truth.

The report surfaces prompt chars, project-context chars, skill prompt chars,
tool summary chars, tool schema chars, transcript chars, tool counts, and the
first drift turn where available.

## CI Policy

Release checks run the `first-hour-20` runtime suite under `mock-openai` with
`OPENCLAW_BUILD_PRIVATE_QA=1`. Scheduled live checks run `first-hour` plus the
selected 20-turn depth row with live token usage. The 100-turn soak remains
available for Testbox, scheduled, or manual execution and is not part of the
default maintainer gate.
