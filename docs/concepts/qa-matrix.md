---
summary: "Maintainer reference for the Docker-backed Matrix live QA lane: CLI, profiles, env vars, scenarios, and output artifacts."
read_when:
  - Running pnpm openclaw qa matrix locally
  - Adding or selecting Matrix QA scenarios
  - Triaging Matrix QA failures, timeouts, or stuck cleanup
title: "Matrix QA"
---

The Matrix QA lane runs the bundled `@openclaw/matrix` plugin against a disposable Tuwunel homeserver in Docker, with temporary driver, SUT, and observer accounts plus seeded rooms. It is the live transport-real coverage for Matrix.

Maintainer-only tooling. Packaged OpenClaw releases omit `qa-lab`, so `openclaw qa` only runs from a source checkout, which loads the bundled runner directly with no plugin install step.

For broader QA framework context, see [QA overview](/concepts/qa-e2e-automation).

## Quick start

```bash
pnpm openclaw qa matrix --profile fast --fail-fast
```

Plain `pnpm openclaw qa matrix` runs `--profile all` and does not stop on first failure. Shard the full inventory across parallel jobs with `--profile transport|media|e2ee-smoke|e2ee-deep|e2ee-cli`.

## What the lane does

1. Provisions a disposable Tuwunel homeserver in Docker (default image `ghcr.io/matrix-construct/tuwunel:v1.5.1`, server name `matrix-qa.test`, port `28008`) behind a bounded redacting request/response recorder.
2. Registers three temporary users: `driver` (sends inbound traffic), `sut` (the OpenClaw Matrix account under test), `observer` (third-party traffic capture).
3. Seeds rooms required by the selected scenarios (main, threading, media, restart, secondary, allowlist, E2EE, verification DM, etc.).
4. Records the Tuwunel request/response boundary with the `matrix-qa-v1`
   redaction profile and attributes traffic to the active QA Lab scenario.
5. Starts a child OpenClaw gateway with the real Matrix plugin scoped to the SUT account.
6. Runs the selected YAML scenarios through the shared QA Lab flow host while
   driver and observer Matrix clients capture transport evidence.
7. Tears down the homeserver and writes the normal QA Lab suite report,
   summary, and evidence artifacts.

## CLI

```text
pnpm openclaw qa matrix [options]
```

### Common flags

| Flag                  | Default                                       | Description                                                                                                                                   |
| --------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--profile <profile>` | `all`                                         | Scenario profile. See [Profiles](#profiles).                                                                                                  |
| `--fail-fast`         | off                                           | Stop after the first failed check or scenario.                                                                                                |
| `--scenario <id>`     | -                                             | Run only this scenario. Repeatable. See [Scenarios](#scenarios).                                                                              |
| `--output-dir <path>` | `<repo>/.artifacts/qa-e2e/matrix-<timestamp>` | Where reports, summary, route/state inventory, observed events, and the output log are written. Relative paths resolve against `--repo-root`. |
| `--repo-root <path>`  | `process.cwd()`                               | Repository root when invoking from a neutral working directory.                                                                               |
| `--sut-account <id>`  | `sut`                                         | Matrix account id inside the QA gateway config.                                                                                               |

### Provider flags

The lane uses a real Matrix transport but the model provider is configurable:

| Flag                     | Default          | Description                                                                                                                               |
| ------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--provider-mode <mode>` | `live-frontier`  | `mock-openai` for deterministic mock dispatch or `live-frontier` for live frontier providers. The legacy alias `live-openai` still works. |
| `--model <ref>`          | provider default | Primary `provider/model` ref.                                                                                                             |
| `--alt-model <ref>`      | provider default | Alternate `provider/model` ref where scenarios switch mid-run.                                                                            |
| `--fast`                 | off              | Enable provider fast mode where supported.                                                                                                |

Matrix QA does not accept `--credential-source` or `--credential-role`. The lane provisions disposable users locally; there is no shared credential pool to lease against.

## Profiles

| Profile         | Use it for                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `all` (default) | Full catalog. Slow but exhaustive.                                                                                                         |
| `release`       | Small release-critical pair covering the channel baseline and live allowlist reload.                                                       |
| `fast`          | Focused transport subset covering thread/reply shape, reactions, approvals, mention and sender policy, bot gating, and an encrypted reply. |
| `transport`     | Transport-level threading, DM, room, autojoin, mention/allowlist, approval, and reaction scenarios.                                        |
| `media`         | Image, audio, video, PDF, EPUB attachment coverage.                                                                                        |
| `e2ee-smoke`    | Minimum E2EE coverage: basic encrypted reply, thread follow-up, bootstrap success.                                                         |
| `e2ee-deep`     | Exhaustive E2EE state-loss, backup, key, and recovery scenarios.                                                                           |
| `e2ee-cli`      | `openclaw matrix encryption setup` and `verify *` CLI scenarios driven through the QA harness.                                             |

The exact mapping lives in
`extensions/qa-lab/src/live-transports/matrix/profiles.ts`.

## Scenarios

The shared Matrix adapter exposes these canonical YAML scenarios through `openclaw qa suite --channel-driver live --channel matrix`:

- `channel-chat-baseline`
- `thread-follow-up`
- `thread-isolation`
- `thread-reply-override`
- `dm-shared-session`
- `dm-per-room-session`

`subagent-thread-spawn` remains available through explicit `--scenario subagent-thread-spawn`
selection, but is not part of the default shared Matrix set until live child-completion proof is stable.

The Matrix-specific scenarios are declarative files under
`qa/scenarios/channels/matrix-*.yaml`; their module-backed implementations live
under `extensions/qa-lab/src/live-transports/matrix/scenarios/`. Categories:

- threading: `matrix-thread-root-preservation`, `matrix-thread-nested-reply-shape`
- top-level / DM / room: `matrix-top-level-reply-shape`, `matrix-room-*`, `matrix-dm-*`
- streaming and tool progress: `matrix-room-partial-streaming-preview`, `matrix-room-quiet-streaming-preview`, `matrix-room-tool-progress-*`, `matrix-room-block-streaming`
- media: `matrix-media-type-coverage`, `matrix-room-image-understanding-attachment`, `matrix-attachment-only-ignored`, `matrix-unsupported-media-safe`
- routing: `matrix-room-autojoin-invite`, `matrix-secondary-room-*`
- reactions: `matrix-reaction-*`
- approvals: `matrix-approval-*` (exec/plugin metadata, chunked fallback, deny reactions, threads, and `target: "both"` routing)
- restart and replay: `matrix-restart-*`, `matrix-stale-sync-replay-dedupe`, `matrix-room-membership-loss`, `matrix-homeserver-restart-resume`, `matrix-initial-catchup-then-incremental`
- mention gating, bot-to-bot, and allowlists: `matrix-mention-*`, `matrix-allowbots-*`, `matrix-allowlist-*`, `matrix-multi-actor-ordering`, `matrix-inbound-edit-*`, `matrix-mxid-prefixed-command-block`, `matrix-observer-allowlist-override`
- E2EE: `matrix-e2ee-*` (basic reply, thread follow-up, bootstrap, recovery key lifecycle, state-loss variants, server backup behavior, device hygiene, SAS / QR / DM verification, restart, artifact redaction)
- E2EE CLI: `matrix-e2ee-cli-*` (encryption setup, idempotent setup, bootstrap failure, recovery-key lifecycle, multi-account, gateway-reply round-trip, self-verification)

Pass `--scenario <id>` (repeatable) to run a hand-picked set. Explicit scenario
ids take precedence over profile selection.

## Environment variables

| Variable                                | Default                                   | Effect                                                                                                                                                                   |
| --------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENCLAW_QA_MATRIX_NO_REPLY_WINDOW_MS` | `8000`                                    | Quiet window for negative no-reply assertions, clamped to the active scenario timeout.                                                                                   |
| `OPENCLAW_QA_MATRIX_TUWUNEL_IMAGE`      | `ghcr.io/matrix-construct/tuwunel:v1.5.1` | Override the homeserver image when validating against a different Tuwunel version.                                                                                       |
| `OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT` | off                                       | `1` skips the compatibility command's deterministic `process.exit`. The default forces exit because matrix-js-sdk native crypto handles can outlive completed artifacts. |

## Output artifacts

Written to `--output-dir` (default
`<repo>/.artifacts/qa-e2e/suite-<run-id>` so successive runs do not overwrite
each other):

- `qa-suite-report.md`: Markdown protocol report showing passed and failed
  scenarios and step details.
- `qa-suite-summary.json`: Structured suite and runtime summary for CI and
  comparison tooling.
- `qa-evidence.json`: Normalized scenario evidence with Matrix-specific
  artifacts referenced from scenario details.
- `matrix-harness-*/matrix-qa-harness.json`: Redacted disposable homeserver
  manifest for the adapter instance.

## Triage tips

- **Run hangs near the end:** `matrix-js-sdk` native crypto handles can outlive the harness. The default forces a clean `process.exit` after artifact write; if you set `OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT=1`, expect the process to linger.
- **Cleanup error:** look for the printed recovery command (a `docker compose ... down --remove-orphans` invocation) and run it manually to release the homeserver port.
- **Flaky negative-assertion windows in CI:** lower `OPENCLAW_QA_MATRIX_NO_REPLY_WINDOW_MS` (default 8 s) when CI is fast; raise it on slow shared runners.
- **Different Tuwunel version:** point `OPENCLAW_QA_MATRIX_TUWUNEL_IMAGE` at the version under test. The lane checks in only the pinned default image.

## Live transport contract

Matrix is one of the live transport lanes that share a single contract
checklist defined in [QA overview: Live transport
coverage](/concepts/qa-e2e-automation#live-transport-coverage). `qa-channel`
remains the broad synthetic suite and is intentionally not part of that
matrix.

## Related

- [QA overview](/concepts/qa-e2e-automation): overall QA stack and live transport contract
- [QA Channel](/channels/qa-channel): synthetic channel adapter for repo-backed scenarios
- [Testing](/help/testing): running tests and adding QA coverage
- [Matrix](/channels/matrix): the channel plugin under test
