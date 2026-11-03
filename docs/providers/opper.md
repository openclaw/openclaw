---
summary: "Use Opper, a European AI gateway, to access 700+ models through one OpenAI-compatible key in OpenClaw"
title: "Opper"
read_when:
  - You want a single API key for many LLMs
  - You want a European AI gateway
  - You want to run models via Opper in OpenClaw
---

[Opper](https://opper.ai) is a European AI gateway. It routes requests to 700+ models
from 50+ providers behind a single OpenAI-compatible endpoint and API key.

| Property      | Value                                         |
| ------------- | --------------------------------------------- |
| Provider      | `opper`                                       |
| Distribution  | Bundled with OpenClaw                         |
| Auth          | `OPPER_API_KEY`                               |
| API           | OpenAI-compatible                             |
| Base URL      | `https://api.opper.ai/v3/compat/`             |
| Model catalog | Auto-discovered via `/models?view=simplified` |

Opper ships with OpenClaw as a bundled provider plugin. No separate plugin
installation is required; it updates together with OpenClaw.

## Setup

<Steps>
  <Step title="Create an API key">
    Go to [platform.opper.ai](https://platform.opper.ai), sign in or create an account, then generate an API key.
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice opper-api-key
    ```

    Or set the environment variable directly:

    ```bash
    export OPPER_API_KEY="<your-opper-api-key>" # pragma: allowlist secret
    ```

  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider opper
    ```
  </Step>
</Steps>

Onboarding preserves your model entries and leaves generated catalog rows to discovery. With `models.mode: "replace"`, it also writes the built-in catalog because that mode skips discovery.

## Non-interactive example

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --mode local \
  --auth-choice opper-api-key \
  --opper-api-key "$OPPER_API_KEY"
```

## Default model and catalog

The default model is `opper/claude-sonnet-5-5`.

Once a key is configured, OpenClaw queries `GET https://api.opper.ai/v3/compat/models?view=simplified`
with that key and publishes the models your key can route to, with Opper's live prices,
context window, output limit, vision, and reasoning flags. Models served by several
providers are addressed by bare name (`claude-sonnet-5-5`, `gpt-6-luna`, `gemini-3.8-flash`),
and Opper picks the route. When discovery is unavailable, the static catalog keeps those
three defaults addressable.

Run `/models opper` or `openclaw models list --provider opper` to see the list for your key.

## Config example

```json5
{
  env: { vars: { OPPER_API_KEY: "<your-opper-api-key>" } }, // pragma: allowlist secret
  agents: {
    defaults: {
      model: { primary: "opper/claude-sonnet-5-5" },
    },
  },
}
```

## Behavior notes

<AccordionGroup>
  <Accordion title="Bare model names and pinned routes">
    Discovery lists each model once. A bare name routes across every provider that serves
    the model, under your organization's rules in Opper. To pin one provider or region
    instead (`aws/claude-sonnet-5-5`, `vertexai/gemini-3.8-flash-eu`), add that id under
    `models.providers.opper.models` in your config; OpenClaw publishes authored rows
    alongside the discovered models.
  </Accordion>

  <Accordion title="Transport, reasoning, and tools">
    Requests use the OpenAI-compatible chat completions path with a Bearer token built from
    your API key. Streaming, tool calls, and vision input work for models whose catalog
    flags advertise them. `/think` levels are sent as the standard `reasoning_effort`
    field for models that report the `reasoning` capability.

    Gemini-backed refs stay on the proxy-Gemini replay path: OpenClaw sanitizes Gemini
    thought signatures there but does not enable native Gemini replay validation.

  </Accordion>

  <Accordion title="Prompt caching">
    OpenClaw does not send Anthropic `cache_control` markers to Opper. Any caching is
    controlled by Opper and the upstream provider. Discovered prices include cache read
    and cache write rates for usage accounting; they do not enable caching.
  </Accordion>

  <Accordion title="Troubleshooting">
    - Discovery only runs once `OPPER_API_KEY` is configured; the list reflects what that key is allowed to use.
    - If discovery fails, OpenClaw reports an unavailable catalog refresh and keeps the static rows; a rejected key is reported as an authentication failure rather than an empty catalog.
    - If a model you expect is missing, check the rules for your project in the Opper console.
    - When Gateway runs as a daemon, ensure `OPPER_API_KEY` is available to that process (for example in `~/.openclaw/.env` or via `env.shellEnv`).

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full OpenClaw configuration reference.
  </Card>
  <Card title="Opper" href="https://platform.opper.ai" icon="arrow-up-right-from-square">
    Opper console, API keys, and usage.
  </Card>
</CardGroup>
