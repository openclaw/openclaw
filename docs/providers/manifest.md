---
summary: "Use Manifest, an open-source LLM router, in OpenClaw"
read_when:
  - You want to cut inference costs with smart model routing
  - You need MANIFEST_API_KEY setup
title: "Manifest"
---

[Manifest](https://manifest.build) is an open-source LLM router that cuts inference
costs through smart routing across 16+ providers. You get full control over which
model handles each request. Route by complexity tier, task-specificity (coding, web
browsing, etc.) and custom tiers. API keys start with `mnfst_`.

## Getting started

<Steps>
  <Step title="Get your API key">
    Create an API key at [manifest.build](https://manifest.build), or
    self-host Manifest with Docker for fully private inference.
  </Step>
  <Step title="Export the key and run onboarding">
    ```bash
    export MANIFEST_API_KEY="mnfst_..."
    openclaw onboard --auth-choice manifest-api-key
    ```
  </Step>
  <Step title="Set the Manifest model">
    ```bash
    openclaw models set manifest/auto
    ```
  </Step>
</Steps>

<Warning>
If you pass `--manifest-api-key` instead of the env var, the value lands in shell
history and `ps` output. Prefer the `MANIFEST_API_KEY` environment variable when
possible.
</Warning>

For non-interactive setup, you can also pass the key directly:

```bash
openclaw onboard --auth-choice manifest-api-key --manifest-api-key "mnfst_..."
```

## Config example

```json5
{
  env: { MANIFEST_API_KEY: "mnfst_..." },
  agents: {
    defaults: {
      model: { primary: "manifest/auto" },
    },
  },
}
```

## Built-in catalog

| Model ref        | Name           | Context | Max output |
| ---------------- | -------------- | ------- | ---------- |
| `manifest/auto`  | Manifest Auto  | 200,000 | 16,384     |

## Advanced configuration

<AccordionGroup>
  <Accordion title="Auto-enable behavior">
    The provider auto-enables when the `MANIFEST_API_KEY` environment variable is set.
    No explicit provider config is required beyond the key.
  </Accordion>

  <Accordion title="Self-hosted Manifest">
    Manifest is open-source and can be self-hosted with Docker. Override the base URL
    in your config to point to your local instance:

    ```json5
    {
      models: {
        providers: {
          manifest: {
            baseUrl: "http://localhost:2099/v1",
          },
        },
      },
    }
    ```

    Self-hosted Manifest can route to local models (Ollama, vLLM, llama.cpp) for
    fully private inference. See [manifest.build](https://manifest.build) for
    deployment instructions.
  </Accordion>

  <Accordion title="OpenAI-compatible endpoint">
    Manifest uses the standard `/v1/chat/completions` endpoint. Any
    OpenAI-compatible tooling works out of the box with the Manifest base URL.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
</CardGroup>
