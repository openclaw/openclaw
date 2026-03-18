---
read_when:
  - 你需要按提供商划分的模型设置参考
  - 你想要模型提供商的示例配置或 CLI 新手引导命令
summary: 模型提供商概览，包含示例配置 + CLI 流程
title: 模型提供商
x-i18n:
  generated_at: "2026-03-16T06:22:52Z"
  model: gpt-5.4
  provider: openai
  source_hash: 1b84eea0103a59e77571f82c800c9c0ad9fc554e8c9b2c1fd15c2cc121e7f6b4
  source_path: concepts/model-providers.md
  workflow: 15
---

# 模型提供商

本页介绍的是 **LLM/模型提供商**（而不是像 WhatsApp/Telegram 这样的聊天渠道）。
有关模型选择规则，请参见 [/concepts/models](/concepts/models)。

## 快速规则

- 模型引用使用 `provider/model`（示例：`opencode/claude-opus-4-6`）。
- 如果你设置了 `agents.defaults.models`，它就会成为 allowlist。
- CLI 辅助命令：`openclaw onboard`、`openclaw models list`、`openclaw models set <provider/model>`。
- 提供商插件可以通过 `registerProvider({ catalog })` 注入模型目录；
  OpenClaw 会在写入
  `models.json` 之前将该输出合并到 `models.providers` 中。
- 提供商清单可以声明 `providerAuthEnvVars`，这样基于通用环境变量的
  身份验证探测就不需要加载插件运行时。其余的核心环境变量映射
  现在只用于非插件/核心提供商，以及少数通用优先级场景，
  例如 Anthropic 以 API 密钥优先的新手引导。
- 提供商插件还可以通过以下机制接管提供商运行时行为：
  `resolveDynamicModel`、`prepareDynamicModel`、`normalizeResolvedModel`、
  `capabilities`、`prepareExtraParams`、`wrapStreamFn`、`formatApiKey`、
  `refreshOAuth`、`buildAuthDoctorHint`、
  `isCacheTtlEligible`、`buildMissingAuthMessage`、
  `suppressBuiltInModel`、`augmentModelCatalog`、`isBinaryThinking`、
  `supportsXHighThinking`、`resolveDefaultThinkingLevel`、
  `isModernModelRef`、`prepareRuntimeAuth`、`resolveUsageAuth`，以及
  `fetchUsageSnapshot`。

## 插件接管的提供商行为

提供商插件现在可以接管大多数提供商特定逻辑，而 OpenClaw 保留
通用推理循环。

典型划分：

- `auth[].run` / `auth[].runNonInteractive`：提供商接管 `openclaw onboard`、`openclaw models auth` 和无头设置的
  新手引导/登录流程
- `wizard.onboarding` / `wizard.modelPicker`：提供商接管新手引导/模型选择器中的身份验证选项标签、
  提示和设置条目
- `catalog`：提供商出现在 `models.providers` 中
- `resolveDynamicModel`：提供商接受尚未出现在本地静态
  目录中的模型 ID
- `prepareDynamicModel`：提供商在重试
  动态解析之前需要刷新元数据
- `normalizeResolvedModel`：提供商需要重写传输或基础 URL
- `capabilities`：提供商发布 transcript/工具/提供商家族的特殊行为
- `prepareExtraParams`：提供商为每个模型请求参数提供默认值或进行标准化
- `wrapStreamFn`：提供商应用请求头/请求体/模型兼容包装器
- `formatApiKey`：提供商将存储的 auth profile 格式化为
  传输层预期的运行时 `apiKey` 字符串
- `refreshOAuth`：当共享的 `pi-ai`
  刷新器不足时，由提供商接管 OAuth 刷新
- `buildAuthDoctorHint`：当 OAuth 刷新
  失败时，提供商附加修复指引
- `isCacheTtlEligible`：提供商决定哪些上游模型 ID 支持 prompt-cache TTL
- `buildMissingAuthMessage`：提供商用提供商特定的恢复提示
  替换通用 auth-store 错误
- `suppressBuiltInModel`：提供商隐藏过时的上游条目，并且可以在直接解析失败时返回
  供应商自有错误
- `augmentModelCatalog`：提供商在
  发现和配置合并后追加合成/最终目录条目
- `isBinaryThinking`：提供商接管二元开/关 thinking UX
- `supportsXHighThinking`：提供商让选定模型支持 `xhigh`
- `resolveDefaultThinkingLevel`：提供商接管某个
  模型家族默认 `/think` 策略
- `isModernModelRef`：提供商接管 live/smoke 首选模型匹配
- `prepareRuntimeAuth`：提供商将已配置凭证转换为短期
  运行时令牌
- `resolveUsageAuth`：提供商为 `/usage`
  以及相关状态/报告界面解析使用量/配额凭证
- `fetchUsageSnapshot`：提供商接管使用量端点的获取/解析，而核心仍负责摘要外壳和格式化

当前内置示例：

- `anthropic`：Claude 4.6 前向兼容回退、身份验证修复提示、使用量
  端点获取，以及 cache-TTL/提供商家族元数据
- `openrouter`：直通模型 ID、请求包装器、提供商能力
  提示，以及 cache-TTL 策略
- `github-copilot`：新手引导/设备登录、前向兼容模型回退、
  Claude-thinking transcript 提示、运行时令牌交换，以及使用量端点
  获取
- `openai`：GPT-5.4 前向兼容回退、直接 OpenAI 传输
  标准化、Codex 感知的缺失身份验证提示、Spark 抑制、合成
  OpenAI/Codex 目录条目、thinking/live-model 策略，以及
  提供商家族元数据
- `google` 和 `google-gemini-cli`：Gemini 3.1 前向兼容回退和
  现代模型匹配；Gemini CLI OAuth 还接管 auth-profile 令牌
  格式化、usage-token 解析，以及面向使用量界面的配额端点获取
- `moonshot`：共享传输、插件接管的 thinking 负载标准化
- `kilocode`：共享传输、插件接管的请求头、reasoning 负载
  标准化、Gemini transcript 提示，以及 cache-TTL 策略
- `zai`：GLM-5 前向兼容回退、`tool_stream` 默认值、cache-TTL
  策略、二元 thinking/live-model 策略，以及使用量身份验证 + 配额获取
- `mistral`、`opencode` 和 `opencode-go`：插件接管的能力元数据
- `byteplus`、`cloudflare-ai-gateway`、`huggingface`、`kimi-coding`、
  `modelstudio`、`nvidia`、`qianfan`、`synthetic`、`together`、`venice`、
  `vercel-ai-gateway` 和 `volcengine`：仅插件接管的目录
- `qwen-portal`：插件接管的目录、OAuth 登录和 OAuth 刷新
- `minimax` 和 `xiaomi`：插件接管的目录，以及使用量身份验证/快照逻辑

内置的 `openai` 插件现在接管两个提供商 ID：`openai` 和
`openai-codex`。

以上涵盖了仍适合 OpenClaw 常规传输的提供商。若某个提供商
需要完全自定义的请求执行器，那就是另一个更深层的扩展接口。

## API 密钥轮换

- 支持为选定提供商进行通用提供商轮换。
- 通过以下方式配置多个密钥：
  - `OPENCLAW_LIVE_<PROVIDER>_KEY`（单个 live 覆盖，最高优先级）
  - `<PROVIDER>_API_KEYS`（逗号或分号分隔列表）
  - `<PROVIDER>_API_KEY`（主密钥）
  - `<PROVIDER>_API_KEY_*`（编号列表，例如 `<PROVIDER>_API_KEY_1`）
- 对于 Google 提供商，还会包含 `GOOGLE_API_KEY` 作为回退。
- 密钥选择顺序会保留优先级并对值去重。
- 仅在速率限制响应时才会使用下一个密钥重试请求（例如 `429`、`rate_limit`、`quota`、`resource exhausted`）。
- 非速率限制失败会立即失败；不会尝试密钥轮换。
- 当所有候选密钥都失败时，将返回最后一次尝试的最终错误。

## 内置提供商（pi-ai 目录）

OpenClaw 附带 pi‑ai 目录。这些提供商**不需要**
`models.providers` 配置；只需设置身份验证 + 选择一个模型。

### OpenAI

- 提供商：`openai`
- 身份验证：`OPENAI_API_KEY`
- 可选轮换：`OPENAI_API_KEYS`、`OPENAI_API_KEY_1`、`OPENAI_API_KEY_2`，以及 `OPENCLAW_LIVE_OPENAI_KEY`（单个覆盖）
- 示例模型：`openai/gpt-5.4`、`openai/gpt-5.4-pro`
- CLI：`openclaw onboard --auth-choice openai-api-key`
- 默认传输为 `auto`（优先 WebSocket，SSE 回退）
- 通过 `agents.defaults.models["openai/<model>"].params.transport` 按模型覆盖（`"sse"`、`"websocket"` 或 `"auto"`）
- OpenAI Responses WebSocket 预热默认通过 `params.openaiWsWarmup` 启用（`true`/`false`）
- 可通过 `agents.defaults.models["openai/<model>"].params.serviceTier` 启用 OpenAI 优先处理
- 可通过 `agents.defaults.models["<provider>/<model>"].params.fastMode` 为每个模型启用 OpenAI 快速模式
- `openai/gpt-5.3-codex-spark` 在 OpenClaw 中被有意抑制，因为 live OpenAI API 会拒绝它；Spark 被视为仅限 Codex

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
}
```

### Anthropic

- 提供商：`anthropic`
- 身份验证：`ANTHROPIC_API_KEY` 或 `claude setup-token`
- 可选轮换：`ANTHROPIC_API_KEYS`、`ANTHROPIC_API_KEY_1`、`ANTHROPIC_API_KEY_2`，以及 `OPENCLAW_LIVE_ANTHROPIC_KEY`（单个覆盖）
- 示例模型：`anthropic/claude-opus-4-6`
- CLI：`openclaw onboard --auth-choice token`（粘贴 setup-token）或 `openclaw models auth paste-token --provider anthropic`
- 直接 API 密钥模型支持共享的 `/fast` 开关和 `params.fastMode`；OpenClaw 会将其映射到 Anthropic `service_tier`（`auto` 与 `standard_only`）
- 策略说明：setup-token 支持属于技术兼容性；Anthropic 过去曾阻止某些在 Claude Code 之外的订阅用法。请核实当前 Anthropic 条款，并根据你的风险承受能力做出决定。
- 建议：相比订阅 setup-token 身份验证，Anthropic API 密钥身份验证是更安全、也更推荐的路径。

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code（Codex）

- 提供商：`openai-codex`
- 身份验证：OAuth（ChatGPT）
- 示例模型：`openai-codex/gpt-5.4`
- CLI：`openclaw onboard --auth-choice openai-codex` 或 `openclaw models auth login --provider openai-codex`
- 默认传输为 `auto`（优先 WebSocket，SSE 回退）
- 通过 `agents.defaults.models["openai-codex/<model>"].params.transport` 按模型覆盖（`"sse"`、`"websocket"` 或 `"auto"`）
- 与直接 `openai/*` 共享相同的 `/fast` 开关和 `params.fastMode` 配置
- 当 Codex OAuth 目录暴露它时，`openai-codex/gpt-5.3-codex-spark` 仍然可用；取决于 entitlement
- 策略说明：OpenAI Codex OAuth 明确支持 OpenClaw 这样的外部工具/工作流。

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
}
```

### OpenCode

- 身份验证：`OPENCODE_API_KEY`（或 `OPENCODE_ZEN_API_KEY`）
- Zen 运行时提供商：`opencode`
- Go 运行时提供商：`opencode-go`
- 示例模型：`opencode/claude-opus-4-6`、`opencode-go/kimi-k2.5`
- CLI：`openclaw onboard --auth-choice opencode-zen` 或 `openclaw onboard --auth-choice opencode-go`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini（API 密钥）

- 提供商：`google`
- 身份验证：`GEMINI_API_KEY`
- 可选轮换：`GEMINI_API_KEYS`、`GEMINI_API_KEY_1`、`GEMINI_API_KEY_2`、`GOOGLE_API_KEY` 回退，以及 `OPENCLAW_LIVE_GEMINI_KEY`（单个覆盖）
- 示例模型：`google/gemini-3.1-pro-preview`、`google/gemini-3-flash-preview`
- 兼容性：使用 `google/gemini-3.1-flash-preview` 的旧版 OpenClaw 配置会被标准化为 `google/gemini-3-flash-preview`
- CLI：`openclaw onboard --auth-choice gemini-api-key`

### Google Vertex 和 Gemini CLI

- 提供商：`google-vertex`、`google-gemini-cli`
- 身份验证：Vertex 使用 gcloud ADC；Gemini CLI 使用其 OAuth 流程
- 注意：OpenClaw 中的 Gemini CLI OAuth 是非官方集成。一些用户报告在使用第三方客户端后遭遇 Google 账号限制。请查看 Google 条款，如果你决定继续，建议使用非关键账号。
- Gemini CLI OAuth 作为内置 `google` 插件的一部分提供。
  - 启用：`openclaw plugins enable google`
  - 登录：`openclaw models auth login --provider google-gemini-cli --set-default`
  - 注意：你**不需要**将客户端 ID 或密钥粘贴到 `openclaw.json` 中。CLI 登录流程会将
    令牌存储在 Gateway 网关主机上的 auth profile 中。

### Z.AI（GLM）

- 提供商：`zai`
- 身份验证：`ZAI_API_KEY`
- 示例模型：`zai/glm-5`
- CLI：`openclaw onboard --auth-choice zai-api-key`
  - 别名：`z.ai/*` 和 `z-ai/*` 会标准化为 `zai/*`

### Vercel AI Gateway

- 提供商：`vercel-ai-gateway`
- 身份验证：`AI_GATEWAY_API_KEY`
- 示例模型：`vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI：`openclaw onboard --auth-choice ai-gateway-api-key`

### Kilo Gateway

- 提供商：`kilocode`
- 身份验证：`KILOCODE_API_KEY`
- 示例模型：`kilocode/anthropic/claude-opus-4.6`
- CLI：`openclaw onboard --kilocode-api-key <key>`
- 基础 URL：`https://api.kilo.ai/api/gateway/`
- 扩展后的内置目录包括 GLM-5 Free、MiniMax M2.5 Free、GPT-5.2、Gemini 3 Pro Preview、Gemini 3 Flash Preview、Grok Code Fast 1 和 Kimi K2.5。

设置详情请参见 [/providers/kilocode](/providers/kilocode)。

### 其他内置提供商插件

- OpenRouter：`openrouter`（`OPENROUTER_API_KEY`）
- 示例模型：`openrouter/anthropic/claude-sonnet-4-5`
- Kilo Gateway：`kilocode`（`KILOCODE_API_KEY`）
- 示例模型：`kilocode/anthropic/claude-opus-4.6`
- MiniMax：`minimax`（`MINIMAX_API_KEY`）
- Moonshot：`moonshot`（`MOONSHOT_API_KEY`）
- Kimi Coding：`kimi-coding`（`KIMI_API_KEY` 或 `KIMICODE_API_KEY`）
- Qianfan：`qianfan`（`QIANFAN_API_KEY`）
- Model Studio：`modelstudio`（`MODELSTUDIO_API_KEY`）
- NVIDIA：`nvidia`（`NVIDIA_API_KEY`）
- Together：`together`（`TOGETHER_API_KEY`）
- Venice：`venice`（`VENICE_API_KEY`）
- Xiaomi：`xiaomi`（`XIAOMI_API_KEY`）
- Vercel AI Gateway：`vercel-ai-gateway`（`AI_GATEWAY_API_KEY`）
- Hugging Face Inference：`huggingface`（`HUGGINGFACE_HUB_TOKEN` 或 `HF_TOKEN`）
- Cloudflare AI Gateway：`cloudflare-ai-gateway`（`CLOUDFLARE_AI_GATEWAY_API_KEY`）
- Volcengine：`volcengine`（`VOLCANO_ENGINE_API_KEY`）
- BytePlus：`byteplus`（`BYTEPLUS_API_KEY`）
- xAI：`xai`（`XAI_API_KEY`）
- Mistral：`mistral`（`MISTRAL_API_KEY`）
- 示例模型：`mistral/mistral-large-latest`
- CLI：`openclaw onboard --auth-choice mistral-api-key`
- Groq：`groq`（`GROQ_API_KEY`）
- Cerebras：`cerebras`（`CEREBRAS_API_KEY`）
  - Cerebras 上的 GLM 模型使用 ID `zai-glm-4.7` 和 `zai-glm-4.6`。
  - OpenAI 兼容基础 URL：`https://api.cerebras.ai/v1`。
- GitHub Copilot：`github-copilot`（`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`）
- Hugging Face Inference 示例模型：`huggingface/deepseek-ai/DeepSeek-R1`；CLI：`openclaw onboard --auth-choice huggingface-api-key`。请参见 [Hugging Face（Inference）](/providers/huggingface)。

## 通过 `models.providers` 配置的提供商（自定义/基础 URL）

使用 `models.providers`（或 `models.json`）来添加**自定义**提供商或
兼容 OpenAI/Anthropic 的代理。

下面许多内置提供商插件已经发布了默认目录。
只有在你希望覆盖默认
基础 URL、请求头或模型列表时，才使用显式 `models.providers.<id>` 条目。

### Moonshot AI（Kimi）

Moonshot 使用兼容 OpenAI 的端点，因此将其配置为自定义提供商：

- 提供商：`moonshot`
- 身份验证：`MOONSHOT_API_KEY`
- 示例模型：`moonshot/kimi-k2.5`

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

- 提供商：`kimi-coding`
- 身份验证：`KIMI_API_KEY`
- 示例模型：`kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth（免费层）

Qwen 通过设备代码流程提供对 Qwen Coder + Vision 的 OAuth 访问。
内置提供商插件默认启用，因此只需登录：

```bash
openclaw models auth login --provider qwen-portal --set-default
```

模型引用：

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

设置详情和说明请参见 [/providers/qwen](/providers/qwen)。

### Volcano Engine（Doubao）

Volcano Engine（火山引擎）为中国用户提供对 Doubao 和其他模型的访问。

- 提供商：`volcengine`（编码：`volcengine-plan`）
- 身份验证：`VOLCANO_ENGINE_API_KEY`
- 示例模型：`volcengine/doubao-seed-1-8-251228`
- CLI：`openclaw onboard --auth-choice volcengine-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "volcengine/doubao-seed-1-8-251228" } },
  },
}
```

可用模型：

- `volcengine/doubao-seed-1-8-251228`（Doubao Seed 1.8）
- `volcengine/doubao-seed-code-preview-251028`
- `volcengine/kimi-k2-5-260127`（Kimi K2.5）
- `volcengine/glm-4-7-251222`（GLM 4.7）
- `volcengine/deepseek-v3-2-251201`（DeepSeek V3.2 128K）

编码模型（`volcengine-plan`）：

- `volcengine-plan/ark-code-latest`
- `volcengine-plan/doubao-seed-code`
- `volcengine-plan/kimi-k2.5`
- `volcengine-plan/kimi-k2-thinking`
- `volcengine-plan/glm-4.7`

### BytePlus（国际版）

BytePlus ARK 为国际用户提供与 Volcano Engine 相同模型的访问。

- 提供商：`byteplus`（编码：`byteplus-plan`）
- 身份验证：`BYTEPLUS_API_KEY`
- 示例模型：`byteplus/seed-1-8-251228`
- CLI：`openclaw onboard --auth-choice byteplus-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "byteplus/seed-1-8-251228" } },
  },
}
```

可用模型：

- `byteplus/seed-1-8-251228`（Seed 1.8）
- `byteplus/kimi-k2-5-260127`（Kimi K2.5）
- `byteplus/glm-4-7-251222`（GLM 4.7）

编码模型（`byteplus-plan`）：

- `byteplus-plan/ark-code-latest`
- `byteplus-plan/doubao-seed-code`
- `byteplus-plan/kimi-k2.5`
- `byteplus-plan/kimi-k2-thinking`
- `byteplus-plan/glm-4.7`

### Synthetic

Synthetic 通过 `synthetic` 提供商提供兼容 Anthropic 的模型：

- 提供商：`synthetic`
- 身份验证：`SYNTHETIC_API_KEY`
- 示例模型：`synthetic/hf:MiniMaxAI/MiniMax-M2.5`
- CLI：`openclaw onboard --auth-choice synthetic-api-key`

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

MiniMax 通过 `models.providers` 配置，因为它使用自定义端点：

- MiniMax（兼容 Anthropic）：`--auth-choice minimax-api`
- 身份验证：`MINIMAX_API_KEY`

设置详情、模型选项和配置片段请参见 [/providers/minimax](/providers/minimax)。

### Ollama

Ollama 作为内置提供商插件提供，并使用 Ollama 的原生 API：

- 提供商：`ollama`
- 身份验证：无需（本地服务器）
- 示例模型：`ollama/llama3.3`
- 安装：[https://ollama.com/download](https://ollama.com/download)

```bash
# 安装 Ollama，然后拉取一个模型：
ollama pull llama3.3
```

```json5
{
  agents: {
    defaults: { model: { primary: "ollama/llama3.3" } },
  },
}
```

当你通过
`OLLAMA_API_KEY` 选择加入时，Ollama 会在本地 `http://127.0.0.1:11434` 被检测到，内置提供商插件会将 Ollama 直接添加到
`openclaw onboard` 和模型选择器中。有关新手引导、云端/本地模式和自定义配置，请参见 [/providers/ollama](/providers/ollama)。

### vLLM

vLLM 作为内置提供商插件提供，用于本地/自托管的 OpenAI 兼容
服务器：

- 提供商：`vllm`
- 身份验证：可选（取决于你的服务器）
- 默认基础 URL：`http://127.0.0.1:8000/v1`

要选择加入本地自动发现（如果你的服务器不强制身份验证，则任意值均可）：

```bash
export VLLM_API_KEY="vllm-local"
```

然后设置一个模型（替换为 `/v1/models` 返回的某个 ID）：

```json5
{
  agents: {
    defaults: { model: { primary: "vllm/your-model-id" } },
  },
}
```

详情请参见 [/providers/vllm](/providers/vllm)。

### SGLang

SGLang 作为内置提供商插件提供，用于高速自托管
OpenAI 兼容服务器：

- 提供商：`sglang`
- 身份验证：可选（取决于你的服务器）
- 默认基础 URL：`http://127.0.0.1:30000/v1`

要选择加入本地自动发现（如果你的服务器不
强制身份验证，则任意值均可）：

```bash
export SGLANG_API_KEY="sglang-local"
```

然后设置一个模型（替换为 `/v1/models` 返回的某个 ID）：

```json5
{
  agents: {
    defaults: { model: { primary: "sglang/your-model-id" } },
  },
}
```

详情请参见 [/providers/sglang](/providers/sglang)。

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

说明：

- 对于自定义提供商，`reasoning`、`input`、`cost`、`contextWindow` 和 `maxTokens` 是可选的。
  如果省略，OpenClaw 默认使用：
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- 建议：设置与你的代理/模型限制匹配的显式值。
- 对于非原生端点上的 `api: "openai-completions"`（任何主机不是 `api.openai.com` 的非空 `baseUrl`），OpenClaw 会强制设置 `compat.supportsDeveloperRole: false`，以避免提供商因不支持 `developer` 角色而返回 400 错误。
- 如果 `baseUrl` 为空/省略，OpenClaw 会保留默认 OpenAI 行为（即解析为 `api.openai.com`）。
- 出于安全考虑，在非原生 `openai-completions` 端点上，显式的 `compat.supportsDeveloperRole: true` 仍会被覆盖。

## CLI 示例

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

另请参见：[/gateway/configuration](/gateway/configuration) 了解完整配置示例。
