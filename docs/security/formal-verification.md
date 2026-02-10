---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: Formal Verification (Security Models)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: Machine-checked security models for OpenClaw’s highest-risk paths.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
permalink: /security/formal-verification/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Formal Verification (Security Models)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This page tracks OpenClaw’s **formal security models** (TLA+/TLC today; more as needed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> Note: some older links may refer to the previous project name.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Goal (north star):** provide a machine-checked argument that OpenClaw enforces its（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
intended security policy (authorization, session isolation, tool gating, and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
misconfiguration safety), under explicit assumptions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**What this is (today):** an executable, attacker-driven **security regression suite**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Each claim has a runnable model-check over a finite state space.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Many claims have a paired **negative model** that produces a counterexample trace for a realistic bug class.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**What this is not (yet):** a proof that “OpenClaw is secure in all respects” or that the full TypeScript implementation is correct.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Where the models live（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Models are maintained in a separate repo: [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Important caveats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- These are **models**, not the full TypeScript implementation. Drift between model and code is possible.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Results are bounded by the state space explored by TLC; “green” does not imply security beyond the modeled assumptions and bounds.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Some claims rely on explicit environmental assumptions (e.g., correct deployment, correct configuration inputs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Reproducing results（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Today, results are reproduced by cloning the models repo locally and running TLC (see below). A future iteration could offer:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CI-run models with public artifacts (counterexample traces, run logs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- a hosted “run this model” workflow for small, bounded checks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Getting started:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git clone https://github.com/vignesh07/openclaw-formal-models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd openclaw-formal-models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Java 11+ required (TLC runs on the JVM).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# The repo vendors a pinned `tla2tools.jar` (TLA+ tools) and provides `bin/tlc` + Make targets.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
make <target>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Gateway exposure and open gateway misconfiguration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Claim:** binding beyond loopback without auth can make remote compromise possible / increases exposure; token/password blocks unauth attackers (per the model assumptions).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Green runs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make gateway-exposure-v2`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make gateway-exposure-v2-protected`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Red (expected):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make gateway-exposure-v2-negative`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See also: `docs/gateway-exposure-matrix.md` in the models repo.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Nodes.run pipeline (highest-risk capability)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Claim:** `nodes.run` requires (a) node command allowlist plus declared commands and (b) live approval when configured; approvals are tokenized to prevent replay (in the model).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Green runs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make nodes-pipeline`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make approvals-token`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Red (expected):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make nodes-pipeline-negative`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make approvals-token-negative`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Pairing store (DM gating)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Claim:** pairing requests respect TTL and pending-request caps.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Green runs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make pairing`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make pairing-cap`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Red (expected):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make pairing-negative`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make pairing-cap-negative`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Ingress gating (mentions + control-command bypass)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Claim:** in group contexts requiring mention, an unauthorized “control command” cannot bypass mention gating.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Green:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make ingress-gating`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Red (expected):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make ingress-gating-negative`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Routing/session-key isolation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Claim:** DMs from distinct peers do not collapse into the same session unless explicitly linked/configured.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Green:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make routing-isolation`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Red (expected):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make routing-isolation-negative`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## v1++: additional bounded models (concurrency, retries, trace correctness)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These are follow-on models that tighten fidelity around real-world failure modes (non-atomic updates, retries, and message fan-out).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Pairing store concurrency / idempotency（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Claim:** a pairing store should enforce `MaxPending` and idempotency even under interleavings (i.e., “check-then-write” must be atomic / locked; refresh shouldn’t create duplicates).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
What it means:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Under concurrent requests, you can’t exceed `MaxPending` for a channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Repeated requests/refreshes for the same `(channel, sender)` should not create duplicate live pending rows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Green runs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make pairing-race` (atomic/locked cap check)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make pairing-idempotency`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make pairing-refresh`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make pairing-refresh-race`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Red (expected):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make pairing-race-negative` (non-atomic begin/commit cap race)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make pairing-idempotency-negative`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make pairing-refresh-negative`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make pairing-refresh-race-negative`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Ingress trace correlation / idempotency（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Claim:** ingestion should preserve trace correlation across fan-out and be idempotent under provider retries.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
What it means:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When one external event becomes multiple internal messages, every part keeps the same trace/event identity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Retries do not result in double-processing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If provider event IDs are missing, dedupe falls back to a safe key (e.g., trace ID) to avoid dropping distinct events.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Green:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make ingress-trace`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make ingress-trace2`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make ingress-idempotency`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make ingress-dedupe-fallback`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Red (expected):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make ingress-trace-negative`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make ingress-trace2-negative`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make ingress-idempotency-negative`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make ingress-dedupe-fallback-negative`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Routing dmScope precedence + identityLinks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Claim:** routing must keep DM sessions isolated by default, and only collapse sessions when explicitly configured (channel precedence + identity links).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
What it means:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel-specific dmScope overrides must win over global defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- identityLinks should collapse only within explicit linked groups, not across unrelated peers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Green:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make routing-precedence`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make routing-identitylinks`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Red (expected):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make routing-precedence-negative`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `make routing-identitylinks-negative`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
