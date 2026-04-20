---
summary: "模型提供程序概述，包含示例配置和CLI流程"
read_when:
  - 你需要按提供程序分类的模型设置参考
  - 你想要模型提供程序的示例配置或CLI入职命令
title: "模型提供程序"
---

# 模型提供程序

本页涵盖**LLM/模型提供程序**（不是WhatsApp/Telegram等聊天频道）。
有关模型选择规则，请参阅[/concepts/models](/concepts/models)。

## 快速规则

- 模型引用使用`provider/model`（示例：`opencode/claude-opus-4-6`）。
- 如果你设置了`agents.defaults.models`，它将成为允许列表。
- CLI帮助工具：`openclaw onboard`、`openclaw models list`、`openclaw models set <provider/model>`。
- 回退运行时规则、冷却探测和会话覆盖持久化在[/concepts/model-failover](/concepts/model-failover)中有记录。
- `models.providers.*.models[].contextWindow`是原生模型元数据；
  `models.providers.*.models[].contextTokens`是有效的运行时上限。
- 提供程序插件可以通过`registerProvider({ catalog })`注入模型目录；
  OpenClaw在写入`models.json`之前将该输出合并到`models.providers`中。
- 提供程序清单可以声明`providerAuthEnvVars`和
  `providerAuthAliases`，以便通用的基于环境的身份验证探测和提供程序变体
  不需要加载插件运行时。剩余的核心环境变量映射现在仅用于非插件/核心提供程序以及一些通用优先级情况，例如Anthropic API密钥优先入职。
- 提供程序插件还可以通过以下方式拥有提供程序运行时行为：
  `normalizeModelId`、`normalizeTransport`、`normalizeConfig`、
  `applyNativeStreamingUsageCompat`、`resolveConfigApiKey`、
  `resolveSyntheticAuth`、`shouldDeferSyntheticProfileAuth`、
  `resolveDynamicModel`、`prepareDynamicModel`、
  `normalizeResolvedModel`、`contributeResolvedModelCompat`、
  `capabilities`、`normalizeToolSchemas`、
  `inspectToolSchemas`、`resolveReasoningOutputMode`、
  `prepareExtraParams`、`createStreamFn`、`wrapStreamFn`、
  `resolveTransportTurnState`、`resolveWebSocketSessionPolicy`、
  `createEmbeddingProvider`、`formatApiKey`、`refreshOAuth`、
  `buildAuthDoctorHint`、
  `matchesContextOverflowError`、`classifyFailoverReason`、
  `isCacheTtlEligible`、`buildMissingAuthMessage`、`suppressBuiltInModel`、
  `augmentModelCatalog`、`isBinaryThinking`、`supportsXHighThinking`、
  `resolveDefaultThinkingLevel`、`applyConfigDefaults`、`isModernModelRef`、
  `prepareRuntimeAuth`、`resolveUsageAuth`、`fetchUsageSnapshot`和
  `onModelSelected`。
- 注意：提供程序运行时`capabilities`是共享运行器元数据（提供程序
  系列、记录/工具怪癖、传输/缓存提示）。它与[公共能力模型](/plugins/architecture#public-capability-model)不同，
  后者描述了插件注册的内容（文本推理、语音等）。
- 捆绑的`codex`提供程序与捆绑的Codex代理框架配对。
  当你想要Codex拥有的登录、模型发现、原生
  线程恢复和应用服务器执行时，使用`codex/gpt-*`。普通的`openai/gpt-*`引用继续
  使用OpenAI提供程序和正常的OpenClaw提供程序传输。
  仅Codex部署可以使用
  `agents.defaults.embeddedHarness.fallback: "none"`禁用自动PI回退；请参阅
  [Codex框架](/plugins/codex-harness)。

## 插件拥有的提供程序行为

提供程序插件现在可以拥有大多数提供程序特定的逻辑，而OpenClaw保持通用推理循环。

典型分工：

- `auth[].run` / `auth[].runNonInteractive`：提供程序拥有`openclaw onboard`、`openclaw models auth`和无头设置的入职/登录流程
- `wizard.setup` / `wizard.modelPicker`：提供程序拥有身份验证选择标签、旧别名、入职允许列表提示以及入职/模型选择器中的设置条目
- `catalog`：提供程序出现在`models.providers`中
- `normalizeModelId`：提供程序在查找或规范化之前标准化旧/预览模型ID
- `normalizeTransport`：提供程序在通用模型组装之前标准化传输系列`api` / `baseUrl`；OpenClaw首先检查匹配的提供程序，然后检查其他具有钩子能力的提供程序插件，直到有一个实际更改传输
- `normalizeConfig`：提供程序在运行时使用之前标准化`models.providers.<id>`配置；OpenClaw首先检查匹配的提供程序，然后检查其他具有钩子能力的提供程序插件，直到有一个实际更改配置。如果没有提供程序钩子重写配置，捆绑的Google系列助手仍然会标准化支持的Google提供程序条目。
- `applyNativeStreamingUsageCompat`：提供程序为配置提供程序应用端点驱动的原生流式传输使用兼容重写
- `resolveConfigApiKey`：提供程序为配置提供程序解析环境标记身份验证，而不强制完全运行时身份验证加载。`amazon-bedrock`在这里也有一个内置的AWS环境标记解析器，即使Bedrock运行时身份验证使用AWS SDK默认链。
- `resolveSyntheticAuth`：提供程序可以公开本地/自托管或其他基于配置的身份验证可用性，而不持久化明文密钥
- `shouldDeferSyntheticProfileAuth`：提供程序可以将存储的合成配置文件占位符标记为比基于环境/配置的身份验证优先级更低
- `resolveDynamicModel`：提供程序接受尚未在本地静态目录中存在的模型ID
- `prepareDynamicModel`：提供程序在重试动态解析之前需要元数据刷新
- `normalizeResolvedModel`：提供程序需要传输或基本URL重写
- `contributeResolvedModelCompat`：提供程序为其供应商模型贡献兼容标志，即使它们通过另一个兼容的传输到达
- `capabilities`：提供程序发布记录/工具/提供程序系列怪癖
- `normalizeToolSchemas`：提供程序在嵌入式运行器看到工具模式之前清理它们
- `inspectToolSchemas`：提供程序在标准化后显示传输特定的模式警告
- `resolveReasoningOutputMode`：提供程序选择原生vs标记推理输出契约
- `prepareExtraParams`：提供程序默认或标准化每个模型的请求参数
- `createStreamFn`：提供程序用完全自定义的传输替换正常的流路径
- `wrapStreamFn`：提供程序应用请求头/正文/模型兼容包装器
- `resolveTransportTurnState`：提供程序提供每回合原生传输头或元数据
- `resolveWebSocketSessionPolicy`：提供程序提供原生WebSocket会话头或会话冷却策略
- `createEmbeddingProvider`：当提供程序插件而不是核心嵌入总机拥有内存嵌入行为时
- `formatApiKey`：提供程序将存储的身份验证配置文件格式化为传输期望的运行时`apiKey`字符串
- `refreshOAuth`：当共享的`pi-ai`刷新器不足时，提供程序拥有OAuth刷新
- `buildAuthDoctorHint`：当OAuth刷新失败时，提供程序附加修复指导
- `matchesContextOverflowError`：提供程序识别通用启发式会错过的提供程序特定上下文窗口溢出错误
- `classifyFailoverReason`：提供程序将提供程序特定的原始传输/API错误映射到故障转移原因，如速率限制或过载
- `isCacheTtlEligible`：提供程序决定哪些上游模型ID支持提示缓存TTL
- `buildMissingAuthMessage`：提供程序用提供程序特定的恢复提示替换通用身份验证存储错误
- `suppressBuiltInModel`：提供程序隐藏过时的上游行，并可以为直接解析失败返回供应商拥有的错误
- `augmentModelCatalog`：提供程序在发现和配置合并后附加合成/最终目录行
- `isBinaryThinking`：提供程序拥有二进制开/关思考UX
- `supportsXHighThinking`：提供程序选择模型进入`xhigh`
- `resolveDefaultThinkingLevel`：提供程序为模型系列拥有默认`/think`策略
- `applyConfigDefaults`：提供程序基于身份验证模式、环境或模型系列在配置实例化期间应用提供程序特定的全局默认值
- `isModernModelRef`：提供程序拥有实时/烟雾首选模型匹配
- `prepareRuntimeAuth`：提供程序将配置的凭据转换为短期运行时令牌
- `resolveUsageAuth`：提供程序为`/usage`和相关状态/报告表面解析使用/配额凭据
- `fetchUsageSnapshot`：提供程序拥有使用端点获取/解析，而核心仍然拥有摘要外壳和格式
- `onModelSelected`：提供程序运行选择后副作用，如遥测或提供程序拥有的会话记账

当前捆绑示例：

- `anthropic`：Claude 4.6前向兼容回退、身份验证修复提示、使用端点获取、缓存TTL/提供程序系列元数据，以及身份验证感知的全局配置默认值
- `amazon-bedrock`：提供程序拥有的上下文溢出匹配和Bedrock特定节流/未就绪错误的故障转移原因分类，以及Anthropic流量上Claude专用重放策略保护的共享`anthropic-by-model`重放系列
- `anthropic-vertex`：Anthropic消息流量上的Claude专用重放策略保护
- `openrouter`：传递模型ID、请求包装器、提供程序能力提示、代理Gemini流量上的Gemini思想签名清理、通过`openrouter-thinking`流系列的代理推理注入、路由元数据转发，以及缓存TTL策略
- `github-copilot`：入职/设备登录、前向兼容模型回退、Claude思考记录提示、运行时令牌交换，以及使用端点获取
- `openai`：GPT-5.4前向兼容回退、直接OpenAI传输标准化、Codex感知的缺失身份验证提示、Spark抑制、合成OpenAI/Codex目录行、思考/实时模型策略、使用令牌别名标准化（`input` / `output`和`prompt` / `completion`系列）、原生OpenAI/Codex包装器的共享`openai-responses-defaults`流系列、提供程序系列元数据、`gpt-image-1`的捆绑图像生成提供程序注册，以及`sora-2`的捆绑视频生成提供程序注册
- `google`和`google-gemini-cli`：Gemini 3.1前向兼容回退、原生Gemini重放验证、引导重放清理、标记推理输出模式、现代模型匹配、Gemini图像预览模型的捆绑图像生成提供程序注册，以及Veo模型的捆绑视频生成提供程序注册；Gemini CLI OAuth还拥有身份验证配置文件令牌格式化、使用令牌解析，以及使用表面的配额端点获取
- `moonshot`：共享传输，插件拥有的思考有效载荷标准化
- `kilocode`：共享传输、插件拥有的请求头、推理有效载荷标准化、代理Gemini思想签名清理，以及缓存TTL策略
- `zai`：GLM-5前向兼容回退、`tool_stream`默认值、缓存TTL策略、二进制思考/实时模型策略，以及使用身份验证+配额获取；未知的`glm-5*` ID从捆绑的`glm-4.7`模板合成
- `xai`：原生Responses传输标准化、Grok快速变体的`/fast`别名重写、默认`tool_stream`、xAI特定的工具模式/推理有效载荷清理，以及`grok-imagine-video`的捆绑视频生成提供程序注册
- `mistral`：插件拥有的能力元数据
- `opencode`和`opencode-go`：插件拥有的能力元数据加上代理Gemini思想签名清理
- `alibaba`：插件拥有的视频生成目录，用于直接Wan模型引用，如`alibaba/wan2.6-t2v`
- `byteplus`：插件拥有的目录加上Wan模型的捆绑视频生成提供程序注册
- `fal`：托管第三方图像生成提供程序注册，用于FLUX图像模型，加上托管第三方视频模型的捆绑视频生成提供程序注册
- `cloudflare-ai-gateway`、`huggingface`、`kimi`、`nvidia`、`qianfan`、`stepfun`、`synthetic`、`venice`、`vercel-ai-gateway`和`volcengine`：仅插件拥有的目录
- `qwen`：文本模型的插件拥有的目录，加上其多模态表面的共享媒体理解和视频生成提供程序注册；Qwen视频生成使用标准DashScope视频端点，捆绑Wan模型如`wan2.6-t2v`和`wan2.7-r2v`
- `runway`：原生Runway基于任务的模型的插件拥有的视频生成提供程序注册，如`gen4.5`
- `minimax`：插件拥有的目录、Hailuo视频模型的捆绑视频生成提供程序注册、`image-01`的捆绑图像生成提供程序注册、混合Anthropic/OpenAI重放策略选择，以及使用身份验证/快照逻辑
- `together`：插件拥有的目录加上Wan视频模型的捆绑视频生成提供程序注册
- `xiaomi`：插件拥有的目录加上使用身份验证/快照逻辑

捆绑的`openai`插件现在拥有两个提供程序ID：`openai`和`openai-codex`。

这涵盖了仍适合OpenClaw正常传输的提供程序。需要完全自定义请求执行器的提供程序是一个单独的、更深层次的扩展表面。

## API密钥轮换

- 支持选定提供程序的通用提供程序轮换。
- 通过以下方式配置多个密钥：
  - `OPENCLAW_LIVE_<PROVIDER>_KEY`（单个实时覆盖，最高优先级）
  - `<PROVIDER>_API_KEYS`（逗号或分号列表）
  - `<PROVIDER>_API_KEY`（主密钥）
  - `<PROVIDER>_API_KEY_*`（编号列表，例如`<PROVIDER>_API_KEY_1`）
- 对于Google提供程序，`GOOGLE_API_KEY`也作为回退包含。
- 密钥选择顺序保持优先级并对值进行去重。
- 仅在速率限制响应时（例如`429`、`rate_limit`、`quota`、`resource exhausted`、`Too many concurrent requests`、`ThrottlingException`、`concurrency limit reached`、`workers_ai ... quota limit exceeded`或周期性使用限制消息）才会使用下一个密钥重试请求。
- 非速率限制故障立即失败；不尝试密钥轮换。
- 当所有候选密钥失败时，最终错误从最后一次尝试返回。

## 内置提供程序（pi-ai目录）

OpenClaw附带pi‑ai目录。这些提供程序**不需要**`models.providers`配置；只需设置身份验证+选择模型。

### OpenAI

- 提供程序：`openai`
- 身份验证：`OPENAI_API_KEY`
- 可选轮换：`OPENAI_API_KEYS`、`OPENAI_API_KEY_1`、`OPENAI_API_KEY_2`，加上`OPENCLAW_LIVE_OPENAI_KEY`（单个覆盖）
- 示例模型：`openai/gpt-5.4`、`openai/gpt-5.4-pro`
- CLI：`openclaw onboard --auth-choice openai-api-key`
- 默认传输是`auto`（WebSocket优先，SSE回退）
- 通过`agents.defaults.models["openai/<model>"].params.transport`覆盖每个模型（`"sse"`、`"websocket"`或`"auto"`）
- OpenAI Responses WebSocket预热默认通过`params.openaiWsWarmup`启用（`true`/`false`）
- OpenAI优先级处理可以通过`agents.defaults.models["openai/<model>"].params.serviceTier`启用
- `/fast`和`params.fastMode`将直接的`openai/*` Responses请求映射到`api.openai.com`上的`service_tier=priority`
- 当你想要显式层级而不是共享的`/fast`切换时，使用`params.serviceTier`
- 隐藏的OpenClaw归因头（`originator`、`version`、`User-Agent`）仅适用于`api.openai.com`上的原生OpenAI流量，不适用于通用OpenAI兼容代理
- 原生OpenAI路由还保留Responses `store`、提示缓存提示和OpenAI推理兼容有效载荷整形；代理路由不保留
- `openai/gpt-5.3-codex-spark`在OpenClaw中被有意抑制，因为实时OpenAI API会拒绝它；Spark被视为仅Codex

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
}
```

### Anthropic

- 提供程序：`anthropic`
- 身份验证：`ANTHROPIC_API_KEY`
- 可选轮换：`ANTHROPIC_API_KEYS`、`ANTHROPIC_API_KEY_1`、`ANTHROPIC_API_KEY_2`，加上`OPENCLAW_LIVE_ANTHROPIC_KEY`（单个覆盖）
- 示例模型：`anthropic/claude-opus-4-6`
- CLI：`openclaw onboard --auth-choice apiKey`
- 直接公开Anthropic请求支持共享的`/fast`切换和`params.fastMode`，包括发送到`api.anthropic.com`的API密钥和OAuth认证流量；OpenClaw将其映射到Anthropic `service_tier`（`auto` vs `standard_only`）
- Anthropic注意：Anthropic工作人员告诉我们，OpenClaw风格的Claude CLI使用再次被允许，因此OpenClaw将Claude CLI重用和`claude -p`使用视为此集成的批准，除非Anthropic发布新政策。
- Anthropic设置令牌仍然作为支持的OpenClaw令牌路径可用，但OpenClaw现在更喜欢Claude CLI重用和`claude -p`（如果可用）。

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code（Codex）

- 提供程序：`openai-codex`
- 身份验证：OAuth（ChatGPT）
- 示例模型：`openai-codex/gpt-5.4`
- CLI：`openclaw onboard --auth-choice openai-codex`或`openclaw models auth login --provider openai-codex`
- 默认传输是`auto`（WebSocket优先，SSE回退）
- 通过`agents.defaults.models["openai-codex/<model>"].params.transport`覆盖每个模型（`"sse"`、`"websocket"`或`"auto"`）
- `params.serviceTier`也在原生Codex Responses请求（`chatgpt.com/backend-api`）上转发
- 隐藏的OpenClaw归因头（`originator`、`version`、`User-Agent`）仅附加在`chatgpt.com/backend-api`上的原生Codex流量上，不适用于通用OpenAI兼容代理
- 与直接`openai/*`共享相同的`/fast`切换和`params.fastMode`配置；OpenClaw将其映射到`service_tier=priority`
- `openai-codex/gpt-5.3-codex-spark`在Codex OAuth目录公开时仍然可用；取决于权限
- `openai-codex/gpt-5.4`保持原生`contextWindow = 1050000`和默认运行时`contextTokens = 272000`；使用`models.providers.openai-codex.models[].contextTokens`覆盖运行时上限
- 政策说明：OpenAI Codex OAuth明确支持OpenClaw等外部工具/工作流。

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
}
```

```json5
{
  models: {
    providers: {
      "openai-codex": {
        models: [{ id: "gpt-5.4", contextTokens: 160000 }],
      },
    },
  },
}
```

### 其他订阅式托管选项

- [Qwen Cloud](/providers/qwen)：Qwen Cloud提供程序表面加上阿里云DashScope和Coding Plan端点映射
- [MiniMax](/providers/minimax)：MiniMax Coding Plan OAuth或API密钥访问
- [GLM Models](/providers/glm)：Z.AI Coding Plan或通用API端点

### OpenCode

- 身份验证：`OPENCODE_API_KEY`（或`OPENCODE_ZEN_API_KEY`）
- Zen运行时提供程序：`opencode`
- Go运行时提供程序：`opencode-go`
- 示例模型：`opencode/claude-opus-4-6`、`opencode-go/kimi-k2.5`
- CLI：`openclaw onboard --auth-choice opencode-zen`或`openclaw onboard --auth-choice opencode-go`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini（API密钥）

- 提供程序：`google`
- 身份验证：`GEMINI_API_KEY`
- 可选轮换：`GEMINI_API_KEYS`、`GEMINI_API_KEY_1`、`GEMINI_API_KEY_2`、`GOOGLE_API_KEY`回退，以及`OPENCLAW_LIVE_GEMINI_KEY`（单个覆盖）
- 示例模型：`google/gemini-3.1-pro-preview`、`google/gemini-3-flash-preview`
- 兼容性：使用`google/gemini-3.1-flash-preview`的旧OpenClaw配置被标准化为`google/gemini-3-flash-preview`
- CLI：`openclaw onboard --auth-choice gemini-api-key`
- 直接Gemini运行也接受`agents.defaults.models["google/<model>"].params.cachedContent`（或旧的`cached_content`）转发提供程序原生的`cachedContents/...`句柄；Gemini缓存命中显示为OpenClaw `cacheRead`

### Google Vertex和Gemini CLI

- 提供程序：`google-vertex`、`google-gemini-cli`
- 身份验证：Vertex使用gcloud ADC；Gemini CLI使用其OAuth流程
- 注意：OpenClaw中的Gemini CLI OAuth是一个非官方集成。一些用户报告在使用第三方客户端后Google账户受到限制。请查看Google条款，如果选择继续，请使用非关键账户。
- Gemini CLI OAuth作为捆绑`google`插件的一部分提供。
  - 首先安装Gemini CLI：
    - `brew install gemini-cli`
    - 或`npm install -g @google/gemini-cli`
  - 启用：`openclaw plugins enable google`
  - 登录：`openclaw models auth login --provider google-gemini-cli --set-default`
  - 默认模型：`google-gemini-cli/gemini-3-flash-preview`
  - 注意：你**不需要**将客户端ID或密钥粘贴到`openclaw.json`中。CLI登录流程将令牌存储在网关主机上的身份验证配置文件中。
  - 如果登录后请求失败，请在网关主机上设置`GOOGLE_CLOUD_PROJECT`或`GOOGLE_CLOUD_PROJECT_ID`。
  - Gemini CLI JSON回复从`response`解析；使用回退到`stats`，`stats.cached`被标准化为OpenClaw `cacheRead`。

### Z.AI (GLM)

- 提供程序：`zai`
- 身份验证：`ZAI_API_KEY`
- 示例模型：`zai/glm-5.1`
- CLI：`openclaw onboard --auth-choice zai-api-key`
  - 别名：`z.ai/*`和`z-ai/*`标准化为`zai/*`
  - `zai-api-key`自动检测匹配的Z.AI端点；`zai-coding-global`、`zai-coding-cn`、`zai-global`和`zai-cn`强制特定表面

### Vercel AI Gateway

- 提供程序：`vercel-ai-gateway`
- 身份验证：`AI_GATEWAY_API_KEY`
- 示例模型：`vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI：`openclaw onboard --auth-choice ai-gateway-api-key`

### Kilo Gateway

- 提供程序：`kilocode`
- 身份验证：`KILOCODE_API_KEY`
- 示例模型：`kilocode/kilo/auto`
- CLI：`openclaw onboard --auth-choice kilocode-api-key`
- 基本URL：`https://api.kilo.ai/api/gateway/`
- 静态回退目录提供`kilocode/kilo/auto`；实时`https://api.kilo.ai/api/gateway/models`发现可以进一步扩展运行时目录。
- `kilocode/kilo/auto`背后的精确上游路由由Kilo Gateway拥有，而不是在OpenClaw中硬编码。

请参阅[/providers/kilocode](/providers/kilocode)了解设置详情。

### 其他捆绑提供程序插件

- OpenRouter：`openrouter`（`OPENROUTER_API_KEY`）
- 示例模型：`openrouter/auto`
- 当请求实际针对`openrouter.ai`时，OpenClaw才应用OpenRouter文档化的应用归因头
- OpenRouter特定的Anthropic `cache_control`标记同样仅限于已验证的OpenRouter路由，而不是任意代理URL
- OpenRouter仍然使用代理风格的OpenAI兼容路径，因此原生OpenAI专用请求整形（`serviceTier`、Responses `store`、提示缓存提示、OpenAI推理兼容有效载荷）不会被转发
- Gemini支持的OpenRouter引用仅保留代理Gemini思想签名清理；原生Gemini重放验证和引导重写保持关闭
- Kilo Gateway：`kilocode`（`KILOCODE_API_KEY`）
- 示例模型：`kilocode/kilo/auto`
- Gemini支持的Kilo引用保持相同的代理Gemini思想签名清理路径；`kilocode/kilo/auto`和其他不支持代理推理的提示跳过代理推理注入
- MiniMax：`minimax`（API密钥）和`minimax-portal`（OAuth）
- 身份验证：`MINIMAX_API_KEY`用于`minimax`；`MINIMAX_OAUTH_TOKEN`或`MINIMAX_API_KEY`用于`minimax-portal`
- 示例模型：`minimax/MiniMax-M2.7`或`minimax-portal/MiniMax-M2.7`
- MiniMax入职/API密钥设置写入带有`input: ["text", "image"]`的显式M2.7模型定义；捆绑的提供程序目录保持聊天引用仅文本，直到该提供程序配置被实例化
- Moonshot：`moonshot`（`MOONSHOT_API_KEY`）
- 示例模型：`moonshot/kimi-k2.5`
- Kimi Coding：`kimi`（`KIMI_API_KEY`或`KIMICODE_API_KEY`）
- 示例模型：`kimi/kimi-code`
- Qianfan：`qianfan`（`QIANFAN_API_KEY`）
- 示例模型：`qianfan/deepseek-v3.2`
- Qwen Cloud：`qwen`（`QWEN_API_KEY`、`MODELSTUDIO_API_KEY`或`DASHSCOPE_API_KEY`）
- 示例模型：`qwen/qwen3.5-plus`
- NVIDIA：`nvidia`（`NVIDIA_API_KEY`）
- 示例模型：`nvidia/nvidia/llama-3.1-nemotron-70b-instruct`
- StepFun：`stepfun` / `stepfun-plan`（`STEPFUN_API_KEY`）
- 示例模型：`stepfun/step-3.5-flash`、`stepfun-plan/step-3.5-flash-2603`
- Together：`together`（`TOGETHER_API_KEY`）
- 示例模型：`together/moonshotai/Kimi-K2.5`
- Venice：`venice`（`VENICE_API_KEY`）
- Xiaomi：`xiaomi`（`XIAOMI_API_KEY`）
- 示例模型：`xiaomi/mimo-v2-flash`
- Vercel AI Gateway：`vercel-ai-gateway`（`AI_GATEWAY_API_KEY`）
- Hugging Face Inference：`huggingface`（`HUGGINGFACE_HUB_TOKEN`或`HF_TOKEN`）
- Cloudflare AI Gateway：`cloudflare-ai-gateway`（`CLOUDFLARE_AI_GATEWAY_API_KEY`）
- Volcengine：`volcengine`（`VOLCANO_ENGINE_API_KEY`）
- 示例模型：`volcengine-plan/ark-code-latest`
- BytePlus：`byteplus`（`BYTEPLUS_API_KEY`）
- 示例模型：`byteplus-plan/ark-code-latest`
- xAI：`xai`（`XAI_API_KEY`）
  - 原生捆绑xAI请求使用xAI Responses路径
  - `/fast`或`params.fastMode: true`将`grok-3`、`grok-3-mini`、`grok-4`和`grok-4-0709`重写为它们的`*-fast`变体
  - `tool_stream`默认开启；设置`agents.defaults.models["xai/<model>"].params.tool_stream`为`false`以禁用
- Mistral：`mistral`（`MISTRAL_API_KEY`）
- 示例模型：`mistral/mistral-large-latest`
- CLI：`openclaw onboard --auth-choice mistral-api-key`
- Groq：`groq`（`GROQ_API_KEY`）
- Cerebras：`cerebras`（`CEREBRAS_API_KEY`）
  - Cerebras上的GLM模型使用ID `zai-glm-4.7`和`zai-glm-4.6`。
  - OpenAI兼容基本URL：`https://api.cerebras.ai/v1`。
- GitHub Copilot：`github-copilot`（`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`）
- Hugging Face Inference示例模型：`huggingface/deepseek-ai/DeepSeek-R1`；CLI：`openclaw onboard --auth-choice huggingface-api-key`。请参阅[Hugging Face (Inference)](/providers/huggingface)。

## 通过`models.providers`的提供程序（自定义/基本URL）

使用`models.providers`（或`models.json`）添加**自定义**提供程序或OpenAI/Anthropic兼容代理。

下面的许多捆绑提供程序插件已经发布默认目录。仅当你想要覆盖默认基本URL、头或模型列表时，才使用显式`models.providers.<id>`条目。

### Moonshot AI (Kimi)

Moonshot作为捆绑提供程序插件提供。默认使用内置提供程序，仅在需要覆盖基本URL或模型元数据时添加显式`models.providers.moonshot`条目：

- 提供程序：`moonshot`
- 身份验证：`MOONSHOT_API_KEY`
- 示例模型：`moonshot/kimi-k2.5`
- CLI：`openclaw onboard --auth-choice moonshot-api-key`或`openclaw onboard --auth-choice moonshot-api-key-cn`

Kimi K2模型ID：

[//]: # "moonshot-kimi-k2-model-refs:start"

- `moonshot/kimi-k2.5`
- `moonshot/kimi-k2-thinking`
- `moonshot/kimi-k2-thinking-turbo`
- `moonshot/kimi-k2-turbo`

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

Kimi Coding使用Moonshot AI的Anthropic兼容端点：

- 提供程序：`kimi`
- 身份验证：`KIMI_API_KEY`
- 示例模型：`kimi/kimi-code`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi/kimi-code" } },
  },
}
```

旧的`kimi/k2p5`仍然作为兼容模型ID被接受。

### Volcano Engine (Doubao)

Volcano Engine（火山引擎）在中国提供对Doubao和其他模型的访问。

- 提供程序：`volcengine`（编码：`volcengine-plan`）
- 身份验证：`VOLCANO_ENGINE_API_KEY`
- 示例模型：`volcengine-plan/ark-code-latest`
- CLI：`openclaw onboard --auth-choice volcengine-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "volcengine-plan/ark-code-latest" } },
  },
}
```

入职默认为编码表面，但同时注册通用`volcengine/*`目录。

在入职/配置模型选择器中，Volcengine身份验证选择优先考虑`volcengine/*`和`volcengine-plan/*`行。如果这些模型尚未加载，OpenClaw会回退到未过滤的目录，而不是显示空的提供程序范围选择器。

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

### BytePlus (国际)

BytePlus ARK为国际用户提供与Volcano Engine相同的模型。

- 提供程序：`byteplus`（编码：`byteplus-plan`）
- 身份验证：`BYTEPLUS_API_KEY`
- 示例模型：`byteplus-plan/ark-code-latest`
- CLI：`openclaw onboard --auth-choice byteplus-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "byteplus-plan/ark-code-latest" } },
  },
}
```

入职默认为编码表面，但同时注册通用`byteplus/*`目录。

在入职/配置模型选择器中，BytePlus身份验证选择优先考虑`byteplus/*`和`byteplus-plan/*`行。如果这些模型尚未加载，OpenClaw会回退到未过滤的目录，而不是显示空的提供程序范围选择器。

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

Synthetic在`synthetic`提供程序后面提供Anthropic兼容模型：

- 提供程序：`synthetic`
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

MiniMax通过`models.providers`配置，因为它使用自定义端点：

- MiniMax OAuth（全球）：`--auth-choice minimax-global-oauth`
- MiniMax OAuth（中国）：`--auth-choice minimax-cn-oauth`
- MiniMax API密钥（全球）：`--auth-choice minimax-global-api`
- MiniMax API密钥（中国）：`--auth-choice minimax-cn-api`
- 身份验证：`MINIMAX_API_KEY`用于`minimax`；`MINIMAX_OAUTH_TOKEN`或`MINIMAX_API_KEY`用于`minimax-portal`

请参阅[/providers/minimax](/providers/minimax)了解设置详情、模型选项和配置片段。

在MiniMax的Anthropic兼容流式传输路径上，OpenClaw默认禁用思考，除非你明确设置，并且`/fast on`将`MiniMax-M2.7`重写为`MiniMax-M2.7-highspeed`。

插件拥有的能力拆分：

- 文本/聊天默认保持在`minimax/MiniMax-M2.7`
- 图像生成是`minimax/image-01`或`minimax-portal/image-01`
- 图像理解是两个MiniMax身份验证路径上的插件拥有的`MiniMax-VL-01`
- 网络搜索保持在提供程序ID `minimax`

### LM Studio

LM Studio作为使用原生API的捆绑提供程序插件提供：

- 提供程序：`lmstudio`
- 身份验证：`LM_API_TOKEN`
- 默认推理基本URL：`http://localhost:1234/v1`

然后设置模型（替换为`http://localhost:1234/api/v1/models`返回的ID之一）：

```json5
{
  agents: {
    defaults: { model: { primary: "lmstudio/openai/gpt-oss-20b" } },
  },
}
```

OpenClaw使用LM Studio的原生`/api/v1/models`和`/api/v1/models/load`进行发现+自动加载，默认使用`/v1/chat/completions`进行推理。请参阅[/providers/lmstudio](/providers/lmstudio)了解设置和故障排除。

### Ollama

Ollama作为使用Ollama原生API的捆绑提供程序插件提供：

- 提供程序：`ollama`
- 身份验证：不需要（本地服务器）
- 示例模型：`ollama/llama3.3`
- 安装：[https://ollama.com/download](https://ollama.com/download)

```bash
# 安装Ollama，然后拉取模型：
ollama pull llama3.3
```

```json5
{
  agents: {
    defaults: { model: { primary: "ollama/llama3.3" } },
  },
}
```

当你使用`OLLAMA_API_KEY`选择加入时，Ollama在本地`http://127.0.0.1:11434`被检测到，并且捆绑的提供程序插件直接将Ollama添加到`openclaw onboard`和模型选择器中。请参阅[/providers/ollama](/providers/ollama)了解入职、云/本地模式和自定义配置。

### vLLM

vLLM作为本地/自托管OpenAI兼容服务器的捆绑提供程序插件提供：

- 提供程序：`vllm`
- 身份验证：可选（取决于你的服务器）
- 默认基本URL：`http://127.0.0.1:8000/v1`

要在本地选择加入自动发现（如果你的服务器不强制执行身份验证，任何值都有效）：

```bash
export VLLM_API_KEY="vllm-local"
```

然后设置模型（替换为`/v1/models`返回的ID之一）：

```json5
{
  agents: {
    defaults: { model: { primary: "vllm/your-model-id" } },
  },
}
```

请参阅[/providers/vllm](/providers/vllm)了解详情。

### SGLang

SGLang作为快速自托管OpenAI兼容服务器的捆绑提供程序插件提供：

- 提供程序：`sglang`
- 身份验证：可选（取决于你的服务器）
- 默认基本URL：`http://127.0.0.1:30000/v1`

要在本地选择加入自动发现（如果你的服务器不强制执行身份验证，任何值都有效）：

```bash
export SGLANG_API_KEY="sglang-local"
```

然后设置模型（替换为`/v1/models`返回的ID之一）：

```json5
{
  agents: {
    defaults: { model: { primary: "sglang/your-model-id" } },
  },
}
```

请参阅[/providers/sglang](/providers/sglang)了解详情。

### 本地代理（LM Studio、vLLM、LiteLLM等）

示例（OpenAI兼容）：

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

注意：

- 对于自定义提供程序，`reasoning`、`input`、`cost`、`contextWindow`和`maxTokens`是可选的。
  省略时，OpenClaw默认为：
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- 推荐：设置与你的代理/模型限制匹配的显式值。
- 对于非原生端点（任何非空`baseUrl`，其主机不是`api.openai.com`）上的`api: "openai-completions"`，OpenClaw强制`compat.supportsDeveloperRole: false`，以避免不支持`developer`角色的提供程序400错误。
- 代理风格的OpenAI兼容路由也跳过原生OpenAI专用请求整形：无`service_tier`、无Responses `store`、无提示缓存提示、无OpenAI推理兼容有效载荷整形，以及无隐藏的OpenClaw归因头。
- 如果`baseUrl`为空/省略，OpenClaw保持默认OpenAI行为（解析为`api.openai.com`）。
- 为安全起见，在非原生`openai-completions`端点上，显式的`compat.supportsDeveloperRole: true`仍然被覆盖。

## CLI示例

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

另请参阅：[/gateway/configuration](/gateway/configuration)获取完整配置示例。

## 相关

- [模型](/concepts/models) — 模型配置和别名
- [模型故障转移](/concepts/model-failover) — 回退链和重试行为
- [配置参考](/gateway/configuration-reference#agent-defaults) — 模型配置键
- [提供程序](/providers) — 按提供程序分类的设置指南