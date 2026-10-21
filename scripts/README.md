---
summary: "Repository script entry points and compatibility notes"
read_when:
  - Looking for an existing script before adding a new one
  - Running repository checks, tests, docs, Docker, release, or GitHub helper scripts
  - Updating package scripts or CI workflow script references
title: "Scripts Directory"
---

# Scripts Directory

The `scripts/` directory contains repository tooling used by local development,
CI, docs publishing, releases, Docker proof, and maintainer operations. Prefer
the package-script entry points in `package.json` when one exists, then read the
underlying script before running it directly.

## Compatibility

Many scripts are stable paths referenced by `package.json`, GitHub Actions,
docs, and maintainer runbooks. Do not move, rename, or regroup scripts only to
improve taxonomy. A directory migration needs an explicit maintainer-approved
compatibility plan for package scripts, workflows, docs snippets, and any raw
script paths users may have copied.

This index is a discovery aid for the current flat layout. It does not define a
new directory taxonomy.

## Common Entry Points

| Area            | Prefer                                                                         | Notes                                                                                                               |
| --------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Build           | `pnpm build`                                                                   | Runs `scripts/build-all.mts`; use specific build scripts only when debugging a build stage.                         |
| Changed checks  | `pnpm changed:lanes --json`, `pnpm check:changed`                              | Lane classification lives in `scripts/changed-lanes.mjs`; changed-file checks live in `scripts/check-changed.mjs`.  |
| Docs            | `pnpm docs:list`, `pnpm docs:check-mdx`, `pnpm docs:check-links`               | Backed by `scripts/docs-list.js`, `scripts/check-docs-mdx.mjs`, and `scripts/docs-link-audit.mjs`.                  |
| Formatting docs | `pnpm format:docs:check`                                                       | Uses `scripts/format-docs.mts`; use write mode only when intentionally formatting docs.                             |
| Lint            | `pnpm lint`, `pnpm lint:core`, `pnpm lint:all`                                 | Wrapper scripts keep oxlint behavior aligned with repo config.                                                      |
| Targeted tests  | `pnpm test <path-or-filter>` or `node scripts/run-vitest.mjs <path-or-filter>` | Avoid bare `vitest`; it can start watch mode.                                                                       |
| Changed tests   | `pnpm test:changed`                                                            | Uses the repo's changed-test resolver instead of a broad Vitest run.                                                |
| Docker proof    | `pnpm test:docker:all`, `pnpm test:docker:rerun`, `pnpm test:docker:timings`   | Use the planner/rerun helpers before launching broad Docker work.                                                   |
| Live proof      | `pnpm test:live`                                                               | Live checks require the matching environment and credentials.                                                       |
| Release checks  | `pnpm release:check`, `pnpm release:beta`, `pnpm release:candidate`            | Release scripts are maintainer workflows; read release docs before use.                                             |
| GitHub reads    | `scripts/gh-read`                                                              | Uses a GitHub App read token when configured, leaving normal `gh` login for writes.                                 |
| Commits         | `git add <files...>` then `git commit -m "<message>"`                          | Stage only the intended files for each commit.                                                                      |
| Remote proof    | `node scripts/crabbox-wrapper.mjs ...`                                         | Use when the current host lacks the required isolation, OS, device, or capacity; sync each run and reuse the lease. |

## Control UI development benchmark

Measure CLI-to-listening readiness without a browser or source edits:

```sh
node --import ./scripts/tsx.mjs scripts/bench-control-ui-dev-loop.mts \
  --root <checkout> --mode warm --samples 5 --startup-only \
  --label candidate --out-dir <proof-dir>
```

For before/after comparisons, alternate checkouts with `--samples 1`, run serially,
and report the samples, median, p95, range, and recorded host load. `--mode cold`
passes Vite's `--force` to rebuild optimizer inputs; it does not clear OS caches.
`--mode warm` omits `--force` and assumes an existing valid optimizer cache.
Startup-only mode stops at Vite's listening banner and cannot prime an empty cache:
load the UI first, then check the retained server logs for re-optimization.
Readiness is separate from a loaded application's boot time.

Omit `--startup-only` to render the real chat loading component, change its first
skeleton width from 82% to 42%, and measure the visible update after the Vite
WebSocket connects. The benchmark rejects full-page reloads, saves synthetic
screenshots and logs, and restores its own source edit and temporary fixtures,
including on SIGINT/SIGTERM. Use a task-owned checkout without concurrent edits.

If file edits produce no Vite update, try the existing watcher opt-in:

```sh
CHOKIDAR_USEPOLLING=1 pnpm ui:dev
```

The same environment setting applies to the benchmark. Polling uses more CPU;
leave it opt-in for hosts where native directory events are unavailable. On macOS,
the Vite config resolves this setting before Chokidar selects its native backend.

## Formatting and lint selection

`lib/dev-tool.mts` selects the pinned Bun fork for local formatting, with an
oxfmt fallback, and oxlint for linting. CI formatting still gates on oxfmt and
checks Bun parity. See the
[local development tools reference](https://docs.openclaw.ai/reference/test/local#openclaw-bun-fork)
for overrides, staging, and benchmark details. On a clean AWS `c7a.8xlarge`,
three interleaved runs measured `pnpm format` at 0.62 s with Bun versus 1.41 s
with oxfmt, and `pnpm format:check` at 0.62 s versus 1.38 s. The loaded Mac
sanity run measured 15.65 s versus 14.74 s for writes and 14.31 s versus 16.40 s
for checks; the write gain is not universal. `DEFAULT_LINT_TOOL` waits for upstream commit
`b39aa848` and diagnostic parity. Bun receives the repository's existing
configuration; no separate formatter configuration is maintained.

| Caller                                                                                                                                | Selection and reason                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `format`, `format:check`, `format:fix`, `format:diff`, `format:all`                                                                   | `run-format.mts` uses the selector. In CI, checks compare oxfmt and Bun on identical arguments and require oxfmt success.         |
| `check.mts`, `check-changed.mts`, `ci-check-plan.mts`, `ci.yml`                                                                       | Consume `format:check`, including CI parity, without another job or runner.                                                       |
| `pre-commit/format-staged.sh`, `.pre-commit-config.yaml`                                                                              | `run-node-tool.sh` uses the selector when dependencies exist; index-only formatting and partial staging remain owned by the hook. |
| Dependency-less `pre-commit/run-node-tool.sh` recovery                                                                                | Retains its verified tooling-owner oxfmt fallback so code-only checkouts can satisfy the CI gate without installing dependencies. |
| `run-lint.mts` and `run-oxlint-shards.mts`                                                                                            | `run-oxlint.mts` selects the executable after existing scope/resource preparation; all shards honor the override.                 |
| `format-docs.mts`                                                                                                                     | Retains oxfmt for the dedicated docs CI gate and temporary-copy checks.                                                           |
| `lib/format-generated-module.mts`, `generate-prompt-snapshots.ts`, `lib/codex-app-server-protocol-source.ts`                          | Retain oxfmt so generated modules, snapshots, and protocol bytes match CI regeneration.                                           |
| `generate-control-ui-validators.mts`, `plugin-sdk-shipped-surface.mts`, `database-worker-inventory.mjs`, `qa/render-maturity-docs.ts` | Retain the oxfmt API for reproducible generated-artifact gates, including explicit per-artifact options.                          |
| `crabbox-hydrate.yml`                                                                                                                 | Only verifies the oxfmt dependency is installed for CI; does not invoke formatting.                                               |

There is no lint-staged formatter configuration; staged-file formatting belongs
to the hooks above. References in configuration, test fixtures, and scope
classifiers do not invoke a formatter.

## Script Families

The database-worker ratchet always analyzes current sources, including personal
credential writers. Its historical inventory reuses the build-artifact cache
under `.artifacts`: the key includes the base Git tree, analyzer/config source,
native compiler/API bytes, Node version, platform and checkout path. One base
generation is retained per cache root; changed inputs or damaged outputs rebuild
it. The complete semantic program is preserved on cache misses.

- `check-*.mts` / `check-*.ts` / retained `check-*.mjs`: guardrails for architecture, docs, package
  contents, boundaries, workflows, and generated artifacts.
- `run-*.mjs` / `run-*.mts`: stable wrappers and typed implementations for Node, Vitest,
  oxlint, tsgo, and environment setup.
- `test-*.mts` / retained `test-*.mjs` / `test-*.sh` / `test-*.ts`: test planners, Docker lanes, live
  checks, and focused validation helpers.
- `docs-*` and `check-docs-*`: docs listing, link auditing, MDX checks,
  spellcheck, sync, and i18n glossary checks.
- `release-*`, `openclaw-npm-*`, and `plugin-*-release-*`: release preparation,
  package verification, and publishing helpers.
- `docker-*`, `test-docker-*`, and `test-live-*-docker.sh`: Docker E2E planning,
  rerun, timing, and live/package lane helpers.
- `gh-read*`, `label-*`, `sync-labels.ts`, and PR helpers: GitHub read,
  labeling, and maintainer workflow support.
- `generate-*`, `write-*`, `copy-*`, and `sync-*`: generated docs, metadata,
  package surfaces, and build artifact support.
- `lib/`: shared helpers imported by script entry points.

## Maintenance Rules

- Read `scripts/AGENTS.md` before changing scripts.
- Keep package scripts, generators, generated-artifact checks, docs references,
  and workflow references aligned when touching a script path.
- Prefer existing wrappers instead of introducing a raw tool invocation.
- Add or update focused tests under `test/scripts/` when changing script
  behavior.

See also [Scripts](https://docs.openclaw.ai/help/scripts) for public-facing script guidance.
