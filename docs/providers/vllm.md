---
summary: "Run OpenClaw with vLLM (OpenAI-compatible local server)"
read_when:
  - You want to run OpenClaw against a local vLLM server
  - You want OpenAI-compatible /v1 endpoints with your own models
title: "vLLM"
---

vLLM serves open-source (and some custom) models through an **OpenAI-compatible** HTTP API. OpenClaw connects using the `openai-completions` API and can **auto-discover** models when you opt in with `VLLM_API_KEY`.

| Property         | Value                                      |
| ---------------- | ------------------------------------------ |
| Provider ID      | `vllm`                                     |
| API              | `openai-completions` (OpenAI-compatible)   |
| Auth             | `VLLM_API_KEY` environment variable        |
| Default base URL | `http://127.0.0.1:8000/v1`                 |
| Streaming usage  | Supported (`stream_options.include_usage`) |

## Getting started

<Steps>
  <Step title="Start vLLM with an OpenAI-compatible server">
    Your base URL must expose `/v1` endpoints (`/v1/models`, `/v1/chat/completions`). Start the server with the model you want to serve:

    ```bash
    vllm serve <model-id>
    ```

    See the [vLLM online serving docs](https://docs.vllm.ai/en/latest/serving/online_serving/) for flags. vLLM commonly runs on:

    ```text
    http://127.0.0.1:8000/v1
    ```

  </Step>
  <Step title="Set the API key environment variable">
    Any non-empty value works if your server does not enforce auth:

    ```bash
    export VLLM_API_KEY="vllm-local"
    ```

  </Step>
  <Step title="Select a model">
    Replace with one of your vLLM model IDs:

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "vllm/your-model-id" },
        },
      },
    }
    ```

  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider vllm
    ```
  </Step>
</Steps>

<Tip>
For non-interactive setup (CI, scripting), pass the base URL, key, and model directly:

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --mode local \
  --auth-choice vllm \
  --custom-base-url "http://127.0.0.1:8000/v1" \
  --custom-api-key "vllm-local" \
  --custom-model-id "your-model-id"
```

</Tip>

## Model discovery (implicit provider)

When `VLLM_API_KEY` is set (or an auth profile exists) and `models.providers.vllm` is **not** defined, OpenClaw queries `GET http://127.0.0.1:8000/v1/models` and converts the returned IDs into model entries.

<Note>
If you set `models.providers.vllm` explicitly, OpenClaw uses only your declared models. Add `"vllm/*": {}` to `agents.defaults.models` to make OpenClaw also query that configured provider's `/models` endpoint and include all advertised vLLM models.
</Note>

## Explicit configuration

Configure explicitly when vLLM runs on a different host or port, you want to pin `contextWindow`/`maxTokens`, your server requires a real API key, or you connect to a trusted loopback, LAN, or Tailscale endpoint:

```json5
{
  models: {
    providers: {
      vllm: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "${VLLM_API_KEY}",
        api: "openai-completions",
        timeoutSeconds: 300, // Optional: extend request timeout for slow local models
        models: [
          {
            id: "your-model-id",
            name: "Local vLLM Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

To keep the provider dynamic without listing every model, add a wildcard to the visible model catalog:

```json5
{
  agents: {
    defaults: {
      models: {
        "vllm/*": {},
      },
    },
  },
}
```

## Advanced configuration

<AccordionGroup>
  <Accordion title="Proxy-style behavior">
    vLLM is treated as a proxy-style OpenAI-compatible `/v1` backend, not a native OpenAI endpoint:

    | Behavior                                | Applied?                         |
    | --------------------------------------- | -------------------------------- |
    | Native OpenAI request shaping           | No                               |
    | `service_tier`                          | Not sent                         |
    | Responses `store`                       | Not sent                         |
    | Prompt-cache hints                      | Not sent                         |
    | OpenAI reasoning-compat payload shaping | Not applied                      |
    | Hidden OpenClaw attribution headers     | Not injected on custom base URLs |

  </Accordion>

  <Accordion title="Qwen thinking controls">
    For Qwen models, set `compat.thinkingFormat: "qwen-chat-template"` on the model row when the server expects Qwen chat-template kwargs. These models expose a binary `/think` profile (`off`, `on`) because Qwen chat-template thinking is an on/off flag, not an OpenAI-style effort ladder.

    ```json5
    {
      models: {
        providers: {
          vllm: {
            models: [
              {
                id: "Qwen/Qwen3-8B",
                name: "Qwen3 8B",
                reasoning: true,
                compat: { thinkingFormat: "qwen-chat-template" },
              },
            ],
          },
        },
      },
    }
    ```

    OpenClaw maps `/think off` to:

    ```json
    {
      "chat_template_kwargs": {
        "enable_thinking": false,
        "preserve_thinking": true
      }
    }
    ```

    Non-`off` thinking levels send `enable_thinking: true`. If your endpoint expects DashScope-style top-level flags instead, use `compat.thinkingFormat: "qwen"` to send `enable_thinking` at the request root.

    If your served template accepts effort levels, declare them in `compat.supportedReasoningEfforts`, for example `["low", "medium", "xhigh"]`. OpenClaw then exposes those `/think` choices plus `off`. The shared reasoning resolver maps the selected level to the declared wire value. With `qwen-chat-template`, that value goes in `chat_template_kwargs.reasoning_effort`; with `qwen`, it goes in root `reasoning_effort`.

    Provider-native values are case-sensitive. Use `compat.reasoningEffortMap`, such as `{ low: "LOW", high: "HIGH" }`, to map logical choices to a declared native list such as `["LOW", "HIGH"]`. Unmapped native labels are not advertised as effort choices. Missing, empty, or unusable lists keep binary thinking, as does `compat.supportsReasoningEffort: false`.

    The plugin prepares these mappings as model capabilities before session setup, so advanced choices such as `xhigh` and `max` also survive session-level clamping when their native wire labels differ.

    The default remains `off`, including after upgrading an existing configured model. An explicit enabled level now sends its declared effort instead of silently using the template's default. Ordinary binary Qwen models keep their existing request shape. Per-model `params.extra_body` remains the final request-body override.

  </Accordion>

  <Accordion title="DeepSeek V4 thinking controls">
    For vLLM model IDs containing `deepseek-v4` or `deepseek_v4`, configure `reasoning: true`. OpenClaw sends the selected effort through `chat_template_kwargs.reasoning_effort`, with both `thinking` and `enable_thinking` set to `true`. Declared efforts and `reasoningEffortMap` use the same shared resolver as other OpenAI-compatible models.

    `/think off` sends both template flags as `false`, because vLLM enables DeepSeek thinking when either flag is true. Hosted DeepSeek's root `thinking` object and root `reasoning_effort` are removed. Existing explicit template kwargs and the final `params.extra_body` override remain authoritative. Explicit Qwen thinking formats take precedence over the model-name match.

    This request shaping does not enable reasoning for catalog rows marked `reasoning: false` or change discovery heuristics. Configure the model explicitly if discovery does not recognize its reasoning capability.

  </Accordion>

  <Accordion title="Nemotron 3 thinking controls">
    For `vllm/nemotron-3-*` models with thinking off, the bundled plugin sends:

    ```json
    {
      "chat_template_kwargs": {
        "enable_thinking": false,
        "force_nonempty_content": true
      }
    }
    ```

    To customize these values, set `chat_template_kwargs` under the model params. If you also set `params.extra_body.chat_template_kwargs`, that value wins because `extra_body` is the last request-body override.

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "vllm/nemotron-3-super": {
              params: {
                chat_template_kwargs: {
                  enable_thinking: false,
                  force_nonempty_content: true,
                },
              },
            },
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Qwen tool calls appear as text">
    First confirm vLLM was started with the right tool-call parser and chat template for the model. vLLM documents `hermes` for Qwen2.5 models and `qwen3_xml` for Qwen3-Coder models.

    Symptoms: skills/tools never run, the assistant prints raw JSON/XML such as `{"name":"read","arguments":...}`, or vLLM returns an empty `tool_calls` array when OpenClaw sends `tool_choice: "auto"`.

    Some Qwen/vLLM combinations return structured tool calls only when the request uses `tool_choice: "required"`. Force it per model with `params.extra_body`:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "vllm/Qwen-Qwen2.5-Coder-32B-Instruct": {
              params: {
                extra_body: {
                  tool_choice: "required",
                },
              },
            },
          },
        },
      },
    }
    ```

    Replace the model id with the exact id from `openclaw models list --provider vllm`, or apply the same override from the CLI:

    ```bash
    openclaw config set agents.defaults.models '{"vllm/Qwen-Qwen2.5-Coder-32B-Instruct":{"params":{"extra_body":{"tool_choice":"required"}}}}' --strict-json --merge
    ```

    This is an opt-in workaround: it forces every turn with tools to make a tool call, so use it only for a dedicated model entry where that is acceptable. Do not set it as a global default for all vLLM models, and do not pair it with a proxy that converts arbitrary assistant text into executable tool calls.

  </Accordion>

  <Accordion title="Custom base URL">
    If your vLLM server runs on a non-default host or port, set `baseUrl` in the explicit provider config:

    ```json5
    {
      models: {
        providers: {
          vllm: {
            baseUrl: "http://192.168.1.50:9000/v1",
            apiKey: "${VLLM_API_KEY}",
            api: "openai-completions",
            timeoutSeconds: 300,
            models: [
              {
                id: "my-custom-model",
                name: "Remote vLLM Model",
                reasoning: false,
                input: ["text"],
                contextWindow: 64000,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    }
    ```

  </Accordion>
</AccordionGroup>

## Troubleshooting

<AccordionGroup>
  <Accordion title="Slow first response or remote server timeout">
    For large local models, remote LAN hosts, or tailnet links, set a provider-scoped request timeout:

    ```json5
    {
      models: {
        providers: {
          vllm: {
            baseUrl: "http://192.168.1.50:8000/v1",
            apiKey: "${VLLM_API_KEY}",
            api: "openai-completions",
            timeoutSeconds: 300,
            models: [{ id: "your-model-id", name: "Local vLLM Model" }],
          },
        },
      },
    }
    ```

    `timeoutSeconds` applies to vLLM model HTTP requests only: connection setup, response headers, body streaming, and the total guarded-fetch abort. It also raises the LLM idle/stream watchdog ceiling above the implicit ~120s default for this provider. Prefer this over increasing `agents.defaults.timeoutSeconds`, which controls the whole agent run.

  </Accordion>

  <Accordion title="Server not reachable">
    Check that the vLLM server is running and accessible:

    ```bash
    curl http://127.0.0.1:8000/v1/models
    ```

    If you see a connection error, verify the host, port, and that vLLM started in OpenAI-compatible server mode. OpenClaw trusts the exact configured `models.providers.vllm.baseUrl` origin for guarded model requests on loopback, LAN, and Tailscale endpoints. Metadata, link-local, and local-use NAT64 (`64:ff9b:1::/48`) origins remain blocked without explicit opt-in. Set `models.providers.vllm.request.allowPrivateNetwork: true` only when vLLM requests must reach another private origin, or `false` to opt out of exact-origin trust.

  </Accordion>

  <Accordion title="Auth errors on requests">
    If requests fail with auth errors, set a real `VLLM_API_KEY` that matches your server configuration, or configure the provider explicitly under `models.providers.vllm`.

    <Tip>
    If your vLLM server does not enforce auth, any non-empty value for `VLLM_API_KEY` works as an opt-in signal for OpenClaw.
    </Tip>

  </Accordion>

  <Accordion title="No models discovered">
    Auto-discovery requires `VLLM_API_KEY` to be set. If you have defined `models.providers.vllm`, OpenClaw uses only your declared models unless `agents.defaults.models` includes `"vllm/*": {}`.
  </Accordion>

  <Accordion title="Tools render as raw text">
    If a Qwen model prints JSON/XML tool syntax instead of executing a skill:

    - Start vLLM with the correct parser/template for that model.
    - Confirm the exact model id with `openclaw models list --provider vllm`.
    - Add a dedicated per-model `params.extra_body.tool_choice: "required"` override only if `tool_choice: "auto"` still returns empty or text-only tool calls.

  </Accordion>
</AccordionGroup>

<Warning>
More help: [Troubleshooting](/help/troubleshooting) and [FAQ](/help/faq).
</Warning>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="OpenAI" href="/providers/openai" icon="bolt">
    Native OpenAI provider and OpenAI-compatible route behavior.
  </Card>
  <Card title="OAuth and auth" href="/gateway/authentication" icon="key">
    Auth details and credential reuse rules.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    Common issues and how to resolve them.
  </Card>
</CardGroup>
