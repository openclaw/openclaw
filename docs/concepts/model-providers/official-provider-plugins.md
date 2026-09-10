---
summary: "Per-provider setup for the bundled provider plugins, the bundled provider table, and provider quirks."
read_when:
  - You are setting up a bundled provider such as OpenAI, Anthropic, or Google
  - You need the bundled provider id, auth env, and example model
  - You hit a provider-specific quirk
title: "Official provider plugins"
---

## Official provider plugins

Official provider plugins publish their own model catalog rows. These providers require **no** `models.providers` model entries; enable the provider plugin, set auth, and pick a model. Use `models.providers` only for explicit custom providers or narrow request settings such as timeouts.

### OpenAI

- Provider: `openai`
- Auth: `OPENAI_API_KEY`
- Optional rotation: `OPENAI_API_KEYS`, `OPENAI_API_KEY_1`, `OPENAI_API_KEY_2`, plus `OPENCLAW_LIVE_OPENAI_KEY` (single override)
- Fresh setup default: `openai/gpt-5.6-sol`.
- Example models: `openai/gpt-5.6-sol`, `openai/gpt-5.6-terra`, `openai/gpt-5.6-luna`, `openai/gpt-5.5`; the bare direct-API `openai/gpt-5.6` alias remains supported.
- Verify account/model availability with `openclaw models list --provider openai` if a specific install or API key behaves differently.
- CLI: `openclaw onboard --auth-choice openai-api-key`
- Direct OpenAI API-key Responses requests default to `"sse"`.
- Override per model via `agents.defaults.models["openai/<model>"].params.transport` (`"sse"`, `"websocket"`, `"websocket-cached"`, or `"auto"`). Cached WebSockets reuse the session connection and send only new input with `previous_response_id` when history still matches.
- Set an explicit OpenAI API service tier with `params.serviceTier` or `params.service_tier`; Fast mode (formerly Priority processing) uses `service_tier=priority`.
- On native public OpenAI and ChatGPT/Codex Responses requests, precedence is payload/transport `service_tier`, then a valid explicit model param, then the fast-mode default.
- `/fast` and valid `params.fastMode` / `params.fast_mode` values are shared agent-runtime controls; on direct embedded `openai/*` Responses requests they supply `service_tier=priority` only when no higher-precedence tier exists.
- Hidden OpenClaw attribution headers (`originator`, `version`, `User-Agent`) apply only on native OpenAI traffic to `api.openai.com`, not generic OpenAI-compatible proxies
- Native OpenAI routes also keep Responses `store`, prompt-cache hints, and OpenAI reasoning-compat payload shaping; proxy routes do not
- `openai/gpt-5.3-codex-spark` is available only through ChatGPT/Codex OAuth; direct OpenAI API-key and Azure API-key routes reject it

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } },
}
```

If the API organization does not expose GPT-5.6, set
`openai/gpt-5.5` explicitly. Normal onboarding and reauthentication preserve an
existing explicit primary model; `models auth login --set-default` and
`models set` are the intentional replacement paths.

### Anthropic

- Provider: `anthropic`
- Auth: `ANTHROPIC_API_KEY`
- Optional rotation: `ANTHROPIC_API_KEYS`, `ANTHROPIC_API_KEY_1`, `ANTHROPIC_API_KEY_2`, plus `OPENCLAW_LIVE_ANTHROPIC_KEY` (single override)
- Example model: `anthropic/claude-opus-5`
- CLI: `openclaw onboard --auth-choice apiKey`
- Direct public Anthropic requests support the shared `/fast` toggle and `params.fastMode`, including API-key and OAuth-authenticated traffic sent to `api.anthropic.com`; OpenClaw maps that to Anthropic `service_tier` (`auto` vs `standard_only`)
- Preferred Claude CLI config keeps the model ref canonical and selects the CLI
  backend separately: `anthropic/claude-opus-5` with
  model-scoped `agentRuntime.id: "claude-cli"`. Legacy
  `claude-cli/claude-opus-4-7` refs still work for compatibility.

<Note>
Claude CLI reuse (`claude -p`) is a sanctioned OpenClaw integration path. Anthropic setup-token auth remains supported, but OpenClaw prefers Claude CLI reuse when available.
</Note>

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-5" } } },
}
```

### OpenAI ChatGPT/Codex OAuth

- Provider: `openai`
- Auth: OAuth (ChatGPT)
- Fresh native Codex app-server harness ref: `openai/gpt-5.6-sol`
- Native Codex app-server harness docs: [Codex harness](/plugins/codex-harness)
- Astra (`openai/gpt-6-astra`) defaults to `low` reasoning effort to limit routine budget use. The [OpenAI provider default](/providers/openai/models#gpt-6-astra) is shared by model controls and both runtimes; explicit thinking settings take precedence.
- Legacy model refs: `codex/gpt-*`, `openai-codex/gpt-*`
- Plugin boundary: `openai/*` loads the OpenAI plugin; explicit runtime policy or the provider-owned effective route decides whether the native Codex app-server plugin is selected.
- CLI: `openclaw onboard --auth-choice openai` or `openclaw models auth login --provider openai`
- OpenClaw's embedded ChatGPT Responses transport defaults to `auto` (WebSocket-first, SSE fallback).
- `agents.defaults.models["openai/<model>"].params.transport` and `params.serviceTier` are authored embedded-provider request settings. They keep implicit runtime selection on OpenClaw; native Codex owns its app-server transport and service tier.
- Valid model-scoped `params.fastMode` / `params.fast_mode` values and valid cutoff keys are portable typed agent-runtime controls. They do not count as authored provider request params and do not select a runtime. Pin `agentRuntime.id: "openclaw"` or `agentRuntime.id: "codex"` when a recipe depends on one runtime.
- Hidden OpenClaw attribution headers (`originator`, `version`, `User-Agent`) are only attached on native Codex traffic to `chatgpt.com/backend-api`, not generic OpenAI-compatible proxies
- The shared `/fast` toggle, configured defaults, and valid model-scoped Fast params resolve through one runtime-control policy. See [Thinking levels](/tools/thinking#fast-mode-%2Ffast) for precedence.
- OpenAI API Fast mode is premium-priced and model-specific. GPT-5.6 Sol currently costs 2× Standard token pricing, and long-context multipliers stack. ChatGPT/Codex-credit Fast mode is separate: GPT-5.6 and GPT-5.5 currently consume 2.5× Standard credits, while API-key Codex runs use API token pricing. See [Fast mode](https://openai.com/api-priority-processing/), [API pricing](https://developers.openai.com/api/docs/pricing), and [Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed).
- The native Codex catalog can expose exact `openai/gpt-5.6-sol`, `openai/gpt-5.6-terra`, and `openai/gpt-5.6-luna` refs according to account access. It does not apply the direct API's bare `gpt-5.6` alias client-side.
- `openai/gpt-5.5` uses the Codex catalog native `contextWindow = 400000` and default runtime `contextTokens = 272000`; override the runtime cap with `models.providers.openai.models[].contextTokens`
- Sign in with `openai` auth and use `openai/gpt-5.6-sol` for a fresh subscription-backed setup. Select `openai/gpt-5.5` explicitly if that Codex workspace does not expose GPT-5.6.
- Use provider/model `agentRuntime.id: "openclaw"` to keep an otherwise eligible route on the built-in runtime. With runtime unset or `auto`, only an exact official HTTPS Responses/ChatGPT-compatible route with no authored provider request override may select Codex implicitly.
- Legacy Codex GPT refs are legacy state, not a live provider route. Use canonical `openai/*` refs for new agent config, and run `openclaw doctor --fix` to migrate `codex/*` and `openai-codex/*` refs while preserving their native Codex semantics with model-scoped `agentRuntime.id: "codex"`. Existing explicit canonical `openai/gpt-5.5` selections are not upgraded.

```json5
{
  plugins: { entries: { codex: { enabled: true } } },
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.6-sol" },
    },
  },
}
```

```json5
{
  models: {
    providers: {
      openai: {
        models: [{ id: "gpt-5.5", contextTokens: 160000 }],
      },
    },
  },
}
```

### Other subscription-style hosted options

<CardGroup cols={3}>
  <Card title="MiniMax" href="/providers/minimax">
    MiniMax Coding Plan OAuth or API key access.
  </Card>
  <Card title="Qwen Cloud" href="/providers/qwen">
    Qwen Cloud provider surface plus Alibaba DashScope and Coding Plan endpoint mapping.
  </Card>
  <Card title="Z.AI (GLM)" href="/providers/zai">
    Z.AI Coding Plan or general API endpoints.
  </Card>
</CardGroup>

### OpenCode

- Auth: `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`)
- Zen runtime provider: `opencode`
- Go runtime provider: `opencode-go`
- Example models: `opencode/claude-opus-4-6`, `opencode-go/kimi-k2.6`
- CLI: `openclaw onboard --auth-choice opencode-zen` or `openclaw onboard --auth-choice opencode-go`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (API key)

- Provider: `google`
- Auth: `GEMINI_API_KEY`
- Optional rotation: `GEMINI_API_KEYS`, `GEMINI_API_KEY_1`, `GEMINI_API_KEY_2`, `GOOGLE_API_KEY` fallback, and `OPENCLAW_LIVE_GEMINI_KEY` (single override)
- Example models: `google/gemini-3.1-pro-preview`, `google/gemini-3.5-flash`
- Compatibility: legacy OpenClaw config using `google/gemini-3.1-flash-preview` is normalized to `google/gemini-3-flash-preview`
- Alias: `google/gemini-3.1-pro` is accepted and normalized to Google's live Gemini API id, `google/gemini-3.1-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`
- Thinking: `/think adaptive` uses Google dynamic thinking. Gemini 3/3.1 omit a fixed `thinkingLevel`; Gemini 2.5 sends `thinkingBudget: -1`.
- Direct Gemini runs also accept `agents.defaults.models["google/<model>"].params.cachedContent` (or legacy `cached_content`) to forward a provider-native `cachedContents/...` handle; Gemini cache hits surface as OpenClaw `cacheRead`

### Google Vertex and Gemini CLI runtime

- `google-vertex`: managed Google Cloud access through gcloud Application
  Default Credentials.
- `google-gemini-cli`: optional local runtime for an explicitly configured
  canonical `google/*` model.

OpenClaw does not create Gemini CLI OAuth or Antigravity OAuth profiles. Connect
Google through an AI Studio API key or Vertex AI. If you explicitly choose the
Gemini CLI runtime, it can use the selected Google API-key profile. Existing
valid Gemini CLI OAuth profiles remain runtime-compatible, but they are not a
setup or recovery route.

Gemini CLI uses `stream-json` by default. OpenClaw reads assistant stream
messages and normalizes `stats.cached` into `cacheRead`; legacy
`--output-format json` overrides still read reply text from `response`.

### Z.AI (GLM)

- Provider: `zai`
- Auth: `ZAI_API_KEY`
- Example model: `zai/glm-5.2`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - Model refs use the canonical `zai/*` provider ID.
  - `zai-api-key` auto-detects the matching Z.AI endpoint; `zai-coding-global`, `zai-coding-cn`, `zai-global`, and `zai-cn` force a specific surface

### Vercel AI Gateway

- Provider: `vercel-ai-gateway`
- Auth: `AI_GATEWAY_API_KEY`
- Example models: `vercel-ai-gateway/anthropic/claude-opus-4.6`, `vercel-ai-gateway/moonshotai/kimi-k2.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### Other bundled provider plugins

| Provider                                | Id                               | Auth env                                             | Example model                                          |
| --------------------------------------- | -------------------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| [Arcee](/providers/arcee)               | `arcee`                          | `ARCEEAI_API_KEY` or `OPENROUTER_API_KEY`            | `arcee/trinity-large-thinking`                         |
| BytePlus                                | `byteplus` / `byteplus-plan`     | `BYTEPLUS_API_KEY`                                   | `byteplus-plan/ark-code-latest`                        |
| Cerebras                                | `cerebras`                       | `CEREBRAS_API_KEY`                                   | `cerebras/zai-glm-4.7`                                 |
| Chutes                                  | `chutes`                         | `CHUTES_API_KEY` or `CHUTES_OAUTH_TOKEN`             | `chutes/zai-org/GLM-5-TEE`                             |
| ClawRouter                              | `clawrouter`                     | `CLAWROUTER_API_KEY`                                 | `clawrouter/anthropic/claude-sonnet-4-6`               |
| Cohere                                  | `cohere`                         | `COHERE_API_KEY`                                     | `cohere/command-a-plus-05-2026`                        |
| DeepInfra                               | `deepinfra`                      | `DEEPINFRA_API_KEY`                                  | `deepinfra/deepseek-ai/DeepSeek-V4-Flash`              |
| DeepSeek                                | `deepseek`                       | `DEEPSEEK_API_KEY`                                   | `deepseek/deepseek-v4-flash`                           |
| Featherless AI                          | `featherless`                    | `FEATHERLESS_API_KEY`                                | `featherless/Qwen/Qwen3-32B`                           |
| GitHub Copilot                          | `github-copilot`                 | `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` | -                                                      |
| GMI Cloud                               | `gmi`                            | `GMI_API_KEY`                                        | `gmi/google/gemini-3.1-flash-lite`                     |
| Groq                                    | `groq`                           | `GROQ_API_KEY`                                       | `groq/llama-3.3-70b-versatile`                         |
| Hugging Face Inference                  | `huggingface`                    | `HUGGINGFACE_HUB_TOKEN` or `HF_TOKEN`                | `huggingface/deepseek-ai/DeepSeek-R1`                  |
| MiniMax                                 | `minimax` / `minimax-portal`     | `MINIMAX_API_KEY` / `MINIMAX_OAUTH_TOKEN`            | `minimax/MiniMax-M3`                                   |
| Mistral                                 | `mistral`                        | `MISTRAL_API_KEY`                                    | `mistral/mistral-large-latest`                         |
| Moonshot                                | `moonshot`                       | `MOONSHOT_API_KEY`                                   | `moonshot/kimi-k2.6`                                   |
| NVIDIA                                  | `nvidia`                         | `NVIDIA_API_KEY`                                     | `nvidia/nvidia/nemotron-3-ultra-550b-a55b`             |
| NovitaAI                                | `novita`                         | `NOVITA_API_KEY`                                     | `novita/deepseek/deepseek-v3-0324`                     |
| [Ollama Cloud](/providers/ollama-cloud) | `ollama-cloud`                   | `OLLAMA_API_KEY`                                     | `ollama-cloud/kimi-k2.6`                               |
| OpenRouter                              | `openrouter`                     | OpenRouter OAuth or `OPENROUTER_API_KEY`             | `openrouter/auto`                                      |
| Qianfan                                 | `qianfan`                        | `QIANFAN_API_KEY`                                    | `qianfan/deepseek-v3.2`                                |
| Tencent TokenHub                        | `tencent-tokenhub`               | `TOKENHUB_API_KEY`                                   | `tencent-tokenhub/hy3-preview`                         |
| Together                                | `together`                       | `TOGETHER_API_KEY`                                   | `together/meta-llama/Llama-3.3-70B-Instruct-Turbo`     |
| Venice                                  | `venice`                         | `VENICE_API_KEY`                                     | -                                                      |
| Vercel AI Gateway                       | `vercel-ai-gateway`              | `AI_GATEWAY_API_KEY`                                 | `vercel-ai-gateway/anthropic/claude-opus-4.6`          |
| Volcano Engine (Doubao)                 | `volcengine` / `volcengine-plan` | `VOLCANO_ENGINE_API_KEY`                             | `volcengine-plan/ark-code-latest`                      |
| xAI                                     | `xai`                            | SuperGrok/X Premium OAuth or `XAI_API_KEY`           | `xai/grok-4.6`                                         |
| Xiaomi                                  | `xiaomi` / `xiaomi-token-plan`   | `XIAOMI_API_KEY` / `XIAOMI_TOKEN_PLAN_API_KEY`       | `xiaomi/mimo-v2.5` / `xiaomi-token-plan/mimo-v2.5-pro` |

#### Quirks worth knowing

<AccordionGroup>
  <Accordion title="OpenRouter">
    Applies its app-attribution headers and Anthropic `cache_control` markers only on verified `openrouter.ai` routes. DeepSeek, Moonshot, and ZAI refs are cache-TTL eligible for OpenRouter-managed prompt caching but do not receive Anthropic cache markers. As a proxy-style OpenAI-compatible path, it skips native-OpenAI-only shaping (`serviceTier`, Responses `store`, prompt-cache hints, OpenAI reasoning-compat). Gemini-backed refs keep proxy-Gemini thought-signature sanitation only.
  </Accordion>
  <Accordion title="Kilo Gateway">
    Gemini-backed refs follow the same proxy-Gemini sanitation path; `kilocode/kilo-auto/balanced` and other proxy-reasoning-unsupported refs skip proxy reasoning injection.
  </Accordion>
  <Accordion title="MiniMax">
    API-key onboarding writes explicit M3 and M2.7 chat model definitions; image understanding stays on the plugin-owned `MiniMax-VL-01` media provider.
  </Accordion>
  <Accordion title="NVIDIA">
    Model ids use a `nvidia/<vendor>/<model>` namespace (for example `nvidia/nvidia/nemotron-...`); pickers preserve the literal `<provider>/<model-id>` composition while the canonical key sent to the API stays single-prefixed.
  </Accordion>
  <Accordion title="xAI">
    Uses the xAI Responses path. The recommended path is SuperGrok/X Premium OAuth; OAuth and API-key setup use the curated `xai/grok-4.6` default. Existing primary models stay pinned. Run `openclaw doctor --fix` to repair retired `xai/auto` selections on the subscription route. API keys still work via `XAI_API_KEY` or plugin config. Grok `web_search` reuses the same auth profile before API-key fallback. Older `/fast` and `params.fastMode: true` configurations still resolve through xAI's Grok 4.3 compatibility redirects, but new configurations should select a current model directly. `tool_stream` defaults on; disable via `agents.defaults.models["xai/<model>"].params.tool_stream=false`.
  </Accordion>
</AccordionGroup>
