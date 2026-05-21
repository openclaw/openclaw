# OpenClaw Multitasking — D-GAP-2 Quarantine Surfacing + Turn Timeouts

**Status:** Slice landed compile-ready on `origin/main` 2026-05-21 after a
botched first landing. Phase 1 leaf primitives (`briefing.*` event bus +
turn-timeout watchdog) are in tree and self-tested; runtime wiring into the
agent turn loop and the `briefing.quarantine` emitter are deferred follow-ups.
**Gate:** G-D5.

**Goal:** Stop Ghost from going silent. Surface quarantined inbound messages
once per batch with a `briefing.quarantine` event, and bound hung turns with a
configurable `maxTurnMs` per channel that aborts the turn and emits a single
`briefing.timeout`.

**Parent plans:**

- `2026-05-18-openclaw-multitasking.md` — Phase 1 items 4 (surface
  quarantined messages) + 5 (turn timeouts).
- `2026-05-20-agentos-operator-dispatcher-loop.md` — consumes `briefing.*`
  events as operator-loop escalation inputs.

**Roadmap ref (100% Roadmap Gap Audit, 2026-05-20):**

> **D-GAP-2 — Phase 1 items 4 + 5 (quarantine + turn timeouts).** Surface
> quarantined messages once per batch with a `briefing.quarantine` event;
> bound hung turns with a configurable `maxTurnMs` per channel and emit
> `briefing.timeout` on abort.
> `idempotencyKey = multitask-100-roadmap:D-GAP-2:quarantine-and-timeouts`.

**Owned paths for this slice:**

- `src/infra/briefing-events.ts` (+ `.test.ts`)
- `src/infra/turn-timeout.ts` (+ `.test.ts`)
- this plan doc

---

## Why it exists

Two silent-failure families from Phase 1 share one operator surface — a
low-volume, occurrence-once briefing stream that is distinct from the
per-tool/per-turn `diagnostic-events.ts` telemetry:

1. **Hung turn.** Model never responds, a tool never returns, or an abort got
   swallowed. The session is stuck and burns operator attention with no signal.
2. **Quarantined inbound.** The dead-letter spool silently ate inbound messages
   (4 of Will's messages, ~2h, 2026-05-18). Quarantine must notify once per
   batch, not spam per dead-letter.

Both want the same thing: emit one operator-visible briefing per occurrence.

---

## Scope delivered (this slice)

Two leaf modules under `src/infra/`, plus colocated tests. No runtime callers
yet — these are the typed primitives the wiring will build on.

### `briefing-events.ts` — the `briefing.*` event bus

- Tiny typed listener set, synchronous dispatch, process-local sequence
  counter, per-listener frozen deep clone for isolation. No async queue, no
  diagnostic-config gating — briefings are low-volume and the caller decides
  whether to emit.
- Two event variants defined now:
  - `briefing.timeout` — emitted by `turn-timeout.ts` (this slice).
  - `briefing.quarantine` — the type is defined here so the bus is complete;
    its emitter (`quarantine-briefing.ts`) is a **deferred follow-up** (see
    below). The bus carries both variants today; only `timeout` has a producer.
- `emitBriefingEvent` enriches with `seq`/`ts`, caps recursion depth (64) so a
  misbehaving listener cannot deadlock, and isolates per-listener exceptions.
- `onBriefingEvent` returns an unsubscribe. `resetBriefingEventsForTests` clears
  state. Singleton state keyed via `resolveGlobalSingleton` so reloads/duplicate
  module instances share one bus.

### `turn-timeout.ts` — per-channel turn-timeout watchdog

- `startTurnTimeout({ sessionKey, channel, turnKey, maxTurnMs, abort, ... })`
  arms a single-shot watchdog. On fire: calls `abort()` exactly once and emits
  one `briefing.timeout`. Idempotent — `dispose()` after fire is a no-op, fire
  after `dispose()` is a no-op, briefing emitted at most once per handle.
- **Last-arm wins:** re-arming the same `turnKey` while a previous handle is
  still active auto-disposes the previous handle first (per-call sentinel
  `entry`, identity-matched cleanup) so a stale closure timer cannot fire an
  abort/briefing for a superseded turn. This was the fix that drove the
  `turn-timeout.ts` 273 → 288 line revision (reviewed `eb14a4f55d0`).
- `resolveMaxTurnMs` coalesces a per-channel config value with a default and
  clamps to `[TURN_TIMEOUT_MIN_MS, TURN_TIMEOUT_MAX_MS]`, returning the source
  (`channel`/`default`/`fallback`) for telemetry. Rejects non-finite /
  non-positive inputs so callers can pipe untrusted config in without guards.
- `abort` may be sync or async; async rejections are caught and logged. Abort
  exceptions surface as `detail: "abort dispatch failed: ..."` in the briefing.
- `hasTurnTimeoutFired` exposes a bounded (1024-entry) fired-key set for
  dedupe. `resetTurnTimeoutForTests` clears active + fired state.

Dependencies (all leaf, present on `main`): `../shared/global-singleton.js`,
`../shared/string-coerce.js`, and `turn-timeout.ts → ./briefing-events.js`.

---

## Landing incident + recovery (2026-05-21)

The first landing shipped the watchdog without its dependency:

- Parent slice `2158ceda9d7` created `briefing-events.ts` (+ test).
- Reviewed fix `eb14a4f55d0` landed **only** `turn-timeout.ts` + `.test.ts`
  (the auto-dispose-on-re-arm revision), both of which `import
./briefing-events.js`. That file was never in the landed tree → the slice
  could not compile (`TS2307` at `turn-timeout.ts:22`). The verifier
  (`20260521t011647z`) confirmed: logic sound (8/8 once the dep is present),
  but D-GAP-2 cannot close on that commit alone.
- The compile-ready fix `c716359a0c1` co-located all four files and was
  LAND-approved twice — but never merged to `origin/main`.

**This recovery** brings the reviewed four-file slice onto `origin/main`
byte-for-byte from `c716359a0c1` (provenance: `briefing-events.*` from
`2158ceda9d7`, `turn-timeout.*` from `eb14a4f55d0`), adds this plan doc, and
re-runs the gates on the current base.

---

## Deferred follow-ups (not in this slice)

1. **`quarantine-briefing.ts` emitter.** The original parent slice carried a
   `quarantine-briefing.ts` batcher; the reviewed compile-ready slice dropped
   it to keep the landing minimal. The `briefing.quarantine` _event type_ is
   defined in `briefing-events.ts`; the batcher that dedupes per
   `(sessionKey, channel)` and emits one event per pass lands separately.
2. **Runtime wiring.** Neither module has a production caller yet. Integrating
   the watchdog into the agent turn loop (arm on turn start, dispose on
   completion, resolve `maxTurnMs` from per-channel config) and subscribing the
   gateway/operator surface to `onBriefingEvent` is downstream work.

Until wired, ~460 LOC ship unused — acceptable for an explicitly phased slice.

---

## Verification

Focused, leaf-scoped proof (these modules have no external importers, so a full
build excludes them as dead code and adds nothing beyond the typecheck):

- Focused tests: `briefing-events.test.ts` + `turn-timeout.test.ts` (11 tests).
- Typecheck: `tsgo` core + test-src lanes (authoritative compile-readiness).
- Lint: `oxlint` on the four files.
- `git diff --check`.

Run the full changed gate / build on Crabbox/Testbox before any broader landing
that wires these into the runtime.

---

## Residual risks

- **Dead-until-wired.** The primitives compile and self-test but have no
  runtime caller; no end-to-end proof of the operator-visible behavior yet.
- **`briefing.quarantine` has no producer** in this slice — the type exists but
  nothing emits it until the `quarantine-briefing.ts` follow-up lands.
- **Linked-worktree gate caveat.** When verified from a Codex/linked worktree
  without local `node_modules`, gates run against the shared install; re-run in
  a healthy checkout or Crabbox if dependency skew is a concern.
