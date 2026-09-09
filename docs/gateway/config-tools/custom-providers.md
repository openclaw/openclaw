---
summary: "models.providers registration, base-URL trust, and the full provider field reference"
read_when:
  - Registering a custom or self-hosted model provider
  - Overriding a provider base URL, transport, or TLS settings
  - Declaring capabilities for a custom endpoint route
title: "Configuration — custom providers and base URLs"
---

Registering custom providers under `models.providers`, what a custom `baseUrl` implies for network trust, and the full provider field reference. For worked configurations, see [Provider examples](/gateway/config-tools/provider-examples).

## Custom providers and base URLs

Provider plugins publish their own model catalog rows. Add custom providers via `models.providers` in config or `~/.openclaw/agents/<agentId>/agent/models.json`.

Configuring a custom/local provider `baseUrl` is also the narrow network trust decision for model HTTP requests: OpenClaw allows that exact `scheme://host:port` origin through the guarded fetch path, without adding a separate config option or trusting other private origins.

```json5
{
  models: {
    mode: "merge", // merge (default) | replace
    providers: {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "LITELLM_KEY",
        api: "openai-completions", // openai-completions | openai-responses | anthropic-messages | google-generative-ai | etc.
        models: [
          {
            id: "llama-3.1-8b",
            name: "Llama 3.1 8B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            contextTokens: 96000,
            maxTokens: 32000,
          },
        ],
      },
    },
  },
}
```

<AccordionGroup>
  <Accordion title="Auth and merge precedence">
    - Use `authHeader: true` + `headers` for custom auth needs.
    - Override agent config root with `OPENCLAW_AGENT_DIR`.
    - Merge precedence for matching provider IDs:
      - Non-empty agent `models.json` `baseUrl` values win.
      - Non-empty agent `apiKey` values win only when that provider is not SecretRef-managed in current config/auth-profile context.
      - SecretRef-managed provider `apiKey` values are refreshed from source markers (`ENV_VAR_NAME` for env refs, `secretref-managed` for file/exec/store refs) instead of persisting resolved secrets.
      - SecretRef-managed provider header values are refreshed from source markers (`secretref-env:ENV_VAR_NAME` for env refs, `secretref-managed` for file/exec/store refs).
      - Empty or missing agent `apiKey`/`baseUrl` fall back to `models.providers` in config.
      - Matching model `contextWindow`/`maxTokens`: the explicit config value wins when present and valid (a positive finite number); otherwise the implicit/generated catalog value is used.
      - Matching model `contextTokens` follows the same explicit-wins-else-implicit rule; use it to limit effective context without changing native model metadata.
      - Provider-plugin catalogs are stored as generated plugin-owned catalog shards under the agent's plugin state.
      - Use `models.mode: "replace"` when you want config to fully rewrite `models.json` and skip merging in plugin-owned catalog shards.
      - Marker persistence is source-authoritative: markers are written from the active source config snapshot (pre-resolution), not from resolved runtime secret values.

  </Accordion>
</AccordionGroup>

## Provider field details

<AccordionGroup>
  <Accordion title="Top-level catalog">
    - `models.mode`: provider catalog behavior (`merge` or `replace`).
    - `models.providers`: custom provider map keyed by provider id.
      - Safe edits: use `openclaw config set models.providers.<id> '<json>' --strict-json --merge` or `openclaw config set models.providers.<id>.models '<json-array>' --strict-json --merge` for additive updates. `config set` refuses destructive replacements unless you pass `--replace`.

  </Accordion>
  <Accordion title="Provider connection and auth">
    - `models.providers.*.api`: request adapter (`openai-completions`, `openai-responses`, `openai-chatgpt-responses`, `anthropic-messages`, `google-generative-ai`, `google-vertex`, `github-copilot`, `bedrock-converse-stream`, `ollama`, `azure-openai-responses`). For self-hosted `/v1/chat/completions` backends such as MLX, vLLM, SGLang, and most OpenAI-compatible local servers, use `openai-completions`. A custom provider with `baseUrl` but no `api` defaults to `openai-completions`; set `openai-responses` only when the backend supports `/v1/responses`.
    - `models.providers.*.apiKey`: provider credential (prefer SecretRef/env substitution).
    - `models.providers.*.auth`: auth strategy (`api-key`, `token`, `oauth`, `aws-sdk`).
    - `models.providers.*.maxTokens`: default output-token cap for models under this provider when the model entry does not set `maxTokens`.
    - `models.providers.*.timeoutSeconds`: optional per-provider model HTTP request timeout in seconds, including connect, headers, body, and total request abort handling.
    - `models.providers.*.injectNumCtxForOpenAICompat`: for Ollama + `openai-completions`, inject `options.num_ctx` into requests (default: `true`).
    - `models.providers.*.authHeader`: force credential transport in the `Authorization` header when required.
    - `models.providers.*.baseUrl`: upstream API base URL.
    - `models.providers.*.headers`: extra static headers for proxy/tenant routing.

  </Accordion>
  <Accordion title="Request transport overrides">
    `models.providers.*.request`: transport overrides for model-provider HTTP requests.

    - `request.headers`: extra headers (merged with provider defaults). Values accept SecretRef.
    - `request.auth`: auth strategy override. Modes: `"provider-default"` (use provider's built-in auth), `"authorization-bearer"` (with `token`), `"header"` (with `headerName`, `value`, optional `prefix`).
    - `request.proxy`: HTTP proxy override. Modes: `"env-proxy"` (use `HTTP_PROXY`/`HTTPS_PROXY` env vars), `"explicit-proxy"` (with `url`). Both modes accept an optional `tls` sub-object.
    - `request.tls`: TLS override for direct connections. Fields: `ca`, `cert`, `key`, `passphrase` (all accept SecretRef), `serverName`, `insecureSkipVerify`.
    - `request.allowPrivateNetwork`: when `true`, allow model-provider HTTP requests to private, CGNAT, or similar ranges through the provider HTTP fetch guard. Custom/local provider base URLs already trust the exact configured origin, except metadata, link-local, and local-use NAT64 (`64:ff9b:1::/48`) origins, which remain blocked without explicit opt-in. Set this to `false` to opt out of exact-origin trust. WebSocket uses the same `request` for headers/TLS but not that fetch SSRF gate. Default `false`.

  </Accordion>
  <Accordion title="Model catalog entries">
    - `models.providers.*.models`: explicit provider model catalog entries.
    - `models.providers.*.models.*.input`: model input modalities. Use `["text"]` for text-only models and `["text", "image"]` for native image/vision models. Image attachments are only injected into agent turns when the selected model is marked image-capable.
    - `models.providers.*.models.*.contextWindow`: native context-window metadata for that model.
    - `models.providers.*.models.*.contextTokens`: optional active-input cap for that model; use it when you want an effective budget distinct from the model's native `contextWindow`; `openclaw models list` shows both when they differ.

    #### Custom provider capability declarations

    Provider catalogs own `compat` for bundled and catalog-known model routes. Do not copy those flags into config: OpenClaw uses the catalog row when the configured `api` and `baseUrl` still identify that route. `openclaw doctor --fix` removes matching legacy overrides and reports divergent values for review.

    A `compat` block remains supported for a genuinely custom provider, custom model, or catalog model routed to a different endpoint. Set only capabilities verified against that endpoint:

    | Custom-route key | Runtime contract |
    | --- | --- |
    | `supportsStore` | Accepts the OpenAI `store` request field. |
    | `supportsPromptCacheKey` | Accepts OpenAI prompt-cache/session-affinity keys. |
    | `supportsDeveloperRole` | Accepts `developer` messages instead of requiring `system`. |
    | `supportsReasoningEffort` | Accepts a reasoning-effort control. |
    | `supportsTemperature` | Accepts `temperature` for this model and adapter. |
    | `supportsUsageInStreaming` | Emits usage metadata in streaming responses. |
    | `supportsInstructions` | Responses API only: accepts the system prompt via top-level `instructions` instead of embedded in `input`. Defaults to `true` only for native OpenAI and xAI's main route — the two routes with confirmed contract evidence. Every other route, bundled or custom, defaults to `false`; set explicitly once verified against that endpoint. |
    | `supportsTools` | Supports structured tool/function calling. Set `false` to disable tools. |
    | `supportsStrictMode` | Accepts strict tool schemas. |
    | `requiresStringContent` | Requires plain-string Chat Completions message content. |
    | `strictMessageKeys` | Requires outgoing messages to contain only accepted keys. |
    | `visibleReasoningDetailTypes` | Names reasoning detail block types safe to show in transcripts. |
    | `supportedReasoningEfforts` | Lists the endpoint's accepted reasoning labels. |
    | `reasoningEffortMap` | Maps OpenClaw thinking labels to endpoint-specific labels. |
    | `maxTokensField` | Selects `max_tokens` or `max_completion_tokens`. |
    | `thinkingFormat` | Selects the endpoint's reasoning payload dialect. |
    | `requiresToolResultName` | Requires a tool name on tool-result messages. |
    | `requiresAssistantAfterToolResult` | Requires an assistant message after tool results. |
    | `requiresThinkingAsText` | Replays reasoning as text rather than structured content. |
    | `requiresReasoningContentOnAssistantMessages` | Preserves DeepSeek-style `reasoning_content` during replay. |
    | `toolSchemaProfile` | Selects a tool-schema normalization profile. Custom model entries recognize `llamacpp` and `gemini`. The `llamacpp` profile removes `pattern` and `maxLength` values at or above 2000; built-in `llama-cpp`, `ollama`, and `lmstudio` providers apply the same cleaner automatically. Custom provider IDs pointed at llama-server must select it explicitly. See the [llama.cpp example](/gateway/config-tools/provider-examples#local-models-llama-cpp-llama-server). |
    | `unsupportedToolSchemaKeywords` | Removes named JSON Schema keywords rejected by the endpoint before tool schemas are sent. Use this for endpoint-specific gaps beyond a profile's targeted transformations. |
    | `toolCallArgumentsEncoding` | Selects the endpoint's tool-call argument encoding. |
    | `requiresOpenAiAnthropicToolPayload` | Converts OpenAI-shaped tool calls to Anthropic-family payloads. |

  </Accordion>
  <Accordion title="Amazon Bedrock discovery">
    - `plugins.entries.amazon-bedrock.config.discovery`: Bedrock auto-discovery settings root.
    - `plugins.entries.amazon-bedrock.config.discovery.enabled`: turn implicit discovery on/off.
    - `plugins.entries.amazon-bedrock.config.discovery.region`: AWS region for discovery.
    - `plugins.entries.amazon-bedrock.config.discovery.providerFilter`: optional provider-id filter for targeted discovery.
    - `plugins.entries.amazon-bedrock.config.discovery.refreshInterval`: polling interval for discovery refresh.
    - `plugins.entries.amazon-bedrock.config.discovery.defaultContextWindow`: fallback context window for discovered models.
    - `plugins.entries.amazon-bedrock.config.discovery.defaultMaxTokens`: fallback max output tokens for discovered models.

  </Accordion>
</AccordionGroup>

Interactive custom-provider onboarding infers image input for known vision-model-id patterns, including GPT-4o/GPT-4.1/GPT-5+, the `o1`/`o3`/`o4` reasoning families, Claude, Gemini, any `-vl`-suffixed id (Qwen-VL and similar), and named families such as LLaVA, Pixtral, InternVL, Mllama, MiniCPM-V, and GLM-4V; it skips the extra question for known text-only families (Llama, DeepSeek, Mistral/Mixtral, Kimi/Moonshot, Codestral, Devstral, Phi, QwQ, CodeLlama, and bare Qwen ids without a vl/vision suffix). Unknown model IDs still prompt for image support. Non-interactive onboarding uses the same inference; pass `--custom-image-input` to force image-capable metadata or `--custom-text-input` to force text-only metadata.
