---
summary: "SNES Studio production art pipeline and asset intent contract"
read_when:
  - You are creating sprites, tilesets, backgrounds, UI, or title art for SNES Studio
  - You need to judge whether art matches the prompt
  - You need to prove improved art is actually in the ROM
title: "SNES Studio Art Pipeline"
---

Production art uses an Asset Intent Contract before generation or conversion. The contract makes prompt accuracy measurable.

## Asset Intent Contract

Required fields:

- `assetId`
- `kind`
- `dimensions`
- `frames`
- `paletteLimit`
- `mustShow`
- `mustNotShow`
- `animationBeats`
- `runtimeProofRequired`
- `humanVisualTarget`

Production assets must require runtime proof and human visual approval.

## Proof Chain

1. Preserve source files and hashes.
2. Convert to SNES-safe indexed assets.
3. Validate dimensions, frame count, palette limit, blank frames, and duplicate frames.
4. Generate contact sheets and animation previews.
5. Integrate into the ROM.
6. Capture runtime screenshots.
7. Ask for human visual grade when production quality is required.

Human grade overrides synthetic or model scoring.

## PCC v3 Multi-Agent Coordination

PCC v3 adds dispatch dry-runs, worker sandbox contracts, write-surface guards, patch application gates, local-only live worker dispatch, parallel scheduling metadata, model health routing, artifact cache metadata, reviewer receipts, conflict detection, compact memory cards, telemetry, dashboard snapshots, and legal clean-room prompt-to-ROM benchmark scaffolding. Hosted GLM, paid tools, commercial SNES material, FXPAK writes, push/PR, and human production visual approval remain approval-gated.
