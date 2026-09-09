---
doc-schema-version: 1
summary: "QA report and evidence artifacts, the character-eval judged report, and where each run writes them."
read_when:
  - You are reading a QA report or evidence file
  - You need the character-eval judged report format
title: "QA reporting"
---

## Reporting

`qa-lab` exports a Markdown protocol report from the observed bus timeline.
The report should answer:

- What worked
- What failed
- What stayed blocked
- What follow-up scenarios are worth adding

For the inventory of available scenarios - useful when sizing follow-up work
or wiring a new transport - run `pnpm openclaw qa coverage` (add `--json`
for machine-readable output). When choosing focused proof for a touched
behavior or file path, run `pnpm openclaw qa coverage --match <query>`. The
match report searches scenario metadata, docs refs, code refs, coverage IDs,
plugins, and provider requirements, then prints matching `qa suite
--scenario ...` targets. Generated commands preserve declared channel-driver
requirements and separate scenarios with different driver requirements. Without
a driver requirement, non-QA channels use `live` and `qa-channel` keeps its
default driver.

Every `qa suite` run writes top-level `qa-evidence.json`,
`qa-suite-summary.json`, and `qa-suite-report.md` artifacts for the selected
scenario set. Scenarios that declare `execution.kind: vitest` or
`execution.kind: playwright` run the matching test path and also write
per-scenario logs. Scenarios that declare `execution.kind: script` run the
evidence producer at `execution.path` through `node --import tsx` (with
`${outputDir}` and `${scenarioId}` expanded in `execution.args`); the
producer writes its own `qa-evidence.json`, whose entries are imported into
the suite output and whose artifact paths are resolved relative to that
producer `qa-evidence.json`. When `qa suite` is reached through `qa run
--qa-profile`, the same `qa-evidence.json` also includes the profile
scorecard summary for the selected taxonomy categories.

`qa confidence-report` keeps `productImpact` and `qaImpact` annotations in their
own Markdown table cells, collapsing whitespace for display. The JSON summary
preserves the annotation values, including internal line breaks.

Treat coverage output as a discovery aid, not a gate replacement; the
selected scenario still needs the right provider mode, live transport,
Multipass, Testbox, or release lane for the behavior under test. For
scorecard context, see [Maturity scorecard](/maturity/scorecard).

For character and style checks, run the same scenario across multiple live
model refs and write a judged Markdown report:

```bash
pnpm openclaw qa character-eval \
  --model openai/gpt-5.6-luna,thinking=medium,fast \
  --model openai/gpt-5.2,thinking=xhigh \
  --model openai/gpt-5,thinking=xhigh \
  --model anthropic/claude-opus-4-8,thinking=high \
  --model anthropic/claude-sonnet-4-6,thinking=high \
  --model zai/glm-5.1,thinking=high \
  --model moonshot/kimi-k2.5,thinking=high \
  --model google/gemini-3.1-pro-preview,thinking=high \
  --judge-model openai/gpt-5.6-sol,thinking=xhigh,fast \
  --judge-model anthropic/claude-opus-4-8,thinking=high \
  --blind-judge-models \
  --concurrency 16 \
  --judge-concurrency 16
```

The command runs local QA gateway child processes, not Docker. Character
eval scenarios should set the persona through `SOUL.md`, then run ordinary
user turns such as chat, workspace help, and small file tasks. The candidate
model should not be told that it is being evaluated. The command preserves
each full transcript, records basic run stats, then asks the judge models in
fast mode with `xhigh` reasoning where supported to rank the runs by
naturalness, vibe, and humor. Use `--blind-judge-models` when comparing
providers: the judge prompt still gets every transcript and run status, but
candidate refs are replaced with neutral labels such as `candidate-01`; the
report maps rankings back to real refs after parsing.

Candidate runs default to `high` thinking, with `medium` for GPT-5.6 Luna and
`xhigh` for older OpenAI eval refs that support it. Override a specific candidate
inline with `--model provider/model,thinking=<level>`; inline options also support
`fast`, `no-fast`, and `fast=<bool>`. `--thinking <level>` still sets a global
fallback, and the older `--model-thinking <provider/model=level>` form is kept for
compatibility. OpenAI candidate
refs default to fast mode so priority processing is used where the provider
supports it. Pass `--fast` only when you want to force fast mode on for
every candidate model. Candidate and judge durations are recorded in the
report for benchmark analysis, but judge prompts explicitly say not to rank
by speed. Candidate and judge model runs both default to concurrency 16.
Lower `--concurrency` or `--judge-concurrency` when provider limits or local
gateway pressure make a run too noisy.

When no candidate `--model` is passed, the character eval defaults to
`openai/gpt-5.6-luna`, `openai/gpt-5.2`, `openai/gpt-5`,
`anthropic/claude-opus-4-8`, `anthropic/claude-sonnet-4-6`, `zai/glm-5.1`,
`moonshot/kimi-k2.5`, and `google/gemini-3.1-pro-preview`. When no
`--judge-model` is passed, the judges default to
`openai/gpt-5.6-sol,thinking=xhigh,fast` and
`anthropic/claude-opus-4-8,thinking=high`.
