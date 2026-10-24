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

## Exact memory search benchmark

Use `scripts/bench-memory-search.mjs` against a disposable PostgreSQL database
with pgvector, pg_trgm, and unaccent installed. Set `PGMEMSEARCH_CONNECTION`,
`PGMEMSEARCH_OUT` (a new directory), and `PGMEMSEARCH_CHUNKS` to 20000 or 50000;
run it through `node --import ./scripts/tsx.mjs`. The deterministic corpus needs
no embedding provider. `--help` lists all inputs.

The benchmark interleaves 100 baseline/candidate pairs after five warmups for
vector, keyword, and hybrid retrieval. It captures every search statement,
EXPLAIN ANALYZE/BUFFERS, exact result hashes, p50/p95, and five paired blocks.
The candidate orders by the selected distance; the baseline repeats the bound
cosine expression. `PGMEMSEARCH_SOURCE_MODE` identifies which SQL shape the
checkout produces, so that arm executes unchanged. Eligibility, ranking, and
limits stay fixed. Compare the block deltas and spread at both corpus sizes;
unchanged hashes and statement counts are required before accepting a speedup.

Run `scripts/bench-memory-search-sqlite.mjs` with a separate fresh output
directory and the same chunk count for the production sqlite-vec KNN control.
Both benchmarks create synthetic state; stop and remove only their disposable
database state after collecting results.

## Control UI warm interactions

Build with `pnpm ui:build`, then collect the production renderer's desktop and
mobile interactions against the synthetic Gateway:

```sh
node --import ./scripts/tsx.mjs scripts/bench-control-ui-interactions.ts --trace
```

The report links each asserted step to its screenshot, explicit-mark trace,
source-mapped CPU profile, and interval RPC counts. It covers 1,000 sessions,
two 400-message transcripts, 1,000 models, and 500 Cron jobs. Sessions retains
its supported pagination; text search uses the command palette, not the sidebar.
Navigation setup is outside the measured interval. Native clocks and animations
remain enabled; profiling overhead is included and no live provider is called.
Cron search pastes one complete query so both builds perform the same Gateway
request; model and session searches use sequential key input. The separate
`cron-search-typing` scenario exposes burst-input request coalescing; compare its
request counts before interpreting latency differences as equal work.

Compare saved production builds serially with at least ten interleaved pairs:

```sh
node --import ./scripts/tsx.mjs scripts/bench-control-ui-interactions.ts \
  --bundle-dir <baseline> --compare-bundle-dir <candidate> --pairs 10 \
  --steps model-picker-open-search
```

Use `--viewport desktop` or `mobile` to narrow a diagnosis. Comparisons omit
profiling and report median, p95, and min–max; every cell over 20% worse is marked
for review. These are report-only measurements, not timing gates. Wall time is
automation-to-assertion time, not INP. Keep failed attempts alongside successful
captures and compare only runs with the same fixture, viewport, and collection mode.

## Control UI request waterfalls

The production-bundle cold-load harness can record usable-screen readiness,
Gateway request/reply times, exact duplicate method/parameter sets, overlapping
identical requests, resource timing, and renderer CPU counters. It reuses the
team-scale synthetic Gateway; these are renderer/mock measurements, not real
Gateway server timings.

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs scripts/bench-control-ui-cold-load.ts \
  --bundle-dir <built-control-ui> --first-load --runs 1 --face chat --untraced \
  --critical-path --session-switch --thread-cpu-time --latency-ms 0 --frame-gap-ms 0 \
  --output <proof-dir>
```

Use `--boot-route new` without `--session-switch` for New Session. The default
first-navigation order is Sessions, Settings (Appearance), Cron, Agents. Repeat
`--critical-path-route <name>` to select an order or isolate a single destination.
The harness reloads and settles the boot document before each destination, so
earlier pages cannot warm a later page's domain owner. With `--first-load`, it
first unloads to `about:blank`, clears all measured-origin storage and the browser
HTTP cache over its existing CDP session, and clears session storage on an empty
same-origin preparation document. That document seeds only the existing mock's
build identity; no application code runs there. These resets also run before
each sample. Cold here means fresh application owners, persistent application
storage, and HTTP cache; the Chromium process, V8 code caches, and OS caches remain
warm. Navigation starts after authoritative boot RPCs settle. The harness uses
existing navigation links and the Settings keyboard shortcut; opening the Pages
catalog is preparation outside the measured navigation interval. Each record has
its own document time origin.

For ten serial interleaved cold pairs in one process, add
`--compare-bundle-dir <candidate-control-ui> --runs 20`. Two or three bundle slots
are supported and every cycle must be complete. Use a second independent copy of
the baseline bundle as the comparison for an A/A control. The synthetic server,
fixture, and init scripts are shared; each measured document's owners and storage
are reset. `--gateway-url` remains restricted to one first-load sample without
bundle comparison, so real server-cache lifecycle remains externally controlled.
`--warm-reload` cannot be combined with `--first-load`; the existing persisted
warm-snapshot comparison path remains separate.

For the 100 ms RTT / 10 Mbps profile, replace `--latency-ms 0` with
`--latency-ms 100 --network-latency-ms 100 --download-kbps 10000` and add
`--cold-http-cache`. HTTP/CDP throttling does not affect the synthetic WebSocket,
so critical-path mode also applies the explicit RPC reply floor and serializes
received frame bytes at the selected download rate. HTTP and WebSocket traffic
use separate simulated pipes. The floor includes no real server work, and
serialized Gateway events may add their own fixture delay.

`run-1.critical-path.json` records document-clock start/readiness/capture times,
RPCs (including requests already in flight at interaction start), duplicate
groups, resource timings, and task/script/layout/style CPU milliseconds.
It also records compilation, DevTools command, other-task, and total thread CPU
counters when Chromium exposes them. Add `--cpu-profile` to save each selected
destination's `run-1.<route>.cpuprofile` and `run-1.<route>.trace.json` for attribution.
Profile base and candidate in separate invocations; bundle comparison accepts
only unprofiled runs.
Readiness is the first animation frame with visible transcript and enabled
composer (Chat), enabled composer (New Session), populated usable inventory
(Sessions/Cron/Agents), or visible Appearance controls and Settings search.
The record continues through 750 ms of RPC idle to retain secondary work; that
drain contributes to CPU totals but never to the readiness time. Use
`--thread-cpu-time` to exclude renderer descheduling from those totals on a loaded
host. These are
renderer-frame readiness measurements, not INP or proof that pixels reached a
physical display. Each destination also saves a synthetic screenshot.

Run ten serial interleaved base/head pairs per profile with identical fixture
options and report median, p95, min/max, RPC counts, and duplicate groups. Record
an A/A control on a loaded host; if that control exceeds the timing acceptance
band, use twenty interleaved pairs' CPU counters and structural request counts
for attribution. Keep traced/profiling captures separate from untraced timing
runs, and inspect request/chunk initiation against owner code before claiming
a causal waterfall: adjacent timestamps alone do not establish a dependency.

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

Fixed validators are emitted from their canonical schemas. Gateway, Control UI,
Codex, and plugin generators share the standalone TypeBox emitter in
`lib/typebox-standalone.mts`; it binds explicit static captures and rejects
unsupported ones.

| Schemas                                                     | Regenerate                             |
| ----------------------------------------------------------- | -------------------------------------- |
| Gateway protocol                                            | `pnpm gateway:validators:gen`          |
| Control UI protocol                                         | `pnpm ui:validators:gen`               |
| Codex app-server protocol                                   | `pnpm codex-app-server:validators:gen` |
| Model registry, theme, TypeSafe, and computer-use contracts | `pnpm static:validators:gen`           |

Run `pnpm validators:check` after schema changes to verify the committed
validators are current. CI runs this freshness check alongside the normal build.

- Read `scripts/AGENTS.md` before changing scripts.
- Keep package scripts, generators, generated-artifact checks, docs references,
  and workflow references aligned when touching a script path.
- Prefer existing wrappers instead of introducing a raw tool invocation.
- Add or update focused tests under `test/scripts/` when changing script
  behavior.

See also [Scripts](https://docs.openclaw.ai/help/scripts) for public-facing script guidance.
