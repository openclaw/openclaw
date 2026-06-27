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
