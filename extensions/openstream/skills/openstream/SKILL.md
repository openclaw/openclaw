# OpenStream

Use this skill when OpenClaw is running on Ollama or another open-source model path and you need stronger diagnostics, safer tool-call behavior guidance, or context-window recommendations.

## What This Plugin Helps With

- diagnose whether the current OpenClaw config is ready for OpenStream-style Ollama tuning
- recommend a plugin config and runtime bridge config
- explain which models look like reasoning or long-context families
- keep stable system guidance cached through the OpenClaw plugin hook surface

## Preferred Entry Points

- `/openstream doctor`
- `/openstream model <modelId>`
- `/openstream sample-config`
- `openstream_doctor` tool

## Guidance

When Ollama tool-calling or long-context behavior looks brittle:

1. Run `/openstream doctor` first.
2. If a specific model is involved, run `/openstream model <modelId>`.
3. Use the generated plugin config immediately.
4. Treat the generated runtime bridge config as the path for deeper stream/parser changes until OpenClaw exposes richer provider hooks.

## Important Limit

This plugin does not claim to replace the full OpenStream runtime patch yet.
It is the bundled plugin surface that complements the built-in Ollama provider.
