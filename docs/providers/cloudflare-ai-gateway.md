---
summary: "Cloudflare AI Gateway setup (auth + model selection)"
title: "Cloudflare AI gateway"
read_when:
  - You want to use Cloudflare AI Gateway with OpenClaw
  - You need the account ID, gateway ID, or API key env var
---

[Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) sits in front of provider APIs and adds analytics, caching, and controls. For Anthropic, OpenClaw uses the Anthropic Messages API through your Gateway endpoint.

| Property      | Value                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------- |
| Provider      | `cloudflare-ai-gateway`                                                                  |
| Plugin        | official external package (`@openclaw/cloudflare-ai-gateway-provider`)                   |
| Base URL      | `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`               |
| Default model | `cloudflare-ai-gateway/claude-sonnet-4-6`                                                |
| API key       | `CLOUDFLARE_AI_GATEWAY_API_KEY` (your provider API key for requests through the Gateway) |

<Note>
For Anthropic models routed through Cloudflare AI Gateway, use your **Anthropic API key** as the provider key.
</Note>

When thinking is enabled for Anthropic Messages models, OpenClaw strips trailing
assistant prefill turns before sending the payload through Cloudflare AI Gateway.
Anthropic rejects response prefilling with extended thinking, while ordinary
non-thinking prefill remains available.

## Install plugin

Install the official plugin:

```bash
openclaw plugins install @openclaw/cloudflare-ai-gateway-provider
```

Installation applies to a running Gateway automatically; otherwise it takes effect
on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

## Getting started

<Steps>
  <Step title="Set the provider API key and Gateway details">
    Run onboarding and choose the Cloudflare AI Gateway auth option:

    ```bash
    openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
    ```

    This prompts for your account ID, gateway ID, and API key.

  </Step>
  <Step title="Set a default model">
    Add the model to your OpenClaw config:

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-6" },
        },
      },
    }
    ```

  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider cloudflare-ai-gateway
    ```
  </Step>
</Steps>

## Non-interactive example

For scripted or CI setups, pass all values on the command line:

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## Clef Decision model

The same plugin also owns `cloudflare-workers-ai`, a separate provider for
[Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef/).
This addition requires a development checkout containing the Decision V2
contract; the previously published plugin does not include it.

Use a **Cloudflare API token with Workers AI Read permission**. The Anthropic
key in `CLOUDFLARE_AI_GATEWAY_API_KEY` and a Gateway-only authentication token
are not Workers AI credentials. OpenClaw stores the new credential in
`cloudflare-workers-ai:default` and recognizes `CLOUDFLARE_WORKERS_AI_API_TOKEN`.

```bash
openclaw models auth login --provider cloudflare-workers-ai --method api-key
```

The prompt collects the Cloudflare account ID and API token. It configures
`https://api.cloudflare.com/client/v4/accounts/<account_id>/ai` and leaves your
chat and utility defaults unchanged. Select Clef separately:

```json5
{
  agents: {
    defaults: { decisionModel: "cloudflare-workers-ai/@cf/cloudflare/clef" },
  },
}
```

Non-interactive setup reuses the existing Cloudflare account-ID flag, but uses
the separate Workers AI token flag:

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --mode local --auth-choice cloudflare-workers-ai-api-token \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-workers-ai-api-token "$CLOUDFLARE_WORKERS_AI_API_TOKEN"
```

An existing `models.providers.cloudflare-workers-ai.baseUrl` also satisfies
the account-route requirement. Custom endpoints receive
`/run/@cf/cloudflare/clef` after their path prefix. To route Workers AI through
an AI Gateway, set `models.providers.cloudflare-workers-ai.headers` with
`"cf-aig-gateway-id": "your-gateway-id"`. Existing Gateway credentials and
headers are never copied across providers. Custom routes keep the native Decision
contract but do not inherit Cloudflare's hosted pricing metadata.

Use `decision_evaluate` with `contractVersion: 2`. Clef accepts text, JSON
objects or arrays, or one inline PNG, JPEG, or WebP image. Each question needs
instructions. Supported questions are Boolean, Choice with 2-255 options,
and Score with 2-10 non-null rubric levels. A batch can contain up to 64
questions, with IDs of 1-100 letters, digits, underscores, periods, or hyphens.
Images must fit the host's 4 MiB decoded limit and Clef's 16-megapixel limit.
Remote image URLs, video, sorting, tags, and bounding boxes are not supported.

The adapter preserves native probabilities, fractional scores, confidence,
and token usage. Omit reasoning or use `auto`. Authored generation or routing
parameters are rejected rather than silently discarded. Standard provider
auth, header, proxy, TLS, and private-network settings remain available.
Evaluations transmit the supplied evidence to Cloudflare and incur Workers AI
usage charges. There is no chat fallback or automatic credential substitution.

## Advanced configuration

<AccordionGroup>
  <Accordion title="Authenticated gateways">
    If you enabled Gateway authentication in Cloudflare, add the `cf-aig-authorization` header. This is **in addition to** your provider API key.

    ```json5
    {
      models: {
        providers: {
          "cloudflare-ai-gateway": {
            headers: {
              "cf-aig-authorization": "Bearer <cloudflare-ai-gateway-token>",
            },
          },
        },
      },
    }
    ```

    <Tip>
    The `cf-aig-authorization` header authenticates with the Cloudflare Gateway itself, while the provider API key (for example, your Anthropic key) authenticates with the upstream provider.
    </Tip>

  </Accordion>

  <Accordion title="Environment note">
    If the Gateway runs as a daemon (launchd/systemd), make sure `CLOUDFLARE_AI_GATEWAY_API_KEY` is available to that process.

    <Warning>
    A key exported only in an interactive shell will not help a launchd/systemd daemon unless that environment is imported there as well. Set the key in `~/.openclaw/.env` or via `env.shellEnv` so the gateway process can read it.
    </Warning>

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
