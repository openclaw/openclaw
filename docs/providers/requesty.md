---
summary: "Use Requesty's unified OpenAI-compatible router to access hundreds of models in OpenClaw"
title: "Requesty"
read_when:
  - You want a single API key for many LLMs
  - You want to run models via Requesty in OpenClaw
---

[Requesty](https://requesty.ai) routes requests to hundreds of models behind a single
OpenAI-compatible endpoint and API key, with per-request pricing and prompt caching.

| Property      | Value                                    |
| ------------- | ---------------------------------------- |
| Provider      | `requesty`                               |
| Distribution  | Bundled with OpenClaw                    |
| Auth          | `REQUESTY_API_KEY`                       |
| API           | OpenAI-compatible                        |
| Base URL      | `https://router.requesty.ai/v1/`         |
| Model catalog | Auto-discovered via `/v1/models/managed` |

Requesty ships with OpenClaw as a bundled provider plugin. No separate plugin
installation is required; it updates together with OpenClaw.

## Setup

<Steps>
  <Step title="Create an API key">
    Go to [app.requesty.ai](https://app.requesty.ai), sign in or create an account, then generate an API key.
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice requesty-api-key
    ```

    Or set the environment variable directly:

    ```bash
    export REQUESTY_API_KEY="<your-requesty-api-key>" # pragma: allowlist secret
    ```

  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider requesty
    ```
  </Step>
</Steps>

Onboarding preserves your model entries and leaves generated catalog rows to discovery. With `models.mode: "replace"`, it also writes the built-in catalog because that mode skips discovery.

## Non-interactive example

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --mode local \
  --auth-choice requesty-api-key \
  --requesty-api-key "$REQUESTY_API_KEY"
```

## Default model and catalog

The default model is `requesty/claude-sonnet-5-5`.

Once a key is configured, OpenClaw queries `GET https://router.requesty.ai/v1/models/managed`
with that key and publishes the managed policies your key can route to, with Requesty's live
prices, context window, output limit, vision, and reasoning flags. Managed policies are
addressed by bare name (`claude-sonnet-5-5`, `gpt-6-luna`, `gemini-3.8-flash`), and
Requesty picks the hosting provider. When discovery is unavailable, the static catalog
keeps those three defaults addressable.

Run `/models requesty` or `openclaw models list --provider requesty` to see the list for your
key.

## Config example

```json5
{
  env: { vars: { REQUESTY_API_KEY: "<your-requesty-api-key>" } }, // pragma: allowlist secret
  agents: {
    defaults: {
      model: { primary: "requesty/claude-sonnet-5-5" },
    },
  },
}
```

## Behavior notes

<AccordionGroup>
  <Accordion title="Managed policies and provider-specific ids">
    Discovery lists Requesty's managed policies, which route a bare model name to the best
    available hosting provider under your organization's routing and compliance settings.
    To pin a specific host instead (`vertex/claude-sonnet-4-6`,
    `bedrock/claude-sonnet-4-6`), add that id under
    `models.providers.requesty.models` in your config; OpenClaw publishes authored rows
    alongside the discovered policies.
  </Accordion>

  <Accordion title="Transport, reasoning, and tools">
    Requests use the OpenAI-compatible chat completions path with a Bearer token built from
    your API key. Streaming, tool calls, and vision input work for models whose catalog
    flags advertise them. `/think` levels are sent as the standard `reasoning_effort`
    field for models that report `supports_reasoning`.

    Gemini-backed refs stay on the proxy-Gemini replay path: OpenClaw sanitizes Gemini
    thought signatures there but does not enable native Gemini replay validation.

  </Accordion>

  <Accordion title="Prompt caching">
    OpenClaw does not send Anthropic `cache_control` markers or enable Requesty's
    `auto_cache`. Any caching is controlled by Requesty and the upstream provider.
    Discovered prices include cache read and cache write rates for usage accounting;
    they do not enable caching.
  </Accordion>

  <Accordion title="App attribution">
    Requests to `router.requesty.ai` carry `HTTP-Referer: https://openclaw.ai` and
    `X-Title: OpenClaw` so Requesty's dashboard can attribute usage to OpenClaw. Custom
    headers you set elsewhere are preserved; these two are provider-owned.
  </Accordion>

  <Accordion title="Troubleshooting">
    - Discovery only runs once `REQUESTY_API_KEY` is configured; the list reflects what that key is approved to use.
    - If discovery fails, OpenClaw reports an unavailable catalog refresh and keeps the static rows; a rejected key is reported as an authentication failure rather than an empty catalog.
    - If a policy you expect is missing, check the key's approved models and routing policies in the Requesty dashboard.
    - When Gateway runs as a daemon, ensure `REQUESTY_API_KEY` is available to that process (for example in `~/.openclaw/.env` or via `env.shellEnv`).

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
  <Card title="Requesty" href="https://app.requesty.ai" icon="arrow-up-right-from-square">
    Requesty dashboard, API keys, and usage analytics.
  </Card>
</CardGroup>
