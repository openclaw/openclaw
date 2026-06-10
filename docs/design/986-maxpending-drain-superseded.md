# #986 — maxPendingWork cap + drain-superseded guard for multi-continue_work flood

**Status:** design + MVP implementation
**Fast-follow to:** #982 / #985 (array-capture multi-`continue_work`, `scheduleContinuationWorkBatch`)
**Owner:** ronan (continuation-domain)
**Filed by:** frond-scribe (copilot)

## Problem (figs's 1000x-in-30s foot-gun)

#985 restores N-independent multi-`continue_work()` per turn: a single model
response emits N elections, each its own TaskFlow, each delivering its own wake.
Live-proven on `9d440879a3` (3-fire → 3 distinct on-time wakes).

The open edge: there is **no per-session cap on concurrent pending work** and **no
drain-superseded guard**. Today the only runaway guards are:

- `maxChainLength` (default 10) — caps chain *depth* (cumulative hops in a lineage).
- `costCapTokens` (default 500k) — caps cumulative chain token spend.

These bound a single chain, but a prince could still elect a *flood* (a tight loop
of elections within the chain cap) and, worse, wake into a **backlog** of stale
turns: if the session is busy through a multi-offset window and N elections all
mature at once, `dispatchPendingContinuationWork` drains them back-to-back and
drives N turns — some of which are **moot by delivery** (figs's example:
"it's been 5min, finish + drink the coffee" — the intermediate kettle/stir turns
are stale once the coffee turn is what matters).

## Two guards

### Guard 1 (primary): `maxPendingWork` cap

A per-session cap on **concurrent undelivered** continuation-work flows
(`status ∈ {queued, running}`), enforced at **enqueue** time.

- New config: `agents.defaults.continuation.maxPendingWork` (default **32**,
  clamped positive int). Comfortably above the legit batch ceiling
  (`maxChainLength` default 10, morning-routine = 3) while hard-bounding the flood.
- Enforcement: `scheduleContinuationWork` checks `pendingWorkCount(sessionKey)`
  (already exists in `work-store.ts`) before `enqueuePendingWork`. At/over cap →
  reject with new reason `pending-capped`.
- Batch behaviour: `scheduleContinuationWorkBatch` ends early on `pending-capped`
  exactly like `chain-capped`/`cost-capped` — **partial success is preserved**
  (earlier valid elections stay scheduled; #982's load-bearing invariant). A
  later election hitting the pending-cap means every later one would too, since
  the pending count only grows within the batch.

This **alone** solves "wake into ~1000 stale turns": you can never have more than
`maxPendingWork` undelivered at once.

**Why separate from `maxChainLength`:** chain-depth is a *lineage* bound (how many
hops a single continue-chain may walk); pending-count is a *store-pressure* bound
(how many undelivered wakes may coexist). Orthogonal axes. A high `maxChainLength`
(raised for deep autonomous loops) should not implicitly remove the flood guard.

### Guard 2 (drain-superseded): conservative backlog coalesce

At drain time, collapse a **backlog** so the session does not wake into a stale
pile — without breaking on-time staggered delivery.

**Key observation:** `consumePendingWork` only returns *matured* (`now ≥ dueAt`)
works. A normal staggered routine (kettle@+0, stir@+150s, coffee@+300s) fires
**one-per-poll** — each matures, drains, delivers; the next matures later. They
**only batch together** when the session was busy/backlogged through the window.
So **"multiple matured in one drain batch" is itself the backlog signal**, not the
normal path.

Policy (conservative):

- When a single drain batch yields **>1 matured** work AND the older members are
  **stale** (overdue past `supersededGraceMs`, derived as a multiple of the
  configured `maxDelayMs`), the older overdue siblings are **superseded** by the
  newest-elected member and are **expired without driving** a turn.
- The newest-elected matured work always drives (the live intent).
- Non-stale matured works (overdue by less than the grace) still drive — close
  bursts are not collapsed; only a genuine stale backlog is.
- Supersession is **never silent**: each expired flow finishes with
  `currentStep="superseded"` + a `[continuation:work-superseded]` log line, and a
  single `[system:continuation-note]` summarises how many were collapsed so the
  prince knows their earlier elections were folded.

**What this deliberately does NOT do:** it does not guess *intent* equivalence
(reasons are freeform). It collapses by **staleness + recency within a backlog
batch**, never by semantic dedupe. On-time staggered delivery is fully preserved
because on-time elections never share a drain batch.

## Tradeoffs / open questions (for cohort + figs refinement)

1. `maxPendingWork` default 32 is a guess — high enough to never bite legit use,
   low enough to bound the flood. Tunable via config.
2. `supersededGraceMs` as `N × maxDelayMs` (proposed N=2) is the staleness line.
   Too small risks collapsing legit close-bursts; too large lets a backlog through.
3. Guard 2 keeps **newest-elected**; an alternative is **newest-due**. For the
   morning-routine these coincide (later offset = later election). Documented as
   newest-elected (`electedAt`) since that is the stable monotonic key.
4. Guard 2 only triggers on backlog batches; if the foot-gun is purely "too many
   on-time turns" (not a backlog), Guard 1's cap is the protection, not Guard 2.

## Invariants preserved

- #982 partial-success: earlier valid elections stay scheduled on any cap.
- In-flight-retry (`requests-in-flight` → requeue 1Hz) is untouched; a deferred
  retry is requeued `queued`, so it re-enters the drain as its own (possibly
  newest) member next cycle — it is not spuriously superseded mid-retry.
- Hot-reload: both new knobs read at enforcement points via the live config
  resolver (no captured-snapshot staleness).
