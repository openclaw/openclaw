---
summary: "Cohere setup (auth + model selection)"
title: "Cohere"
read_when:
  - You want to use Cohere with OpenClaw
  - You need the Cohere API key env var or CLI auth choice
---

[Cohere](https://cohere.com) provides OpenAI-compatible inference through its Compatibility API. OpenClaw includes a bundled Cohere provider plugin with the Command A model catalog.

| Property        | Value                                    |
| --------------- | ---------------------------------------- |
| Provider id     | `cohere`                                 |
| Plugin          | bundled, `enabledByDefault: true`        |
| Auth env var    | `COHERE_API_KEY`                         |
| Onboarding flag | `--auth-choice cohere-api-key`           |
| Direct CLI flag | `--cohere-api-key <key>`                 |
| API             | OpenAI-compatible (`openai-completions`) |
| Base URL        | `https://api.cohere.ai/compatibility/v1` |
| Default model   | `cohere/command-a-03-2025`               |

## Get started

1. Create a Cohere API key.
2. Run onboarding:

```bash
openclaw onboard --non-interactive \
  --auth-choice cohere-api-key \
  --cohere-api-key "$COHERE_API_KEY"
```

3. Confirm the catalog is available:

```bash
openclaw models list --provider cohere
```

The default model is set only when no primary model is already configured.

## Environment-only setup

Make `COHERE_API_KEY` available to the Gateway process, then select the bundled model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cohere/command-a-03-2025" },
    },
  },
}
```

<Note>
If the Gateway runs as a daemon or in Docker, configure `COHERE_API_KEY` for that service. Exporting it only in an interactive shell does not make it available to an already-running Gateway.
</Note>

## Related

- [Model providers](/concepts/model-providers)
- [Models CLI](/cli/models)
- [Provider directory](/providers)
