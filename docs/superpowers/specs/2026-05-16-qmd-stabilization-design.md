# QMD Stabilization and Warmup — Design Spec

**Date:** 2026-05-16
**Author:** Ethan Vitanova (assisted by Codex)
**Runtime:** Live Docker gateway on `openclaw:local`
**Scope:** QMD MCP-only memory setup on the live VPS

---

## Problem Statement

The current memory system is intentionally QMD MCP-only, with native OpenClaw memory search disabled. Live verification showed:

- `qmd__status`, `qmd__query`, `qmd__get`, and `qmd__multi_get` all work in Discord/dashboard sessions.
- Native OpenClaw memory search is still disabled:
  - `memory.backend = "builtin"`
  - `agents.defaults.memorySearch.enabled = false`
  - `plugins.slots.memory = "none"`
- QMD has a partial vector index:
  - `886` files indexed
  - `3731` vectors embedded
  - `825` documents still need embedding
- QMD lexical search is fast.
- QMD semantic search is cold-start sensitive on this CPU-only VPS:
  - controlled `search` baseline on `memory-dir-main`: about `1s`
  - first controlled `vsearch` run on `memory-dir-main`: about `14s`
  - second warm `vsearch` run on `memory-dir-main`: about `2s`
- Automatic QMD maintenance was missing on this architecture:
  - native `memory.backend = "qmd"` startup and interval maintenance was disabled
  - no replacement cron or startup worker was maintaining the MCP-only QMD index

One earlier semantic probe also exceeded `45s`, but that test used a heavier path and became confounded by a stray long-lived process. Because of that, boot-time semantic warmup must not be rolled out until the slow-path cause is understood well enough to avoid making gateway boot unpredictable.

---

## Goal

Stabilize QMD memory behavior in four ordered phases:

1. Investigate and fix pending embedding coverage issues.
2. Design and implement a safe QMD warmup protocol on gateway boot.
3. Document the final behavior and operational protocol.
4. Restart the gateway only when the chosen fix path actually requires it.

This work is explicitly staged. No boot-time semantic warmup should be enabled until Step 1 explains the pathological slow case well enough that Step 2 can stay bounded and predictable.

---

## Constraints

- Keep the current QMD MCP-only architecture.
- Do not re-enable native OpenClaw memory-core recall as part of this effort.
- Do not assume that one successful warm `vsearch` run means all semantic paths are safe to execute during gateway boot.
- Preserve the current Docker `latest` update flow and the validated backup/restore protocol.
- Avoid long blocking boot paths that delay gateway readiness or make Discord/dashboard look down.

---

## Approaches Considered

### Approach A — Immediate boot-time semantic warmup

Run a tiny `qmd vsearch` or `qmd query` automatically every time the gateway starts, without first addressing embedding backlog or the earlier `>45s` timeout case.

**Pros**

- Fastest path to improved post-boot query latency
- Minimal implementation effort

**Cons**

- Risks turning an occasional query problem into a startup problem
- Could block boot unpredictably on CPU-only cold starts
- Does nothing to fix incomplete embeddings

**Verdict:** Rejected for now.

### Approach B — Embeddings first, bounded warmup second

First reduce or eliminate pending embeddings, then add a bounded, non-critical warmup query at boot with explicit timeout and narrow collection scope.

**Pros**

- Matches the evidence collected so far
- Reduces both cold-start pain and semantic quality gaps
- Keeps warmup optional, bounded, and operationally understandable

**Cons**

- More work than a blind warmup
- Requires validating that embedding maintenance itself is safe on this VPS

**Verdict:** Recommended.

### Approach C — No boot warmup, lexical-first forever

Leave semantic search cold, rely on lexical search for defaults, and accept that semantic queries will sometimes be slow.

**Pros**

- Lowest operational risk
- No boot-time complexity

**Cons**

- Preserves poor first-use semantic UX
- Leaves vector search feeling unreliable to users

**Verdict:** Acceptable fallback only if bounded warmup proves unsafe.

---

## Recommended Design

Use Approach B.

The work should proceed in two layers:

- **Layer 1: semantic readiness**
  - explain why `825` docs remain unembedded
  - confirm whether backlog is expected, stalled, or timing out
  - verify whether embedding maintenance can complete incrementally on this VPS without destabilizing the gateway

- **Layer 2: cold-start mitigation**
  - once semantic readiness is acceptable, add a bounded warmup query that targets the default main memory library QMD searches by default
  - warm the QMD runtime/model path, not “load the whole library into memory”
  - keep warmup non-fatal and outside the gateway readiness critical path

---

## Execution Plan

### Step 1 — Embedding backlog investigation

Tasks:

- Inspect QMD collections and determine why `825` documents still need embedding.
- Verify whether the backlog is dominated by one collection or spread across all collections.
- Check whether scheduled QMD update/embed maintenance is running at all in the current QMD MCP-only architecture.
- Run controlled embedding maintenance against the live QMD state with explicit observation of:
  - progress
  - CPU impact
  - memory impact
  - whether completion persists across subsequent `qmd status` checks

Success criteria:

- We can explain the backlog mechanistically.
- We know whether it is safe to reduce the backlog on this host.
- We have a chosen remediation path for embeddings.

### Step 1 — Findings and implemented remediation

Status: implemented in code, restart still pending on the live gateway.

Findings:

- The backlog is structural, not random drift.
- SQLite inspection showed the pending set is dominated by the `app` collection, while smaller collections were partially or fully embedded.
- The automatic embed/update loop in `extensions/memory-core/src/memory/qmd-manager.ts` only runs when native QMD memory is active.
- In the current MCP-only deployment (`plugins.slots.memory = "none"` with `mcp.servers.qmd`), that native manager never opens, so no background embed/update work happens.
- Controlled live `qmd embed` probes did persist new vectors and reduced some smaller pending collections, which proved that incremental catch-up is possible on this VPS.
- The same probes also showed that `app` remains the dominant backlog driver, so one-shot full catch-up would be a poor operational default on this CPU-only host.

Implemented remediation:

- Added a QMD MCP-only maintenance service in `extensions/memory-core/src/qmd-mcp-maintenance.ts`.
- Wired it from `extensions/memory-core/index.ts` using `gateway_start` / `gateway_stop` hooks.
- The service only arms in the MCP-only architecture:
  - `plugins.slots.memory = "none"`
  - native `memory.backend` is not `qmd`
  - a managed stdio `mcp.servers.qmd` entry exists
- It reuses the managed MCP server's `command`, `cwd`, and XDG env so maintenance targets the same QMD index used by MCP tools.
- It runs bounded `qmd update` and `qmd embed` work on boot and intervals, with embed batches capped to `20` docs / `64` MB to avoid large CPU spikes.
- It does not re-enable native OpenClaw memory recall or `memory_search`.

### Step 2 — Boot warmup protocol

Blocked on Step 1.

Candidate design:

- Trigger a tiny semantic warmup after gateway boot using the live QMD XDG paths.
- Use a narrow scope such as `memory-dir-main`.
- Use a hard timeout.
- Make failure log-only, not fatal.
- Run after the gateway is already listening, not before readiness.

Important non-goal:

- Do **not** apply this protocol yet to the heavier QMD MCP vector-query path that produced the earlier `>45s` timeout symptom until that path is explicitly understood.

Success criteria:

- Warmup reduces first semantic-query latency materially.
- Gateway readiness and Discord/dashboard availability stay predictable.
- Warmup failures do not break startup.

### Step 3 — Documentation

Update infra/runtime docs after the final behavior is chosen:

- Docker / infrastructure operational docs
- backup / restore notes if embedding or warmup changes add new operational steps
- QMD-specific troubleshooting notes if the backlog cause or warmup caveats are non-obvious

Current status:

- QMD concept docs updated to describe MCP-only maintenance behavior.
- QMD config reference updated so `memory.qmd.update.*` semantics match both native-QMD and MCP-only maintenance paths.

### Step 4 — Restart policy

Restart only when needed:

- embedding-only investigation may not require restart
- QMD environment or startup-hook changes likely will
- documentation-only work will not

Current status:

- The implemented MCP-only maintenance hook does require a gateway restart before the live deployment benefits from it.

---

## Testing Strategy

For Step 1:

- compare `qmd status` before and after controlled embed work
- measure CPU and container load during embedding
- confirm backlog reduction persists
- verify the new MCP-only maintenance hook with targeted tests

For Step 2:

- cold boot baseline: first semantic query latency without warmup
- cold boot with warmup: first semantic query latency after warmup completes
- verify gateway startup remains healthy and Discord delivery still works

---

## Risks

- Embedding backlog remediation may be too CPU-heavy for this VPS if attempted in one large burst.
- A badly chosen warmup query could reproduce the earlier pathological slow path at boot.
- Broad `query` warmups may be much heavier than narrow `vsearch` warmups.
- If the root cause of the large embedding backlog is structural, warmup alone will not solve perceived semantic unreliability.
- The bounded MCP-only maintenance worker may still leave the `app` collection catching up slowly, so vector freshness should be observed after restart before changing warmup behavior.

---

## Decision Gate

Before any boot-time warmup is applied, all of the following must be true:

- embedding backlog cause is understood
- chosen warmup query is bounded and measured
- warmup is proven non-fatal to startup
- docs are updated for the final operational behavior

---

## Out of Scope

- Re-enabling native OpenClaw memory-core auto-recall
- Switching QMD to become the native `memory.backend = "qmd"` path
- Broader memory architecture changes outside QMD stabilization
