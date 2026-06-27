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
