---
name: openclaw-testing
description: Choose, run, rerun, or debug OpenClaw tests, CI checks, Docker E2E lanes, release validation, and the cheapest safe verification path.
---

# OpenClaw Testing

Use this skill when deciding what to test, debugging failures, rerunning CI,
or validating a change without wasting hours.

## Read First

- `docs/reference/test.md` for local test commands.
- `docs/ci.md` for CI scope, release checks, Docker chunks, and runner behavior.
- Scoped `AGENTS.md` files before editing code under a subtree.

## Default Rule

Prove the touched surface first. Do not reflexively run the whole suite.

1. Inspect the diff and classify the touched surface:
   - source: `pnpm changed:lanes --json`, then `pnpm check:changed`
   - tests only: `pnpm test:changed`
   - one failing file: `pnpm test <path-or-filter> -- --reporter=verbose`
   - workflow-only: `git diff --check`, workflow syntax/lint (`actionlint` when available)
   - docs-only: `pnpm docs:list`, docs formatter/lint only if docs tooling changed or requested
2. Reproduce narrowly before fixing.
3. Fix root cause.
4. Rerun the same narrow proof.
5. Broaden only when the touched contract demands it.

## Guardrails

- Do not kill unrelated processes or tests. If something is running elsewhere, treat it as owned by the user or another agent.
- Do not run expensive local Docker, full release checks, full `pnpm test`, or full `pnpm check` unless the user asks or the change genuinely requires it.
- Prefer GitHub Actions for release/Docker proof when the workflow already has the prepared image and secrets.
- Use `scripts/committer "<msg>" <paths...>` when committing; stage only your files.
- If deps are missing, run `pnpm install`, retry once, then report the first actionable error.

## Local Test Shortcuts

```bash
pnpm changed:lanes --json
pnpm check:changed       # changed typecheck/lint/guards; no Vitest
pnpm test:changed        # cheap smart changed Vitest targets
OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed
pnpm test <path-or-filter> -- --reporter=verbose
OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test <path-or-filter>
```

Use targeted file paths whenever possible. Avoid raw `vitest`; use the repo
`pnpm test` wrapper so project routing, workers, and setup stay correct.

## Command Semantics

- `pnpm check` and `pnpm check:changed` do not run Vitest tests. They are for
  typecheck, lint, and guard proof.
- `pnpm test` and `pnpm test:changed` run Vitest tests.
- `pnpm test:changed` is intentionally cheap by default: direct test edits,
  sibling tests, explicit source mappings, and import-graph dependents.
- `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed` is the explicit broad
  fallback for harness/config/package edits that genuinely need it.
- Do not run extension sweeps just because core changed. If a core edit is for a
  specific plugin bug, run that plugin's tests explicitly. If a public SDK or
  contract change needs consumer proof, choose the smallest representative
  plugin/contract tests first, then broaden only when the risk justifies it.
- The test wrapper prints a short `[test] passed|failed|skipped ... in ...`
  line. Vitest's own duration is still the per-shard detail.

## Routing Model

- `pnpm changed:lanes --json` answers "which check lanes does this diff touch?"
  It is used by `pnpm check:changed` for typecheck/lint/guard selection.
- `pnpm test:changed` answers "which Vitest targets are worth running now?" It
  uses the same changed path list, but applies a cheaper test-target resolver.
- Direct test edits run themselves. Source edits prefer explicit mappings,
  sibling `*.test.ts`, then import-graph dependents. Shared harness/config/root
  edits are skipped by default unless they have precise mapped tests.
- Public SDK or contract edits do not automatically run every plugin test.
  `check:changed` proves extension type contracts; the agent chooses the
  smallest plugin/contract Vitest proof that matches the actual risk.
- Use `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed` only when a harness,
  config, package, or unknown-root edit really needs the broad Vitest fallback.

## CI Debugging

Start with current run state, not logs for everything:

```bash
gh run list --branch main --limit 10
gh run view <run-id> --json status,conclusion,headSha,url,jobs
gh run view <run-id> --job <job-id> --log
```

- Check exact SHA. Ignore newer unrelated `main` unless asked.
- For cancelled same-branch runs, confirm whether a newer run superseded it.
- Fetch full logs only for failed or relevant jobs.

## Docker

Docker is expensive. First inspect the scheduler without running Docker:

```bash
OPENCLAW_DOCKER_ALL_DRY_RUN=1 pnpm test:docker:all
OPENCLAW_DOCKER_ALL_DRY_RUN=1 OPENCLAW_DOCKER_ALL_LANES=install-e2e pnpm test:docker:all
OPENCLAW_DOCKER_ALL_LANES=install-e2e node scripts/test-docker-all.mjs --plan-json
```

Run one failed lane locally only when explicitly asked or when GitHub is not
usable:

```bash
OPENCLAW_DOCKER_ALL_LANES=<lane> \
OPENCLAW_DOCKER_ALL_BUILD=0 \
OPENCLAW_DOCKER_ALL_PREFLIGHT=0 \
OPENCLAW_SKIP_DOCKER_BUILD=1 \
OPENCLAW_DOCKER_E2E_BARE_IMAGE='<prepared-bare-image>' \
OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE='<prepared-functional-image>' \
pnpm test:docker:all
```

For release validation, prefer the reusable GitHub workflow input:

```yaml
docker_lanes: install-e2e
```

Multiple lanes are allowed:

```yaml
docker_lanes: install-e2e bundled-channel-update-acpx
```

That skips the three chunk matrix and runs one targeted Docker job against the
prepared GHCR images and a fresh OpenClaw npm tarball for the selected ref.
Reruns usually need that new tarball because the fix being tested changed the
package contents even if the SHA-tagged GHCR Docker image can be reused.
Live-only targeted reruns skip the E2E images and build only the live-test
image. Release-path normal mode remains max three Docker chunk jobs:

- `core`
- `package-update`
- `plugins-integrations`

Docker E2E images never copy repo sources as the app under test: the bare image
is a Node/Git runner, and the functional image installs the same prebuilt npm
tarball that bare lanes mount. `scripts/package-openclaw-for-docker.mjs` is the
single packer for local scripts and CI and validates the tarball inventory
before Docker consumes it. `scripts/test-docker-all.mjs --plan-json` is the
scheduler-owned CI plan for image kind, package, live image, lane, and
credential needs. Docker lane definitions live in the single scenario catalog
`scripts/lib/docker-e2e-scenarios.mjs`; planner logic lives in
`scripts/lib/docker-e2e-plan.mjs`. `scripts/docker-e2e.mjs` converts plan and
summary JSON into GitHub outputs and step summaries. Every scheduler run writes
`.artifacts/docker-tests/**/summary.json` plus `failures.json`. Read those
before rerunning. Lane entries include `command`, `rerunCommand`, status,
timing, timeout state, image kind, and log file path. The summary also includes
top-level phase timings for preflight, image build, package prep, lane pools,
and cleanup. Use `pnpm test:docker:timings <summary.json>` to rank slow lanes
and phases before deciding whether a broader rerun is justified.

## Cheap Docker Reruns

First derive the smallest rerun command from artifacts:

```bash
pnpm test:docker:rerun <github-run-id>
pnpm test:docker:rerun .artifacts/docker-tests/<run>/failures.json
```

The script downloads Docker E2E artifacts for a GitHub run, reads
`summary.json`/`failures.json`, and prints a combined targeted workflow command
plus per-lane commands. Prefer the combined targeted command when several lanes
failed for the same patch:

```bash
gh workflow run openclaw-live-and-e2e-checks-reusable.yml \
  -f ref=<sha> \
  -f include_repo_e2e=false \
  -f include_release_path_suites=false \
  -f include_openwebui=false \
  -f docker_lanes='install-e2e bundled-channel-update-acpx' \
  -f include_live_suites=false \
  -f live_models_only=false
```

That path still runs the prepare job, so it creates a new tarball for `<sha>`.
If the SHA-tagged GHCR bare/functional image already exists, CI skips rebuilding
that image and only uploads the fresh package artifact before the targeted lane
job. Do not rerun the full three-chunk release path unless the failed lane list
or touched surface really requires it.

## Docker Expected Timings

Treat these as ballpark. Blacksmith queue time, GHCR pull speed, provider
latency, npm cache state, and Docker daemon health can dominate.

Current local timing artifact (`.artifacts/docker-tests/lane-timings.json`) has
these rough bands:

- Tiny lanes, seconds to under 1 minute:
  `agents-delete-shared-workspace` ~3s, `plugin-update` ~7s,
  `config-reload` ~14s, `pi-bundle-mcp-tools` ~15s, `onboard` ~18s,
  `session-runtime-context` ~20s, `gateway-network` ~34s, `qr` ~44s.
- Medium deterministic lanes, ~1-5 minutes:
  `npm-onboard-channel-agent` ~96s, `openai-image-auth` ~99s,
  bundled channel/update lanes usually ~90-300s, `openwebui` ~225s,
  `mcp-channels` ~274s.
- Heavy deterministic lanes, ~6-10 minutes:
  `bundled-channel-root-owned` ~429s,
  `bundled-channel-setup-entry` ~420s,
  `bundled-channel-load-failure` ~383s,
  `cron-mcp-cleanup` ~567s.
- Live provider lanes, often ~15-20 minutes:
  `live-gateway` ~958s, `live-models` ~1054s.
- Installer/release lanes:
  `install-e2e` and package-update paths can vary widely with npm, provider,
  and package registry behavior. Budget tens of minutes; prefer GitHub targeted
  reruns over local repeats.

Default fallback lane timeout is 120 minutes. A timeout usually means debug the
lane log/artifacts first, not “run the whole thing again.”

## Failure Workflow

1. Identify exact failing job, SHA, lane, and artifact path.
2. Read `failures.json`, `summary.json`, and the failed lane log tail.
3. Use `pnpm test:docker:rerun <run-id|failures.json>` to generate targeted
   GitHub rerun commands.
4. If the lane has `rerunCommand`, use that only as a local starting point.
5. For Docker release failures, dispatch targeted `docker_lanes=<failed-lane>`
   on GitHub before considering local Docker.
6. Patch narrowly, then rerun the failed file/lane only.
7. Broaden to `pnpm check:changed` or CI only after the isolated proof passes.

## When To Escalate

- Public SDK/plugin contract changes: run changed gate plus relevant extension
  validation.
- Build output, lazy imports, package boundaries, or published surfaces:
  include `pnpm build`.
- Workflow edits: run `pnpm check:workflows`.
- Release branch or tag validation: use release docs and GitHub workflows; avoid
  local Docker unless Peter explicitly asks.
