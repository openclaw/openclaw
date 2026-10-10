---
summary: "DeepSeek setup (auth + model selection)"
title: "DeepSeek"
read_when:
  - You want to use DeepSeek with OpenClaw
  - You need the API key env var or CLI auth choice
---

[DeepSeek](https://www.deepseek.com) provides powerful AI models with an OpenAI-compatible API.

| Property | Value                      |
| -------- | -------------------------- |
| Provider | `deepseek`                 |
| Auth     | `DEEPSEEK_API_KEY`         |
| API      | OpenAI-compatible          |
| Base URL | `https://api.deepseek.com` |

## Install plugin

Install the official plugin:

```bash
openclaw plugins install @openclaw/deepseek-provider
```

Installation applies to a running Gateway automatically; otherwise it takes effect
on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

## Getting started

<Steps>
  <Step title="Get your API key">
    Create an API key at [platform.deepseek.com](https://platform.deepseek.com/api_keys).
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice deepseek-api-key
    ```

    Prompts for your API key and sets `deepseek/deepseek-v4-pro` as the default model.

  </Step>
  <Step title="Verify models are available">
    ```bash
    openclaw models list --provider deepseek
    ```

    To inspect the plugin's static catalog without a running Gateway:

    ```bash
    openclaw models list --all --provider deepseek
    ```

  </Step>
</Steps>

Onboarding preserves your model entries and leaves generated catalog rows to discovery. With `models.mode: "replace"`, it also writes the built-in catalog because that mode skips discovery.

<AccordionGroup>
  <Accordion title="Non-interactive setup">
    For scripted or headless installations, pass all flags directly:

    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice deepseek-api-key \
      --deepseek-api-key "$DEEPSEEK_API_KEY" \
      --skip-health \
      --accept-risk
    ```

  </Accordion>
</AccordionGroup>

<Warning>
If Gateway runs as a daemon (launchd/systemd), make sure `DEEPSEEK_API_KEY` is
available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).
</Warning>

## Built-in catalog

| Model ref                               | Name                                    | Input       | Context   | Max output | Notes                            |
| --------------------------------------- | --------------------------------------- | ----------- | --------- | ---------- | -------------------------------- |
| `deepseek/deepseek-flash`               | DeepSeek V4.1 Flash                     | text, image | 1,000,000 | 384,000    | Canonical Flash model            |
| `deepseek/deepseek-v4-flash`            | DeepSeek V4 Flash                       | text        | 1,000,000 | 384,000    | Fast V4 thinking-capable surface |
| `deepseek/deepseek-v4-pro`              | DeepSeek V4 Pro                         | text        | 1,000,000 | 384,000    | Onboarding default               |
| `deepseek/deepseek-v4-flash-vision-exp` | DeepSeek V4 Flash Vision (Experimental) | text, image | 1,000,000 | 384,000    | Experimental image understanding |

<Warning>
DeepSeek retired `deepseek-chat` and `deepseek-reasoner` on July 24, 2026 at
15:59 UTC. Those model IDs are no longer accessible. Move configured model refs
to `deepseek/deepseek-v4-flash` or `deepseek/deepseek-v4-pro`.
</Warning>

OpenClaw's local costs are estimates. Canonical Flash uses DeepSeek's peak
rates: $0.30 per million input tokens, $1.20 per million output tokens, and
$0.006 per million cached input tokens. Published off-peak rates are half those amounts.
Legacy rows retain their earlier bundled metadata. DeepSeek still accepts
`deepseek-v4-flash` and `deepseek-v4-flash-vision-exp`, routes them to V4.1 Flash,
and bills them at current Flash rates. Existing explicit selections remain valid in OpenClaw.
DeepSeek can change rates; its
[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) page is
authoritative for billing.

For image inputs, select `deepseek/deepseek-flash`. The legacy
`deepseek/deepseek-v4-flash-vision-exp` selection also retains image support.
Canonical Flash accepts
PNG, JPEG, GIF, and WebP images through the same API and API key. See
[DeepSeek vision](https://api-docs.deepseek.com/guides/vision) for image limits.

<Tip>
Canonical Flash and V4 models support DeepSeek's `thinking` control. OpenClaw also replays
DeepSeek `reasoning_content` on follow-up turns so thinking sessions with tool
calls can continue.
Use `/think xhigh` or `/think max` with DeepSeek V4 models to request DeepSeek's
maximum `reasoning_effort`; both map to `"max"`.
</Tip>

## Thinking and tools

DeepSeek V4 thinking sessions require replayed assistant messages from a
thinking-enabled turn to include `reasoning_content` on follow-up requests.
OpenClaw's DeepSeek plugin backfills that field automatically, so normal
multi-turn tool use works on `deepseek/deepseek-flash`, `deepseek/deepseek-v4-flash`,
`deepseek/deepseek-v4-flash-vision-exp`, and `deepseek/deepseek-v4-pro` even when history came from another
OpenAI-compatible provider (no native `reasoning_content`) or from a plain
assistant message. No `/new` required after switching providers mid-session.

When thinking is disabled (including the UI **None** selection), OpenClaw
sends `thinking: { type: "disabled" }` and strips replayed `reasoning_content`
from outgoing history, keeping the session on the non-thinking DeepSeek path.

Fresh onboarding selects `deepseek/deepseek-v4-pro`. To select canonical Flash:

```bash
openclaw models set deepseek/deepseek-flash
```

## Live testing

To run only the DeepSeek V4 direct-model checks from the modern model live suite:

```bash
OPENCLAW_LIVE_PROVIDERS=deepseek \
OPENCLAW_LIVE_MODELS="deepseek/deepseek-v4-flash,deepseek/deepseek-v4-pro" \
pnpm test:live src/agents/models.profiles.live.test.ts
```

Verifies both V4 models complete and that thinking/tool follow-up turns
preserve the replay payload DeepSeek requires.

To check the experimental vision model with the same `DEEPSEEK_API_KEY`:

```bash
OPENCLAW_LIVE_DEEPSEEK_MODEL=deepseek-v4-flash-vision-exp \
pnpm test:live extensions/deepseek/deepseek.live.test.ts
```

This runs text, generated-image recognition, and thinking replay checks against
the selected model.

## Config example

```json5
{
  env: { vars: { DEEPSEEK_API_KEY: "sk-..." } },
  agents: {
    defaults: {
      model: { primary: "deepseek/deepseek-v4-pro" },
    },
  },
}
```

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="ds4 local server" href="/providers/ds4" icon="server">
    Running DeepSeek V4 Flash from a local OpenAI-compatible ds4 server.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
</CardGroup>
