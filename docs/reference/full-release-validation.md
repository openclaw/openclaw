---
summary: "Full Release Validation stages, child workflows, release profiles, rerun handles, and evidence"
title: "Full release validation"
read_when:
  - Running or rerunning Full Release Validation
  - Comparing stable and full release validation profiles
  - Debugging release validation stage failures
---

`Full Release Validation` is the release umbrella. It is the single manual
entrypoint for pre-release proof, but most work happens in child workflows so a
failed box can be rerun without restarting the whole release.

Run it from a trusted workflow ref, normally `main`, and pass the release branch,
tag, or full commit SHA as `ref`:

```bash
gh workflow run full-release-validation.yml \
  --ref main \
  -f ref=release/YYYY.M.D \
  -f provider=openai \
  -f mode=both \
  -f release_profile=stable
```

Child workflows use the trusted workflow ref for the harness and the input
`ref` for the candidate under test. That keeps new validation logic available
when validating an older release branch or tag.

## Top-level stages

| Stage                 | Workflow job name                       | Child workflow            | What it proves                                                                                                                                                                                                                                                                 | Rerun handle                                                     |
| --------------------- | --------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Target resolution     | `Resolve target ref`                    | none                      | Resolves the release branch, tag, or full commit SHA and records selected inputs.                                                                                                                                                                                              | Rerun the umbrella if this fails.                                |
| Vitest and normal CI  | `Run normal full CI`                    | `CI`                      | Manual full CI graph against the target ref, including Linux Node lanes, bundled plugin shards, channel contracts, Node 22 compatibility, `check`, `check-additional`, build smoke, docs checks, Python skills, Windows, macOS, Control UI i18n, and Android via the umbrella. | `rerun_group=ci`                                                 |
| Plugin prerelease     | `Run plugin prerelease validation`      | `Plugin Prerelease`       | Release-only plugin static checks, agentic plugin coverage, full extension batch shards, and plugin prerelease Docker lanes.                                                                                                                                                   | `rerun_group=plugin-prerelease`                                  |
| Release checks        | `Run release/live/Docker/QA validation` | `OpenClaw Release Checks` | Install smoke, cross-OS package checks, live/E2E suites, Docker release-path chunks, Package Acceptance, QA Lab parity, live Matrix, and live Telegram.                                                                                                                        | `rerun_group=release-checks` or a narrower release-checks handle |
| Post-publish Telegram | `Run post-publish Telegram E2E`         | `NPM Telegram Beta E2E`   | Optional published-package Telegram proof when `npm_telegram_package_spec` is set.                                                                                                                                                                                             | `rerun_group=npm-telegram`                                       |
| Umbrella verifier     | `Verify full validation`                | none                      | Re-checks recorded child run conclusions and appends slowest-job tables from child workflows.                                                                                                                                                                                  | Rerun only this job after rerunning a failed child to green.     |

For `ref=main` and `rerun_group=all`, a newer umbrella supersedes an older one.
When the parent is cancelled, its monitor cancels any child workflow it already
dispatched. Release branch and tag validation runs do not cancel each other by
default.

## Release checks stages

`OpenClaw Release Checks` is the largest child workflow. It resolves the target
once and prepares a shared `release-package-under-test` artifact when package
or Docker-facing stages need it.

| Stage               | Workflow job name                                       | Backing workflow or jobs                      | What it tests                                                                                                                                                                                                      | Rerun handle                                                |
| ------------------- | ------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Release target      | `Resolve target ref`                                    | none                                          | Validates the selected ref, optional expected SHA, profile, rerun group, and focused live suite filter.                                                                                                            | Rerun `release-checks`.                                     |
| Package artifact    | `Prepare release package artifact`                      | none                                          | Packs or resolves one candidate tarball and uploads `release-package-under-test` for downstream package-facing checks.                                                                                             | Rerun the affected package, cross-OS, or live/E2E group.    |
| Install smoke       | `Run install smoke`                                     | `Install Smoke`                               | Full install path with root Dockerfile smoke image reuse, QR package install, root and gateway Docker smokes, installer Docker tests, Bun global install image-provider smoke, and fast bundled-plugin Docker E2E. | `rerun_group=install-smoke`                                 |
| Cross-OS            | `cross_os_release_checks`                               | `OpenClaw Cross-OS Release Checks (Reusable)` | Fresh and upgrade lanes on Linux, Windows, and macOS for the selected provider and mode, using the candidate tarball plus a baseline package.                                                                      | `rerun_group=cross-os`                                      |
| Repo and live E2E   | `Run repo/live E2E validation`                          | `OpenClaw Live And E2E Checks (Reusable)`     | Repository E2E, live cache, OpenAI websocket streaming, native live provider and plugin shards, and Docker-backed live model/backend/gateway harnesses selected by `release_profile`.                              | `rerun_group=live-e2e`, optionally with `live_suite_filter` |
| Docker release path | `Run Docker release-path validation`                    | `OpenClaw Live And E2E Checks (Reusable)`     | Release-path Docker chunks against the shared package artifact.                                                                                                                                                    | `rerun_group=live-e2e`                                      |
| Package Acceptance  | `Run package acceptance`                                | `Package Acceptance`                          | Artifact-native bundled-channel dependency compatibility, offline plugin package fixtures, and mock-OpenAI Telegram package acceptance against the same tarball.                                                   | `rerun_group=package`                                       |
| QA parity           | `Run QA Lab parity lane` and `Run QA Lab parity report` | direct jobs                                   | Candidate and baseline agentic parity packs, then the parity report.                                                                                                                                               | `rerun_group=qa-parity` or `rerun_group=qa`                 |
| QA live Matrix      | `Run QA Lab live Matrix lane`                           | direct job                                    | Fast live Matrix QA profile in the `qa-live-shared` environment.                                                                                                                                                   | `rerun_group=qa-live` or `rerun_group=qa`                   |
| QA live Telegram    | `Run QA Lab live Telegram lane`                         | direct job                                    | Live Telegram QA with Convex CI credential leases.                                                                                                                                                                 | `rerun_group=qa-live` or `rerun_group=qa`                   |
| Release verifier    | `Verify release checks`                                 | none                                          | Verifies required release-check jobs for the selected rerun group.                                                                                                                                                 | Rerun after focused child jobs pass.                        |

## Docker release-path chunks

The Docker release-path stage runs these chunks when `live_suite_filter` is
empty:

| Chunk                                                                                       | Coverage                                                                |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `core`                                                                                      | Core Docker release-path smoke lanes.                                   |
| `package-update-openai`                                                                     | OpenAI package install and update behavior.                             |
| `package-update-anthropic`                                                                  | Anthropic package install and update behavior.                          |
| `package-update-core`                                                                       | Provider-neutral package and update behavior.                           |
| `plugins-runtime-plugins`                                                                   | Plugin runtime lanes that exercise plugin behavior.                     |
| `plugins-runtime-services`                                                                  | Service-backed plugin runtime lanes; includes OpenWebUI when requested. |
| `plugins-runtime-install-a` through `plugins-runtime-install-h`                             | Plugin install/runtime batches split for parallel release validation.   |
| `bundled-channels-core`                                                                     | Bundled channel Docker behavior.                                        |
| `bundled-channels-update-a`, `bundled-channels-update-discord`, `bundled-channels-update-b` | Bundled channel update behavior.                                        |
| `bundled-channels-contracts`                                                                | Bundled channel contract checks in the Docker release path.             |

Use targeted `docker_lanes=<lane[,lane]>` on the reusable live/E2E workflow when
only one Docker lane failed. The release artifacts include per-lane rerun
commands with package artifact and image reuse inputs when available.

## Release profiles

`release_profile` only controls live/provider breadth inside release checks. It
does not remove normal full CI, Plugin Prerelease, install smoke, package
acceptance, QA Lab, or Docker release-path chunks.

| Profile   | Intended use                      | Included live/provider coverage                                                                                                                                               |
| --------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minimum` | Fastest release-critical smoke.   | OpenAI/core live path, Docker live models for OpenAI, native gateway core, native OpenAI gateway profile, native OpenAI plugin, and Docker live gateway OpenAI.               |
| `stable`  | Default release approval profile. | `minimum` plus Anthropic, Google, MiniMax, backend, native live test harness, Docker live CLI backend, Docker ACP bind, Docker Codex harness, and an OpenCode Go smoke shard. |
| `full`    | Broad advisory sweep.             | `stable` plus advisory providers, plugin live shards, and media live shards.                                                                                                  |

## Full-only additions

These suites are skipped by `stable` and included by `full`:

| Area                             | Full-only coverage                                                              |
| -------------------------------- | ------------------------------------------------------------------------------- |
| Docker live models               | OpenCode Go, OpenRouter, xAI, Z.ai, and Fireworks.                              |
| Docker live gateway              | Advisory shard for DeepSeek, Fireworks, OpenCode Go, OpenRouter, xAI, and Z.ai. |
| Native gateway provider profiles | Fireworks, DeepSeek, full OpenCode Go model shards, OpenRouter, xAI, and Z.ai.  |
| Native plugin live shards        | Plugins A-K, L-N, O-Z other, Moonshot, and xAI.                                 |
| Native media live shards         | Audio, Google music, MiniMax music, and video groups A-D.                       |

`stable` includes `native-live-src-gateway-profiles-opencode-go-smoke`; `full`
uses the broader OpenCode Go model shards instead.

## Focused reruns

Use `rerun_group` to avoid repeating unrelated release boxes:

| Handle              | Scope                                             |
| ------------------- | ------------------------------------------------- |
| `all`               | All Full Release Validation stages.               |
| `ci`                | Manual full CI child only.                        |
| `plugin-prerelease` | Plugin Prerelease child only.                     |
| `release-checks`    | All OpenClaw Release Checks stages.               |
| `install-smoke`     | Install Smoke through release checks.             |
| `cross-os`          | Cross-OS release checks.                          |
| `live-e2e`          | Repo/live E2E and Docker release-path validation. |
| `package`           | Package Acceptance.                               |
| `qa`                | QA parity plus QA live lanes.                     |
| `qa-parity`         | QA parity lanes and report only.                  |
| `qa-live`           | QA live Matrix and Telegram only.                 |
| `npm-telegram`      | Optional post-publish Telegram E2E only.          |

Use `live_suite_filter` with `rerun_group=live-e2e` when one live suite failed.
Valid filter ids are defined in the reusable live/E2E workflow, including
`docker-live-models`, `live-gateway-docker`,
`live-gateway-anthropic-docker`, `live-gateway-google-docker`,
`live-gateway-minimax-docker`, `live-gateway-advisory-docker`,
`live-cli-backend-docker`, `live-acp-bind-docker`, and
`live-codex-harness-docker`.

## Evidence to keep

Keep the `Full Release Validation` summary as the release-level index. It links
child run ids and includes slowest-job tables. For failures, inspect the child
workflow first, then rerun the smallest matching handle above.

Useful artifacts:

- `release-package-under-test` from `OpenClaw Release Checks`
- Docker release-path artifacts under `.artifacts/docker-tests/`
- Package Acceptance `package-under-test` and Docker acceptance artifacts
- Cross-OS release-check artifacts for each OS and suite
- QA parity, Matrix, and Telegram artifacts

## Workflow files

- `.github/workflows/full-release-validation.yml`
- `.github/workflows/openclaw-release-checks.yml`
- `.github/workflows/openclaw-live-and-e2e-checks-reusable.yml`
- `.github/workflows/plugin-prerelease.yml`
- `.github/workflows/install-smoke.yml`
- `.github/workflows/openclaw-cross-os-release-checks-reusable.yml`
- `.github/workflows/package-acceptance.yml`
