---
summary: "Worked custom-provider configurations for Cerebras, Kimi, llama.cpp, LM Studio, MiniMax, Moonshot, OpenCode, Synthetic, and Z.AI"
read_when:
  - Copying a working config for a specific provider
  - Pointing a custom provider id at a local llama-server
  - Finding the onboarding shortcut for a provider
title: "Configuration — provider examples"
---

Worked `models.providers` configurations. For what each field means, see [Custom providers and base URLs](/gateway/config-tools/custom-providers).

## Provider examples

<AccordionGroup>
  <Accordion title="Cerebras (GPT OSS)">
    The official external `cerebras` provider plugin can configure this via `openclaw onboard --auth-choice cerebras-api-key`. Use explicit provider config only when overriding defaults.

    ```json5
    {
      env: { vars: { CEREBRAS_API_KEY: "sk-..." } },
      agents: {
        defaults: {
          model: {
            primary: "cerebras/gpt-oss-120b",
          },
          models: {
            "cerebras/gpt-oss-120b": { alias: "Cerebras GPT OSS 120B" },
          },
        },
      },
      models: {
        mode: "merge",
        providers: {
          cerebras: {
            baseUrl: "https://api.cerebras.ai/v1",
            apiKey: "${CEREBRAS_API_KEY}",
            api: "openai-completions",
            models: [
              { id: "gpt-oss-120b", name: "GPT OSS 120B (Cerebras)" },
            ],
          },
        },
      },
    }
    ```

    Use `cerebras/gpt-oss-120b` for Cerebras. For Z.AI models, use the separate `zai` provider.

  </Accordion>
  <Accordion title="Kimi Coding">
    ```json5
    {
      env: { vars: { KIMI_API_KEY: "sk-..." } },
      agents: {
        defaults: {
          model: { primary: "kimi/kimi-for-coding" },
          models: { "kimi/kimi-for-coding": { alias: "Kimi Code" } },
        },
      },
    }
    ```

    Anthropic-compatible, built-in provider. Shortcut: `openclaw onboard --auth-choice kimi-code-api-key`.

  </Accordion>
  <Accordion title="Local models (llama.cpp / llama-server)">
    The built-in `llama-cpp` provider applies the llama.cpp schema cleaner in managed and existing-server modes. If you instead point a **custom provider ID** at a remote `llama-server` (or another OpenAI-compatible llama.cpp endpoint), set `compat.toolSchemaProfile: "llamacpp"` on each model whose chat template compiles tool arguments into GBNF. The profile removes `pattern` and `maxLength` values at or above 2000, covering the `cron` tool's `trigger.script` limit of 65536. It is a targeted mitigation, not complete compatibility for every JSON Schema constraint or `minLength`.

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "my-llamacpp/qwen35" },
        },
      },
      models: {
        mode: "merge",
        providers: {
          "my-llamacpp": {
            baseUrl: "http://127.0.0.1:8080/v1",
            apiKey: "llamacpp-no-key",
            api: "openai-completions",
            models: [
              {
                id: "qwen35",
                name: "Qwen3.5 (llama-server)",
                contextWindow: 8192,
                maxTokens: 2048,
                compat: {
                  supportsTools: true,
                  toolSchemaProfile: "llamacpp",
                },
              },
            ],
          },
        },
      },
    }
    ```

    For a broader manual alternative, set `compat.unsupportedToolSchemaKeywords: ["pattern", "patternProperties", "format", "propertyNames", "uniqueItems", "contains", "minContains", "maxContains", "minLength", "maxLength"]`. Unlike the profile, this removes every listed keyword unconditionally.

  </Accordion>
  <Accordion title="Local models (LM Studio)">
    See [Local Models](/gateway/local-models). TL;DR: run a large local model via LM Studio Responses API on serious hardware; keep hosted models merged for fallback.
  </Accordion>
  <Accordion title="MiniMax M3 (direct)">
    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "minimax/MiniMax-M3" },
          models: {
            "minimax/MiniMax-M3": { alias: "Minimax" },
          },
        },
      },
      models: {
        mode: "merge",
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.io/anthropic",
            apiKey: "${MINIMAX_API_KEY}",
            api: "anthropic-messages",
            models: [
              {
                id: "MiniMax-M3",
                name: "MiniMax M3",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 },
                contextWindow: 1000000,
                maxTokens: 131072,
              },
            ],
          },
        },
      },
    }
    ```

    Set `MINIMAX_API_KEY`. Shortcuts: `openclaw onboard --auth-choice minimax-global-api` or `openclaw onboard --auth-choice minimax-cn-api`. The model catalog defaults to M3 and also includes the M2.7 variants. On the Anthropic-compatible streaming path, OpenClaw disables MiniMax M2.x thinking by default unless you explicitly set `thinking` yourself; MiniMax-M3 (and M3.x) stays on the provider's omitted/adaptive thinking path by default. `/fast on` or `params.fastMode: true` rewrites `MiniMax-M2.7` to `MiniMax-M2.7-highspeed`.

  </Accordion>
  <Accordion title="Moonshot AI (Kimi)">
    ```json5
    {
      env: { vars: { MOONSHOT_API_KEY: "sk-..." } },
      agents: {
        defaults: {
          model: { primary: "moonshot/kimi-k2.6" },
          models: { "moonshot/kimi-k2.6": { alias: "Kimi K2.6" } },
        },
      },
      models: {
        mode: "merge",
        providers: {
          moonshot: {
            baseUrl: "https://api.moonshot.ai/v1",
            apiKey: "${MOONSHOT_API_KEY}",
            api: "openai-completions",
            models: [
              {
                id: "kimi-k2.6",
                name: "Kimi K2.6",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 262144,
              },
            ],
          },
        },
      },
    }
    ```

    For the China endpoint: `baseUrl: "https://api.moonshot.cn/v1"` or `openclaw onboard --auth-choice moonshot-api-key-cn`.

    Native Moonshot endpoints advertise streaming usage compatibility on the shared `openai-completions` transport, and OpenClaw keys that off endpoint capabilities rather than the built-in provider id alone.

  </Accordion>
  <Accordion title="OpenCode">
    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "opencode/claude-opus-4-6" },
          models: { "opencode/claude-opus-4-6": { alias: "Opus" } },
        },
      },
    }
    ```

    Set `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`). Use `opencode/...` refs for the Zen catalog or `opencode-go/...` refs for the Go catalog. Shortcut: `openclaw onboard --auth-choice opencode-zen` or `openclaw onboard --auth-choice opencode-go`.

  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    ```json5
    {
      env: { vars: { SYNTHETIC_API_KEY: "sk-..." } },
      agents: {
        defaults: {
          model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M3" },
          models: { "synthetic/hf:MiniMaxAI/MiniMax-M3": { alias: "MiniMax M3" } },
        },
      },
      models: {
        mode: "merge",
        providers: {
          synthetic: {
            baseUrl: "https://api.synthetic.new/anthropic",
            apiKey: "${SYNTHETIC_API_KEY}",
            api: "anthropic-messages",
            models: [
              {
                id: "hf:MiniMaxAI/MiniMax-M3",
                name: "MiniMax M3",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 65536,
              },
            ],
          },
        },
      },
    }
    ```

    Base URL should omit `/v1` (Anthropic client appends it). Shortcut: `openclaw onboard --auth-choice synthetic-api-key`.

  </Accordion>
  <Accordion title="Z.AI (GLM-4.7)">
    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "zai/glm-4.7" },
          models: { "zai/glm-4.7": {} },
        },
      },
    }
    ```

    Set `ZAI_API_KEY`. Model refs use the standard `zai/*` provider ID. Shortcut: `openclaw onboard --auth-choice zai-api-key`.

    - General endpoint: `https://api.z.ai/api/paas/v4`
    - Coding endpoint: `https://api.z.ai/api/coding/paas/v4`
    - The default `zai-api-key` auth choice checks your key and auto-detects which endpoint it belongs to (falling back to a prompt, defaulting to Global, if detection is inconclusive). Dedicated CN and Coding-Plan auth choices are also available for explicit selection.
    - For the general endpoint, define a custom provider with the base URL override.

  </Accordion>
</AccordionGroup>

## Route interactive and background requests to different URLs

Some gateways expose separate URLs for interactive traffic and background or delegated work while serving the same model.
You can represent those routes as two custom providers without changing the runtime model or adding automatic task classification.

1. Copy the provider entry under a second provider id and change only the `baseUrl`.
   Keep the same authentication, API transport, model id, capabilities, context limits, and token limits unless the gateway actually differs.
2. Use the interactive provider as the default model and the background provider as the sub-agent model.
3. Copy the exact model's generation settings to the second fully qualified model key.
   Give the interactive entry the picker alias and omit it on the background entry to avoid assigning the same shortcut name to both routes. Both provider-qualified model entries can still appear separately in model pickers.

```json5
{
  models: {
    mode: "merge",
    providers: {
      "acme-interactive": {
        baseUrl: "https://interactive.example/v1",
        apiKey: "${ACME_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "acme-model",
            name: "Acme model",
            input: ["text", "image"],
            contextWindow: 131072,
            maxTokens: 16384,
          },
        ],
      },
      "acme-background": {
        baseUrl: "https://background.example/v1",
        apiKey: "${ACME_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "acme-model",
            name: "Acme model (background)",
            input: ["text", "image"],
            contextWindow: 131072,
            maxTokens: 16384,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: {
        primary: "acme-interactive/acme-model",
        fallbacks: ["acme-background/acme-model"],
      },
      subagents: {
        model: {
          primary: "acme-background/acme-model",
          fallbacks: ["acme-interactive/acme-model"],
        },
      },
      models: {
        "acme-interactive/acme-model": {
          alias: "Acme model",
          params: { temperature: 0.2 },
        },
        "acme-background/acme-model": {
          params: { temperature: 0.2 },
        },
      },
    },
  },
}
```

The model reference used for a sub-agent is selected in this order: an explicit spawn choice, the per-agent sub-agent model, then `agents.defaults.subagents.model`.
For cron or automation jobs, set the model and fallback list explicitly when the job must use the background route, for example `openclaw automations add ... --model acme-background/acme-model --fallbacks acme-interactive/acme-model`.
When the API transport is unchanged, an existing non-empty `models.json` `baseUrl` takes precedence over the matching config entry, so update that file or remove the override when changing routes.
See [Sub-agents](/tools/subagents), [Model configuration](/gateway/config-agents/models), [Custom providers and base URLs](/gateway/config-tools/custom-providers), and [Automation payloads](/automation/cron-jobs/payloads) for the detailed selection and precedence rules.
