---
title: AJ Router
description: Classifier-driven model selection with sensitivity gating.
---

The **AJ Router** plugin picks the cheapest provider/model pair that can
handle each request, gated by a data-sensitivity policy. It runs on the
`before_model_resolve` hook and rewrites the provider+model override for
every agent run.

Plugin id: `aj-router`. Disabled by default.

## When to enable

Turn this on when:

- You have multiple providers configured and want to stop paying flagship
  prices for trivial classification/extraction tasks.
- You handle data at different sensitivity levels (e.g. business ops vs.
  client-privileged material) and want a hard gate that privileged prompts
  never leave the machine.
- You want post-hoc routing telemetry for cost analysis.

## Enable

Add to `openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "aj-router": { "enabled": true },
    },
  },
}
```

Built-in defaults route simple prompts to Haiku 4.5 and everything else
to Sonnet 4.6. Override any key under `plugins.entries["aj-router"].config`.

## Decision flow

```
prompt + sensitivity
      │
      ▼
classifier (heuristic) ──► tier: simple | medium | complex
      │
      ▼
classificationRules ──► alias
      │
      ▼
aliases ──► candidate provider/model
      │
      ▼
sensitivity gate ──► allow | force-alias | reject
      │
      ▼
escalation (if confidence < threshold) ──► bump tier one rung
      │
      ▼
modelOverride + providerOverride (or fall-through on reject)
```

## Commands

Run inside any chat surface:

- `/router stats` — last 7 days of routing activity.
- `/router health` — alias map with auth-env-var status per provider.
- `/router explain <prompt>` — dry-run the resolver, show the full trail.

## Privileged data

Set `sensitivity.privileged.forceAlias = "privileged"` and
`sensitivity.privileged.blockExternal = true`. Point the `privileged`
alias at a local provider (`ollama/<model>` or `lmstudio/<model>`).

Requests tagged `privileged` that would resolve to an external provider
are **rejected**, not silently sent — the hook returns no override, and
the request falls through to the caller-chosen model.

## Logs

Default: `~/.openclaw/logs/aj-router/routing.jsonl`. One line per
decision. Stored fields: timestamp, sensitivity, tier, confidence,
alias, modelRef, escalated flag, prompt length, rejection reason (if
any). The prompt itself is **never** stored.

Override with `plugins.entries["aj-router"].config.logsDir`.

## See also

- `extensions/aj-router/README.md` — plugin-level details, tests
- Hook reference: `before_model_resolve` in the SDK types
