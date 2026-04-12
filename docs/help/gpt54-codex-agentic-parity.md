# GPT-5.4 / Codex agentic parity in OpenClaw

OpenClaw already worked well with tool-using frontier models, but GPT-5.4 and Codex-style sessions still showed the same practical gaps over and over:

- the model could stop after planning instead of doing the work
- strict tool schemas could create avoidable friction
- `/elevated full` guidance could be wrong for the actual runtime
- replay and compaction failures could feel like the task silently disappeared
- parity claims against Claude Opus 4.6 were mostly anecdotal
- repo instructions like `AGENT.md` or `SOUL.md` could be read without being followed

The merged foundation work solved the first half of that problem:

- PR A made plan-only completion fail closed instead of being silently accepted
- PR B made provider/runtime failures and full-access guidance truthful
- PR C improved tool compatibility and replay/liveness surfacing
- PR D shipped the first-wave parity harness and report

This closeout keeps the remaining work legible as **two PRs**:

- **Runtime Completion Rollup**
- **Parity Proof Rollup**

## What the runtime rollup fixes

The runtime rollup is the final runtime answer to the original GPT-5.4 complaint.

It makes the strict-agentic contract the automatic default for GPT-5-family `openai` and `openai-codex` runs, keeps the retry guard on the same matcher, and emits explicit blocked/replay metadata when the model cannot continue.

The user-facing effect is:

- GPT-5.4 does not stop at a good plan when the next action is feasible
- GPT-5.4 asks for permission less often because the runtime expects act-or-block behavior by default
- blocked or replay-unsafe exits stay explicit instead of looking like a vague completion

## What the parity proof rollup fixes

The parity proof rollup is the proof and release-certification answer.

It combines the second-wave scenario pack, tool-call enforcement, Anthropic mock support, self-describing summary artifacts, mock auth staging, and the docs/runbook.

That rollup does three important things:

1. It expands the parity pack from 10 scenarios to **11** by adding a direct instruction-followthrough scenario.
2. It makes tool-mediated scenarios prove real tool use instead of accepting plausible prose.
3. It lets the parity gate run offline against both provider lanes before we do the final live proof.

## The parity pack

The parity pack now covers these scenarios:

- `approval-turn-tool-followthrough`
- `model-switch-tool-continuity`
- `source-docs-discovery-report`
- `image-understanding-attachment`
- `compaction-retry-mutating-tool`
- `subagent-handoff`
- `subagent-fanout-synthesis`
- `memory-recall`
- `thread-memory-isolation`
- `config-restart-capability-flip`
- `instruction-followthrough-repo-contract`

The new instruction-followthrough scenario exists because it was part of the original problem statement, not optional polish. It checks that the model:

- reads a seeded repo-instruction file first
- follows a required tool sequence
- keeps going through a bounded multi-step task
- does not stop after a plan
- does not bounce back for permission before the first feasible action

## Mock structural gate vs live proof

We use two different proof modes on purpose.

### Mock structural gate

The workflow in `.github/workflows/parity-gate.yml` is the **mock structural gate**.

It verifies:

- scenario registration
- tool-call assertions
- parity report generation
- offline OpenAI and Anthropic mock routing
- machine-readable summary provenance

This is the fast, reproducible CI-safe gate.

### Live-frontier proof

The final product claim still depends on a **live-frontier** comparison:

- candidate: GPT-5.4 / Codex lane
- baseline: Opus 4.6 lane

That run uses the same parity pack and the same report generator, but real providers instead of the mock server.

## How this was verified

Local verification for the closeout work included:

- runtime contract regressions for strict-agentic activation and blocked exits
- parity-report regressions for required-scenario handling, provenance, and fake-success detection
- scenario-catalog regressions for tool-call enforcement and mock-only debug assertions
- mock-server regressions for Anthropic `/v1/messages`, streaming, remember prompts, and exact-reply precedence
- summary artifact regressions for `qa-suite-summary.json` provenance
- actionlint for the parity workflow

The broader evidence we already have is:

- **live GPT-5.4 harness pass:** 10/10 on the full live pack
- **offline structural parity rerun:** pass with both provider lanes green and the parity report green end to end

The remaining live release claim still depends on a successful live Opus baseline run when Anthropic provider access is stable.

## Reading the parity verdict

The release gate writes two canonical artifacts:

- `qa-agentic-parity-report.md`
- `qa-agentic-parity-summary.json`

`qa-agentic-parity-summary.json` is the final machine-readable decision.

`pass` means:

- no required scenario is missing, skipped, or failed
- GPT-5.4 does not regress on completion rate
- GPT-5.4 does not regress on unintended stops
- GPT-5.4 does not regress on valid tool-call rate
- fake-success count is zero

`fail` means at least one of those hard gates tripped.

## What this changes for users

Before this work, GPT-5.4 could feel less agentic than Opus because OpenClaw tolerated a few behaviors that are especially harmful for GPT-5-style models.

After the full closeout:

- the runtime expects real progress by default
- tool use is easier to complete and easier to audit
- full-access guidance is truthful
- blocked and replay-unsafe outcomes are explicit
- parity claims are evidence-backed instead of anecdotal
- repo instructions are tested as a real success criterion
