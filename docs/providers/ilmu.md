---
summary: "ILMU setup (auth + model selection)"
title: "ILMU"
read_when:
  - You want to use ILMU with OpenClaw
  - You need the API key env var or CLI auth choice
---

[ILMU](https://ilmu.ai) is a sovereign AI platform that exposes its models through an OpenAI-compatible API.

| Property | Value                                                                               |
| -------- | ----------------------------------------------------------------------------------- |
| Provider | `ilmu`                                                                              |
| Auth     | `ILMU_API_KEY`                                                                      |
| API      | OpenAI-compatible                                                                   |
| Base URL | `https://api.ilmu.ai/v1`                                                            |
| Docs     | [ILMU OpenClaw BYOM guide](https://docs.ilmu.ai/docs/developer-tools/openclaw-byom) |

## Getting started

<Steps>
  <Step title="Get your API key">
    Sign in to the ILMU console and create an API key. See the [ILMU OpenClaw BYOM guide](https://docs.ilmu.ai/docs/developer-tools/openclaw-byom) for the current console URL and key-management UI.
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice ilmu-api-key
    ```

    This prompts for your API key and sets `ilmu/nemo-super` as the default model with reasoning turned on.

  </Step>
  <Step title="Verify models are available">
    ```bash
    openclaw models list --provider ilmu
    ```

    To inspect the bundled static catalog without requiring a running Gateway,
    use:

    ```bash
    openclaw models list --all --provider ilmu
    ```

  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Non-interactive setup">
    For scripted or headless installations, pass all flags directly:

    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ilmu-api-key \
      --ilmu-api-key "$ILMU_API_KEY" \
      --skip-health \
      --accept-risk
    ```

  </Accordion>
</AccordionGroup>

<Warning>
If the Gateway runs as a daemon (launchd/systemd), make sure `ILMU_API_KEY`
is available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).
</Warning>

## Built-in catalog

| Model ref             | Name            | Input | Context | Max output | Notes                                  |
| --------------------- | --------------- | ----- | ------- | ---------- | -------------------------------------- |
| `ilmu/nemo-super`     | ILMU Nemo Super | text  | 256,000 | 128,000    | Default model; flagship reasoning tier |
| `ilmu/ilmu-nemo-nano` | ILMU Nemo Nano  | text  | 256,000 | 128,000    | Lighter sibling for cheaper turns      |

<Tip>
ILMU declares `reasoning: true` on both models. OpenClaw turns reasoning on by default during onboarding, so step-by-step thinking shows up out of the box. Toggle `agents.defaults.reasoningDefault` if you prefer non-reasoning replies.
</Tip>

## Custom base URL

Sovereign or self-hosted ILMU deployments can override the default base URL via
the standard provider config:

```json5
{
  models: {
    providers: {
      ilmu: {
        baseUrl: "https://api.your-ilmu-deployment.example/v1",
      },
    },
  },
}
```

The plugin keeps `api: "openai-completions"` and the bundled model catalog so a
private deployment serving the same model IDs works without further changes.

## Live testing

The plugin ships a live test gated on `OPENCLAW_LIVE_TEST=1`,
`ILMU_LIVE_TEST=1`, and `ILMU_API_KEY`. To run only the ILMU live checks
against `https://api.ilmu.ai/v1`:

```bash
OPENCLAW_LIVE_TEST=1 ILMU_LIVE_TEST=1 \
  pnpm test:live -- extensions/ilmu/ilmu.live.test.ts
```

The live test verifies both `nemo-super` and `ilmu-nemo-nano` complete a
single chat turn through the OpenAI-compatible endpoint.

## Config example

```json5
{
  env: { ILMU_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "ilmu/nemo-super" },
      reasoningDefault: "on",
      thinkingDefault: "medium",
    },
  },
}
```

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
</CardGroup>
