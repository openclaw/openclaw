---
doc-schema-version: 1
summary: "The `pnpm openclaw qa` subcommand table and the profile-backed `qa run` selector."
read_when:
  - You need to pick the right qa subcommand
  - You are choosing a QA profile for `qa run`
title: "Command surface"
---

## Command surface

Every QA flow runs under `pnpm openclaw qa <subcommand>`. Many have `pnpm qa:*`
script aliases; both forms work.

| Command                                             | Purpose                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qa run`                                            | Bundled QA self-check without `--qa-profile`; taxonomy-backed maturity profile runner with `--qa-profile smoke-ci`, `--qa-profile release`, or `--qa-profile all`.                                                                                                  |
| `qa suite`                                          | Run repo-backed scenarios against the QA gateway lane. `--runner multipass` uses a disposable Linux VM instead of the host.                                                                                                                                         |
| `qa coverage`                                       | Print the YAML scenario-coverage inventory (`--json` for machine output; `--match <query>` to find scenarios for a touched behavior; `--tools` for runtime tool fixture coverage).                                                                                  |
| `qa parity-report`                                  | Compare two `qa-suite-summary.json` files for a model-axis parity gate, or use `--runtime-axis --token-efficiency` to write Codex-vs-OpenClaw runtime parity and token-efficiency reports.                                                                          |
| `qa confidence-report`                              | Classify QA proof artifacts against a manifest into a zero-unknown confidence report.                                                                                                                                                                               |
| `qa confidence-self-test`                           | Write seeded negative-control canaries proving the confidence gate detects drift.                                                                                                                                                                                   |
| `qa jsonl-replay`                                   | Replay curated JSONL transcripts through the runtime parity replay harness.                                                                                                                                                                                         |
| `qa character-eval`                                 | Run the character QA scenario across multiple live models with a judged report. See [Reporting](/concepts/qa-e2e-automation/qa-reporting#reporting).                                                                                                                |
| `qa manual`                                         | Run a one-off prompt against the selected provider/model lane.                                                                                                                                                                                                      |
| `qa ui`                                             | Start the QA debugger UI and local QA bus (alias: `pnpm qa:lab:ui`).                                                                                                                                                                                                |
| `qa docker-build-image`                             | Build the prebaked QA Docker image.                                                                                                                                                                                                                                 |
| `qa docker-scaffold`                                | Write a docker-compose scaffold for the QA dashboard + gateway lane.                                                                                                                                                                                                |
| `qa up`                                             | Build the QA site, start the Docker-backed stack, print the URL (alias: `pnpm qa:lab:up`; `:fast` variant adds `--use-prebuilt-image --bind-ui-dist --skip-ui-build`).                                                                                              |
| `qa aimock`                                         | Start only the AIMock provider server.                                                                                                                                                                                                                              |
| `qa mock-openai`                                    | Start only the scenario-aware `mock-openai` provider server.                                                                                                                                                                                                        |
| `qa credentials doctor` / `add` / `list` / `remove` | Manage the shared Convex credential pool.                                                                                                                                                                                                                           |
| `qa buzz`                                           | Live transport lane against a real Buzz relay room with dedicated driver and SUT identities.                                                                                                                                                                        |
| `qa discord`                                        | Live transport lane against a real private Discord guild channel.                                                                                                                                                                                                   |
| `qa matrix`                                         | QA Lab Matrix catalog scenarios against a disposable Tuwunel homeserver. See [Matrix live lane](/concepts/qa-e2e-automation/operator-flow#matrix-live-lane).                                                                                                        |
| `qa slack`                                          | Live transport lane against a real private Slack channel.                                                                                                                                                                                                           |
| `qa telegram`                                       | Live transport lane against a real private Telegram group.                                                                                                                                                                                                          |
| `qa whatsapp`                                       | Live transport lane against real WhatsApp Web accounts.                                                                                                                                                                                                             |
| `qa mantis`                                         | Before/after verification runner for live transport bugs, with Discord status-reactions evidence, Crabbox desktop/browser smoke, and Slack-in-VNC smoke. See [Mantis](/concepts/mantis) and [Mantis Slack Desktop Runbook](/concepts/mantis-slack-desktop-runbook). |

### Profile-backed `qa run`

Profile-backed `qa run` reads membership from `taxonomy.yaml`, then dispatches
the resolved scenarios through `qa suite`. `--surface` and `--category` filter
the selected profile instead of defining separate lanes. The resulting
`qa-evidence.json` includes a profile scorecard summary with selected-category
counts and missing coverage IDs; the individual evidence entries remain the
source of truth for the tests, coverage roles, and results. Taxonomy feature
coverage IDs are exact proof targets, not aliases: primary scenario coverage
fulfills matching IDs, while secondary coverage stays advisory. Every coverage
ID is exactly `taxonomy-surface.feature`, using the short surface ID from
`taxonomy.yaml`. A scenario's separate `surface` field is an execution/reporting
label (for example, `channel` or `runtime-tool`); it does not define taxonomy
ownership. An explicit profile coverage ID selects every eligible primary owner
for that ID, deduplicated by scenario. Scenario file and taxonomy order do not
affect membership or execution order.

`scenario.execution.channels` is an OR eligibility list: a channel-specific
runner may execute the scenario on any one listed channel. Profile-backed
execution expands that same list across every channel supported by the selected
driver, and the profile run passes only when every expanded channel execution
passes. This applies uniformly to every taxonomy profile.

Slim evidence omits per-entry `execution` and sets `evidenceMode: "slim"`;
`smoke-ci` defaults to slim, and `--evidence-mode full` restores full entries:

```bash
pnpm openclaw qa run \
  --qa-profile smoke-ci \
  --category channels.conversation-routing-and-delivery \
  --provider-mode mock-openai \
  --output-dir .artifacts/qa-e2e/smoke-ci-profile-dispatch
```

Use `smoke-ci` for deterministic profile proof with mock model providers and
Crabline local provider servers. Use `release` for Stable/LTS proof against
live channels. Use `all` only for explicit full-taxonomy evidence runs; it
selects every active maturity category and can be dispatched through the `QA
Profile Evidence` GitHub Actions workflow with `qa_profile=all`. When a
command also needs an OpenClaw root profile, put the root profile before the
QA command:

```bash
pnpm openclaw --profile work qa run --qa-profile smoke-ci
```
