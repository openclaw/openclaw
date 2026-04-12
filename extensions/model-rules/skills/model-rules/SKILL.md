---
name: model-rules
description: "Per-model corrective instructions that patch known model defects"
metadata: { "openclaw": { "emoji": "🎯" } }
---

# Model Rules

Injects model-specific corrective instructions into the system prompt on every turn. Only rules for the currently active model are injected. If no rules exist for the current model, nothing is injected and zero tokens are spent.

## How to enable

```json5
{
  plugins: {
    entries: {
      "model-rules": {},
    },
  },
}
```

## How to add rules for any model

Rules live in `MODELS.md` in the workspace. Each model has a section:

```
## MODEL: gpt-5.4

Never describe what you would do — do it and show the result.
When modifying files, show the actual diff or final state.
```

To add a new model, add a new `## MODEL:` heading with the exact model ID. No code changes or PRs needed — edit the file and rules take effect on the next message.

This works with any provider: cloud (OpenAI, Anthropic, Google), local (Ollama, vLLM, LM Studio), or custom endpoints. Use the model ID exactly as it appears in your OpenClaw config.

## Writing effective rules

Good rules are direct behavioral instructions that address specific failure modes:

```
## MODEL: gpt-5.4

Never describe what you would do — do it and show the result.
When modifying files, show the actual diff or final state.
Limit responses to 150 tokens unless the task requires more.
```

Avoid vague or generic guidance:

```
## MODEL: gpt-5.4

Be helpful and accurate.
Try your best.
```

The first example addresses specific GPT-5.4 failure modes (verbosity, describing instead of acting). The second could apply to any model and adds no value.

## How matching works

1. The plugin reads the active model for this turn (not the session default).
2. It tries the full ref first (e.g., `## MODEL: openai/gpt-5.4`).
3. If no full-ref section exists, it tries the bare ID (e.g., `## MODEL: gpt-5.4`).
4. Matching is case-insensitive.
5. Only the matched section is injected — other models' rules never enter context.
6. If you switch models mid-session, rules update automatically on the next message.
7. Sections containing only `[paste rules here]` (the default placeholder) are skipped.

## Local models

Local models work the same way. Use the model ID as OpenClaw sees it:

- Ollama: `## MODEL: gemma4` or `## MODEL: llama4`
- vLLM/LM Studio: use whatever model ID appears in your OpenClaw config

Check your active model ID with `openclaw config get agents.defaults.model`.

## Config options

| Option           | Default     | Description                                  |
| ---------------- | ----------- | -------------------------------------------- |
| `enabled`        | `true`      | Toggle the plugin on or off                  |
| `modelsFile`     | `MODELS.md` | Custom filename for the rules file           |
| `disabledModels` | `[]`        | Model IDs to skip even if they have sections |

Example:

```json5
{
  plugins: {
    entries: {
      "model-rules": {
        config: {
          disabledModels: ["gpt-5.3"],
        },
      },
    },
  },
}
```

## Debugging

**Rules not applied?** Most common cause is a model ID mismatch. Check:

```bash
openclaw config get agents.defaults.model
```

The output (e.g., `openai/gpt-5.4`) must match a `## MODEL:` heading in MODELS.md. Either `## MODEL: openai/gpt-5.4` (full ref) or `## MODEL: gpt-5.4` (bare ID) will work.

**Section skipped?** Sections containing only the default placeholder text `[paste rules here]` are ignored. Replace the placeholder with real rules.

**File not found?** The plugin looks for MODELS.md in the workspace root. If you moved it, set `modelsFile` in plugin config.

## Format notes

- `## MODEL:` must start at the beginning of a line.
- Everything between one `## MODEL:` heading and the next is the section body.
- Avoid writing `## MODEL:` inside fenced code blocks — the parser reads line-by-line and cannot distinguish headings inside code fences.

## When NOT to use model-rules

| Need                               | Use instead               |
| ---------------------------------- | ------------------------- |
| Personality, tone, persona         | `SOUL.md`                 |
| Project-wide coding standards      | `AGENTS.md`               |
| Tool configuration and preferences | `TOOLS.md`                |
| User profile and preferences       | `USER.md`                 |
| Model-specific failure corrections | `MODELS.md` (this plugin) |
