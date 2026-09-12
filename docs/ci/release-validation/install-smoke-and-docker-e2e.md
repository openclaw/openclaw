---
summary: "Install Smoke coverage, the local Docker E2E aggregate, and release-path Docker chunks"
read_when:
  - You are running or debugging Docker E2E lanes
  - You need the local Docker E2E tunables or the release-path chunk names
title: "Install smoke and Docker E2E"
sidebarTitle: "Install smoke and Docker E2E"
---

Install Smoke coverage, the local Docker E2E aggregate and its tunables, the reusable live/E2E workflow, and release-path chunks. Part of the [Release validation workflows](/ci/release-validation) index.

## Install smoke

The `Install Smoke` workflow no longer runs on pull requests or `main` pushes. Its nightly/manual wrapper and release validation both call the read-only `install-smoke-reusable.yml` core, and every run takes the full install-smoke path on GitHub-hosted runners:

- The root Dockerfile smoke image is built once per target SHA, bound to the workflow revision and producer attempt in an immutable artifact, then loaded by the CLI smoke, agents delete shared-workspace CLI smoke, container gateway-network E2E, and bundled `matrix` plugin build-arg smoke. The plugin smoke verifies runtime dependency install mirroring and that the plugin loads without entry-escape diagnostics.
- QR package install and the installer/update Docker smokes (including Rocky Linux installer lanes and an update lane against a configurable `update_baseline_version` npm baseline) run as separate jobs so installer work does not wait behind the root image smokes.

The slow Bun global install and runtime smoke is separately gated by `run_bun_global_install_smoke`. It installs the candidate with trusted lifecycle scripts, then verifies representative CLI, local-agent, and Gateway paths under Bun 1.4 or newer. It runs on the nightly schedule, defaults on for workflow calls from release checks, and manual `Install Smoke` dispatches can opt into it. Normal PR CI still runs the fast Bun launcher regression lane for Node-relevant changes. QR and installer Docker tests keep their own install-focused Dockerfiles.

## Local Docker E2E

`pnpm test:docker:all` prebuilds one shared live-test image, packs OpenClaw once as an npm tarball, and builds two shared `scripts/e2e/Dockerfile` images:

- a bare Node/Git runner for installer/update/plugin-dependency lanes;
- a functional image that installs the same tarball into `/app` for normal functionality lanes.

Docker lane definitions live in `scripts/lib/docker-e2e-scenarios.mts`, planner logic lives in `scripts/lib/docker-e2e-plan.mts`, and the runner only executes the selected plan. The scheduler selects the image per lane with `OPENCLAW_DOCKER_E2E_BARE_IMAGE` and `OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE`, then runs lanes with `OPENCLAW_SKIP_DOCKER_BUILD=1`. Live lanes that use these package images do not require the separate source live-test image; model/backend lanes that consume the source image still prepare it.

### Tunables

| Variable                               | Default | Purpose                                                                                       |
| -------------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `OPENCLAW_DOCKER_ALL_PARALLELISM`      | 10      | Main-pool slot count for normal lanes.                                                        |
| `OPENCLAW_DOCKER_ALL_TAIL_PARALLELISM` | 10      | Provider-sensitive tail-pool slot count.                                                      |
| `OPENCLAW_DOCKER_ALL_LIVE_LIMIT`       | 9       | Concurrent live lane cap so providers do not throttle.                                        |
| `OPENCLAW_DOCKER_ALL_NPM_LIMIT`        | 5       | Concurrent npm install lane cap.                                                              |
| `OPENCLAW_DOCKER_ALL_SERVICE_LIMIT`    | 7       | Concurrent multi-service lane cap.                                                            |
| `OPENCLAW_DOCKER_ALL_START_STAGGER_MS` | 2000    | Stagger between lane starts to avoid Docker daemon create storms; set `0` for no stagger.     |
| `OPENCLAW_DOCKER_ALL_LANE_TIMEOUT_MS`  | 7200000 | Per-lane fallback timeout (120 minutes); selected live/tail lanes use tighter caps.           |
| `OPENCLAW_DOCKER_ALL_DRY_RUN`          | unset   | `1` prints the scheduler plan without running lanes.                                          |
| `OPENCLAW_DOCKER_ALL_LANES`            | unset   | Comma-separated exact lane list; skips cleanup smoke so agents can reproduce one failed lane. |

A lane heavier than its effective cap can still start from an empty pool, then runs alone until it releases capacity. The local aggregate preflights Docker, removes stale OpenClaw E2E containers, emits active-lane status, persists lane timings for longest-first ordering, and stops scheduling new pooled lanes after the first failure by default.

### Reusable live/E2E workflow

Repository E2E runs as nine independent jobs: four duration-weighted Gateway shards, four
duration-weighted Control UI shards, and the standalone agent-plugin Gateway
test. Two independent producers build the selected source once per profile:
the full private-QA build for Gateway package/type checks, and the CI artifact
build for UI and agent-plugin tests. Consumers restore exact producer artifacts,
including generated plugin assets and local build metadata, and install their
own Chromium and sandbox prerequisites. Each group has four test slots, so long
UI shards start together without waiting for Gateway declarations or tests.
A failed producer blocks its own consumers; other diagnostics continue.

Gateway shards retain the existing
four fresh-process boundaries and two-worker limit. Each UI shard runs its
bundled files with up to two workers, then its private-server, real-Gateway, and
runtime-budget files serially. The root sequencer assigns files across both
projects to the same four weighted shards. No tests are filtered out, and the
existing 90-minute job deadline is unchanged. Local `pnpm test:e2e` still runs
its suite commands sequentially; each UI command uses the same project policy.

This removes seven builds per invocation and raises peak test concurrency from
six to eight. Release checks route the full Gateway build and four Gateway test
shards to the existing `blacksmith-32vcpu-ubuntu-2404` profile through
`gateway_repo_e2e_use_github_hosted_runners: false`. This uses five Blacksmith
registrations per campaign, with at most four Gateway test runners at once;
UI, plugin, and other live-suite routing stays unchanged. Other callers default
the Gateway option to true and retain their overall hosted-runner choice.
A standalone Blacksmith invocation can register eleven runners: two producers
and nine test jobs. Producer artifact identities
survive consumer-only retries; consumers never select an artifact by their own
current attempt number.

The reusable live/E2E workflow asks `scripts/test-docker-all.mjs --plan-json` which package, image kind, live image, lane, and credential coverage is required. `scripts/docker-e2e.mjs` then converts that plan into GitHub outputs and summaries. It either packs OpenClaw through `scripts/package-openclaw-for-docker.mjs`, downloads a current-run package artifact, or downloads a package artifact from `package_artifact_run_id`, then validates the tarball inventory. The default `no-push-artifact` path builds package-digest-tagged bare/functional images through Blacksmith's Docker layer cache, packs the exact image bytes into an immutable workflow artifact, and has each consumer verify and load that artifact. `existing-only` instead requires explicit `docker_e2e_bare_image`/`docker_e2e_functional_image` GHCR refs and never builds or pushes. Those registry pulls use a bounded 180-second per-attempt timeout so a stuck stream retries quickly instead of consuming most of the CI critical path. After successful scheduled validation, `openclaw-scheduled-live-checks.yml` passes the immutable tested-image manifest to the separate package-write publisher; read-only release and prerelease callers never traverse that writer.

### Release-path chunks

Release Docker coverage runs smaller chunked jobs with `OPENCLAW_SKIP_DOCKER_BUILD=1` so each chunk verifies and loads only the artifact-backed image kind it needs (or pulls it under explicit `existing-only` reuse) and executes multiple lanes through the same weighted scheduler:

- `OPENCLAW_DOCKER_ALL_PROFILE=release-path`
- `OPENCLAW_DOCKER_ALL_CHUNK=core | package-update-openai | package-update-onboarding | package-update-migrations | package-update-self-upgrade | plugins-runtime-plugins | plugins-runtime-services | plugins-runtime-install-a..h | openwebui`

Current release Docker chunks are `core`, `package-update-openai`, `package-update-onboarding`, `package-update-migrations`, `package-update-self-upgrade`, `plugins-runtime-plugins`, `plugins-runtime-services`, `plugins-runtime-install-a` through `plugins-runtime-install-h`, and `openwebui`. `package-update-openai` includes the live Codex plugin package lane, which installs the candidate OpenClaw package, installs the Codex plugin from `codex_plugin_spec` or a same-ref tarball with explicit Codex CLI install approval, runs Codex CLI preflight and same-session agent turns, then runs a zero-retry medium-thinking turn that sends progress, reads randomized workspace inputs, writes their exact artifact, and sends completion. `plugins-runtime-core`, `plugins-runtime`, and `plugins-integrations` remain aggregate plugin/runtime aliases. The `install-e2e` lane alias remains the aggregate manual rerun alias for both provider installer lanes.

The stable/full Docker `core` chunk includes `live-anthropic-cache`. It sends eight
bounded requests through the candidate package's Anthropic provider and managed
transport, checking conversation cache reuse while temporary runtime context
moves past two real tool results and a subsequent user turn. Missing credentials,
incorrect cache markers, changed cached prefixes, or repeated history writes fail
the lane without retries. This supplements the source-based live cache floors;
it does not exercise Gateway session scheduling.
The scheduler declares `anthropic-api-key` for this lane, and both full-chunk and
targeted-lane preflights require `ANTHROPIC_API_KEY` specifically; OAuth credentials
remain accepted for the other Anthropic lanes that support them.

Provider-neutral package checks run in three balanced rows: onboarding and install switching, channel/published migrations, and self-upgrades. This avoids serializing eight npm-heavy lanes behind one runner's npm resource limit. The aggregate `package-update-core` and `package-update` names remain available for manual runs. The `package-update-openai` row also runs root-managed VPS upgrade and authenticated update restart proof. Scheduler resource limits remain unchanged. Credential preflight failures remain blocking while the following diagnostic pool drains non-live lanes; earlier setup failures and cancellation still prevent execution.

OpenWebUI runs as a standalone `openwebui` chunk on a dedicated large-disk Blacksmith runner whenever stable or full release-path coverage requests it, even when the reusable workflow routes supported jobs to GitHub-hosted runners. Keeping the external image pull separate prevents the large image from competing with the shared package and plugin images in `plugins-runtime-services`; legacy aggregate plugin/runtime chunks still include OpenWebUI for compatible manual reruns. Bundled-channel update lanes retry once for transient npm network failures.

Each chunk uploads `.artifacts/docker-tests/` with lane logs, timings, `summary.json`, `failures.json`, phase timings, scheduler plan JSON, slow-lane tables, and per-lane rerun commands. The workflow `docker_lanes` input runs selected lanes against images prepared for that run instead of the chunk jobs, which keeps failed-lane debugging bounded to one targeted Docker job; if a selected lane is a live Docker lane, the targeted job builds the live-test image locally for that rerun. The rerun helper validates the failure artifact's exact selected target SHA and manual dispatch repacks that ref, because the internal reusable-workflow package tuple is not part of the `workflow_dispatch` schema. Generated commands include prepared image inputs and `shared_image_policy=existing-only` only when those inputs are GHCR-backed; runner-local artifact tags are omitted so a fresh runner rebuilds them. An explicit target override drops recovered GHCR image refs unless the artifact proves they match the override. Artifact-generated workflow-definition refs are also omitted because full-release temporary branches are deleted; dispatch uses the repository default branch unless the operator explicitly overrides it.

```bash
pnpm test:docker:rerun <run-id>      # download Docker artifacts and print combined/per-lane targeted rerun commands
pnpm test:docker:timings <summary>   # slow-lane and phase critical-path summaries
```

The scheduled live/E2E workflow runs the full release-path Docker suite daily and, after it succeeds, invokes the explicit publisher for the exact tested image artifacts.
