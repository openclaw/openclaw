---
summary: "OpenPaths setup (auth + auto task-tier models)"
title: "OpenPaths"
read_when:
  - You want to use OpenPaths with OpenClaw
  - You need OPENPATHS_API_KEY setup
  - You want OpenPaths auto, easy, medium, hard, or autothink models
---

[OpenPaths](https://openpaths.io) is an OpenAI-compatible model router. The
bundled provider plugin lets OpenClaw use one OpenPaths key while routing agent
turns through OpenPaths auto model selection.

| Property | Value                     |
| -------- | ------------------------- |
| Provider | `openpaths`               |
| Auth     | `OPENPATHS_API_KEY`       |
| API      | OpenAI-compatible         |
| Base URL | `https://openpaths.io/v1` |

## Getting started

<Steps>
  <Step title="Get your API key">
    Create an API key in OpenPaths and export it on the Gateway host:

    ```bash
    export OPENPATHS_API_KEY="op-..."
    ```

  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice openpaths-api-key
    ```

    This prompts for the key and sets `openpaths/auto-medium-task` as the
    default model.

  </Step>
  <Step title="Verify the catalog">
    ```bash
    openclaw models list --provider openpaths
    openclaw models list --all --provider openpaths
    ```
  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Non-interactive setup">
    For scripted or headless installations, pass all flags directly:

    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice openpaths-api-key \
      --openpaths-api-key "$OPENPATHS_API_KEY" \
      --skip-health \
      --accept-risk
    ```

  </Accordion>
</AccordionGroup>

<Warning>
If the Gateway runs as a daemon (launchd/systemd), make sure
`OPENPATHS_API_KEY` is available to that process, for example in
`~/.openclaw/.env` or through `env.shellEnv`.
</Warning>

## Built-in catalog

| Model ref                    | Name                       | Notes                        |
| ---------------------------- | -------------------------- | ---------------------------- |
| `openpaths/auto`             | OpenPaths Auto             | General automatic routing    |
| `openpaths/auto-easy-task`   | OpenPaths Auto Easy Task   | Lower-cost simple tasks      |
| `openpaths/auto-medium-task` | OpenPaths Auto Medium Task | Default practical agent tier |
| `openpaths/auto-hard-task`   | OpenPaths Auto Hard Task   | Harder reasoning/coding work |
| `openpaths/auto-think`       | OpenPaths Auto Think       | Thinking-oriented routing    |
| `openpaths/autothink`        | OpenPaths AutoThink        | Compact autothink alias      |

OpenClaw exposes `/think off|minimal|low|medium|high|xhigh` for OpenPaths auto
models. The provider sends OpenAI-compatible `reasoning_effort` values for
models that accept them; `xhigh` maps to the strongest OpenPaths-compatible
effort currently accepted by the OpenAI-compatible transport.

## Config example

```json5
{
  env: { OPENPATHS_API_KEY: "op-..." },
  agents: {
    defaults: {
      model: { primary: "openpaths/auto-medium-task" },
      thinkingDefault: "medium",
    },
  },
}
```

To override the endpoint in explicit provider config, keep the provider id but
set `models.providers.openpaths.baseUrl`. `https://openpaths.io` and
`https://openpaths.io/v1` are normalized to `https://openpaths.io/v1`.

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Authentication" href="/gateway/authentication" icon="key">
    API key storage and auth-profile behavior.
  </Card>
</CardGroup>
