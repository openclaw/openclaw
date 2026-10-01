# Tests

Read when writing or changing tests or configuring a test environment. Paths and commands in this document are repository-root
relative unless explicitly stated otherwise. The root AGENTS.md Arxi execution
and authorization rules apply to every example and linked skill.

- Use the current repository test runner and colocated tests. Derive supported live models from the owning provider catalog; preserve user-selected model/effort. Use the cheapest supported model only when it proves the required capability; fixtures use stable public or synthetic IDs.
- Prefer existing coverage. Add no regression test for a prose-only change or a static value when focused inspection already establishes the result.
- Tests protect named behavior against credible failures; avoid near-duplicates and test-only production seams. Regression tests fail pre-fix for the intended reason. Use `$test-audit` for a test audit or when coverage quality needs investigation.
- Choose proof at the boundary where the behavior can fail. Use fault injection for relevant failure modes, not a network/provider/restart matrix for every change. Delivery/dispatch/session behavior changes need boundary proof; reuse existing coverage when it already establishes the requirement.
- Prefer invariant assertions (every input accounted for; every action ends in a visible outcome or recorded non-outcome) over enumerating happy paths.
- Shared-state/order failures: reproduce original execution order and add boundary regression coverage; use tracked environment helpers, never consumer-only environment overrides that mask producer leaks.
- Prefer behavior tests over workflow/docs string greps. Put operator policy reminders in AGENTS/docs.
- A test asserting on files owned by lane X belongs in lane X's suite. A cross-lane assertion may never be selected by PR change classification, so it passes PR CI and first breaks on `main` full runs.
- Clean timers/env/globals/mocks/sockets/temp dirs/module state; `--isolate=false` safe.
- Tests asserting resolver/root-containment paths: `fs.realpath` mkdtemp/tmp roots first. macOS `os.tmpdir()` is a `/var` -> `/private/var` symlink; prod resolvers return canonical paths, so raw mkdtemp assertions pass on Linux CI but fail on Mac.
- Explicit `vi.mock` factories must export every binding prod touches, including error classes used in `instanceof` checks; `vi.importActual` the defining module for those instead of stub classes.
- Prefer injection and narrow `*.runtime.ts` mocks over broad barrels or `openclaw/plugin-sdk/*`.
- Do not edit baseline/inventory/ignore/snapshot/expected-failure files to silence checks without explicit approval. Shrink-only ratchet updates that exactly record removed violations are required maintenance and need no separate approval.
- Never edit source/test files while a Vitest run is in flight in the same checkout; mid-collection reads produce phantom failures and 120s timeouts. Wait for the run to finish, then edit.
- Vitest rejects Jest `--runInBand`; use `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test` for serial proof. Test workers max 16.
- Live: `OPENCLAW_LIVE_TEST=1 pnpm test:live`; verbose `OPENCLAW_LIVE_TEST_QUIET=0`.
- Live gateway tests: session-owned dev gateway only — isolated `OPENCLAW_STATE_DIR` + free port. Never bind the operator's real gateway port (default 18789) while their gateway runs.
- Changes to an operator-owned gateway service or live state/config require explicit task authorization. Reuse authorization already given for that operation; ordinary development uses the isolated gateway you started.
- Realistic data: copy the state/DB into your dev state dir and test the copy. In-place migration of a live gateway's state needs explicit operator approval.
- Guide: `docs/reference/test.md`.
