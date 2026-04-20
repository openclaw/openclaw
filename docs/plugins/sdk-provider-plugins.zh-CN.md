---
title: "构建提供商插件"
sidebarTitle: "提供商插件"
summary: "为 OpenClaw 构建模型提供商插件的分步指南"
read_when:
  - 你正在构建新的模型提供商插件
  - 你想向 OpenClaw 添加 OpenAI 兼容的代理或自定义 LLM
  - 你需要了解提供商认证、目录和运行时钩子
---

# 构建提供商插件

本指南将引导你构建一个向 OpenClaw 添加模型提供商（LLM）的提供商插件。完成后，你将拥有一个带有模型目录、API 密钥认证和动态模型解析的提供商。

<Info>
  如果你之前从未构建过 OpenClaw 插件，请先阅读 [入门指南](/plugins/building-plugins)，了解基本的包结构和清单设置。
</Info>

<Tip>
  提供商插件将模型添加到 OpenClaw 的正常推理循环中。如果模型必须通过拥有线程、压缩或工具事件的原生代理守护程序运行，请将提供商与 [代理 harness](/plugins/sdk-agent-harness) 配对，而不是将守护程序协议细节放在核心中。
</Tip>

## 演练

<Steps>
  <a id="step-1-package-and-manifest"></a>
  <Step title="包和清单">
    <CodeGroup>
    ```json package.json
    {
      "name": "@myorg/openclaw-acme-ai",
      "version": "1.0.0",
      "type": "module",
      "openclaw": {
        "extensions": ["./index.ts"],
        "providers": ["acme-ai"],
        "compat": {
          "pluginApi": ">=2026.3.24-beta.2",
          "minGatewayVersion": "2026.3.24-beta.2"
        },
        "build": {
          "openclawVersion": "2026.3.24-beta.2",
          "pluginSdkVersion": "2026.3.24-beta.2"
        }
      }
    }
    ```

    ```json openclaw.plugin.json
    {
      "id": "acme-ai",
      "name": "Acme AI",
      "description": "Acme AI 模型提供商",
      "providers": ["acme-ai"],
      "modelSupport": {
        "modelPrefixes": ["acme-"]
      },
      "providerAuthEnvVars": {
        "acme-ai": ["ACME_AI_API_KEY"]
      },
      "providerAuthAliases": {
        "acme-ai-coding": "acme-ai"
      },
      "providerAuthChoices": [
        {
          "provider": "acme-ai",
          "method": "api-key",
          "choiceId": "acme-ai-api-key",
          "choiceLabel": "Acme AI API 密钥",
          "groupId": "acme-ai",
          "groupLabel": "Acme AI",
          "cliFlag": "--acme-ai-api-key",
          "cliOption": "--acme-ai-api-key <key>",
          "cliDescription": "Acme AI API 密钥"
        }
      ],
      "configSchema": {
        "type": "object",
        "additionalProperties": false
      }
    }
    ```
    </CodeGroup>

    清单声明 `providerAuthEnvVars`，以便 OpenClaw 可以在不加载插件运行时的情况下检测凭证。当提供商变体应重用另一个提供商 ID 的认证时，添加 `providerAuthAliases`。`modelSupport` 是可选的，允许 OpenClaw 在运行时钩子存在之前从简写模型 ID（如 `acme-large`）自动加载你的提供商插件。如果你在 ClawHub 上发布提供商，则 `package.json` 中需要这些 `openclaw.compat` 和 `openclaw.build` 字段。

  </Step>

  <Step title="注册提供商">
    最小提供商需要 `id`、`label`、`auth` 和 `catalog`：

    ```typescript index.ts
    import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
    import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";

    export default definePluginEntry({
      id: "acme-ai",
      name: "Acme AI",
      description: "Acme AI 模型提供商",
      register(api) {
        api.registerProvider({
          id: "acme-ai",
          label: "Acme AI",
          docsPath: "/providers/acme-ai",
          envVars: ["ACME_AI_API_KEY"],

          auth: [
            createProviderApiKeyAuthMethod({
              providerId: "acme-ai",
              methodId: "api-key",
              label: "Acme AI API 密钥",
              hint: "来自 Acme AI 仪表板的 API 密钥",
              optionKey: "acmeAiApiKey",
              flagName: "--acme-ai-api-key",
              envVar: "ACME_AI_API_KEY",
              promptMessage: "输入你的 Acme AI API 密钥",
              defaultModel: "acme-ai/acme-large",
            }),
          ],

          catalog: {
            order: "simple",
            run: async (ctx) => {
              const apiKey =
                ctx.resolveProviderApiKey("acme-ai").apiKey;
              if (!apiKey) return null;
              return {
                provider: {
                  baseUrl: "https://api.acme-ai.com/v1",
                  apiKey,
                  api: "openai-completions",
                  models: [
                    {
                      id: "acme-large",
                      name: "Acme Large",
                      reasoning: true,
                      input: ["text", "image"],
                      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
                      contextWindow: 200000,
                      maxTokens: 32768,
                    },
                    {
                      id: "acme-small",
                      name: "Acme Small",
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
                      contextWindow: 128000,
                      maxTokens: 8192,
                    },
                  ],
                },
              };
            },
          },
        });
      },
    });
    ```

    这是一个工作提供商。用户现在可以 `openclaw onboard --acme-ai-api-key <key>` 并选择 `acme-ai/acme-large` 作为他们的模型。

    如果上游提供商使用与 OpenClaw 不同的控制令牌，请添加一个小的双向文本转换，而不是替换流路径：

    ```typescript
    api.registerTextTransforms({
      input: [
        { from: /red basket/g, to: "blue basket" },
        { from: /paper ticket/g, to: "digital ticket" },
        { from: /left shelf/g, to: "right shelf" },
      ],
      output: [
        { from: /blue basket/g, to: "red basket" },
        { from: /digital ticket/g, to: "paper ticket" },
        { from: /right shelf/g, to: "left shelf" },
      ],
    });
    ```

    `input` 在传输前重写最终系统提示和文本消息内容。`output` 在 OpenClaw 解析自己的控制标记或通道传递之前重写助手文本增量和最终文本。

    对于仅注册一个带有 API 密钥认证和单个目录支持的运行时的捆绑提供商，偏好更窄的 `defineSingleProviderPluginEntry(...)` 助手：

    ```typescript
    import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";

    export default defineSingleProviderPluginEntry({
      id: "acme-ai",
      name: "Acme AI",
      description: "Acme AI 模型提供商",
      provider: {
        label: "Acme AI",
        docsPath: "/providers/acme-ai",
        auth: [
          {
            methodId: "api-key",
            label: "Acme AI API 密钥",
            hint: "来自 Acme AI 仪表板的 API 密钥",
            optionKey: "acmeAiApiKey",
            flagName: "--acme-ai-api-key",
            envVar: "ACME_AI_API_KEY",
            promptMessage: "输入你的 Acme AI API 密钥",
            defaultModel: "acme-ai/acme-large",
          },
        ],
        catalog: {
          buildProvider: () => ({
            api: "openai-completions",
            baseUrl: "https://api.acme-ai.com/v1",
            models: [{ id: "acme-large", name: "Acme Large" }],
          }),
        },
      },
    });
    ```

    如果你的认证流程还需要在引导期间修补 `models.providers.*`、别名和代理默认模型，请使用 `openclaw/plugin-sdk/provider-onboard` 中的预设助手。最窄的助手是 `createDefaultModelPresetAppliers(...)`、`createDefaultModelsPresetAppliers(...)` 和 `createModelCatalogPresetAppliers(...)`。

    当提供商的原生端点在正常的 `openai-completions` 传输上支持流式使用块时，偏好 `openclaw/plugin-sdk/provider-catalog-shared` 中的共享目录助手，而不是硬编码提供商 ID 检查。`supportsNativeStreamingUsageCompat(...)` 和 `applyProviderNativeStreamingUsageCompat(...)` 从端点能力映射中检测支持，因此当插件使用自定义提供商 ID 时，原生 Moonshot/DashScope 风格的端点仍然可以选择加入。

  </Step>

  <Step title="添加动态模型解析">
    如果你的提供商接受任意模型 ID（如代理或路由器），添加 `resolveDynamicModel`：

    ```typescript
    api.registerProvider({
      // ... 上面的 id, label, auth, catalog

      resolveDynamicModel: (ctx) => ({
        id: ctx.modelId,
        name: ctx.modelId,
        provider: "acme-ai",
        api: "openai-completions",
        baseUrl: "https://api.acme-ai.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      }),
    });
    ```

    如果解析需要网络调用，请使用 `prepareDynamicModel` 进行异步预热 — `resolveDynamicModel` 会在它完成后再次运行。

  </Step>

  <Step title="添加运行时钩子（根据需要）">
    大多数提供商只需要 `catalog` + `resolveDynamicModel`。根据你的提供商需要，逐步添加钩子。

    共享助手构建器现在涵盖了最常见的重放/工具兼容系列，因此插件通常不需要一个接一个地手动连接每个钩子：

    ```typescript
    import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
    import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream";
    import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";

    const GOOGLE_FAMILY_HOOKS = {
      ...buildProviderReplayFamilyHooks({ family: "google-gemini" }),
      ...buildProviderStreamFamilyHooks("google-thinking"),
      ...buildProviderToolCompatFamilyHooks("gemini"),
    };

    api.registerProvider({
      id: "acme-gemini-compatible",
      // ...
      ...GOOGLE_FAMILY_HOOKS,
    });
    ```

    今天可用的重放系列：

    | 系列 | 它接线什么 |
    | --- | --- |
    | `openai-compatible` | OpenAI 兼容传输的共享 OpenAI 风格重放策略，包括工具调用 ID 清理、助手优先排序修复，以及传输需要时的通用 Gemini 回合验证 |
    | `anthropic-by-model` | 按 `modelId` 选择的 Claude 感知重放策略，因此 Anthropic 消息传输仅在解析的模型实际是 Claude ID 时获得 Claude 特定的思考块清理 |
    | `google-gemini` | 原生 Gemini 重放策略加上引导重放清理和标记推理输出模式 |
    | `passthrough-gemini` | 通过 OpenAI 兼容代理传输运行的 Gemini 模型的 Gemini 思想签名清理；不启用原生 Gemini 重放验证或引导重写 |
    | `hybrid-anthropic-openai` | 用于在一个插件中混合 Anthropic 消息和 OpenAI 兼容模型表面的混合策略；可选的仅 Claude 思考块删除保持在 Anthropic 侧的范围内 |

    真实的捆绑示例：

    - `google` 和 `google-gemini-cli`：`google-gemini`
    - `openrouter`、`kilocode`、`opencode` 和 `opencode-go`：`passthrough-gemini`
    - `amazon-bedrock` 和 `anthropic-vertex`：`anthropic-by-model`
    - `minimax`：`hybrid-anthropic-openai`
    - `moonshot`、`ollama`、`xai` 和 `zai`：`openai-compatible`

    今天可用的流系列：

    | 系列 | 它接线什么 |
    | --- | --- |
    | `google-thinking` | 共享流路径上的 Gemini 思考有效负载规范化 |
    | `kilocode-thinking` | 共享代理流路径上的 Kilo 推理包装器，`kilo/auto` 和不支持的代理推理 ID 跳过注入的思考 |
    | `moonshot-thinking` | 从配置 + `/think` 级别映射 Moonshot 二进制原生思考有效负载 |
    | `minimax-fast-mode` | 共享流路径上的 MiniMax 快速模式模型重写 |
    | `openai-responses-defaults` | 共享原生 OpenAI/Codex Responses 包装器：归因标头、`/fast`/`serviceTier`、文本详细程度、原生 Codex 网络搜索、推理兼容有效负载塑造，以及 Responses 上下文管理 |
    | `openrouter-thinking` | 代理路由的 OpenRouter 推理包装器，不支持的模型/`auto` 跳过集中处理 |
    | `tool-stream-default-on` | 对于像 Z.AI 这样希望工具流默认开启的提供商的默认开启 `tool_stream` 包装器，除非明确禁用 |

    真实的捆绑示例：

    - `google` 和 `google-gemini-cli`：`google-thinking`
    - `kilocode`：`kilocode-thinking`
    - `moonshot`：`moonshot-thinking`
    - `minimax` 和 `minimax-portal`：`minimax-fast-mode`
    - `openai` 和 `openai-codex`：`openai-responses-defaults`
    - `openrouter`：`openrouter-thinking`
    - `zai`：`tool-stream-default-on`

    `openclaw/plugin-sdk/provider-model-shared` 还导出重放系列枚举以及这些系列构建自的共享助手。常见的公共导出包括：

    - `ProviderReplayFamily`
    - `buildProviderReplayFamilyHooks(...)`
    - 共享重放构建器，如 `buildOpenAICompatibleReplayPolicy(...)`、`buildAnthropicReplayPolicyForModel(...)`、`buildGoogleGeminiReplayPolicy(...)` 和 `buildHybridAnthropicOrOpenAIReplayPolicy(...)`
    - Gemini 重放助手，如 `sanitizeGoogleGeminiReplayHistory(...)` 和 `resolveTaggedReasoningOutputMode()`
    - 端点/模型助手，如 `resolveProviderEndpoint(...)`、`normalizeProviderId(...)`、`normalizeGooglePreviewModelId(...)` 和 `normalizeNativeXaiModelId(...)`

    `openclaw/plugin-sdk/provider-stream` 同时暴露系列构建器和这些系列重用的公共包装器助手。常见的公共导出包括：

    - `ProviderStreamFamily`
    - `buildProviderStreamFamilyHooks(...)`
    - `composeProviderStreamWrappers(...)`
    - 共享 OpenAI/Codex 包装器，如 `createOpenAIAttributionHeadersWrapper(...)`、`createOpenAIFastModeWrapper(...)`、`createOpenAIServiceTierWrapper(...)`、`createOpenAIResponsesContextManagementWrapper(...)` 和 `createCodexNativeWebSearchWrapper(...)`
    - 共享代理/提供商包装器，如 `createOpenRouterWrapper(...)`、`createToolStreamWrapper(...)` 和 `createMinimaxFastModeWrapper(...)`

    一些流助手有意保持提供商本地。当前捆绑示例：`@openclaw/anthropic-provider` 从其公共 `api.ts` / `contract-api.ts` 接缝导出 `wrapAnthropicProviderStream`、`resolveAnthropicBetas`、`resolveAnthropicFastMode`、`resolveAnthropicServiceTier` 和较低级别的 Anthropic 包装器构建器。这些助手保持 Anthropic 特定，因为它们还编码 Claude OAuth beta 处理和 `context1m` 门控。

    其他捆绑提供商在行为不能跨系列干净共享时也保持传输特定的包装器本地。当前示例：捆绑的 xAI 插件在其自己的 `wrapStreamFn` 中保持原生 xAI Responses 塑造，包括 `/fast` 别名重写、默认 `tool_stream`、不支持的严格工具清理，以及 xAI 特定的推理有效负载移除。

    `openclaw/plugin-sdk/provider-tools` 当前暴露一个共享工具模式系列加上共享模式/兼容助手：

    - `ProviderToolCompatFamily` 记录今天的共享系列清单。
    - `buildProviderToolCompatFamilyHooks("gemini")` 为需要 Gemini 安全工具模式的提供商接线 Gemini 模式清理 + 诊断。
    - `normalizeGeminiToolSchemas(...)` 和 `inspectGeminiToolSchemas(...)` 是底层的公共 Gemini 模式助手。
    - `resolveXaiModelCompatPatch()` 返回捆绑的 xAI 兼容补丁：`toolSchemaProfile: "xai"`、不支持的模式关键字、原生 `web_search` 支持，以及 HTML 实体工具调用参数解码。
    - `applyXaiModelCompat(model)` 在模型到达运行器之前将相同的 xAI 兼容补丁应用到解析的模型。

    真实的捆绑示例：xAI 插件使用 `normalizeResolvedModel` 加上 `contributeResolvedModelCompat` 来保持该兼容元数据由提供商拥有，而不是在核心中硬编码 xAI 规则。

    相同的包根模式也支持其他捆绑提供商：

    - `@openclaw/openai-provider`：`api.ts` 导出提供商构建器、默认模型助手和实时提供商构建器
    - `@openclaw/openrouter-provider`：`api.ts` 导出提供商构建器以及引导/配置助手

    <Tabs>
      <Tab title="令牌交换">
        对于每次推理调用前需要令牌交换的提供商：

        ```typescript
        prepareRuntimeAuth: async (ctx) => {
          const exchanged = await exchangeToken(ctx.apiKey);
          return {
            apiKey: exchanged.token,
            baseUrl: exchanged.baseUrl,
            expiresAt: exchanged.expiresAt,
          };
        },
        ```
      </Tab>
      <Tab title="自定义标头">
        对于需要自定义请求标头或正文修改的提供商：

        ```typescript
        // wrapStreamFn 返回从 ctx.streamFn 派生的 StreamFn
        wrapStreamFn: (ctx) => {
          if (!ctx.streamFn) return undefined;
          const inner = ctx.streamFn;
          return async (params) => {
            params.headers = {
              ...params.headers,
              "X-Acme-Version": "2",
            };
            return inner(params);
          };
        },
        ```
      </Tab>
      <Tab title="原生传输身份">
        对于需要在通用 HTTP 或 WebSocket 传输上使用原生请求/会话标头或元数据的提供商：

        ```typescript
        resolveTransportTurnState: (ctx) => ({
          headers: {
            "x-request-id": ctx.turnId,
          },
          metadata: {
            session_id: ctx.sessionId ?? "",
            turn_id: ctx.turnId,
          },
        }),
        resolveWebSocketSessionPolicy: (ctx) => ({
          headers: {
            "x-session-id": ctx.sessionId ?? "",
          },
          degradeCooldownMs: 60_000,
        }),
        ```
      </Tab>
      <Tab title="使用和计费">
        对于暴露使用/计费数据的提供商：

        ```typescript
        resolveUsageAuth: async (ctx) => {
          const auth = await ctx.resolveOAuthToken();
          return auth ? { token: auth.token } : null;
        },
        fetchUsageSnapshot: async (ctx) => {
          return await fetchAcmeUsage(ctx.token, ctx.timeoutMs);
        },
        ```
      </Tab>
    </Tabs>

    <Accordion title="所有可用的提供商钩子">
      OpenClaw 按此顺序调用钩子。大多数提供商只使用 2-3 个：

      | # | 钩子 | 何时使用 |
      | --- | --- | --- |
      | 1 | `catalog` | 模型目录或基础 URL 默认值 |
      | 2 | `applyConfigDefaults` | 配置物化期间提供商拥有的全局默认值 |
      | 3 | `normalizeModelId` | 查找前的遗留/预览模型 ID 别名清理 |
      | 4 | `normalizeTransport` | 通用模型组装前的提供商系列 `api` / `baseUrl` 清理 |
      | 5 | `normalizeConfig` | 规范化 `models.providers.<id>` 配置 |
      | 6 | `applyNativeStreamingUsageCompat` | 配置提供商的原生流式使用兼容重写 |
      | 7 | `resolveConfigApiKey` | 提供商拥有的环境标记认证解析 |
      | 8 | `resolveSyntheticAuth` | 本地/自托管或配置支持的合成认证 |
      | 9 | `shouldDeferSyntheticProfileAuth` | 在环境/配置认证后面降低合成存储配置文件占位符 |
      | 10 | `resolveDynamicModel` | 接受任意上游模型 ID |
      | 11 | `prepareDynamicModel` | 解析前的异步元数据获取 |
      | 12 | `normalizeResolvedModel` | 运行器前的传输重写 |

    运行时回退说明：

    - `normalizeConfig` 首先检查匹配的提供商，然后检查其他具有钩子能力的提供商插件，直到一个实际更改配置。如果没有提供商钩子重写支持的 Google 系列配置条目，捆绑的 Google 配置规范化器仍然适用。
    - `resolveConfigApiKey` 在暴露时使用提供商钩子。捆绑的 `amazon-bedrock` 路径在这里也有一个内置的 AWS 环境标记解析器，即使 Bedrock 运行时认证本身仍然使用 AWS SDK 默认链。
      | 13 | `contributeResolvedModelCompat` | 另一个兼容传输背后的供应商模型的兼容标志 |
      | 14 | `capabilities` | 遗留静态能力包；仅兼容 |
      | 15 | `normalizeToolSchemas` | 注册前提供商拥有的工具模式清理 |
      | 16 | `inspectToolSchemas` | 提供商拥有的工具模式诊断 |
      | 17 | `resolveReasoningOutputMode` | 标记与原生推理输出契约 |
      | 18 | `prepareExtraParams` | 默认请求参数 |
      | 19 | `createStreamFn` | 完全自定义的 StreamFn 传输 |
      | 20 | `wrapStreamFn` | 正常流路径上的自定义标头/正文包装器 |
      | 21 | `resolveTransportTurnState` | 原生每回合标头/元数据 |
      | 22 | `resolveWebSocketSessionPolicy` | 原生 WS 会话标头/冷却 |
      | 23 | `formatApiKey` | 自定义运行时令牌形状 |
      | 24 | `refreshOAuth` | 自定义 OAuth 刷新 |
      | 25 | `buildAuthDoctorHint` | 认证修复指导 |
      | 26 | `matchesContextOverflowError` | 提供商拥有的溢出检测 |
      | 27 | `classifyFailoverReason` | 提供商拥有的速率限制/过载分类 |
      | 28 | `isCacheTtlEligible` | 提示缓存 TTL 门控 |
      | 29 | `buildMissingAuthMessage` | 自定义缺失认证提示 |
      | 30 | `suppressBuiltInModel` | 隐藏过时的上游行 |
      | 31 | `augmentModelCatalog` | 合成前向兼容行 |
      | 32 | `isBinaryThinking` | 二进制思考开/关 |
      | 33 | `supportsXHighThinking` | `xhigh` 推理支持 |
      | 34 | `resolveDefaultThinkingLevel` | 默认 `/think` 策略 |
      | 35 | `isModernModelRef` | 实时/冒烟模型匹配 |
      | 36 | `prepareRuntimeAuth` | 推理前的令牌交换 |
      | 37 | `resolveUsageAuth` | 自定义使用凭证解析 |
      | 38 | `fetchUsageSnapshot` | 自定义使用端点 |
      | 39 | `createEmbeddingProvider` | 提供商拥有的内存/搜索嵌入适配器 |
      | 40 | `buildReplayPolicy` | 自定义转录重放/压缩策略 |
      | 41 | `sanitizeReplayHistory` | 通用清理后的提供商特定重放重写 |
      | 42 | `validateReplayTurns` | 嵌入式运行器前的严格重放回合验证 |
      | 43 | `onModelSelected` | 选择后回调（例如遥测） |

      提示调优说明：

      - `resolveSystemPromptContribution` 让提供商为模型系列注入缓存感知的系统提示指导。当行为属于一个提供商/模型系列并且应该保留稳定/动态缓存拆分时，偏好它而不是 `before_prompt_build`。

      有关详细描述和真实示例，请参阅 [内部：提供商运行时钩子](/plugins/architecture#provider-runtime-hooks)。
    </Accordion>

  </Step>

  <Step title="添加额外能力（可选）">
    <a id="step-5-add-extra-capabilities"></a>
    提供商插件可以注册语音、实时转录、实时语音、媒体理解、图像生成、视频生成、网络获取和网络搜索以及文本推理：

    ```typescript
    register(api) {
      api.registerProvider({ id: "acme-ai", /* ... */ });

      api.registerSpeechProvider({
        id: "acme-ai",
        label: "Acme Speech",
        isConfigured: ({ config }) => Boolean(config.messages?.tts),
        synthesize: async (req) => ({
          audioBuffer: Buffer.from(/* PCM 数据 */),
          outputFormat: "mp3",
          fileExtension: ".mp3",
          voiceCompatible: false,
        }),
      });

      api.registerRealtimeTranscriptionProvider({
        id: "acme-ai",
        label: "Acme 实时转录",
        isConfigured: () => true,
        createSession: (req) => ({
          connect: async () => {},
          sendAudio: () => {},
          close: () => {},
          isConnected: () => true,
        }),
      });

      api.registerRealtimeVoiceProvider({
        id: "acme-ai",
        label: "Acme 实时语音",
        isConfigured: ({ providerConfig }) => Boolean(providerConfig.apiKey),
        createBridge: (req) => ({
          connect: async () => {},
          sendAudio: () => {},
          setMediaTimestamp: () => {},
          submitToolResult: () => {},
          acknowledgeMark: () => {},
          close: () => {},
          isConnected: () => true,
        }),
      });

      api.registerMediaUnderstandingProvider({
        id: "acme-ai",
        capabilities: ["image", "audio"],
        describeImage: async (req) => ({ text: "一张照片..." }),
        transcribeAudio: async (req) => ({ text: "转录..." }),
      });

      api.registerImageGenerationProvider({
        id: "acme-ai",
        label: "Acme 图像",
        generate: async (req) => ({ /* 图像结果 */ }),
      });

      api.registerVideoGenerationProvider({
        id: "acme-ai",
        label: "Acme 视频",
        capabilities: {
          generate: {
            maxVideos: 1,
            maxDurationSeconds: 10,
            supportsResolution: true,
          },
          imageToVideo: {
            enabled: true,
            maxVideos: 1,
            maxInputImages: 1,
            maxDurationSeconds: 5,
          },
          videoToVideo: {
            enabled: false,
          },
        },
        generateVideo: async (req) => ({ videos: [] }),
      });

      api.registerWebFetchProvider({
        id: "acme-ai-fetch",
        label: "Acme 获取",
        hint: "通过 Acme 的渲染后端获取页面。",
        envVars: ["ACME_FETCH_API_KEY"],
        placeholder: "acme-...",
        signupUrl: "https://acme.example.com/fetch",
        credentialPath: "plugins.entries.acme.config.webFetch.apiKey",
        getCredentialValue: (fetchConfig) => fetchConfig?.acme?.apiKey,
        setCredentialValue: (fetchConfigTarget, value) => {
          const acme = (fetchConfigTarget.acme ??= {});
          acme.apiKey = value;
        },
        createTool: () => ({
          description: "通过 Acme 获取获取页面。",
          parameters: {},
          execute: async (args) => ({ content: [] }),
        }),
      });

      api.registerWebSearchProvider({
        id: "acme-ai-search",
        label: "Acme 搜索",
        search: async (req) => ({ content: [] }),
      });
    }
    ```

    OpenClaw 将此分类为**混合能力**插件。这是公司插件的推荐模式（每个供应商一个插件）。请参阅 [内部：能力所有权](/plugins/architecture#capability-ownership-model)。

    对于视频生成，偏好上面所示的模式感知能力形状：`generate`、`imageToVideo` 和 `videoToVideo`。扁平聚合字段（如 `maxInputImages`、`maxInputVideos` 和 `maxDurationSeconds`）不足以干净地宣传转换模式支持或禁用模式。

    音乐生成提供商应遵循相同的模式：`generate` 用于仅提示生成，`edit` 用于基于参考图像的生成。扁平聚合字段（如 `maxInputImages`、`supportsLyrics` 和 `supportsFormat`）不足以宣传编辑支持；明确的 `generate` / `edit` 块是预期的契约。

  </Step>

  <Step title="测试">
    <a id="step-6-test"></a>
    ```typescript src/provider.test.ts
    import { describe, it, expect } from "vitest";
    // 从 index.ts 或专用文件导出你的提供商配置对象
    import { acmeProvider } from "./provider.js";

    describe("acme-ai 提供商", () => {
      it("解析动态模型", () => {
        const model = acmeProvider.resolveDynamicModel!({
          modelId: "acme-beta-v3",
        } as any);
        expect(model.id).toBe("acme-beta-v3");
        expect(model.provider).toBe("acme-ai");
      });

      it("当密钥可用时返回目录", async () => {
        const result = await acmeProvider.catalog!.run({
          resolveProviderApiKey: () => ({ apiKey: "test-key" }),
        } as any);
        expect(result?.provider?.models).toHaveLength(2);
      });

      it("当无密钥时返回 null 目录", async () => {
        const result = await acmeProvider.catalog!.run({
          resolveProviderApiKey: () => ({ apiKey: undefined }),
        } as any);
        expect(result).toBeNull();
      });
    });
    ```

  </Step>
</Steps>

## 发布到 ClawHub

提供商插件的发布方式与任何其他外部代码插件相同：

```bash
clawhub package publish your-org/your-plugin --dry-run
clawhub package publish your-org/your-plugin
```

不要在这里使用遗留的仅技能发布别名；插件包应使用 `clawhub package publish`。

## 文件结构

```
<bundled-plugin-root>/acme-ai/
├── package.json              # openclaw.providers 元数据
├── openclaw.plugin.json      # 带有提供商认证元数据的清单
├── index.ts                  # definePluginEntry + registerProvider
└── src/
    ├── provider.test.ts      # 测试
    └── usage.ts              # 使用端点（可选）
```

## 目录顺序参考

`catalog.order` 控制你的目录相对于内置提供商的合并时间：

| 顺序      | 时间         | 使用场景                     |
| --------- | ------------ | ---------------------------- |
| `simple`  | 第一遍       | 普通 API 密钥提供商          |
| `profile` | simple 之后  | 基于认证配置文件的提供商     |
| `paired`  | profile 之后 | 合成多个相关条目             |
| `late`    | 最后一遍     | 覆盖现有提供商（冲突时获胜） |

## 下一步

- [通道插件](/plugins/sdk-channel-plugins) — 如果你的插件也提供通道
- [SDK 运行时](/plugins/sdk-runtime) — `api.runtime` 助手（TTS、搜索、子代理）
- [SDK 概览](/plugins/sdk-overview) — 完整的子路径导入参考
- [插件内部架构](/plugins/architecture#provider-runtime-hooks) — 钩子详细信息和捆绑示例
