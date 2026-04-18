# Quality & Testing Patterns

**Analysis Date:** 2026-04-18

## Test Framework

**Runner:** Vitest ^4.1.4 (`package.json:1442`).
**Coverage:** `@vitest/coverage-v8` ^4.1.4, thresholds 70% lines/branches/functions/statements (`.claude/rules/testing-guidelines.md`).
**Config topology:** 82 Vitest config files under `test/vitest/` (root `vitest.config.ts` re-exports from `test/vitest/vitest.config.ts`). Per-surface configs keep scope narrow:

- `vitest.unit.config.ts`, `vitest.unit-fast.config.ts`, `vitest.fast.*`
- `vitest.gateway.config.ts`, `vitest.channels.config.ts`, `vitest.commands.config.ts`
- `vitest.e2e.config.ts`, `vitest.live.config.ts`
- `vitest.contracts.config.ts` (plugin + channel contract invariants)
- `vitest.bundled.config.ts`, `vitest.extensions.config.ts`, plus ~25 per-extension configs (`vitest.extension-<id>.config.ts`).
- Pool is native root-project `threads` by default, with hard `forks` exceptions for `gateway`, `agents`, and `commands` (`.claude/rules/testing-guidelines.md` "Test Execution").

**Run commands:**

```bash
pnpm test                    # Default routed runner (scripts/test-projects.mjs)
pnpm test:fast               # vitest.unit.config.ts
pnpm test:coverage           # With V8 coverage
pnpm test:changed            # --changed origin/main (scoped runs)
pnpm test:gateway            # Gateway suite
pnpm test:contracts          # Plugin + channel contract tests
pnpm test:live               # Live-key suite (OPENCLAW_LIVE_TEST=1)
pnpm test:docker:*           # Per-surface Docker E2E
pnpm test:parallels:<os>     # VM smoke suites
```

**Scale:**

- `src/`: **2,681** `*.test.ts` files alongside **3,794** non-test TS files — roughly 1 test file per 1.4 source files.
- `extensions/`: **1,279** `*.test.ts` files alongside **2,645** non-test TS files — ~1 test per 2 source files.
- Total coverage is enforced at 70% minimum.

## Test File Organization

**Location:** Tests are co-located with source as `*.test.ts` (`.claude/rules/testing-guidelines.md`).
**Naming:**

- Unit: `foo.ts` + `foo.test.ts`.
- E2E: `foo.e2e.test.ts`.
- Live (real keys): `foo.live.test.ts`.
- Integration: `foo.integration.test.ts`.
- Coverage-only supplements: `foo.coverage.test.ts`.
- Scoped configs use matching `*-paths.mjs` / `*-paths.ts` helpers to pin glob scope (`test/vitest/vitest.channel-paths.mjs`, `vitest.bundled-plugin-paths.ts`).

## Test Performance Guardrails

Documented in `.claude/rules/testing-guidelines.md`. Enforced in review, not by code:

- Avoid `vi.resetModules()` + `await import(…)` in `beforeEach` for heavy modules. Import once in `beforeAll` and reset mocks in `beforeEach`.
- Do **not** partial-mock broad `openclaw/plugin-sdk/*` barrels in hot tests — add a plugin-local `*.runtime.ts` seam.
- Prefer narrow public SDK subpaths (`models-provider-runtime`, `skill-commands-runtime`, `reply-dispatch-runtime`) over broad helper barrels.
- Worker budget derived from host (CPU, memory band, load). Hard cap at 16; `OPENCLAW_VITEST_MAX_WORKERS=1` for conservative runs.
- Import-dominated test time is treated as a boundary bug.

## Coding Conventions

**Naming:**

- Files: `lowercase-with-hyphens.ts` (`.claude/rules/local-runtime-platform.md` "Descriptive lowercase-hyphen file names").
- Headings: product is **OpenClaw**; CLI / package / paths / config keys use `openclaw` (`.claude/rules/coding-style.md`).
- Written English: American spelling in code, comments, docs, UI strings.

**Type discipline:**

- TypeScript ESM, strict typing.
- `@ts-nocheck` is banned; inline lint suppressions discouraged. Survey across `src/`: 9 files touch `@ts-ignore` / `@ts-expect-error` / `eslint-disable` / `oxlint-disable` in total — practically zero in production code.
- `any` usage is small and mostly test-only. Survey: 22 files across `src/`, almost all are `*.test.ts` (`src/channels/plugins/setup-wizard-helpers.test.ts:12`, `src/agents/tool-policy-pipeline.test.ts:13`, `src/agents/pi-tools.before-tool-call.integration.e2e.test.ts:10`, etc.). Production `any` occurrences: `src/config/types.channels.ts`, `src/agents/agent-scope.ts`, `src/agents/tools/common.ts`, `src/agents/skills-clawhub.ts`, `src/agents/subagent-spawn.ts`, `src/agents/subagent-attachments.ts`, `src/agents/pi-embedded-runner/run/images.ts`, `src/agents/pi-embedded-messaging.ts`, `src/agents/pi-embedded-helpers/failover-matches.ts` — single-digit per file.
- `zod` / `typebox` at every external boundary (config, webhook payloads, CLI/JSON output, Gateway protocol, persisted JSON).
- Discriminated unions preferred over runtime string switches; `Result<T, E>`-style outcomes preferred over thrown errors for recoverable cases (`.claude/rules/coding-style.md`).
- No `?? 0` / empty-string / magic-string sentinels for runtime control flow.
- Prototype mutation (`applyPrototypeMixins`, `Class.prototype.method = …`) forbidden outside explicitly-approved cases.

**TODO density:** Survey across `src/**/*.ts` — only 5 files contain `TODO`/`FIXME`/`HACK`/`XXX` markers (`src/cron/isolated-agent/session.test.ts`, `src/auto-reply/heartbeat.ts`, `src/agents/pi-hooks/compaction-safeguard.test.ts`, `src/agents/pi-hooks/compaction-safeguard-quality.ts`, `src/agents/compaction.ts`). Unusually low density for a codebase this size.

**File size guideline:** "aim under ~700 LOC" — guideline, not a hard guardrail. 14 production files still exceed 1,500 LOC (see `CONCERNS.md`). Enforcement via `pnpm check:loc` (`scripts/check-ts-max-loc.ts --max 500`, guideline only).

## Formatting / Linting

- **Format:** `oxfmt` 0.44 (`pnpm format`, `pnpm format:fix`, `pnpm format:check`). Pre-commit hook runs `pnpm format` then `pnpm check`. `FAST_COMMIT=1` skips the hook's repo-wide pass.
- **Lint:** `oxlint` ^1.59 + `oxlint-tsgolint` (`pnpm lint` → `scripts/run-oxlint.mjs`).
- **Architecture lints:** The `pnpm check` pipeline (`package.json:1111`) chains many custom scripts:
  - `check:no-conflict-markers`, `tool-display:check`, `check:host-env-policy:swift`
  - `check:import-cycles` + `check:madge-import-cycles` (runtime + static SCC detection)
  - `tsgo` (type check)
  - `prepare-extension-package-boundary-artifacts.mjs`
  - `lint` + per-surface guards: `lint:webhook:no-low-level-body-read`, `lint:auth:no-pairing-store-group`, `lint:auth:pairing-account-scope`.
  - Additional boundary guards (run in CI `check-additional`): `lint:extensions:no-plugin-sdk-internal`, `lint:extensions:no-relative-outside-package`, `lint:extensions:no-src-outside-plugin-sdk`, `lint:plugins:no-extension-imports`, `lint:plugins:no-extension-src-imports`, `lint:plugins:no-extension-test-core-imports`, `lint:plugins:no-monolithic-plugin-sdk-entry-imports`, `lint:plugins:no-register-http-handler`, `lint:plugins:plugin-sdk-subpaths-exported`, `lint:tmp:channel-agnostic-boundaries`, `lint:tmp:no-random-messaging`, `lint:tmp:no-raw-channel-fetch`, `lint:ui:no-raw-window-open`, `lint:web-fetch-provider-boundaries`, `lint:web-search-provider-boundaries`.

## Contract / Drift Detection

Built around SHA-256 hash files in `docs/.generated/`:

- `pnpm config:schema:gen` / `:check` — base config zod schema.
- `pnpm config:docs:gen` / `:check` — config help/labels baseline.
- `pnpm config:channels:gen` / `:check` — bundled channel config metadata.
- `pnpm plugin-sdk:api:gen` / `:check` — public Plugin SDK API baseline.
- `pnpm plugin-sdk:check-exports` / `:sync-exports` — `package.json exports` ↔ SDK module parity.
- `pnpm protocol:gen` / `:check` — Gateway protocol schema + Swift codegen parity (also touches `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`, `apps/shared/OpenClawKit/…`).
- `pnpm runtime-sidecars:check` — runtime sidecar path baseline.
- `pnpm codex-app-server:protocol:check` — Codex app server protocol drift.
- `pnpm canon:check` — repo-wide canonical invariants.
- `pnpm tool-display:check` — tool display/metadata baseline.

These gates are the load-bearing mechanism that prevents contract rot.

## Dead Code Reporting

`pnpm deadcode:report` runs three passes and writes reports under `.artifacts/deadcode/`:

- `knip` (`pnpm deadcode:knip`, config `knip.config.ts:1`)
- `ts-prune` (`pnpm deadcode:ts-prune`)
- `ts-unused-exports` (`pnpm deadcode:ts-unused`)

CI variants drop results into `.artifacts/deadcode/*.txt` for reviewer inspection.

## Duplication

`pnpm dup:check` uses `jscpd` 4.0.9 with min-lines 12 / min-tokens 80 across `src extensions test scripts`.

## Live / Integration Tests

- Default `pnpm test:live` is quiet; `[live]` progress lines only. Full logs: `OPENCLAW_LIVE_TEST_QUIET=0 pnpm test:live`.
- Dockerized live suites exist for model providers (`test:docker:live-models`, `-gateway`, `-cli-backend`, `-acp-bind`), onboarding (`test:docker:onboard`), install scripts (`test:install:smoke`, `test:install:e2e`), QA lab (`test:docker:openwebui`, `test:docker:mcp-channels`, `test:docker:plugins`), and doctor-switch parity.
- Parallels VM smoke tests for macOS, Linux, Windows, and npm-update parity (`pnpm test:parallels:*`). Covered by `.agents/skills/openclaw-parallels-smoke/SKILL.md`.

## Benchmarks & Budgets

- CLI startup: `pnpm test:startup:bench`, `bench:save`, `bench:smoke`, `bench:update`, `bench:check` (budget gate via `scripts/test-cli-startup-bench-budget.mjs`).
- Startup memory: `pnpm test:startup:memory`.
- Per-suite perf: `pnpm test:perf:budget`, `test:perf:hotspots`, `test:perf:imports`, `test:perf:profile:*`, `test:perf:changed:bench`.

## Structural Patterns

**Dependency injection:**

- `createDefaultDeps` (`src/cli/deps.ts`, re-exported from `src/library.ts:3`) is the canonical DI factory. Tests substitute narrow subsets; production code passes the default.

**Lazy module loading:**

- Hot entrypoints use the pattern:
  ```ts
  let modPromise: Promise<typeof import("./heavy.js")> | null = null;
  function load() {
    modPromise ??= import("./heavy.js");
    return modPromise;
  }
  export const doThing = async (...args) => (await load()).doThing(...args);
  ```
  Example: `src/library.ts:31-74`.
- Dynamic-import guardrail: never mix static + dynamic import for the same module (`.claude/rules/coding-style.md`).

**Plugin-local seams:**

- Plugins expose `api.ts`, `runtime-api.ts`, `contract-api.ts`, `test-api.ts`, and an `index.ts` entry. Core reaches them only through `src/plugin-sdk/<id>.ts` facades or `src/test-utils/bundled-plugin-public-surface.ts`.

**Prompt-cache stability:**

- `.claude/rules/prompt-cache-stability.md` mandates deterministic ordering whenever payloads are assembled from maps, sets, registries, or plugin lists. Cache-sensitive changes require regression tests that prove turn-to-turn prefix stability.

## Mocking Norms

- Prefer explicit mock factories over `importOriginal()` for broad modules.
- Per-instance stubs preferred over prototype mutation.
- When production code accepts `deps` / callbacks / runtime injection, use that seam instead of module-level mocks.
- Tests must clean up timers, env, globals, mocks, sockets, temp dirs, and module state so `--isolate=false` stays green (`.claude/rules/testing-guidelines.md`).

## Pre-Commit / CI Hooks

- Local: `prek install` sets up the pre-commit hook (`AGENTS.md:35`).
- Hook runs `pnpm format` then `pnpm check`.
- `FAST_COMMIT=1` skips the repo-wide passes only; does not change CI.
- `git-hooks/` contains the managed hook scripts (`pnpm prepare` wires `core.hooksPath`).
- CI lanes: `.github/workflows/ci.yml` (main), `codeql.yml`, `install-smoke.yml`, `openclaw-release-checks.yml`, `docker-release.yml`, `macos-release.yml`, `openclaw-npm-release.yml`, `plugin-clawhub-release.yml`, `plugin-npm-release.yml`, `sandbox-common-smoke.yml`, `workflow-sanity.yml`, `docs-sync-publish.yml`, `docs-translate-trigger-release.yml`.

## Release Validation

`pnpm release:check` chains `check:base-config-schema && check:bundled-channel-config-metadata && config:docs:check && plugin-sdk:check-exports && plugin-sdk:api:check && release-check.ts`. A release cannot land without all drift-detection hash files being current.

---

_Quality analysis: 2026-04-18_
