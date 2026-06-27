# SNES Studio Agent Routing

## Default model policy

- Producer Orchestrator: deterministic script, no model.
- Initial blueprint and final high-level review: GPT 5.5 high-reasoning, approval-gated.
- Routine workers: `ollama/openclaw-control-qwen3-30b-q6-chatfix:latest`.
- Quality fallback: `ollama/openclaw-control-qwen36-27b:latest`.
- Speed fallback: `ollama/openclaw-control-qwen25-32b:latest`.
- Hosted GLM: disabled unless explicitly approved.

## Parallel-safe workers

These can run together when write surfaces do not overlap:

- `snes-level-designer`
- `snes-game-feel-tuner`
- `snes-pixel-art-director`
- `snes-audio-spc700`
- `snes-engine-architect`

## Sequential gates

Run these sequentially:

- initial blueprint;
- integration;
- ROM build;
- milestone judging;
- final release decision.

The worker who produced a milestone must not approve it.

## PCC v3 Multi-Agent Coordination

PCC v3 adds dispatch dry-runs, worker sandbox contracts, write-surface guards, patch application gates, local-only live worker dispatch, parallel scheduling metadata, model health routing, artifact cache metadata, reviewer receipts, conflict detection, compact memory cards, telemetry, dashboard snapshots, and legal clean-room prompt-to-ROM benchmark scaffolding. Hosted GLM, paid tools, commercial SNES material, FXPAK writes, push/PR, and human production visual approval remain approval-gated.

## Real local worker routing

Dry-run dispatch creates packets only. Real worker dispatch requires `--local-only --invoke-local-models`, uses installed Ollama/OpenClaw models, records model health and response hashes, and falls back only to other healthy local models. Hosted GPT/GLM routing remains approval-gated.
