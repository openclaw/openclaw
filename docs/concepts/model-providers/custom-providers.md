---
summary: "Providers configured through models.providers: custom endpoints, base URLs, and local inference servers."
read_when:
  - You are configuring a provider through models.providers
  - You are pointing OpenClaw at a custom base URL or proxy
  - You are running llama.cpp, LM Studio, Ollama, vLLM, or SGLang
title: "Custom providers and local runtimes"
---

## Providers via `models.providers` (custom/base URL)

Use `models.providers` (or `models.json`) to add **custom** providers or OpenAI/Anthropic-compatible proxies.

Many of the bundled provider plugins below already publish a default catalog. Use explicit `models.providers.<id>` entries only when you want to override the default base URL, headers, or model list.

Bundled and catalog-known routes take their `compat` capabilities from the owning provider plugin. A config `compat` block is for a custom provider/model or a different `api`/`baseUrl` route whose endpoint contract you have verified; see the [custom-provider capability guide](/gateway/config-tools#custom-provider-capability-declarations). Doctor removes legacy values that merely repeat the catalog and leaves divergent values visible for operator review.

Gateway model capability checks also read explicit `models.providers.<id>.models[]` metadata. If a custom or proxy model accepts images, set `input: ["text", "image"]` on that model so WebChat and node-origin attachment paths pass images as native model inputs instead of text-only media refs.

`agents.defaults.models["provider/model"]` controls aliases and per-model metadata for agents. It neither restricts overrides nor registers a new runtime model by itself. For custom provider models, also add `models.providers.<provider>.models[]` with at least the matching `id`; use `agents.defaults.modelPolicy.allow` separately when you want an override restriction.

### Moonshot AI (Kimi)

Install `@openclaw/moonshot-provider` before onboarding. Add an explicit `models.providers.moonshot` entry only when you need to override the base URL or model metadata:

- Provider: `moonshot`
- Auth: `MOONSHOT_API_KEY`
- Example model: `moonshot/kimi-k3`
- CLI: `openclaw onboard --auth-choice moonshot-api-key` or `openclaw onboard --auth-choice moonshot-api-key-cn`

Kimi model IDs:

[//]: # "moonshot-kimi-k2-model-refs:start"

- `moonshot/kimi-k2.6`
- `moonshot/kimi-k3`
- `moonshot/kimi-k2.7-code`
- `moonshot/kimi-k2.7-code-highspeed`
- `moonshot/kimi-k2.5`

[//]: # "moonshot-kimi-k2-model-refs:end"

```json5
{
  agents: {
    defaults: { model: { primary: "moonshot/kimi-k2.6" } },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [{ id: "kimi-k2.6", name: "Kimi K2.6" }],
      },
    },
  },
}
```

See [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot) for the full setup guide.

### Kimi Coding

Kimi Coding uses Moonshot AI's Anthropic-compatible endpoint:

- Provider: `kimi`
- Auth: `KIMI_API_KEY`
- Kimi K3: `kimi/k3` (up to 1M, tier-gated) or `kimi/k3-256k` (256K, lower quota use)
- Kimi Code: `kimi/kimi-for-coding`
- Kimi Code HighSpeed: `kimi/kimi-for-coding-highspeed`

```json5
{
  env: { vars: { KIMI_API_KEY: "sk-..." } },
  agents: {
    defaults: { model: { primary: "kimi/kimi-for-coding" } },
  },
}
```

Kimi K3 uses adaptive thinking. `--thinking minimal|low` selects low effort,
`--thinking medium|high|adaptive` selects high effort, and `--thinking xhigh|max`
selects max effort. Catalog pricing is $3/MTok input, $15/MTok output, and
$0.30/MTok cache reads. Legacy `kimi/kimi-code` and `kimi/k2p5` remain
accepted as compatibility model ids and normalize to Kimi's stable API model
id; the previously published `kimi/k3[1m]` ref normalizes to `kimi/k3` for
existing configs.

### Volcano Engine (Doubao)

Volcano Engine (火山引擎) provides access to Doubao and other models in China.

- Provider: `volcengine` (coding: `volcengine-plan`)
- Auth: `VOLCANO_ENGINE_API_KEY`
- Example model: `volcengine-plan/ark-code-latest`
- CLI: `openclaw onboard --auth-choice volcengine-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "volcengine-plan/ark-code-latest" } },
  },
}
```

Onboarding defaults to the coding surface, but the general `volcengine/*` catalog is registered at the same time.

In onboarding/configure model pickers, the Volcengine auth choice prefers both `volcengine/*` and `volcengine-plan/*` rows. If those models are not loaded yet, OpenClaw falls back to the unfiltered catalog instead of showing an empty provider-scoped picker.

<Tabs>
  <Tab title="Standard models">
    - `volcengine/doubao-seed-1-8-251228` (Doubao Seed 1.8)
    - `volcengine/doubao-seed-code-preview-251028`
    - `volcengine/kimi-k2-5-260127` (Kimi K2.5)
    - `volcengine/glm-4-7-251222` (GLM 4.7)
    - `volcengine/deepseek-v3-2-251201` (DeepSeek V3.2)

  </Tab>
  <Tab title="Coding models (volcengine-plan)">
    - `volcengine-plan/ark-code-latest`
    - `volcengine-plan/doubao-seed-code`

  </Tab>
</Tabs>

### BytePlus (International)

BytePlus ARK provides access to the same models as Volcano Engine for international users.

- Plugin: `@openclaw/byteplus-provider`
- Provider: `byteplus` (coding: `byteplus-plan`)
- Auth: `BYTEPLUS_API_KEY`
- Example model: `byteplus-plan/ark-code-latest`
- CLI: `openclaw onboard --auth-choice byteplus-api-key`

Install the official plugin and restart the Gateway:

```bash
openclaw plugins install @openclaw/byteplus-provider
openclaw gateway restart
```

```json5
{
  agents: {
    defaults: { model: { primary: "byteplus-plan/ark-code-latest" } },
  },
}
```

Onboarding defaults to the coding surface, but the general `byteplus/*` catalog is registered at the same time.

In onboarding/configure model pickers, the BytePlus auth choice prefers both `byteplus/*` and `byteplus-plan/*` rows. If those models are not loaded yet, OpenClaw falls back to the unfiltered catalog instead of showing an empty provider-scoped picker.

<Tabs>
  <Tab title="Standard models">
    - `byteplus/seed-1-8-251228` (Seed 1.8)
    - `byteplus/kimi-k2-5-260127` (Kimi K2.5)
    - `byteplus/glm-4-7-251222` (GLM 4.7)

  </Tab>
  <Tab title="Coding models (byteplus-plan)">
    - `byteplus-plan/ark-code-latest`
    - `byteplus-plan/kimi-k2.5`
    - `byteplus-plan/glm-4.7`

  </Tab>
</Tabs>

### Synthetic

Synthetic provides Anthropic-compatible models behind the `synthetic` provider:

- Provider: `synthetic`
- Auth: `SYNTHETIC_API_KEY`
- Example model: `synthetic/hf:MiniMaxAI/MiniMax-M3`
- CLI: `openclaw onboard --auth-choice synthetic-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M3" } },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [{ id: "hf:MiniMaxAI/MiniMax-M3", name: "MiniMax M3" }],
      },
    },
  },
}
```

### MiniMax

MiniMax is configured via `models.providers` because it uses custom endpoints:

- MiniMax OAuth (Global): `--auth-choice minimax-global-oauth`
- MiniMax OAuth (CN): `--auth-choice minimax-cn-oauth`
- MiniMax API key (Global): `--auth-choice minimax-global-api`
- MiniMax API key (CN): `--auth-choice minimax-cn-api`
- Auth: `MINIMAX_API_KEY` for `minimax`; `MINIMAX_OAUTH_TOKEN` or `MINIMAX_API_KEY` for `minimax-portal`

See [/providers/minimax](/providers/minimax) for setup details, model options, and config snippets.

<Note>
On MiniMax's Anthropic-compatible streaming path, OpenClaw disables thinking by default for the M2.x family unless you explicitly set it; MiniMax-M3 (and M3.x) stays on the provider's omitted/adaptive thinking path by default. `/fast on` rewrites `MiniMax-M2.7` to `MiniMax-M2.7-highspeed`.
</Note>

Plugin-owned capability split:

- Text/chat defaults stay on `minimax/MiniMax-M3`
- Image generation is `minimax/image-01` or `minimax-portal/image-01`
- Image understanding is plugin-owned `MiniMax-VL-01` on both MiniMax auth paths
- Web search stays on provider id `minimax`

### llama.cpp

The bundled `llama-cpp` plugin provides one local text provider with two setup choices:

- **Managed local server** installs and supervises a verified llama-server and local GGUF files.
- **Existing llama-server** connects to a server that you operate and discovers its models.

Install the plugin once for either path:

```bash
openclaw plugins install @openclaw/llama-cpp-provider
```

Both use `llama-cpp/<model>` references. See [llama.cpp](/plugins/llama-cpp) for setup,
discovery, authentication, and managed local embeddings.

### LM Studio

LM Studio ships as a bundled provider plugin which uses the native API:

- Provider: `lmstudio`
- Auth: `LM_API_TOKEN`
- Default inference base URL: `http://localhost:1234/v1`

Then set a model (replace with one of the IDs returned by `http://localhost:1234/api/v1/models`):

```json5
{
  agents: {
    defaults: { model: { primary: "lmstudio/openai/gpt-oss-20b" } },
  },
}
```

OpenClaw uses LM Studio's native `/api/v1/models` and `/api/v1/models/load` for discovery + auto-load, with `/v1/chat/completions` for inference by default. If you want LM Studio JIT loading, TTL, and auto-evict to own model lifecycle, set `models.providers.lmstudio.params.preload: false`. See [/providers/lmstudio](/providers/lmstudio) for setup and troubleshooting.

### Ollama

Ollama ships as a bundled provider plugin and uses Ollama's native API:

- Provider: `ollama`
- Auth: None required (local server)
- Example model: `ollama/llama3.3`
- Installation: [https://ollama.com/download](https://ollama.com/download)

```bash
# Install Ollama, then pull a model:
ollama pull llama3.3
```

```json5
{
  agents: {
    defaults: { model: { primary: "ollama/llama3.3" } },
  },
}
```

Ollama is detected locally at `http://127.0.0.1:11434` when you opt in with `OLLAMA_API_KEY`, and the bundled provider plugin adds Ollama directly to `openclaw onboard` and the model picker. See [/providers/ollama](/providers/ollama) for onboarding, cloud/local mode, and custom configuration.

### vLLM

vLLM ships as a bundled provider plugin for local/self-hosted OpenAI-compatible servers:

- Provider: `vllm`
- Auth: Optional (depends on your server)
- Default base URL: `http://127.0.0.1:8000/v1`

To opt in to auto-discovery locally (any value works if your server doesn't enforce auth):

```bash
export VLLM_API_KEY="vllm-local"
```

Then set a model (replace with one of the IDs returned by `/v1/models`):

```json5
{
  agents: {
    defaults: { model: { primary: "vllm/your-model-id" } },
  },
}
```

See [/providers/vllm](/providers/vllm) for details.

### SGLang

SGLang ships as a bundled provider plugin for fast self-hosted OpenAI-compatible servers:

- Provider: `sglang`
- Auth: Optional (depends on your server)
- Default base URL: `http://127.0.0.1:30000/v1`

To opt in to auto-discovery locally (any value works if your server does not enforce auth):

```bash
export SGLANG_API_KEY="sglang-local"
```

Then set a model (replace with one of the IDs returned by `/v1/models`):

```json5
{
  agents: {
    defaults: { model: { primary: "sglang/your-model-id" } },
  },
}
```

See [/providers/sglang](/providers/sglang) for details.

### Local proxies (LM Studio, vLLM, LiteLLM, etc.)

Example (OpenAI-compatible):

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/my-local-model" },
      models: { "lmstudio/my-local-model": { alias: "Local" } },
    },
  },
  models: {
    providers: {
      lmstudio: {
        baseUrl: "http://localhost:1234/v1",
        apiKey: "${LM_API_TOKEN}",
        api: "openai-completions",
        timeoutSeconds: 300,
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

<AccordionGroup>
  <Accordion title="Default optional fields">
    For custom providers, `reasoning`, `input`, `cost`, `contextWindow`, and `maxTokens` are optional. When omitted, OpenClaw defaults to:

    - `reasoning: false`
    - `input: ["text"]`
    - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
    - `maxTokens`: no fixed default. For OpenAI-compatible Completions, an unknown output limit omits both `max_tokens` and `max_completion_tokens`, letting the provider apply its default.

    An omitted `contextWindow` remains unset so authored native-window metadata is unambiguous. When neither discovery nor per-model context metadata is available, context-budget callers use the standard `200000`-token fallback.

    Recommended: set explicit values that match your proxy/model limits.

  </Accordion>
  <Accordion title="Proxy-route shaping rules">
    - For `api: "openai-completions"` on non-native endpoints (any non-empty `baseUrl` whose host is not `api.openai.com`), OpenClaw forces `compat.supportsDeveloperRole: false` to avoid provider 400 errors for unsupported `developer` roles.
    - Proxy-style OpenAI-compatible routes also skip native OpenAI-only request shaping: no `service_tier`, no Responses `store`, no Completions `store`, no prompt-cache hints, no OpenAI reasoning-compat payload shaping, and no hidden OpenClaw attribution headers.
    - For OpenAI-compatible Completions proxies that need vendor-specific fields, set `agents.defaults.models["provider/model"].params.extra_body` (or `extraBody`) to merge extra JSON into the outbound request body.
    - For vLLM chat-template controls, set `agents.defaults.models["provider/model"].params.chat_template_kwargs`. The bundled vLLM plugin automatically sends `enable_thinking: false` and `force_nonempty_content: true` for `vllm/nemotron-3-*` when the session thinking level is off.
    - For slow local models or remote LAN/tailnet hosts, set `models.providers.<id>.timeoutSeconds`. This extends provider model HTTP request handling, including connect, headers, body streaming, and the total guarded-fetch abort, without increasing the whole agent runtime timeout. If `agents.defaults.timeoutSeconds` or a run-specific timeout is lower, raise that ceiling too; provider timeouts cannot extend the whole run.
    - Model provider HTTP calls allow Surge, Clash, and sing-box fake-IP DNS answers in `198.18.0.0/15` and `fc00::/7` only for the configured provider `baseUrl` hostname. Custom/local provider endpoints also trust that exact configured `scheme://host:port` origin for guarded model requests, including loopback, LAN, and tailnet hosts. This is not a new config option; the `baseUrl` you configure extends the request policy only for that origin. Fake-IP hostname allowance and exact-origin trust are independent mechanisms. Other private, loopback, link-local, metadata, local-use NAT64 (`64:ff9b:1::/48`) destinations, and different ports still require an explicit `models.providers.<id>.request.allowPrivateNetwork: true` opt-in. Set `models.providers.<id>.request.allowPrivateNetwork: false` to opt out of the exact-origin trust.
    - If `baseUrl` is empty/omitted, OpenClaw keeps the default OpenAI behavior (which resolves to `api.openai.com`).
    - For safety, an explicit `compat.supportsDeveloperRole: true` is still overridden on non-native `openai-completions` endpoints.
    - For `api: "anthropic-messages"` on non-direct endpoints (any provider other than canonical `anthropic`, or a custom `models.providers.anthropic.baseUrl` whose host is not a public `api.anthropic.com` endpoint), OpenClaw suppresses implicit Anthropic beta headers such as `claude-code-20250219`, `interleaved-thinking-2025-05-14`, and OAuth markers, so custom Anthropic-compatible proxies do not reject unsupported beta flags. Set `models.providers.<id>.headers["anthropic-beta"]` explicitly if your proxy needs specific beta features.

  </Accordion>
</AccordionGroup>
