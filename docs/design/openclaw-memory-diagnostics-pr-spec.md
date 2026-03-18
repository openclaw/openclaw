# Memory Diagnostics and Backend Health PR Spec

This document turns the strongest first contribution from the audit into a PR-ready implementation plan.

Related:

- [Memory CLI](/cli/memory)
- [Memory](/concepts/memory)
- [Repo audit and contribution plan](/design/openclaw-repo-audit-contribution-plan)
- [Contribution shortlist](/design/openclaw-contribution-shortlist)

## Why this PR

OpenClaw already has a strong `openclaw memory status` surface, but it still leaves operators guessing about freshness and failure mode.

Today, the command can tell you:

- which backend is active
- which provider/model is configured
- whether the store is dirty
- indexed file and chunk counts
- whether vector and embedding probes pass
- whether a QMD-to-builtin fallback happened

What it still does not tell you clearly:

- when the last successful sync happened
- whether indexing is currently healthy, stale, or in backoff
- what the last sync error was
- whether the current backend is degraded vs fully healthy
- whether QMD is updating collections but failing embeds, or not updating at all

That gap matters because memory is one of the most trust-sensitive parts of OpenClaw. When recall looks wrong, maintainers and users need evidence fast.

## Problem statement

The current memory status contract is good for static configuration inspection, but weak for runtime diagnosis.

Impact:

- maintainers get bug reports without enough state to separate config mistakes from backend regressions
- users cannot easily tell the difference between "memory is disabled", "memory is stale", and "memory is serving degraded fallback results"
- `doctor` can point users to `memory status --deep`, but the command still lacks the freshness and failure signals needed for confident triage

## Goals

- extend the existing memory status contract instead of adding a new command
- make runtime health readable in both human CLI output and `--json`
- keep the first PR bounded to diagnostics only
- reuse current runtime state where possible
- make the new status fields useful to CLI, `doctor`, and future Gateway/UI surfaces

## Non-goals

- no behavior change to search or indexing algorithms
- no new persistence layer or historical event log
- no Control UI work in the first PR
- no scope-audit timeline for every denied query
- no schema migration beyond the in-memory status contract

## Proposed user-visible outcome

### Before

`openclaw memory status --deep` answers "what is configured?" but not reliably "is memory healthy right now?"

### After

`openclaw memory status --deep` should answer:

- is memory ready, degraded, or failing
- when the last successful sync completed
- whether the backend is currently dirty, syncing, or in backoff
- what the most recent sync or embed error was
- whether QMD is serving normally or OpenClaw has fallen back to builtin search

Example target output:

```text
Memory Search (main)
Provider: qmd (requested: qmd)
Health: degraded
Sync: backoff
Last success: 3m ago
Last error: qmd embed timed out
Fallback: qmd -> builtin
Indexed: 218/230 files · 1412 chunks
QMD collections: 3
Last update: 2m ago
Last embed: 17m ago
```

## Technical design

### 1. Extend the typed status contract

Add first-class typed fields to `MemoryProviderStatus` in `src/memory/types.ts`.

Recommended additions:

```ts
health?: {
  state: "ready" | "degraded" | "error";
  reason?: string;
};
sync?: {
  supported: boolean;
  state: "idle" | "running" | "backoff" | "error";
  dirty?: boolean;
  lastStartAt?: number;
  lastSuccessAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  lastReason?: string;
};
freshness?: {
  lastIndexedAt?: number;
  lastSessionsExportAt?: number;
};
```

Why first-class fields instead of only `custom`:

- CLI and `doctor` should not parse backend-specific blobs
- this is status contract material, not incidental metadata
- future Gateway/UI surfaces can reuse the same shape without backend conditionals

If maintainers want a narrower first step, backend-only extras can still stay under `custom.qmd`.

### 2. Builtin manager diagnostics

Extend `src/memory/manager.ts` to expose lifecycle state the manager already knows or can cheaply track.

Add internal fields for:

- last sync start time
- last successful sync time
- last sync error time
- last sync error message
- last sync trigger reason

Map those into the new `status()` fields.

Expected behavior:

- `dirty: true` with no active sync becomes `sync.state = "idle"`
- sync failures become `health.state = "degraded"` or `"error"` depending on whether search is still usable
- batch failures stay in `batch`, but the headline state should still surface through `health` or `sync`

### 3. QMD manager diagnostics

Extend `src/memory/qmd-manager.ts` to publish a normalized status shape.

This file already tracks strong raw signals such as:

- `lastUpdateAt`
- `lastEmbedAt`
- embed failure count
- embed backoff state

Promote the operator-relevant parts into `health`, `sync`, and `freshness`, while leaving backend-specific details in `custom.qmd`.

Recommended `custom.qmd` additions:

- `collections`
- `lastUpdateAt`
- `lastEmbedAt`
- `embedFailureCount`
- `embedBackoffUntil`

Recommended headline mapping:

- recent successful update + no fallback => `health.ready`
- update succeeds but embeds are backing off => `health.degraded`, `sync.backoff`
- hard QMD failure with fallback active => `health.degraded` plus `fallback`

### 4. Fallback wrapper enrichment

Extend `src/memory/search-manager.ts` so `FallbackMemoryManager.status()` reports more than a one-line fallback reason.

Specifically:

- preserve the fallback backend status
- override `health.state` to at least `degraded`
- set `sync.lastError` when QMD was the failing side
- keep the current `fallback.from` and `fallback.reason`

This is important because the wrapper is where runtime truth becomes easy to lose.

### 5. CLI status rendering

Update `src/cli/memory-cli.ts` to render the new fields in both text and JSON output.

Recommended new lines for text mode:

- `Health`
- `Sync`
- `Last success`
- `Last error`

Rules:

- show these lines only when the data exists
- keep `--json` output lossless
- keep current provider/vector/source counts intact
- do not turn `memory status` into a wall of backend-specific details

### 6. Doctor integration

Update `src/commands/doctor-memory-search.ts` to use the stronger status semantics when available.

This should stay small in the first PR:

- use `health.state` and `sync.lastError` to improve note text
- keep doctor config-first
- do not add new network probes

## Files and modules impacted

- `src/memory/types.ts`
- `src/memory/manager.ts`
- `src/memory/qmd-manager.ts`
- `src/memory/search-manager.ts`
- `src/cli/memory-cli.ts`
- `src/commands/doctor-memory-search.ts`
- `src/cli/memory-cli.test.ts`
- `src/memory/search-manager.test.ts`
- `src/memory/qmd-manager.test.ts`
- `docs/cli/memory.md`

## Suggested implementation order

1. Add the new typed fields to `MemoryProviderStatus`.
2. Implement builtin manager status enrichment.
3. Implement QMD status enrichment.
4. Update fallback wrapper behavior.
5. Render new lines in `memory status`.
6. Add or update tests.
7. Update docs.

## Test plan

Add focused tests rather than one broad integration test.

Coverage to add:

- builtin manager reports sync metadata after success and after failure
- QMD manager reports update and embed freshness
- fallback manager marks status as degraded and carries the QMD error forward
- `memory status --json` includes the new fields
- text-mode CLI renders new lines only when present
- doctor messaging improves when a last error is available

Likely test files:

- `src/cli/memory-cli.test.ts`
- `src/memory/search-manager.test.ts`
- `src/memory/qmd-manager.test.ts`
- `src/memory/index.test.ts` or a focused builtin-manager test if that is cleaner

## Risks and tradeoffs

Main risk:

- status semantics become too clever or backend-specific

Mitigation:

- keep the shared contract small
- keep backend extras in `custom`
- avoid persistence in the first PR

Secondary risk:

- maintainers may prefer not to widen the shared contract yet

Fallback plan:

- land the first PR with `custom.diagnostics` plus CLI rendering
- follow with a second PR that promotes stable fields into the typed contract

## Expected maintainer value

Why this is a strong first contribution:

- improves a real subsystem that users depend on
- reduces support and triage cost
- demonstrates you understood the current architecture before proposing change
- creates a foundation for future Gateway or Control UI visibility without forcing UI work now

## Draft PR title

`memory: surface backend health and sync freshness in memory status`

## Draft PR description

### Problem

`openclaw memory status --deep` shows configuration and index counts, but it does not clearly explain whether memory is healthy, stale, or degraded.

### What changed

- extended the memory status contract with shared health and sync metadata
- surfaced builtin and QMD freshness/error signals
- preserved fallback context when QMD degrades to builtin search
- rendered the new data in `openclaw memory status`
- updated tests and memory CLI docs

### Why this helps

- faster operator diagnosis
- better maintainer bug reports
- clearer distinction between ready, degraded, and failing memory states

### Follow-ups

- expose the same status in Gateway or Control UI
- add richer scope-denial diagnostics for QMD-backed memory
