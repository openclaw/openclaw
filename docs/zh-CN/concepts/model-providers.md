---
read_when:
  - 你需要一份逐提供商的模型设置参考
  - 你需要模型提供商的示例配置或 CLI 新手引导命令
summary: 模型提供商概览，包含示例配置和 CLI 流程
title: 模型提供商
x-i18n:
  generated_at: "2026-03-16T02:12:40Z"
  model: claude-opus-4-6
  provider: pi
  source_hash: 978798c80c5809c162f9807072ab48fdf99bfe0db39b2b3c245ce8b4e5451603
  source_path: concepts/model-providers.md
  workflow: 15
---

# 模型提供商

本页涵盖 **LLM/模型提供商** （不是 WhatsApp/Telegram 等聊天渠道）。
有关模型选择规则，请参阅 [/concepts/models](/concepts/models)。

## 快速规则

- 模型引用使用 `provider/model` （例如： `opencode/claude-opus-4-6`）。
- 如果你设置了 `agents.defaults.models`，它将成为允许列表。
- CLI 辅助命令： `openclaw onboard`， `openclaw models list`， `openclaw models set <provider/model>`。
- 提供商插件可以通过以下方式注入模型目录 `registerProvider({ catalog })`；
  OpenClaw 将该输出合并到 `models.providers` 之后再写入
  `models.json`。
- 提供商插件还可以通过以下方式控制提供商的运行时行为
  `resolveDynamicModel`， `prepareDynamicModel`， `normalizeResolvedModel`，
  `capabilities`， `prepareExtraParams`， `wrapStreamFn`，
  `isCacheTtlEligible`， `prepareRuntimeAuth`， `resolveUsageAuth`，以及
  `fetchUsageSnapshot`。

## 插件管理的提供商行为

提供商插件现在可以管理大部分提供商特定逻辑，而 OpenClaw 负责维护通用推理循环。

典型分工：

- `catalog`：提供商出现在 `models.providers`
- `resolveDynamicModel`：提供商接受尚未出现在本地静态目录中的模型 ID
- `prepareDynamicModel`：提供商在重试动态解析之前需要刷新元数据
- `normalizeResolvedModel`：提供商需要传输层或基础 URL 重写
- `capabilities`：提供商发布会话记录/工具/提供商系列的特殊行为
- `prepareExtraParams`：提供商默认或规范化每个模型的请求参数
- `wrapStreamFn`：提供商应用请求头/请求体/模型兼容性封装
- `isCacheTtlEligible`：提供商决定哪些上游模型 ID 支持 prompt-cache TTL
- `prepareRuntimeAuth`：提供商将配置的凭证转换为短期运行时令牌
- `resolveUsageAuth`：提供商为以下用途解析使用量/配额凭证 `/usage`
  以及相关的状态/报告界面
- `fetchUsageSnapshot`：提供商负责使用量端点的获取/解析，而核心仍负责摘要外壳和格式化

当前内置示例：

- `anthropic`：Claude 4.6 向前兼容回退、使用量端点获取，以及 cache-TTL/提供商系列元数据
- `openrouter`：直通模型 ID、请求封装、提供商能力提示，以及 cache-TTL 策略
- `github-copilot`：向前兼容模型回退、Claude-thinking 会话记录提示、运行时令牌交换，以及使用量端点获取
- `openai`：GPT-5.4 向前兼容回退、直接 OpenAI 传输规范化，以及提供商系列元数据
- `openai-codex`：向前兼容模型回退、传输规范化，以及默认传输参数和使用量端点获取
- `google-gemini-cli`：Gemini 3.1 向前兼容回退，以及使用量界面的 usage-token 解析和配额端点获取
- `moonshot`：共享传输、插件管理的 thinking 负载规范化
- `kilocode`：共享传输、插件管理的请求头、推理负载规范化、Gemini 会话记录提示，以及 cache-TTL 策略
- `zai`：GLM-5 向前兼容回退， `tool_stream` 默认值、cache-TTL 策略，以及使用量认证和配额获取
- `mistral`， `opencode`，以及`opencode-go`：插件管理的能力元数据
- `byteplus`， `cloudflare-ai-gateway`， `huggingface`， `kimi-coding`，
  `minimax-portal`， `modelstudio`， `nvidia`， `qianfan`， `qwen-portal`，
  `synthetic`， `together`， `venice`， `vercel-ai-gateway`，以及`volcengine`：仅限插件管理的目录
- `minimax` 和 `xiaomi`：插件管理的目录以及使用量认证/快照逻辑

以上涵盖了仍然适用于 OpenClaw 常规传输层的提供商。如果某个提供商需要完全自定义的请求执行器，则属于一个独立的、更深层的扩展层面。

## API 密钥轮换

- 支持对选定提供商的通用提供商轮换。
- 通过以下方式配置多个密钥：
  - `OPENCLAW_LIVE_<PROVIDER>_KEY` （单个实时覆盖，最高优先级）
  - `<PROVIDER>_API_KEYS` （逗号或分号分隔的列表）
  - `<PROVIDER>_API_KEY` （主密钥）
  - `<PROVIDER>_API_KEY_*` （编号列表，例如 `<PROVIDER>_API_KEY_1`）
- 对于 Google 提供商， `GOOGLE_API_KEY` 也作为备选项包含在内。
- 密钥选择顺序按优先级排列并去除重复值。
- 仅在速率限制响应时使用下一个密钥重试请求（例如 `429`， `rate_limit`， `quota`， `resource exhausted`）。
- 非速率限制的失败会立即报错；不会尝试密钥轮换。
- 当所有候选密钥均失败时，返回最后一次尝试的错误。

## 内置提供商（pi-ai 目录）

OpenClaw 附带 pi-ai 目录。这些提供商需要 **无需**
`models.providers` 配置；只需设置认证并选择一个模型。

### OpenAI

- 提供商： `openai`
- 认证： `OPENAI_API_KEY`
- 可选轮换： `OPENAI_API_KEYS`， `OPENAI_API_KEY_1`， `OPENAI_API_KEY_2`，加上 `OPENCLAW_LIVE_OPENAI_KEY` （单个覆盖）
- 示例模型： `openai/gpt-5.4`， `openai/gpt-5.4-pro`
- CLI： `openclaw onboard --auth-choice openai-api-key`
- 默认传输为 `auto` （WebSocket 优先，SSE 备选）
- 通过以下方式覆盖每个模型 `agents.defaults.models["openai/<model>"].params.transport` （`"sse"`， `"websocket"`，或 `"auto"`）
- OpenAI Responses WebSocket 预热默认通过以下方式启用 `params.openaiWsWarmup` （`true`/`false`）
- OpenAI 优先处理可以通过以下方式启用 `agents.defaults.models["openai/<model>"].params.serviceTier`
- OpenAI 快速模式可以通过以下方式为每个模型启用 `agents.defaults.models["<provider>/<model>"].params.fastMode`
- `openai/gpt-5.3-codex-spark` 在 OpenClaw 中被有意屏蔽，因为 OpenAI 实时 API 会拒绝它；Spark 被视为仅限 Codex 使用

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
}
```

### Anthropic

- 提供商： `anthropic`
- 认证： `ANTHROPIC_API_KEY` 或 `claude setup-token`
- 可选轮换： `ANTHROPIC_API_KEYS`， `ANTHROPIC_API_KEY_1`， `ANTHROPIC_API_KEY_2`，加上 `OPENCLAW_LIVE_ANTHROPIC_KEY` （单个覆盖）
- 示例模型： `anthropic/claude-opus-4-6`
- CLI： `openclaw onboard --auth-choice token` （粘贴 setup-token）或 `openclaw models auth paste-token --provider anthropic`
- 直接 API 密钥模型支持共享的 `/fast` 切换和 `params.fastMode`；OpenClaw 将其映射到 Anthropic 的 `service_tier` （`auto` 与 `standard_only`）
- 策略说明：setup-token 支持属于技术兼容性；Anthropic 过去曾阻止部分订阅在 Claude Code 之外的使用。请核实当前 Anthropic 条款，并根据你的风险承受能力做出决定。
- 建议：Anthropic API 密钥认证是比订阅 setup-token 认证更安全的推荐方式。

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- 提供商： `openai-codex`
- 认证：OAuth (ChatGPT)
- 示例模型： `openai-codex/gpt-5.4`
- CLI： `openclaw onboard --auth-choice openai-codex` 或 `openclaw models auth login --provider openai-codex`
- 默认传输为 `auto` （WebSocket 优先，SSE 备选）
- 通过以下方式覆盖每个模型 `agents.defaults.models["openai-codex/<model>"].params.transport` （`"sse"`， `"websocket"`，或 `"auto"`）
- 与相同的 `/fast` 切换和 `params.fastMode` 配置共享，如同直接的 `openai/*`
- `openai-codex/gpt-5.3-codex-spark` 当 Codex OAuth 目录公开时仍然可用；取决于授权资格
- 策略说明：OpenAI Codex OAuth 明确支持 OpenClaw 等外部工具/工作流。

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
}
```

### OpenCode

- 认证： `OPENCODE_API_KEY` （或 `OPENCODE_ZEN_API_KEY`）
- Zen 运行时提供商： `opencode`
- Go 运行时提供商： `opencode-go`
- 示例模型： `opencode/claude-opus-4-6`， `opencode-go/kimi-k2.5`
- CLI： `openclaw onboard --auth-choice opencode-zen` 或 `openclaw onboard --auth-choice opencode-go`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini（API 密钥）

- 提供商： `google`
- 认证： `GEMINI_API_KEY`
- 可选轮换： `GEMINI_API_KEYS`， `GEMINI_API_KEY_1`， `GEMINI_API_KEY_2`， `GOOGLE_API_KEY` 备选，以及 `OPENCLAW_LIVE_GEMINI_KEY` （单个覆盖）
- 示例模型： `google/gemini-3.1-pro-preview`， `google/gemini-3-flash-preview`
- 兼容性：使用旧版 OpenClaw 配置的 `google/gemini-3.1-flash-preview` 会被规范化为 `google/gemini-3-flash-preview`
- CLI： `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex 和 Gemini CLI

- 提供商： `google-vertex`， `google-gemini-cli`
- 认证：Vertex 使用 gcloud ADC；Gemini CLI 使用其 OAuth 流程
- 注意：OpenClaw 中的 Gemini CLI OAuth 是非官方集成。部分用户报告称在使用第三方客户端后 Google 账户受到限制。请查阅 Google 条款，如果你选择继续，建议使用非关键账户。
- Gemini CLI OAuth 作为内置的 `google` 插件的一部分提供。
  - 启用： `openclaw plugins enable google`
  - 登录： `openclaw models auth login --provider google-gemini-cli --set-default`
  - 注意：你确实 **不** 需要将 client ID 或 secret 粘贴到 `openclaw.json`中。CLI 登录流程将令牌存储在 Gateway 网关主机的认证配置文件中。

### Z.AI (GLM)

- 提供商： `zai`
- 认证： `ZAI_API_KEY`
- 示例模型： `zai/glm-5`
- CLI： `openclaw onboard --auth-choice zai-api-key`
  - 别名： `z.ai/*` 和 `z-ai/*` 规范化为 `zai/*`

### Vercel AI Gateway

- 提供商： `vercel-ai-gateway`
- 认证： `AI_GATEWAY_API_KEY`
- 示例模型： `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI： `openclaw onboard --auth-choice ai-gateway-api-key`

### Kilo Gateway

- 提供商： `kilocode`
- 认证： `KILOCODE_API_KEY`
- 示例模型： `kilocode/anthropic/claude-opus-4.6`
- CLI： `openclaw onboard --kilocode-api-key <key>`
- 基础 URL： `https://api.kilo.ai/api/gateway/`
- 扩展的内置目录包括 GLM-5 Free、MiniMax M2.5 Free、GPT-5.2、Gemini 3 Pro Preview、Gemini 3 Flash Preview、Grok Code Fast 1 和 Kimi K2.5。

参阅 [/providers/kilocode](/providers/kilocode) 了解详情。

### 其他内置提供商插件

- OpenRouter： `openrouter` （`OPENROUTER_API_KEY`）
- 示例模型： `openrouter/anthropic/claude-sonnet-4-5`
- Kilo Gateway： `kilocode` （`KILOCODE_API_KEY`）
- 示例模型： `kilocode/anthropic/claude-opus-4.6`
- MiniMax： `minimax` （`MINIMAX_API_KEY`）
- Moonshot： `moonshot` （`MOONSHOT_API_KEY`）
- Kimi Coding： `kimi-coding` （`KIMI_API_KEY` 或 `KIMICODE_API_KEY`）
- Qianfan： `qianfan` （`QIANFAN_API_KEY`）
- Model Studio： `modelstudio` （`MODELSTUDIO_API_KEY`）
- NVIDIA： `nvidia` （`NVIDIA_API_KEY`）
- Together： `together` （`TOGETHER_API_KEY`）
- Venice： `venice` （`VENICE_API_KEY`）
- Xiaomi： `xiaomi` （`XIAOMI_API_KEY`）
- Vercel AI Gateway： `vercel-ai-gateway` （`AI_GATEWAY_API_KEY`）
- Hugging Face Inference： `huggingface` （`HUGGINGFACE_HUB_TOKEN` 或 `HF_TOKEN`）
- Cloudflare AI Gateway： `cloudflare-ai-gateway` （`CLOUDFLARE_AI_GATEWAY_API_KEY`）
- Volcengine： `volcengine` （`VOLCANO_ENGINE_API_KEY`）
- BytePlus： `byteplus` （`BYTEPLUS_API_KEY`）
- xAI： `xai` （`XAI_API_KEY`）
- Mistral： `mistral` （`MISTRAL_API_KEY`）
- 示例模型： `mistral/mistral-large-latest`
- CLI： `openclaw onboard --auth-choice mistral-api-key`
- Groq： `groq` （`GROQ_API_KEY`）
- Cerebras： `cerebras` （`CEREBRAS_API_KEY`）
  - Cerebras 上的 GLM 模型使用 ID `zai-glm-4.7` 和 `zai-glm-4.6`。
  - 兼容 OpenAI 的基础 URL： `https://api.cerebras.ai/v1`。
- GitHub Copilot： `github-copilot` （`COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`）
- Hugging Face Inference 示例模型： `huggingface/deepseek-ai/DeepSeek-R1`；CLI： `openclaw onboard --auth-choice huggingface-api-key`。参阅 [Hugging Face (Inference)](/providers/huggingface)。

## 通过以下方式提供的提供商 `models.providers` （自定义/基础 URL）

使用 `models.providers` （或 `models.json`）来添加 **自定义** 提供商或 OpenAI/Anthropic 兼容代理。

下方许多内置提供商插件已经发布了默认目录。
使用显式的 `models.providers.<id>` 条目仅在你需要覆盖默认基础 URL、请求头或模型列表时使用。

### Moonshot AI (Kimi)

Moonshot 使用兼容 OpenAI 的端点，因此将其配置为自定义提供商：

- 提供商： `moonshot`
- 认证： `MOONSHOT_API_KEY`
- 示例模型： `moonshot/kimi-k2.5`

Kimi K2 模型 ID：

[//]: # "moonshot-kimi-k2-model-refs:start"

- `moonshot/kimi-k2.5`
- `moonshot/kimi-k2-0905-preview`
- `moonshot/kimi-k2-turbo-preview`
- `moonshot/kimi-k2-thinking`
- `moonshot/kimi-k2-thinking-turbo`

[//]: # "moonshot-kimi-k2-model-refs:end"

```json5
{
  agents: {
    defaults: { model: { primary: "moonshot/kimi-k2.5" } },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [{ id: "kimi-k2.5", name: "Kimi K2.5" }],
      },
    },
  },
}
```

### Kimi Coding

Kimi Coding 使用 Moonshot AI 的 Anthropic 兼容端点：

- 提供商： `kimi-coding`
- 认证： `KIMI_API_KEY`
- 示例模型： `kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth（免费套餐）

Qwen 通过设备码流程提供对 Qwen Coder + Vision 的 OAuth 访问。
内置提供商插件默认启用，只需登录：

```bash
openclaw models auth login --provider qwen-portal --set-default
```

模型引用：

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

参阅 [/providers/qwen](/providers/qwen) 了解详情和注意事项。

### 火山引擎（豆包）

火山引擎提供对豆包及中国其他模型的访问。

- 提供商： `volcengine` （编码： `volcengine-plan`）
- 认证： `VOLCANO_ENGINE_API_KEY`
- 示例模型： `volcengine/doubao-seed-1-8-251228`
- CLI： `openclaw onboard --auth-choice volcengine-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "volcengine/doubao-seed-1-8-251228" } },
  },
}
```

可用模型：

- `volcengine/doubao-seed-1-8-251228` （豆包 Seed 1.8）
- `volcengine/doubao-seed-code-preview-251028`
- `volcengine/kimi-k2-5-260127` （Kimi K2.5）
- `volcengine/glm-4-7-251222` （GLM 4.7）
- `volcengine/deepseek-v3-2-251201` （DeepSeek V3.2 128K）

编码模型（`volcengine-plan`）：

- `volcengine-plan/ark-code-latest`
- `volcengine-plan/doubao-seed-code`
- `volcengine-plan/kimi-k2.5`
- `volcengine-plan/kimi-k2-thinking`
- `volcengine-plan/glm-4.7`

### BytePlus（国际版）

BytePlus ARK 为国际用户提供与火山引擎相同的模型访问。

- 提供商： `byteplus` （编码： `byteplus-plan`）
- 认证： `BYTEPLUS_API_KEY`
- 示例模型： `byteplus/seed-1-8-251228`
- CLI： `openclaw onboard --auth-choice byteplus-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "byteplus/seed-1-8-251228" } },
  },
}
```

可用模型：

- `byteplus/seed-1-8-251228` （Seed 1.8）
- `byteplus/kimi-k2-5-260127` （Kimi K2.5）
- `byteplus/glm-4-7-251222` （GLM 4.7）

编码模型（`byteplus-plan`）：

- `byteplus-plan/ark-code-latest`
- `byteplus-plan/doubao-seed-code`
- `byteplus-plan/kimi-k2.5`
- `byteplus-plan/kimi-k2-thinking`
- `byteplus-plan/glm-4.7`

### Synthetic

Synthetic 提供 Anthropic 兼容模型，位于 `synthetic` 提供商背后：

- 提供商： `synthetic`
- 认证： `SYNTHETIC_API_KEY`
- 示例模型： `synthetic/hf:MiniMaxAI/MiniMax-M2.5`
- CLI： `openclaw onboard --auth-choice synthetic-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.5" } },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [{ id: "hf:MiniMaxAI/MiniMax-M2.5", name: "MiniMax M2.5" }],
      },
    },
  },
}
```

### MiniMax

MiniMax 通过以下方式配置 `models.providers` ，因为它使用自定义端点：

- MiniMax（Anthropic 兼容）： `--auth-choice minimax-api`
- 认证： `MINIMAX_API_KEY`

参阅 [/providers/minimax](/providers/minimax) 了解详情、模型选项和配置代码片段。

### Ollama

Ollama 作为内置提供商插件提供，并使用 Ollama 的原生 API：

- 提供商： `ollama`
- 认证：无需（本地服务器）
- 示例模型： `ollama/llama3.3`
- 安装： [https://ollama.com/download](https://ollama.com/download)

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

Ollama 在本地通过以下地址检测 `http://127.0.0.1:11434` 当你通过以下方式选择启用时
`OLLAMA_API_KEY`，内置提供商插件会将 Ollama 直接添加到
`openclaw onboard` 和模型选择器中。参阅 [/providers/ollama](/providers/ollama)
了解新手引导、云端/本地模式和自定义配置。

### vLLM

vLLM 作为内置提供商插件提供，用于本地/自托管的兼容 OpenAI 服务器：

- 提供商： `vllm`
- 认证：可选（取决于你的服务器）
- 默认基础 URL： `http://127.0.0.1:8000/v1`

要在本地选择启用自动发现（如果你的服务器不强制认证，任何值均可）：

```bash
export VLLM_API_KEY="vllm-local"
```

然后设置一个模型（替换为由 `/v1/models`）：

```json5
{
  agents: {
    defaults: { model: { primary: "vllm/your-model-id" } },
  },
}
```

参阅 [/providers/vllm](/providers/vllm) 了解详情。

### SGLang

SGLang 作为内置提供商插件提供，用于快速自托管的兼容 OpenAI 服务器：

- 提供商： `sglang`
- 认证：可选（取决于你的服务器）
- 默认基础 URL： `http://127.0.0.1:30000/v1`

要在本地选择启用自动发现（如果你的服务器不强制认证，任何值均可）：

```bash
export SGLANG_API_KEY="sglang-local"
```

然后设置一个模型（替换为由 `/v1/models`）：

```json5
{
  agents: {
    defaults: { model: { primary: "sglang/your-model-id" } },
  },
}
```

参阅 [/providers/sglang](/providers/sglang) 了解详情。

### 本地代理（LM Studio、vLLM、LiteLLM 等）

示例（兼容 OpenAI）：

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.5-gs32" },
      models: { "lmstudio/minimax-m2.5-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    providers: {
      lmstudio: {
        baseUrl: "http://localhost:1234/v1",
        apiKey: "LMSTUDIO_KEY",
        api: "openai-completions",
        models: [
          {
            id: "minimax-m2.5-gs32",
            name: "MiniMax M2.5",
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

注意事项：

- 对于自定义提供商， `reasoning`， `input`， `cost`， `contextWindow`，以及`maxTokens` 是可选的。
  省略时，OpenClaw 默认为：
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- 建议：设置与你的代理/模型限制相匹配的显式值。
- 对于 `api: "openai-completions"` 在非原生端点上（任何非空的 `baseUrl` 且主机不是 `api.openai.com`），OpenClaw 强制使用 `compat.supportsDeveloperRole: false` 以避免提供商对不支持的 `developer` 角色返回 400 错误。
- 如果 `baseUrl` 为空/省略，OpenClaw 保持默认的 OpenAI 行为（解析为 `api.openai.com`）。
- 为安全起见，显式的 `compat.supportsDeveloperRole: true` 在非原生 `openai-completions` 端点上仍会被覆盖。

## CLI 示例

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

另请参阅： [/gateway/configuration](/gateway/configuration) 查看完整配置示例。
