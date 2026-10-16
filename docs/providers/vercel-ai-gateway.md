---
summary: "Vercel AI Gateway setup (auth + model selection)"
title: "Vercel AI gateway"
read_when:
  - You want to use Vercel AI Gateway with OpenClaw
  - You need the API key env var or CLI auth choice
---

The [Vercel AI Gateway](https://vercel.com/ai-gateway) provides a unified API to
access hundreds of models through a single endpoint.

| Property      | Value                                  |
| ------------- | -------------------------------------- |
| Provider      | `vercel-ai-gateway`                    |
| Package       | `@openclaw/vercel-ai-gateway-provider` |
| Auth          | `AI_GATEWAY_API_KEY`                   |
| API           | Anthropic Messages compatible          |
| Base URL      | `https://ai-gateway.vercel.sh`         |
| Model catalog | Auto-discovered via `/v1/models`       |

<Tip>
OpenClaw auto-discovers the Gateway `/v1/models` catalog, so both the
`/models vercel-ai-gateway` chat command and
`openclaw models list --provider vercel-ai-gateway` include current model
refs such as `vercel-ai-gateway/openai/gpt-5.5` and
`vercel-ai-gateway/moonshotai/kimi-k2.6`.
</Tip>

## Getting started

These steps use a regular AI Gateway API key. For a subscription-scoped key,
follow [Token Pass](/providers/vercel-ai-gateway#token-pass) below instead of using the Claude default.

<Steps>
  <Step title="Install the plugin">
    ```bash
    openclaw plugins install @openclaw/vercel-ai-gateway-provider
    ```

    Installation applies to a running Gateway automatically; otherwise it takes effect
    on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

  </Step>
  <Step title="Set the API key">
    ```bash
    openclaw onboard --auth-choice ai-gateway-api-key
    ```
  </Step>
  <Step title="Set a default model">
    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
        },
      },
    }
    ```
  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider vercel-ai-gateway
    ```
  </Step>
</Steps>

## Non-interactive example

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## Token Pass

[Vercel Token Pass](https://vercel.com/docs/ai-gateway/token-pass) uses a
**Token Pass API key**, not a regular AI Gateway API key or a Vercel access
token. Create the key for the team with the active subscription. OpenClaw uses
the existing `vercel-ai-gateway` plugin and auth flow; no separate provider or
endpoint is needed.

1. Install the plugin as above, then run
   `openclaw onboard --auth-choice ai-gateway-api-key` and enter the Token Pass
   key at the protected prompt. `AI_GATEWAY_API_KEY` also accepts this key.
2. Replace the onboarding Claude default with a featured model. Vercel currently
   lists these Token Pass model refs:

   - `vercel-ai-gateway/moonshotai/kimi-k3`
   - `vercel-ai-gateway/zai/glm-5.3`

3. To keep this agent on Token Pass only, list its saved profiles and restrict
   its auth order to the profile holding that key. Replace the placeholder with
   the actual profile id from the list:

   ```bash
   openclaw models auth list --provider vercel-ai-gateway
   openclaw models auth order set --provider vercel-ai-gateway <token-pass-profile-id>
   ```

4. Set the primary model, an empty model fallback list, and the allowed featured
   models in `openclaw.json`. Onboarding adds a Claude model entry; replace that
   allowlist for this pass-only setup:

   ```json5
   {
     agents: {
       defaults: {
         model: {
           primary: "vercel-ai-gateway/moonshotai/kimi-k3",
           fallbacks: [],
         },
         models: {
           "vercel-ai-gateway/moonshotai/kimi-k3": {},
           "vercel-ai-gateway/zai/glm-5.3": {},
         },
       },
     },
   }
   ```

Apply the same restrictions to any per-agent model overrides. For another
agent, use `--agent <id>` on the auth commands. Clear any session-specific
selection of a different account before using the restricted route. An empty
model fallback list does not disable rotation among eligible credentials:
if a regular paid Gateway key remains eligible, OpenClaw can use it after a
Token Pass failure. A session preference for one key is not an exclusive auth
order. See [Model failover](/concepts/model-failover).

The Token Pass key automatically routes featured models through Vercel's
`token-pass` provider. No provider routing option is required. It cannot use
the Claude onboarding default, other non-featured models, fast variants, or
image, audio, and embedding endpoints. A model appearing in
`openclaw models list --provider vercel-ai-gateway` proves catalog availability,
not access under the subscription. Check the current
[featured models and routing rules](https://vercel.com/docs/ai-gateway/token-pass/models-and-routing)
before changing models.

Vercel returns HTTP 403 when Token Pass credits are exhausted or a model is
outside the pass. OpenClaw treats the documented exhaustion message as a
billing failure and the documented model-scope message as a model failure, so
an unsupported model does not disable the key for featured models. Vercel does
not automatically charge ordinary Gateway credits when the pass runs out.
Wait for the billing reset, or explicitly choose a regular Gateway key and
paid routing if that is your intent.

## Model ID shorthand

OpenClaw normalizes Claude shorthand model refs at runtime:

| Shorthand input                     | Normalized model ref                          |
| ----------------------------------- | --------------------------------------------- |
| `vercel-ai-gateway/claude-opus-4.6` | `vercel-ai-gateway/anthropic/claude-opus-4.6` |
| `vercel-ai-gateway/opus-4.6`        | `vercel-ai-gateway/anthropic/claude-opus-4-6` |

<Tip>
Use either form in your configuration; OpenClaw resolves the full
`anthropic/...` ref automatically.
</Tip>

## Advanced configuration

<AccordionGroup>
  <Accordion title="Environment variable for daemon processes">
    If the OpenClaw Gateway runs as a daemon (launchd/systemd), make sure
    `AI_GATEWAY_API_KEY` is available to that process.

    <Warning>
    A key exported only in an interactive shell will not be visible to a
    launchd/systemd daemon unless that environment is explicitly imported. Set
    the key in `~/.openclaw/.env` or via `env.shellEnv` so the gateway
    process can read it.
    </Warning>

  </Accordion>

  <Accordion title="Provider routing">
    Vercel AI Gateway routes each request to the upstream provider named in the
    model ref prefix. For example, `vercel-ai-gateway/anthropic/claude-opus-4.6`
    routes through Anthropic, `vercel-ai-gateway/openai/gpt-5.5` routes through
    OpenAI, and `vercel-ai-gateway/moonshotai/kimi-k2.6` routes through
    MoonshotAI. A regular `AI_GATEWAY_API_KEY` authenticates those routes;
    a Token Pass key is restricted to its featured models.
  </Accordion>
  <Accordion title="Thinking levels">
    `/think` options follow the upstream model prefix when OpenClaw recognizes
    it. `vercel-ai-gateway/anthropic/...` uses the Claude thinking profile,
    including the adaptive default for Claude 4.6 models. Trusted
    `vercel-ai-gateway/openai/...` refs (`gpt-5.2` and newer, plus Codex
    variants down to `gpt-5.1-codex`) expose `/think xhigh`. Other namespaced
    refs keep the standard reasoning levels unless their catalog metadata
    declares more.
  </Accordion>
  <Accordion title="App attribution">
    Requests to `ai-gateway.vercel.sh` carry Vercel's documented app-attribution
    headers, `HTTP-Referer: https://openclaw.ai` and `X-Title: OpenClaw`. This
    also applies to custom provider ids whose `baseUrl` points at AI Gateway.
    A custom proxy `baseUrl` gets no attribution headers.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    General troubleshooting and FAQ.
  </Card>
</CardGroup>
