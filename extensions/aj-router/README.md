# @openclaw/aj-router

Classifier-driven model selection plugin. Routes every agent run to the
cheapest alias that can handle the prompt, gated by a data-sensitivity
policy. Logs every decision as JSONL for post-hoc cost analysis.

## What it does

1. **Classifies** the prompt via a cheap, deterministic heuristic
   (`simple | medium | complex`).
2. **Maps** the tier to an alias via `classificationRules`.
3. **Resolves** the alias to a concrete `provider/model` reference via
   `aliases`.
4. **Gates** the result through the configured `sensitivity` rule —
   privileged data can be forced onto a local model, confidential onto
   a whitelisted provider, etc.
5. **Escalates** one tier up when the classifier's confidence falls
   below `escalationThreshold`.
6. **Logs** the decision to `<logsDir>/routing.jsonl`.
7. Emits model+provider overrides via the `before_model_resolve` hook.

The plugin is disabled by default. Enable it by setting
`plugins.entries["aj-router"].enabled = true` in `openclaw.json`.

## Configuration

All keys live under `plugins.entries["aj-router"].config` in `openclaw.json`.
Missing keys fall back to the defaults baked into the plugin.

```jsonc
{
  "plugins": {
    "entries": {
      "aj-router": {
        "enabled": true,
        "config": {
          "defaultAlias": "workhorse",
          "aliases": {
            "speed": "anthropic/claude-haiku-4-5",
            "workhorse": "anthropic/claude-sonnet-4-6",
            "flagship": "anthropic/claude-sonnet-4-6",
          },
          "classificationRules": {
            "simple": "speed",
            "medium": "workhorse",
            "complex": "flagship",
          },
          "classifier": { "mode": "heuristic" },
          "sensitivity": {
            "privileged": { "forceAlias": "privileged", "blockExternal": true },
            "confidential": { "allowedProviders": ["anthropic"] },
            "internal": { "allowedProviders": ["anthropic", "google", "openai"] },
            "public": { "allowedProviders": "*" },
          },
          "defaultSensitivity": "internal",
          "escalationThreshold": 0.85,
          "budgetCeilingUsdPerRequest": 0.05,
        },
      },
    },
  },
}
```

## Commands

- `/router stats` — summary of the last 7 days (decisions, per-alias mix,
  escalation rate, average confidence).
- `/router health` — shows the alias map and whether each provider's auth
  env var is populated.
- `/router explain <prompt>` — dry-runs the resolver on the given prompt
  and prints the full decision trail without logging.

## Sensitivity labels

| Label          | Default policy                                                  |
| -------------- | --------------------------------------------------------------- |
| `public`       | Any provider allowed.                                           |
| `internal`     | Anthropic, Google, OpenAI allowed. (Default when unspecified.)  |
| `confidential` | Anthropic only.                                                 |
| `privileged`   | Forced to the `privileged` alias; must resolve to a local model |
|                | (ollama, lmstudio, llamafile) or the request is rejected.       |

> **Note:** `privileged` only functions when the `privileged` alias points
> at a local provider. Out of the box it points at Anthropic as a
> placeholder and all privileged requests reject — configure Ollama and
> re-point the alias before classifying real privileged data.

## Logs

Default path: `~/.openclaw/logs/aj-router/routing.jsonl`. One JSON record
per decision. The log stores prompt **length**, not the prompt itself.

## Classifier

v1 is heuristic-only:

- Long prompts (>4000 chars) → `complex`.
- Keyword-driven patterns for simple (classify/extract/yes-no) and
  complex (architecture/multi-agent/legal/privileged).
- Short prompts default to `simple` with low confidence so they
  escalate if unsure.

A follow-up will wire `classifier.mode: "llm"` to call a small model
(Haiku 4.5) for ambiguous cases.

## Tests

```bash
pnpm vitest run extensions/aj-router
```
