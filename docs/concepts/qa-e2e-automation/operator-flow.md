---
doc-schema-version: 1
summary: "Bring up QA Lab and run the observability, Matrix, Discord Mantis, Slack desktop, and credential-pool lanes."
read_when:
  - You are running a QA lane end to end
  - You need the Matrix live lane or a Mantis runner
title: "Operator flow"
---

## Operator flow

The current QA operator flow is a two-pane QA site:

- Left: Gateway dashboard (Control UI) with the agent.
- Right: QA Lab, showing the Slack-ish transcript and scenario plan.

Run it with:

```bash
pnpm qa:lab:up
```

That builds the QA site, starts the Docker-backed gateway lane, and exposes
the QA Lab page where an operator or automation loop can give the agent a QA
mission, observe real channel behavior, and record what worked, failed, or
stayed blocked.

The Runner's Scenarios panel can launch flow, Playwright, Vitest, and script
catalog entries together. **Profile** uses the taxonomy-owned membership plan;
checking scenarios creates an explicit override, while **Profile** in the
Scenarios panel returns to server-resolved profile membership.

Config also exposes **Provider lane**, primary and alternate models,
**Execution channel**, **Channel driver**, **Evidence mode**, **Runtime pair**,
and **Runtime-pair lane** (`core`, `extended`, or `soak`). Provider/model,
runtime, and channel-driver choices remain independent: for example, Real
frontier providers can use the Crabline channel driver, and Synthetic (mock) can
use Real channels. The server resolves taxonomy membership, provider/model
eligibility, declared `execution.channel`, runtime-pair-lane membership, and
supported execution kinds before launch. The Run panel shows the selected
execution kinds plus explicit exclusions or errors. Unknown, empty explicit,
profile-incompatible, or lane-incompatible selections fail closed instead of
being replaced by a default suite.

For faster QA Lab UI iteration without rebuilding the Docker image each time,
start the stack with a bind-mounted QA Lab bundle:

```bash
pnpm openclaw qa docker-build-image
pnpm qa:lab:build
pnpm qa:lab:up:fast
pnpm qa:lab:watch
```

`qa:lab:up:fast` keeps the Docker services on a prebuilt image and
bind-mounts `extensions/qa-lab/web/dist` into the `qa-lab` container.
`qa:lab:watch` rebuilds that bundle on change, and the browser auto-reloads
when the QA Lab asset hash changes.

### Observability smokes

<Note>
Observability QA stays source-checkout only. The npm tarball intentionally
omits QA Lab (and `qa-channel`), so package Docker release lanes
do not run `qa` commands. Run these from a built source checkout when
changing diagnostics instrumentation.
</Note>

| Alias                                   | What it runs                                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm qa:otel:smoke`                    | Local OpenTelemetry receiver plus the `otel-trace-smoke` scenario with `diagnostics-otel` enabled.                                      |
| `pnpm qa:otel:collector-smoke`          | Same lane behind a real OpenTelemetry Collector Docker container. Use it when changing endpoint wiring or collector/OTLP compatibility. |
| `pnpm qa:prometheus:smoke`              | The `docker-prometheus-smoke` scenario with `diagnostics-prometheus` enabled.                                                           |
| `pnpm qa:observability:smoke`           | `qa:otel:smoke` followed by `qa:prometheus:smoke`.                                                                                      |
| `pnpm qa:observability:collector-smoke` | `qa:otel:collector-smoke` followed by `qa:prometheus:smoke`.                                                                            |

`qa:otel:smoke` starts a local OTLP/HTTP receiver, runs a minimal QA-channel
agent turn, then asserts traces, metrics, and logs are exported. It decodes
the exported protobuf trace spans and checks the release-critical shape:
`openclaw.run`, `openclaw.harness.run`, a latest GenAI semantic-convention
model-call span, `openclaw.context.assembled`, and `openclaw.message.delivery`
must all be present. The smoke forces
`OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`, so the model-call
span must use the `{gen_ai.operation.name} {gen_ai.request.model}` name; model
calls must not export `StreamAbandoned` on successful turns; raw diagnostic
IDs and `openclaw.content.*` attributes must stay out of the trace. The scenario
prompt asks the model to reply with a fixed marker and to withhold a fixed
secret string; the raw OTLP payloads must not contain either, or the QA
session key derived from the scenario id. It writes `otel-smoke-summary.json`
next to the QA suite artifacts.

`qa:prometheus:smoke` verifies unauthenticated scrapes are rejected, then
checks the authenticated scrape includes release-critical metric families
without prompt content, response content, raw diagnostic identifiers, auth
tokens, or local paths.

### Matrix live lane

For a transport-real Matrix lane that does not require model-provider
credentials, use the deterministic mock OpenAI provider:

```bash
pnpm openclaw qa matrix --provider-mode mock-openai
```

For the live-frontier provider lane, supply OpenAI-compatible credentials
explicitly:

```bash
OPENCLAW_LIVE_OPENAI_KEY="${OPENAI_API_KEY}" \
  pnpm openclaw qa matrix --provider-mode live-frontier
```

Plain `pnpm openclaw qa matrix` runs every flow scenario that explicitly
declares Matrix eligibility through `execution.channel` or
`execution.channels`, and it continues after scenario failures. Use
`--fail-fast` for a shorter feedback loop or repeat `--scenario <id>` for an
explicit subset, including portable scenarios with no channel restriction.

Matrix live implementations live under
`extensions/qa-lab/src/live-transports/matrix/scenarios/`.

The adapter provisions a disposable Tuwunel homeserver in Docker (default image
`ghcr.io/matrix-construct/tuwunel:v1.8.3`, pinned to its multi-architecture OCI
index digest; server name `matrix-qa.test`, Docker-assigned host port), registers
temporary driver, SUT, and observer users, seeds the required rooms, and records the
redacted request/response boundary. It then runs the real Matrix plugin inside
a child QA gateway scoped to that transport (no `qa-channel`) and tears the
environment down.

The v1.8.3 GHCR index resolves to
`sha256:699fa9971c174e01c884abad8d1a3cfb2fe518e1a71f1fa16ea9dedf11873d74`.
`docker buildx imagetools inspect ghcr.io/matrix-construct/tuwunel:v1.8.3`
reports manifests for `linux/arm64`, `linux/amd64`, `linux/amd64/v2`, and
`linux/amd64/v3`.

Common options:

| Flag                     | Default           | Purpose                                                                              |
| ------------------------ | ----------------- | ------------------------------------------------------------------------------------ |
| `--scenario <id>`        | -                 | Select one scenario; repeatable.                                                     |
| `--fail-fast`            | off               | Stop after the first failed check or scenario.                                       |
| `--allow-failures`       | off               | Write artifacts without returning a failing exit code for scenario failures.         |
| `--provider-mode <mode>` | `live-frontier`   | Use `mock-openai` for deterministic dispatch or `live-frontier` for a live provider. |
| `--model <ref>`          | provider default  | Set the primary `provider/model` reference.                                          |
| `--alt-model <ref>`      | provider default  | Set the alternate model used by scenarios that switch models.                        |
| `--fast`                 | off               | Enable provider fast mode where supported.                                           |
| `--output-dir <path>`    | generated         | Choose the report directory; relative paths resolve against `--repo-root`.           |
| `--repo-root <path>`     | current directory | Run from a neutral working directory.                                                |
| `--sut-account <id>`     | `sut`             | Select the Matrix account id in the child gateway config.                            |

Matrix QA does not lease shared Matrix credentials: the adapter creates
disposable users locally, so it does not accept `--credential-source` or
`--credential-role`. Override the homeserver image with
`OPENCLAW_QA_MATRIX_TUWUNEL_IMAGE`; tune negative no-reply assertions with
`OPENCLAW_QA_MATRIX_NO_REPLY_WINDOW_MS` (default `8000`, clamped to the active
scenario timeout). The single-shot command normally forces a clean exit after
artifacts flush because Matrix crypto native handles can outlive cleanup; set
`OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT=1` only for a direct test harness that
needs the command to return instead.

Each run writes the normal QA Lab artifacts under the selected output
directory: `qa-suite-report.md`, `qa-suite-summary.json`, and
`qa-evidence.json`. If cleanup fails, run the printed
`docker compose ... down --remove-orphans` recovery command. On slow runners,
increase the no-reply window; on fast CI, a smaller window can shorten negative
assertions.

The catalog covers transport behavior that unit tests cannot prove end to
end: mention gating, allow-bot policies, allowlists, top-level and threaded
replies, DM routing, reaction handling, inbound edit suppression, restart
replay dedupe, homeserver interruption recovery, approval metadata delivery,
media handling, and Matrix E2EE bootstrap/recovery/verification flows. The
E2EE CLI scenarios also drive `openclaw matrix encryption setup` and
verification commands through the same disposable homeserver before checking
gateway replies.

CI uses the same command surface in
`.github/workflows/qa-live-transports-convex.yml`. Scheduled, release, and
manual runs execute the catalog-derived selection in one job with up to four
isolated host workers. Each worker owns its disposable homeserver, Gateway,
state, and artifacts. Scenario membership stays catalog-owned; `--fail-fast`
keeps execution serial and stops after the first failure.
Use `openclaw qa matrix --concurrency <count>` to request fewer workers;
values above the transport limit stay capped.

### Discord Mantis scenarios

Discord also has Mantis-only opt-in scenarios for bug reproduction. Use
`--scenario discord-status-reactions-tool-only` for the explicit status
reaction timeline, or `--scenario discord-thread-reply-filepath-attachment`
to create a real Discord thread and verify that `message.thread-reply`
preserves a `filePath` attachment. These scenarios stay out of the default
live Discord lane because they are before/after repro probes rather than
broad smoke coverage. The thread-attachment Mantis workflow can also add a
logged-in Discord Web witness video when
`MANTIS_DISCORD_VIEWER_CHROME_PROFILE_DIR` or
`MANTIS_DISCORD_VIEWER_CHROME_PROFILE_TGZ_B64` is configured in the QA
environment. That viewer profile is only for visual capture; the pass/fail
decision still comes from the Discord REST oracle.

For the other transport-real smoke lanes:

```bash
pnpm openclaw qa buzz
pnpm openclaw qa discord
pnpm openclaw qa slack
pnpm openclaw qa telegram
pnpm openclaw qa whatsapp
```

They target a pre-existing real channel with two bots or accounts (driver +
SUT). Required env vars, scenario lists, output artifacts, and the Convex
credential pool for those five transports are documented in
[Buzz, Discord, Slack, Telegram, and WhatsApp QA reference](/concepts/qa-e2e-automation/channel-qa-reference#buzz-discord-slack-telegram-and-whatsapp-qa-reference).

### Mantis Slack desktop and visual-task runners

For a full Slack desktop VM run with VNC rescue, run:

```bash
pnpm openclaw qa mantis slack-desktop-smoke \
  --gateway-setup \
  --scenario slack-canary \
  --keep-lease
```

That command leases a Crabbox desktop/browser machine, runs the Slack live
lane inside the VM, opens Slack Web in the VNC browser, captures the desktop,
and copies `slack-qa/`, `slack-desktop-smoke.png`, and
`slack-desktop-smoke.mp4` (when video capture is available) back to the
Mantis artifact directory. Crabbox desktop/browser leases provide the capture
tools and browser/native-build helper packages up front, so the scenario
should only install fallbacks on older leases. Mantis reports total and
per-phase timings in `mantis-slack-desktop-smoke-report.md` so slow runs show
whether time went into lease warmup, credential acquisition, remote setup, or
artifact copy. Reuse `--lease-id <cbx_...>` after logging in to Slack Web
manually through VNC; reused leases also keep Crabbox's pnpm store cache
warm. The default `--hydrate-mode source` verifies from a source checkout and
runs install/build inside the VM. Use `--hydrate-mode prehydrated` only when
the reused remote workspace already has `node_modules` and a built `dist/`;
that mode skips the expensive install/build step and fails closed when the
workspace is not ready. With `--gateway-setup`, Mantis leaves a persistent
OpenClaw Slack gateway running inside the VM on port `38973`; without it, the
command runs the normal bot-to-bot Slack QA lane and exits after artifact
capture.

To prove native Slack approval UI with desktop evidence, run the Mantis
approval checkpoint mode:

```bash
pnpm openclaw qa mantis slack-desktop-smoke \
  --approval-checkpoints \
  --credential-source convex \
  --credential-role maintainer
```

This mode is mutually exclusive with `--gateway-setup`. It runs the Slack
approval scenarios, rejects non-approval scenario ids, waits at each pending
and resolved approval state, renders the observed Slack API message into
`approval-checkpoints/<scenario>-pending.png` and
`approval-checkpoints/<scenario>-resolved.png`, then fails if any checkpoint,
message evidence, acknowledgement, or rendered screenshot is missing or
empty. Cold CI leases may still show Slack sign-in in
`slack-desktop-smoke.png`; the approval checkpoint images are the visual
proof for this lane.

The default checkpoint run keeps the two standard Slack approval scenarios.
To capture either opt-in Codex approval route, select it explicitly with
`--scenario slack-codex-approval-exec-native` or
`--scenario slack-codex-approval-plugin-native`; Mantis accepts both and emits
the same pending/resolved screenshot pair. The runner expands its checkpoint
and remote-command deadlines for each selected Codex route so the full
approval, agent completion, and resolved-update sequence can finish.

The operator checklist, GitHub workflow dispatch command, evidence-comment
contract, hydrate-mode decision table, timing interpretation, and failure
handling steps live in
[Mantis Slack Desktop Runbook](/concepts/mantis-slack-desktop-runbook).

For an agent/CV style desktop task, run:

```bash
pnpm openclaw qa mantis visual-task \
  --browser-url https://example.net \
  --expect-text "Example Domain" \
  --vision-model openai/gpt-5.6-luna
```

`visual-task` leases or reuses a Crabbox desktop/browser machine, starts
`crabbox record --while`, drives the visible browser through a nested
`visual-driver`, captures `visual-task.png`, runs `openclaw infer image
describe` against the screenshot when `--vision-mode image-describe` is
selected, and writes `visual-task.mp4`, `mantis-visual-task-summary.json`,
`mantis-visual-task-driver-result.json`, and
`mantis-visual-task-report.md`. When `--expect-text` is set, the vision
prompt asks for a structured JSON verdict (`visible`, `evidence`, `reason`)
and only passes when the model reports `visible: true` with evidence that
cites the expected text; a `visible: false` response that merely quotes the
target text still fails the assertion. Use `--vision-mode metadata` for a
no-model smoke that proves the desktop, browser, screenshot, and video
plumbing without calling an image-understanding provider. Recording is a
required artifact for `visual-task`; if Crabbox records no non-empty
`visual-task.mp4`, the task fails even when the visual driver passed. On
failure, Mantis keeps the lease for VNC unless the task had already passed
and `--keep-lease` was not set.

### Credential pool health check

Before using pooled live credentials, run:

```bash
pnpm openclaw qa credentials doctor
```

The doctor checks Convex broker env (`OPENCLAW_QA_CONVEX_SITE_URL`,
`OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX`), validates endpoint settings, reports
only set/missing status for `OPENCLAW_QA_CONVEX_SECRET_CI` and
`OPENCLAW_QA_CONVEX_SECRET_MAINTAINER`, and verifies admin/list reachability
when the maintainer secret is present.
