---
summary: "Baseten setup for DeepSeek V4.1 Flash and hosted Model APIs"
title: "Baseten"
read_when:
  - You want image input and reasoning through Baseten Model APIs
  - You want one OpenAI-compatible API for Baseten's hosted models
---

[Baseten Model APIs](https://docs.baseten.co/inference/model-apis/overview) provide hosted, OpenAI-compatible access to frontier models. The official external plugin uses authenticated discovery, so OpenClaw follows the complete model set enabled for your Baseten account. Its offline fallback contains the current curated models listed below.

| Property        | Value                                                    |
| --------------- | -------------------------------------------------------- |
| Provider id     | `baseten`                                                |
| Plugin          | official external package (`@openclaw/baseten-provider`) |
| Auth env var    | `BASETEN_API_KEY`                                        |
| Onboarding flag | `--auth-choice baseten-api-key`                          |
| Direct CLI flag | `--baseten-api-key <key>`                                |
| API             | OpenAI-compatible (`openai-completions`)                 |
| Base URL        | `https://inference.baseten.co/v1`                        |
| Default model   | `baseten/deepseek-ai/DeepSeek-V4.1-Flash`                |

## Install plugin

```bash
openclaw plugins install @openclaw/baseten-provider
```

Installation applies to a running Gateway automatically; otherwise it takes effect
on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

## Getting started

<Steps>
  <Step title="Create a Baseten account and API key">
    Baseten's Basic plan has no monthly platform fee. Model API calls are usage-priced. Create a key in [Baseten API key settings](https://app.baseten.co/settings/api_keys) and check current rates on the [pricing page](https://www.baseten.co/pricing).
  </Step>
  <Step title="Run onboarding">
    <CodeGroup>

```bash Onboarding
openclaw onboard --auth-choice baseten-api-key
```

```bash Direct flag
openclaw onboard --non-interactive --accept-risk --skip-health \
  --auth-choice baseten-api-key \
  --baseten-api-key "$BASETEN_API_KEY"
```

```bash Env only
export BASETEN_API_KEY=...
```

    </CodeGroup>

    Onboarding saves the connection settings without copying the generated catalog into your config. Existing model rows, aliases, and an explicit primary model stay unchanged. If you use `models.mode: "replace"`, onboarding also adds the bundled catalog because that mode disables implicit discovery.

  </Step>
  <Step title="Verify the live catalog">
    ```bash
    openclaw models list --provider baseten
    ```

    With usable auth, the plugin requests `GET /v1/models` and lists every model returned for the account. Without auth, it stays offline and uses the bundled fallback.

  </Step>
</Steps>

<a id="inkling" />

## Default model

DeepSeek V4.1 Flash is the default for new Baseten setups. It supports text and image input, tool calling, a 1,048,576-token context window, and up to 262,144 output tokens:

```json5
{
  agents: {
    defaults: {
      model: { primary: "baseten/deepseek-ai/DeepSeek-V4.1-Flash" },
    },
  },
}
```

Use `/model baseten/deepseek-ai/DeepSeek-V4.1-Flash -s` to switch the current session.
Its thinking choices are `off`, `low`, `high`, and `max`, with `high` as the native default. OpenClaw sends `off` as `reasoning_effort: "none"`. See [Baseten's reasoning controls](https://docs.baseten.co/inference/model-apis/reasoning).

Saved explicit selections such as `baseten/thinkingmachines/inkling` are not redirected to the new default. If a previously selected model is no longer available, list the current catalog and choose a replacement explicitly. Reconnecting the API key preserves the saved primary model.

## Bundled fallback catalog

The authenticated live catalog is authoritative. This curated fallback covers current Model APIs; live discovery can include additional models. Removing a retired row from this fallback does not delete an explicitly authored row from your config:

| Model ref                                          | Input       | Context | Max output |
| -------------------------------------------------- | ----------- | ------: | ---------: |
| `baseten/deepseek-ai/DeepSeek-V4-Pro-0813`         | text        |  1.048M |       262k |
| `baseten/deepseek-ai/DeepSeek-V4.1-Flash`          | text, image |  1.048M |       262k |
| `baseten/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B` | text        |    202k |       202k |
| `baseten/openai/gpt-oss-120b`                      | text        |    128k |       128k |
| `baseten/zai-org/GLM-5.2`                          | text, image |  1.048M |       262k |
| `baseten/zai-org/GLM-5.2-Fast`                     | text, image |  1.048M |       262k |

All bundled models support tool calling and reasoning. OpenClaw maps its thinking levels to models with native `reasoning_effort`. Its opt-in GLM and Nemotron routes default to thinking off. Nemotron exposes a binary off/on control; the bundled GLM 5.2 definitions expose off, high, and max. These routes use Baseten's `chat_template_args.enable_thinking` control. GLM's scalar effort and image input depend on discovery advertising those capabilities; sparse live GLM rows currently omit them.

The same thinking controls apply to agent turns and standalone model completions. Current DeepSeek V4 Pro 0813 and explicitly configured older Pro references preserve replayed reasoning metadata while thinking is enabled and remove it for explicit `off` requests. The current Pro endpoint additionally receives the required thinking envelope when scalar effort is sent.

<Note>
Baseten can add, remove, or change Model APIs independently of OpenClaw releases. The plugin refreshes model ids, context limits, output limits, and input, cached-input, and output pricing from the authenticated API. Current DeepSeek V4.1 Flash and V4 Pro 0813 retain their documented controls when otherwise populated catalog rows omit the corresponding feature flags.
</Note>

## Manual config

Most setups only need the API key. To pin the provider explicitly:

```json5
{
  env: { vars: { BASETEN_API_KEY: "..." } },
  agents: {
    defaults: {
      model: { primary: "baseten/deepseek-ai/DeepSeek-V4.1-Flash" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      baseten: {
        baseUrl: "https://inference.baseten.co/v1",
        apiKey: "${BASETEN_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "deepseek-ai/DeepSeek-V4.1-Flash",
            name: "DeepSeek V4.1 Flash",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 1048576,
            maxTokens: 262144,
          },
        ],
      },
    },
  },
}
```

<Note>
If the Gateway runs as a daemon (launchd, systemd, Docker), make sure `BASETEN_API_KEY` is available to that process. For example, set it in `~/.openclaw/.env` or via `env.shellEnv`. A key exported only in an interactive shell is not visible to an already-running managed service.
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Thinking modes" href="/tools/thinking" icon="brain">
    Select OpenClaw reasoning effort levels.
  </Card>
  <Card title="Models CLI" href="/cli/models" icon="terminal">
    List, inspect, and select discovered models.
  </Card>
  <Card title="Models FAQ" href="/help/faq-models" icon="circle-question">
    Auth profiles and model-selection troubleshooting.
  </Card>
</CardGroup>
