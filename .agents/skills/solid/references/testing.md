# Testing Solid code

Follow [writing tests](../../../../docs/help/testing/writing-tests.md), [test-audit](../../test-audit/SKILL.md), and [OpenClaw testing](../../openclaw-testing/SKILL.md). Keep assertions when you replace a harness; delete a test only when its behavior is gone.

## Helpers (`ui/src/test-helpers/`)

- **`mountSolid(() => view, options)`** (`mount-solid.ts`) returns scoped queries, `container`, and an idempotent `unmount()`. Roots are disposed after each test and before the shared-worker reset. Helper-created containers are removed; caller-supplied ones remain.
- **`createSolidApplicationContextProvider(context)`** (`solid-application-context.tsx`) as the mount's `wrapper` shares the Lit harness's Gateway snapshot and event fixtures. `setContext(next)` retires and remounts consumers.
- **`flush` and `waitForSolid`** (`solid-settle.ts`): `flush()` applies pending synchronous signal writes; `waitForSolid(() => expect(...))` awaits an observable async outcome. `flush()` doesn't settle promises or browser layout.
- **`renderSolidRef(() => ref, { targetElement, ...options })`** (`render-solid-ref.ts`) tests ref factories; it forwards container, wrapper, query, and hydration options that Testing Library beta.3 drops.
- Retained Lit children still need their own `updateComplete` boundary (`components/option-card.test.ts` shows the mixed-renderer pattern).

## Discovery and runners

- `.test.tsx` files are discovered by the UI Vitest config and `test/vitest/vitest.ui-paths.mjs`. Confirm a new test file actually appears in the run; a silently skipped file is worse than a failing one.
- The shared non-isolated runner keeps **one Solid module graph per worker**. It skips re-evaluating `solid-js`/`@solidjs/*` between files, because re-evaluation splits the scheduler and context graph. Don't reintroduce `vi.resetModules()` there; the runner's own reset already covers it.
- Pre-optimize the Solid runtime packages that browser tests use in `ui/vitest.config.ts`'s `optimizeDeps.include`. When Vite discovers a dependency mid-run, it re-optimizes and reloads, which shows up as lost suite context or "duplicate custom element" errors in WebKit. Add the package there instead of chasing the symptom.
- Non-UI Vitest projects (Gateway, core, extensions) compile UI `.tsx` through the shared, **scoped** Solid transform in `ui/config/control-ui-solid.ts` (include globs `ui/**/*.tsx`, `extensions/*/browser/**/*.tsx`; `environment: "node"` pinned). Never add the Solid plugin unscoped: it silently switches the test environment to `jsdom`.
- Bun-only `WeakRef` retention flakes come from JSC's conservative GC; those suites run on Node.

## E2E

- E2E selects host tags and classes, which is why both stay stable.
- Wait on the readiness contract, never on timers: `window.openclawControlUi?.snapshot()` facts (`routeReady`, `gatewayPhase`, `rosterReady`, …). The hook loads lazily on first read, so a one-shot read must first `waitForFunction(() => window.openclawControlUi !== undefined)`.
- Overlay and focus changes need WebKit runs as well as Chromium.

## Visual parity

`pnpm ui:parity` captures the scene gallery (924 shots across profiles) on two builds and diffs them. Run it on your merge base and your head for the routes and states you touched. Same-SHA captures are deterministic except an explicit, documented list of known-nondeterministic shots (Apps image clipping). One-level color noise is reported separately. Inspect the gallery before claiming parity, and embed sanitized before/after screenshots in the PR for visual changes.

## Quantitative gates

The chat gates (see [state and ownership](state-and-ownership.md#chat-render-lifecycle)) and the three `WeakRef` + `collectGarbageForTest` suites must stay green. Solid owners and closures can add strong retention without any visible failure, and these suites are the only thing that notices.

## Where proof runs

Follow the canonical [proof policy](../../openclaw-testing/SKILL.md#proof-policy)
for local, PR CI, and exceptional remote proof; use the owning UI/Gateway lane
for the changed contract.
