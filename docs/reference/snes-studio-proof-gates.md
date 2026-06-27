---
summary: "SNES Studio PCC proof surfaces and milestone judging rules"
read_when:
  - You are marking a SNES Studio milestone complete
  - You are debugging why PCC blocked or failed a milestone
  - You need to preserve source, runtime, emulator, FXPAK, hardware, and human approval separately
title: "SNES Studio Proof Gates"
---

SNES Studio completion is receipt-based. A milestone cannot pass because prose sounds right or a contact sheet looks better.

## Separate Proof Surfaces

Keep these surfaces separate:

- source preservation;
- asset conversion;
- browser preview;
- ROM build;
- runtime asset truth;
- emulator screenshot and replay;
- FXPAK package dry-run;
- removable-media copy;
- original hardware proof;
- human visual approval.

## Judge Order

1. Deterministic validator.
2. Domain QA validator.
3. GPT 5.5 for repeated blockers or final review only.
4. Human approval for production visuals.

If proof is unavailable, write a blocked receipt with the exact blocker. Do not use available checks to claim full production completion.

## Repair Policy

Failures are classified as `invalid-patch`, `build-failure`, `runtime-failure`, `visual-failure`, `budget-failure`, or `external-blocker`. External blockers do not loop endlessly; they wait for user, hardware, or approval action.

## Approval queue and overnight stops

PCC v2 records approval-gated work in `approval-queue.json`. A runner may continue deterministic validation and repair planning, but it must stop for human production visual approval, live model-spending automation, hosted GLM, paid tools/assets, FXPAK/removable writes, push/PR, or original hardware proof.

## PCC v3 Multi-Agent Coordination

PCC v3 adds dispatch dry-runs, worker sandbox contracts, write-surface guards, patch application gates, local-only live worker dispatch, parallel scheduling metadata, model health routing, artifact cache metadata, reviewer receipts, conflict detection, compact memory cards, telemetry, dashboard snapshots, and legal clean-room prompt-to-ROM benchmark scaffolding. Hosted GLM, paid tools, commercial SNES material, FXPAK writes, push/PR, and human production visual approval remain approval-gated.

## Real worker output proof gate

Real PCC worker output must validate as `openclaw-snes-pcc-worker-output-v1` before any receipt or patch is applied. The gate rejects malformed JSON, hosted-provider flags, paid/commercial/FXPAK claims, secret-looking paths, unsupported file writes, wrong project or milestone ids, and missing required proof receipts. The milestone judge still runs after apply.
