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
