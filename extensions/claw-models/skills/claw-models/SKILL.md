---
name: claw-models
description: "Per-model corrective instructions that patch known model defects"
metadata:
  { "openclaw": { "emoji": "🎯" } }
---

# Claw Models — Per-Model Corrective Rules

This plugin injects model-specific corrective instructions into your context at bootstrap. Only rules for your exact model ID are injected — you never see rules for other models. If no rules exist for the current model, nothing is injected.

## How to enable

Add the plugin to your `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "claw-models": {}
    }
  }
}
```

## How to edit rules

Rules live in `MODELS.md` in the workspace. Each model has a section:

```
## MODEL: <exact-model-id>

Your corrective rules here.
```

Edit the file directly. Changes take effect on the next message.

## How to add rules for a new model

Add a new section to `MODELS.md` using the exact model ID from your OpenClaw config (the part after the provider prefix, e.g., `gpt-5.4` from `openai/gpt-5.4`).

## How to disable rules

Either:
- Delete the section from `MODELS.md`
- Add the model ID to `disabledModels` in the plugin config
- Set `enabled: false` in the plugin config to disable entirely
