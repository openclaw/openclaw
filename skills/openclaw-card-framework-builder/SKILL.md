---
name: openclaw-card-framework-builder
description: Build or change OpenClaw modules only after creating linked Source, Component, Capability, Module, Architecture, World Model, 3D Viewpoint, 3D Node Graph, Contract, Validation, and Report cards.
metadata: { "openclaw": { "criticality": "important" } }
---

# OpenClaw Card Framework Builder

Use this skill before creating, changing, or promoting any OpenClaw module, plugin, skill, runtime flow, Task Flow, UI control surface, or validation gate.

## Required preflight

1. Read the user request and identify the smallest safe module goal.
2. Create or update linked cards in `reports/openclaw-card-framework-cards.json`.
3. Include these card types before implementation:
   - Source Card: official or trusted evidence.
   - Component Card: original OpenClaw architecture component with `componentRole` and `componentPaths`.
   - Capability Card: what capability is being built.
   - Module Card: OpenClaw surface and owner boundary.
   - Architecture Card: architecture-as-code, C4/arc42/Structurizr/Backstage mapping, and drift detection boundary.
   - World Model Card: world-model simulation, imagined failure scenarios, and safe future-state prediction boundary.
   - 3D Viewpoint Card: registry-derived scene/view slice for inspecting card nodes and links.
   - 3D Node Graph Card: card id, type, target, componentRole, linksTo, node position, picking, and 2D fallback contract.
   - Contract Card: API, hook, schema, command, file, or lifecycle contract.
   - Validation Card: executable checks and failure gates.
   - Report Card: human-readable result, risk, rollback path, and next safe task.
4. Link every card through `linksTo`; isolated cards are invalid.
5. Choose exactly one OpenClaw target: `docs`, `skill`, `plugin`, `runtime`, or `taskflow`.
6. Run `pnpm check:openclaw-card-framework` before implementation and again after changes.

## Block conditions

Stop and report `BLOCKED_CARD_FRAMEWORK` when any of these are true:

- Missing source evidence.
- Missing original architecture Component Card, `componentRole`, or `componentPaths`.
- Source path points outside the current OpenClaw root.
- Missing `contract`.
- Missing `validation`.
- Missing multi-card `linksTo`.
- Trading runtime is not linked to a `trading-risk-gate` Component Card.
- The proposal is only a standalone helper and not an OpenClaw native surface.
- 3D viewpoint output is only a picture and does not trace back to card id, source, validation, report, and 2D fallback.
- The target is not one of `docs`, `skill`, `plugin`, `runtime`, or `taskflow`.
- Real API write, live trading, credential mutation, or external destructive action is requested without a safe approval gate.
- Paid-only design has no open or local fallback.

## Correctness standard

The card framework check must show:

```text
falseAccepted=0
falseBlocked=0
```

`falseAccepted=0` means wrong cards were excluded.
`falseBlocked=0` means correct cards were not incorrectly blocked.

## Output shape

After using this skill, report only:

- Core result
- Files changed
- Validation result
- Remaining blockers
- Next task
