---
summary: "SNES Studio local model benchmark and promotion policy"
read_when:
  - You are comparing local models for SNES Studio worker roles
  - You are changing SNES Studio model routing defaults
  - You need to know when GLM or another local model can be promoted
title: "SNES Studio Model Benchmarking"
---

SNES Studio promotes models only from local benchmark receipts. Installed models are not automatically trusted.

## Current Default Policy

Routine worker model:

```text
ollama/openclaw-control-qwen3-30b-q6-chatfix:latest
```

Fallbacks:

```text
ollama/openclaw-control-qwen36-27b:latest
ollama/openclaw-control-qwen25-32b:latest
```

Use GPT 5.5 for blueprint, repeated blocker diagnosis, and final review. Do not use it for routine patch generation when deterministic scripts or local workers can do the work.

## Benchmark Command

```bash
pnpm snes:benchmark:models -- --mode output --rounds 3 --judge none --no-download --timeout 180 --json
```

Hosted GLM and model downloads are disabled unless explicitly approved. Promotion requires valid JSON, safe patches, SNES specificity, verification awareness, reliability, and no blocked or unsafe runs.

## PCC v3 Multi-Agent Coordination

PCC v3 adds dispatch dry-runs, worker sandbox contracts, write-surface guards, patch application gates, local-only live worker dispatch, parallel scheduling metadata, model health routing, artifact cache metadata, reviewer receipts, conflict detection, compact memory cards, telemetry, dashboard snapshots, and legal clean-room prompt-to-ROM benchmark scaffolding. Hosted GLM, paid tools, commercial SNES material, FXPAK writes, push/PR, and human production visual approval remain approval-gated.

## PCC model health versus benchmark scores

Model benchmarks compare quality, but PCC `model-health` is the executable readiness check for live worker use. A model is eligible only when it is installed locally, returns valid JSON within timeout, and keeps `hostedGlmUsed: false` and `gpt55Used: false`.
