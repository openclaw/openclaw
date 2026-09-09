---
summary: "Copyable Ollama config recipes, model selection, and quick verification"
read_when:
  - You want a working config for a local, LAN, cloud, or mixed setup
  - You are selecting a model or verifying an Ollama setup end to end
title: "Ollama config recipes"
sidebarTitle: "Recipes"
---

## Common recipes

Replace model IDs with exact names from `ollama list` or
`openclaw models list --provider ollama`.

<AccordionGroup>
  <Accordion title="Local model with auto-discovery">
    Ollama on the same machine as the Gateway, discovered automatically:

    ```bash
    ollama serve
    ollama pull gemma4
    export OLLAMA_API_KEY="ollama-local"
    openclaw models list --provider ollama
    openclaw models set ollama/gemma4
    ```

    Leave `models.providers.ollama` unset to use the default local endpoint, or
    configure a self-hosted endpoint with `models: []` to keep discovery eligible.

  </Accordion>

  <Accordion title="LAN Ollama host with manual models">
    ```json5
    {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://gpu-box.local:11434",
            apiKey: "ollama-local",
            api: "ollama",
            timeoutSeconds: 300,
            maxTokens: 8192,
            models: [
              {
                id: "qwen3.5:9b",
                name: "qwen3.5:9b",
                reasoning: true,
                input: ["text"],
                contextTokens: 32768,
                params: {
                  num_ctx: 32768,
                  thinking: false,
                  keep_alive: "15m",
                },
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "ollama/qwen3.5:9b" },
        },
      },
    }
    ```

    `contextTokens` caps OpenClaw's active-input budget; `params.num_ctx` sets
    Ollama's request context. Keep them aligned when hardware cannot run the
    model's full advertised context.

  </Accordion>

  <Accordion title="Ollama Cloud only">
    No local daemon, hosted models directly:

    ```bash
    export OLLAMA_API_KEY="your-ollama-api-key"
    ```

    ```json5
    {
      models: {
        providers: {
          ollama: {
            baseUrl: "https://ollama.com",
            apiKey: "OLLAMA_API_KEY",
            api: "ollama",
            models: [
              {
                id: "kimi-k2.5:cloud",
                name: "kimi-k2.5:cloud",
                reasoning: false,
                input: ["text", "image"],
                contextWindow: 128000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "ollama/kimi-k2.5:cloud" },
        },
      },
    }
    ```

    For the dedicated `ollama-cloud` provider id instead of this shape, see
    [Ollama Cloud](/providers/ollama-cloud).

  </Accordion>

  <Accordion title="Cloud plus local through a signed-in daemon">
    ```bash
    ollama signin
    ollama pull gemma4
    ```

    ```json5
    {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            apiKey: "ollama-local",
            api: "ollama",
            timeoutSeconds: 300,
            models: [
              { id: "gemma4", name: "gemma4", input: ["text"] },
              { id: "kimi-k2.5:cloud", name: "kimi-k2.5:cloud", input: ["text", "image"] },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "ollama/gemma4",
            fallbacks: ["ollama/kimi-k2.5:cloud"],
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Multiple Ollama hosts">
    Custom provider IDs when running more than one Ollama server; each gets its
    own host, models, auth, and timeout.

    ```json5
    {
      models: {
        providers: {
          "ollama-fast": {
            baseUrl: "http://mini.local:11434",
            apiKey: "ollama-local",
            api: "ollama",
            models: [
              { id: "gemma4", name: "gemma4", input: ["text"], contextTokens: 32768 },
            ],
          },
          "ollama-large": {
            baseUrl: "http://gpu-box.local:11434",
            apiKey: "ollama-local",
            api: "ollama",
            timeoutSeconds: 420,
            maxTokens: 16384,
            models: [
              { id: "qwen3.5:27b", name: "qwen3.5:27b", input: ["text"], contextTokens: 131072 },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "ollama-fast/gemma4",
            fallbacks: ["ollama-large/qwen3.5:27b"],
          },
        },
      },
    }
    ```

    OpenClaw strips the active provider prefix (falling back to a bare
    `ollama/` prefix) before calling Ollama, so `ollama-large/qwen3.5:27b`
    reaches Ollama as `qwen3.5:27b`.

  </Accordion>

  <Accordion title="Small local model profile">
    Local Ollama models automatically use structured [Tool Search](/tools/tool-search)
    when `tools.toolSearch` is unset. This keeps optional capabilities available
    while loading their schemas only when needed. Setup does not enable lean mode.
    App, interactive CLI, and non-interactive setup use a 32,768-token runtime
    context, or the model's native window if smaller. The advertised native window
    is retained separately; known cloud routes keep their hosted context.
    Large file reads use OpenClaw's context-based paging. The native adapter
    preserves those text pages and their continuation instructions; structured
    fallback data is bounded separately.
    Bound any explicit context override to what the host can support:

    ```json5
    {
      agents: {
        entries: {
          local: {
            default: true,
            model: { primary: "ollama/gemma4" },
          },
        },
      },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            apiKey: "ollama-local",
            api: "ollama",
            models: [
              {
                id: "gemma4",
                name: "gemma4",
                input: ["text"],
                contextTokens: 32768,
                params: { num_ctx: 32768 },
              },
            ],
          },
        },
      },
    }
    ```

    Explicit `tools.toolSearch` settings take precedence, including `false`.
    Tool Search does not change Ollama's context or thinking mode. Ollama thinking
    defaults to off; an explicit thinking setting can change that independently.
    If you previously enabled `localModelLean`, set it to `false` to restore
    optional tools while retaining automatic Tool Search.

    Use `compat.supportsTools: false` only when the model or server reliably
    fails on tool schemas; it disables tool use entirely. For a deliberately
    narrower agent, prefer `tools.profile` or a per-agent tool policy.

  </Accordion>
</AccordionGroup>

### Model selection

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "ollama/gpt-oss:20b",
        fallbacks: ["ollama/llama3.3", "ollama/qwen2.5-coder:32b"],
      },
    },
  },
}
```

Custom provider ids work the same way: for a ref using the active provider
prefix, such as `ollama-spark/qwen3:32b`, OpenClaw strips that prefix before
calling Ollama, sending `qwen3:32b`.

For slow local models, prefer provider-scoped tuning before raising the whole
agent runtime timeout:

```json5
{
  models: {
    providers: {
      ollama: {
        timeoutSeconds: 300,
        models: [
          {
            id: "gemma4:26b",
            name: "gemma4:26b",
            params: { keep_alive: "15m" },
          },
        ],
      },
    },
  },
}
```

`timeoutSeconds` covers the model HTTP request: connection setup, headers,
body streaming, and the total guarded-fetch abort. `params.keep_alive` is
forwarded as top-level `keep_alive` on native `/api/chat` requests; set it per
model when first-turn load time is the bottleneck.

### Quick verification

```bash
# Ollama daemon visible to this machine
curl http://127.0.0.1:11434/api/tags

# OpenClaw catalog and selected model
openclaw models list --provider ollama
openclaw models status

# Direct model smoke
openclaw infer model run \
  --model ollama/gemma4 \
  --prompt "Reply with exactly: ok"
```

For remote hosts, replace `127.0.0.1` with the `baseUrl` host. If `curl`
works but OpenClaw does not, check whether the Gateway runs on a different
machine, container, or service account.
