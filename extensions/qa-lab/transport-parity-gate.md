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
- `soak-100`: an optional 100-turn same-session soak for Testbox, scheduled, or
  manual runs only.

Every suite scenario declares `runtimeParityTier` in its `qa-scenario`
metadata. The resolver rejects missing or invalid tier membership so the gate
cannot silently drift.

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
