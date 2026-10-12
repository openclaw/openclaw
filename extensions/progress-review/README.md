# Progress Review (plugin)

Experimental and off by default. Every few turns, or after enough minutes of
agent run time, a reviewer model reads a conversation's recent agent work. When
it finds avoidable work, such as drifting beyond the request or repeated tool
calls, the agent receives one short correction on its next turn.

Enable it in **Settings → Agents & Tools → Labs → Progress review**, or:

```json
{
  "plugins": {
    "entries": {
      "progress-review": {
        "enabled": true,
        "config": { "everyTurns": 10, "everyMinutes": 20 }
      }
    }
  }
}
```

To review with a different model, also set `config.model` and trust the plugin
for that model only:

```json
{
  "plugins": {
    "entries": {
      "progress-review": {
        "config": { "model": "openai/gpt-6.1-sol" },
        "subagent": { "allowModelOverride": true, "allowedModels": ["openai/gpt-6.1-sol"] }
      }
    }
  }
}
```

Docs: https://docs.openclaw.ai/concepts/experimental-features#progress-review
