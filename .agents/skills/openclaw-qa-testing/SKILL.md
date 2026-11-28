---
name: openclaw-qa-testing
description: Run, watch, debug, extend, or explain OpenClaw qa-lab and qa-channel scenarios, artifacts, and live lanes.
---

# OpenClaw QA Testing

Use this skill for `qa-lab` / `qa-channel` work. Repo-local QA only.

## Read first

- `docs/concepts/qa-e2e-automation.md`
- `docs/help/testing.md`
- `docs/channels/qa-channel.md`
- `qa/README.md`
- `qa/scenarios/index.yaml`
- `extensions/qa-lab/src/suite.ts`
- `extensions/qa-lab/src/character-eval.ts`

## Model policy

- Normal live suite runs rely on QA Lab source- and auth-aware defaults.
- Do not pass `--model`, `--alt-model`, or `--fast` by default. Omitted
  `--fast` does not mean fast is disabled; fast behavior is source-owned.
- For scenario-specific runs, the complete `execution.summary` is authoritative
  and overrides generic default guidance, including when it requires other
  flags. Add explicit provider/model pins only when
  `execution.config.requiredProvider` or `requiredModel` requires them.

## Default workflow

1. Read the scenario pack and current suite implementation.
2. Decide lane:
   - mock/dev: `mock-openai`
   - real validation: `live-frontier`
3. For a normal live suite, use:

```bash
pnpm openclaw qa suite \
  --provider-mode live-frontier \
  --output-dir .artifacts/qa-e2e/run-all-live-frontier-<tag>
```

4. Watch outputs:
   - summary: `.artifacts/qa-e2e/run-all-live-frontier-<tag>/qa-suite-summary.json`
   - report: `.artifacts/qa-e2e/run-all-live-frontier-<tag>/qa-suite-report.md`
5. If the user wants to watch the live UI, find the current `openclaw-qa` listen port and report `http://127.0.0.1:<port>`.
6. If a scenario fails, fix the product or harness root cause, then rerun the full lane.

## OTEL smoke

For local QA-lab OpenTelemetry validation, use:

```bash
pnpm qa:otel:smoke
```

This starts a local OTLP/HTTP trace receiver, runs the `otel-trace-smoke`
scenario through qa-channel, decodes the emitted protobuf spans, and verifies
the exported trace names and privacy contract. It does not require Opik,
Langfuse, or external collector credentials.

## QA credentials and 1Password

Before any QA secret lookup or credential-backed lane, read
[QA credentials and 1Password](references/credentials.md) in full. It owns
tmux-only secret access, approved references, Convex roles, and missing-reference
handling. A dispatch does not provision credentials or bypass a refusal.

## WhatsApp live credentials

For WhatsApp credential setup, replacement, or session recovery, read
[WhatsApp live credentials](references/whatsapp-credentials.md) in full, after the
shared [QA credential requirements](references/credentials.md). Keep live account
and credential material out of the repository and proof artifacts.

## Character evals

For style, persona, or vibe comparisons, read [character evals](references/character-evals.md)
in full before choosing models, building the QA lane, or writing scenarios.
The reference owns candidate/judge defaults, source-build requirements, scenario
format, and persona setup.

## Codex CLI model lane

When QA should use Codex as its model backend, read the
[Codex CLI model lane](references/codex-cli.md) in full before running the suite,
manual QA, or character evals. Keep the concrete model name as user/config input;
the reference also covers live versus mock environment handling and auth triage.

## Repo facts

- Seed scenarios live in `qa/scenarios/index.yaml` and
  `qa/scenarios/<theme>/*.yaml`.
- Main live runner: `extensions/qa-lab/src/suite.ts`
- QA lab server: `extensions/qa-lab/src/lab-server.ts`
- Child gateway harness: `extensions/qa-lab/src/gateway-child.ts`
- Synthetic channel: `extensions/qa-channel/`

## What “done” looks like

- Full suite green for the requested lane.
- User gets:
  - watch URL if applicable
  - pass/fail counts
  - artifact paths
  - concise note on what was fixed

## Common failure patterns

- Live timeout too short:
  - widen live waits in `extensions/qa-lab/src/suite.ts`
- Discovery cannot find repo files:
  - point prompts at `repo/...` inside seeded workspace
- Subagent proof too brittle:
  - prefer stable final reply evidence over transient child-session listing
- Harness “rebuild” delay:
  - dirty tree can trigger a pre-run build; expect that before ports appear

## When adding scenarios

- Add or update scenario YAML under `qa/scenarios/`; do not add `.md` scenario
  files or fenced YAML blocks.
- Keep kickoff expectations in `qa/scenarios/index.yaml` aligned
- Add executable coverage in `extensions/qa-lab/src/suite.ts`
- Prefer end-to-end assertions over mock-only checks
- Save outputs under `.artifacts/qa-e2e/`
