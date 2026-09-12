---
doc-schema-version: 1
summary: "Release profile coverage, full-only additions, and the focused rerun handles and suite filters"
title: "Release profiles and focused reruns"
read_when:
  - Comparing beta, stable, and full profile coverage
  - Picking a focused rerun_group or suite filter
---

## Release profiles

`release_profile` controls live/provider breadth inside release checks. The
bounded canonical beta gate described in [Extended-stable and changelog-only
validation](/reference/full-release-validation/extended-stable) also selects npm-focused CI and
defers performance and Telegram confidence. Plugin Prerelease, install smoke,
package acceptance, and QA parity remain selected. Stable and full profiles always run exhaustive
repo/live E2E, Docker release-path, and QA-live soak coverage. The beta profile
adds those lanes only with `run_release_soak=true`, an explicit `qa-live`
controller retry, or the direct child's manual `qa` aggregate. Package
Acceptance supplies the canonical package Telegram E2E when selected; beta
`all` without soak defers it to confidence work.

| Profile  | Intended use                      | Included live/provider coverage                                                                                                                                                                            |
| -------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beta`   | Fastest release-critical smoke.   | OpenAI/core live path, Docker live models for OpenAI, native gateway core, native OpenAI gateway profile, native OpenAI plugin, and Docker live gateway OpenAI.                                            |
| `stable` | Default release approval profile. | `beta` plus Anthropic smoke, Google, MiniMax, backend, native live test harness, Docker live CLI backend, Docker ACP bind, Docker Codex harness, Docker subagent-announce, and an OpenCode Go smoke shard. |
| `full`   | Broad advisory sweep.             | `stable` plus advisory providers, plugin live shards, and media live shards.                                                                                                                               |

## Full-only additions

These suites are skipped by `stable` and included by `full`:

| Area                             | Full-only coverage                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Docker live models               | OpenCode Go, OpenRouter, xAI, Z.ai, and Fireworks.                                                                          |
| Docker live gateway              | Advisory providers split into DeepSeek/Fireworks, OpenCode Go/OpenRouter, and xAI/Z.ai shards.                              |
| Native gateway provider profiles | Full Anthropic Opus and Sonnet/Haiku shards, Fireworks, DeepSeek, full OpenCode Go model shards, OpenRouter, xAI, and Z.ai. |
| Native plugin live shards        | Plugins A-K, L-N, O-Z other, Moonshot, and xAI.                                                                             |
| Native media live shards         | Audio, Google music, MiniMax music, and video groups A-D.                                                                   |

`stable` includes `native-live-src-gateway-profiles-anthropic-smoke` and
`native-live-src-gateway-profiles-opencode-go-smoke`; `full` uses the broader
Anthropic and OpenCode Go model shards instead. Focused reruns can still use the
aggregate `native-live-src-gateway-profiles-anthropic` or
`native-live-src-gateway-profiles-opencode-go` handles.

## Focused reruns

Use `rerun_group` to avoid repeating unrelated release boxes:

| Handle              | Scope                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `all`               | Profile-selected qualification; canonical beta without soak uses `npm-beta-v1`; regular stable uses `npm-stable-v1`, which defers native apps only. |
| `ci`                | Manual full CI child only.                                                                                                                          |
| `plugin-prerelease` | Plugin Prerelease child only.                                                                                                                       |
| `install-smoke`     | Install Smoke through release checks.                                                                                                               |
| `cross-os`          | Cross-OS release checks.                                                                                                                            |
| `live-e2e`          | Repo/live E2E and Docker release-path validation.                                                                                                   |
| `package`           | Package Acceptance.                                                                                                                                 |
| `qa-parity`         | QA parity, runtime-pair/restart, and runtime tool coverage.                                                                                         |
| `qa-live`           | QA live Matrix, Buzz, and Telegram plus gated Discord, WhatsApp, and Slack lanes when enabled.                                                      |
| `npm-telegram`      | Published-package Telegram E2E; requires `release_package_spec` or `npm_telegram_package_spec`.                                                     |
| `performance`       | Product performance evidence only.                                                                                                                  |

Use `live_suite_filter` with `rerun_group=live-e2e` when one live suite failed.
The former `release-checks` aggregate retry handle is invalid. It silently
expanded to every release-check lane, including package and Docker setup. Pick
one concrete group after classifying the failed surface.
The umbrella/controller also rejects `qa`; direct `OpenClaw Release Checks`
dispatches may use it only as a deliberate manual aggregate of `qa-parity` and
`qa-live`. Live and QA-live filters must match their owning group; cross-OS
filters are also accepted for `all`.
Mismatches fail before scheduling and never widen to an unfiltered run.
Valid filter ids are defined in the reusable live/E2E workflow, including
`docker-live-models`, `live-gateway-docker`,
`live-gateway-anthropic-docker`, `live-gateway-google-docker`,
`live-gateway-minimax-docker`, `live-gateway-advisory-docker`,
`live-cli-backend-docker`, `live-cli-cache-docker`, `live-acp-bind-docker`, and
`live-codex-harness-docker`.

For a focused QA transport rerun, set `rerun_group=qa-live` and use the
canonical selector `qa-live-matrix`, `qa-live-buzz`, `qa-live-telegram`,
`qa-live-discord`, `qa-live-whatsapp`, or `qa-live-slack`.

The `live-gateway-advisory-docker` handle is an aggregate rerun handle for its
three provider shards, so it still fans out to all advisory Docker gateway jobs.

Use `cross_os_suite_filter` with `rerun_group=cross-os` when one cross-OS lane
failed. The filter accepts comma-separated OS ids, suite ids, or OS/suite pairs,
for example `windows/packaged-upgrade`, `windows`, or `packaged-fresh`.
All-group runs accept the same selections: `-f cross_os_suite_filter=ubuntu,macos`
excludes Windows while retaining every Linux suite. `npm-stable-v1` and
`npm-beta-v1` still qualify when advisory OS lanes are omitted, provided all
three Linux suites (`packaged-fresh`, `installer-fresh`, and `packaged-upgrade`)
remain selected and the other policy requirements hold. Omitted lanes are not
run, never passed. Focused reruns remain focused evidence, not publication
authorization. Cross-OS
summaries include per-phase timings for packaged upgrade lanes, and long-running
commands print heartbeat lines so a stuck update is visible before the job
timeout.

QA release-check failures block normal release validation, including selected
parity, runtime-pair/restart, Matrix, and runtime tool coverage. Some QA jobs use
`continue-on-error` to preserve diagnostics, but the release verifier checks
their recorded status; that setting does not remove the gate. Source and package
Telegram outcomes are advisory; failed, skipped, or deferred attempts are never
reported as passed. Tideclaw alpha runs may still treat non-package-safety
release-check lanes as advisory. With
`release_profile=beta`, the `Run repo/live E2E validation` live-provider suites
are advisory: third-party model deployments change underneath a release, so
beta surfaces their failures as warnings while stable and full profiles keep
them blocking. When
`live_suite_filter` explicitly requests a gated QA live lane such as Discord,
WhatsApp, or Slack, the matching `OPENCLAW_RELEASE_QA_*_LIVE_CI_ENABLED` repo
variable must be enabled; otherwise input capture fails instead of silently skipping the lane.
Use controller groups `qa-parity` or `qa-live` for fresh QA evidence. A direct
manual `OpenClaw Release Checks` dispatch may use `qa` to aggregate both.
