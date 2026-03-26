---
read_when:
  - 添加或修改插件/扩展时
  - 记录插件安装或加载规则时
  - 使用与 Codex/Claude 兼容的插件包时
summary: OpenClaw 插件/扩展：发现、配置与安全
title: 插件
x-i18n:
  generated_at: "2026-03-16T06:36:16Z"
  model: gpt-5.4
  provider: openai
  source_hash: d84a98f113817836c829b6e6f8a1cae441d2f0ee284fdd7194d193fd1aa34ff9
  source_path: tools/plugin.md
  workflow: 15
---

# 插件（扩展）

## 快速开始（刚接触插件？）

插件可以是以下两种之一：

- 原生 **OpenClaw 插件**（`openclaw.plugin.json` + 运行时模块），或
- 兼容的 **bundle**（`.codex-plugin/plugin.json` 或 `.claude-plugin/plugin.json`）

两者都会显示在 `openclaw plugins` 下，但只有原生 OpenClaw 插件会在进程内执行运行时代码。

大多数情况下，当你想要某项核心 OpenClaw 尚未内置的功能时，就会使用插件（或者你希望将可选功能保留在主安装之外）。

快捷路径：

1. 查看当前已加载的内容：

```bash
openclaw plugins list
```

2. 安装官方插件（示例：Voice Call）：

```bash
openclaw plugins install @openclaw/voice-call
```

Npm 规格仅支持 **registry-only**（包名 + 可选的 **精确版本** 或 **dist-tag**）。

Git/URL/file 规格和 semver 范围都会被拒绝。

裸规格和 `@latest` 会停留在稳定通道。如果 npm 将其中任一解析为预发布版本，OpenClaw 会停止并要求你通过预发布标签（例如 `@beta`/`@rc`）或精确的预发布版本显式选择加入。

3. 重启 Gateway 网关，然后在 `plugins.entries.<id>.config` 下进行配置。

查看 [Voice Call](/plugins/voice-call) 获取一个具体的插件示例。
想找第三方列表？请查看 [Community plugins](/plugins/community)。
需要了解 bundle 兼容性细节？请查看 [Plugin bundles](/plugins/bundles)。

对于兼容的 bundle，可从本地目录或归档文件安装：

```bash
openclaw plugins install ./my-bundle
openclaw plugins install ./my-bundle.tgz
```

## 架构

OpenClaw 的插件系统有四层：

1. **清单 + 发现**
   OpenClaw 会从已配置路径、工作区根目录、全局扩展根目录以及随附扩展中查找候选插件。发现过程会先读取原生 `openclaw.plugin.json` 清单以及受支持的 bundle 清单。
2. **启用 + 验证**
   核心会决定某个已发现插件是启用、禁用、阻止，还是被选用于某个独占插槽（例如内存）。
3. **运行时加载**
   原生 OpenClaw 插件通过 jiti 在进程内加载，并将功能注册到一个中央注册表中。兼容的 bundle 会被规范化为注册表记录，而不会导入运行时代码。
4. **表面消费**
   OpenClaw 的其余部分会读取注册表，以公开工具、渠道、提供商设置、hooks、HTTP 路由、CLI 命令和服务。

重要的设计边界：

- 发现 + 配置验证应基于 **manifest/schema 元数据** 运行，而不执行插件代码
- 原生运行时行为来自插件模块的 `register(api)` 路径

这种拆分让 OpenClaw 能够在完整运行时激活之前，就验证配置、解释缺失/被禁用的插件，并构建 UI/schema 提示。

## 兼容的 bundle

OpenClaw 还识别两种兼容的外部 bundle 布局：

- Codex 风格 bundle：`.codex-plugin/plugin.json`
- Claude 风格 bundle：`.claude-plugin/plugin.json`，或者没有清单的默认 Claude 组件布局
- Cursor 风格 bundle：`.cursor-plugin/plugin.json`

它们会在插件列表中显示为 `format=bundle`，并在详细/info 输出中显示 `codex` 或 `claude` 子类型。

有关精确的检测规则、映射行为和当前支持矩阵，请参阅 [Plugin bundles](/plugins/bundles)。

目前，OpenClaw 将这些内容视为 **能力包**，而不是原生运行时插件：

- 当前支持：捆绑的 `skills`
- 当前支持：Claude `commands/` markdown 根目录，映射到常规 OpenClaw 技能加载器
- 当前支持：Claude bundle `settings.json` 默认值，用于嵌入式 Pi 智能体设置（会清理 shell override 键）
- 当前支持：Cursor `.cursor/commands/*.md` 根目录，映射到常规 OpenClaw 技能加载器
- 当前支持：使用 OpenClaw hook-pack 布局的 Codex bundle hook 目录（`HOOK.md` + `handler.ts`/`handler.js`）
- 已检测但尚未接线：其他已声明的 bundle 能力，例如 agents、Claude hook 自动化、Cursor rules/hooks/MCP 元数据、MCP/app/LSP 元数据、输出样式

这意味着 bundle 的安装/发现/列表/info/启用都可正常工作，并且当 bundle 被启用时，bundle skills、Claude command-skills、Claude bundle settings 默认值以及兼容的 Codex hook 目录都会被加载，但 bundle 运行时代码不会在进程内执行。

Bundle hook 支持仅限于常规 OpenClaw hook 目录格式（在声明的 hook 根目录下使用 `HOOK.md` 加上 `handler.ts`/`handler.js`）。
供应商特定的 shell/JSON hook 运行时，包括 Claude `hooks.json`，当前仅会被检测，不会被直接执行。

## 执行模型

原生 OpenClaw 插件与 Gateway 网关 **在同一进程内** 运行。它们不会进行沙箱隔离。已加载的原生插件与核心代码处于相同的进程级信任边界。

这意味着：

- 原生插件可以注册工具、网络处理器、hooks 和服务
- 原生插件中的 bug 可能导致 gateway 崩溃或不稳定
- 恶意原生插件等同于在 OpenClaw 进程内部执行任意代码

兼容的 bundle 默认更安全，因为 OpenClaw 目前将它们视为元数据/内容包。在当前版本中，这主要意味着捆绑的技能。

对于非捆绑插件，请使用 allowlist 和显式安装/加载路径。将工作区插件视为开发期代码，而不是生产默认项。

重要信任说明：

- `plugins.allow` 信任的是 **plugin id**，而不是来源出处。
- 如果某个工作区插件与某个捆绑插件具有相同 id，那么启用/加入 allowlist 后，工作区插件会有意覆盖捆绑副本。
- 这是一种正常且有用的行为，适合本地开发、补丁测试和热修复。

## 可用插件（官方）

- Microsoft Teams 自 `2026.1.15` 起仅以插件形式提供；如果你使用 Teams，请安装 `@openclaw/msteams`。
- Memory（Core）— 捆绑的内存搜索插件（默认通过 `plugins.slots.memory` 启用）
- Memory（LanceDB）— 捆绑的长期记忆插件（自动召回/捕获；设置 `plugins.slots.memory = "memory-lancedb"`）
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Anthropic provider 运行时 — 以 `anthropic` 形式捆绑（默认启用）
- BytePlus provider catalog — 以 `byteplus` 形式捆绑（默认启用）
- Cloudflare AI Gateway provider catalog — 以 `cloudflare-ai-gateway` 形式捆绑（默认启用）
- Google 网络搜索 + Gemini CLI OAuth — 以 `google` 形式捆绑（网页搜索会自动加载；provider 身份验证仍需选择启用）
- GitHub Copilot provider 运行时 — 以 `github-copilot` 形式捆绑（默认启用）
- Hugging Face provider catalog — 以 `huggingface` 形式捆绑（默认启用）
- Kilo Gateway provider 运行时 — 以 `kilocode` 形式捆绑（默认启用）
- Kimi Coding provider catalog — 以 `kimi-coding` 形式捆绑（默认启用）
- MiniMax provider catalog + usage + OAuth — 以 `minimax` 形式捆绑（默认启用；拥有 `minimax` 和 `minimax-portal`）
- Mistral provider 能力 — 以 `mistral` 形式捆绑（默认启用）
- Model Studio provider catalog — 以 `modelstudio` 形式捆绑（默认启用）
- Moonshot provider 运行时 — 以 `moonshot` 形式捆绑（默认启用）
- NVIDIA provider catalog — 以 `nvidia` 形式捆绑（默认启用）
- OpenAI provider 运行时 — 以 `openai` 形式捆绑（默认启用；同时拥有 `openai` 和 `openai-codex`）
- OpenCode Go provider 能力 — 以 `opencode-go` 形式捆绑（默认启用）
- OpenCode Zen provider 能力 — 以 `opencode` 形式捆绑（默认启用）
- OpenRouter provider 运行时 — 以 `openrouter` 形式捆绑（默认启用）
- Qianfan provider catalog — 以 `qianfan` 形式捆绑（默认启用）
- Synthetic provider catalog — 以 `synthetic` 形式捆绑（默认启用）
- Together provider catalog — 以 `together` 形式捆绑（默认启用）
- Venice provider catalog — 以 `venice` 形式捆绑（默认启用）
- Vercel AI Gateway provider catalog — 以 `vercel-ai-gateway` 形式捆绑（默认启用）
- Volcengine provider catalog — 以 `volcengine` 形式捆绑（默认启用）
- Xiaomi provider catalog + usage — 以 `xiaomi` 形式捆绑（默认启用）
- Z.AI provider 运行时 — 以 `zai` 形式捆绑（默认启用）
- Copilot Proxy（provider 身份验证）— 本地 VS Code Copilot Proxy 桥接；不同于内置的 `github-copilot` 设备登录（已捆绑，默认禁用）

原生 OpenClaw 插件是通过 jiti 在运行时加载的 **TypeScript 模块**。
**配置验证不会执行插件代码**；它使用的是插件 manifest 和 JSON Schema。请参阅 [Plugin manifest](/plugins/manifest)。

原生 OpenClaw 插件可以注册：

- Gateway RPC 方法
- Gateway HTTP 路由
- 智能体工具
- CLI 命令
- 后台服务
- 上下文引擎
- provider 身份验证流程和模型目录
- 用于动态模型 id、传输规范化、能力元数据、流包装、缓存 TTL 策略、缺失身份验证提示、内置模型抑制、目录增强、运行时身份验证交换以及 usage/billing 身份验证 + 快照解析的 provider 运行时 hooks
- 可选配置验证
- **Skills**（通过在插件 manifest 中列出 `skills` 目录）
- **自动回复命令**（无需调用 AI 智能体即可执行）

原生 OpenClaw 插件与 Gateway 网关 **在同一进程内** 运行，因此应将其视为受信任代码。
工具编写指南：[Plugin agent tools](/plugins/agent-tools)。

## Provider 运行时 hooks

Provider 插件现在有两层：

- manifest 元数据：`providerAuthEnvVars`，用于在运行时加载前进行低成本的环境身份验证查找
- 配置时 hooks：`catalog` / 旧版 `discovery`
- 运行时 hooks：`resolveDynamicModel`、`prepareDynamicModel`、`normalizeResolvedModel`、`capabilities`、`prepareExtraParams`、`wrapStreamFn`、`formatApiKey`、`refreshOAuth`、`buildAuthDoctorHint`、`isCacheTtlEligible`、`buildMissingAuthMessage`、`suppressBuiltInModel`、`augmentModelCatalog`、`isBinaryThinking`、`supportsXHighThinking`、`resolveDefaultThinkingLevel`、`isModernModelRef`、`prepareRuntimeAuth`、`resolveUsageAuth`、`fetchUsageSnapshot`

OpenClaw 仍然负责通用的智能体循环、故障切换、转录处理和工具策略。这些 hooks 是 provider 特定行为的接缝，而无需整个自定义推理传输层。

当 provider 具有基于环境变量的凭据，并且你希望通用 auth/status/model-picker 路径在不加载插件运行时的情况下就能看到这些凭据时，请使用 manifest `providerAuthEnvVars`。
保留 provider 运行时 `envVars` 用于面向操作员的提示，例如新手引导标签或 OAuth client-id/client-secret 设置环境变量。

### Hook 顺序

对于 model/provider 插件，OpenClaw 大致按以下顺序使用 hooks：

1. `catalog`
   在生成 `models.json` 期间，将 provider 配置发布到 `models.providers` 中。
2. 内置/已发现模型查找
   OpenClaw 会先尝试常规注册表/目录路径。
3. `resolveDynamicModel`
   对于本地注册表中尚不存在的 provider 自有 model id，进行同步后备解析。
4. `prepareDynamicModel`
   仅在异步模型解析路径上执行异步预热，然后再次运行 `resolveDynamicModel`。
5. `normalizeResolvedModel`
   在嵌入式运行器使用已解析模型之前进行最终重写。
6. `capabilities`
   由共享核心逻辑使用的 provider 自有转录/工具元数据。
7. `prepareExtraParams`
   在通用流选项包装器之前执行 provider 自有请求参数规范化。
8. `wrapStreamFn`
   在应用通用包装器之后执行 provider 自有流包装器。
9. `formatApiKey`
   当存储的 auth profile 需要转换为运行时 `apiKey` 字符串时，使用 provider 自有身份验证配置器。
10. `refreshOAuth`
    对自定义刷新端点或刷新失败策略执行 provider 自有 OAuth 刷新覆盖。
11. `buildAuthDoctorHint`
    当 OAuth 刷新失败时，追加 provider 自有修复提示。
12. `isCacheTtlEligible`
    为代理/backhaul provider 提供 provider 自有提示词缓存策略。
13. `buildMissingAuthMessage`
    用 provider 自有内容替换通用的缺失身份验证恢复消息。
14. `suppressBuiltInModel`
    执行 provider 自有的过时上游模型抑制，并可返回面向用户的错误提示。
15. `augmentModelCatalog`
    在发现后附加 provider 自有的合成/最终目录行。
16. `isBinaryThinking`
    为二元 thinking provider 提供 provider 自有的开/关推理切换。
17. `supportsXHighThinking`
    为选定模型提供 provider 自有的 `xhigh` 推理支持。
18. `resolveDefaultThinkingLevel`
    为特定模型家族提供 provider 自有的默认 `/think` 级别。
19. `isModernModelRef`
    提供 provider 自有的现代模型匹配器，用于 live profile 过滤器和 smoke 选择。
20. `prepareRuntimeAuth`
    在推理前将已配置的凭据交换为实际的运行时令牌/密钥。
21. `resolveUsageAuth`
    为 `/usage` 及相关状态表面解析 usage/billing 凭据。
22. `fetchUsageSnapshot`
    在身份验证解析完成后，抓取并规范化 provider 特定的 usage/quota 快照。

### 应该使用哪个 hook

- `catalog`：将 provider 配置和模型目录发布到 `models.providers`
- `resolveDynamicModel`：处理本地注册表中尚未存在的透传或前向兼容 model id
- `prepareDynamicModel`：在重试动态解析之前执行异步预热（例如刷新 provider 元数据缓存）
- `normalizeResolvedModel`：在推理前重写已解析模型的传输/base URL/兼容性
- `capabilities`：发布 provider 家族和转录/工具差异，而不在核心中硬编码 provider id
- `prepareExtraParams`：在通用流包装之前设置 provider 默认值或规范化 provider 特定的每模型参数
- `wrapStreamFn`：在仍使用常规 `pi-ai` 执行路径时，添加 provider 特定的 header/payload/model 兼容补丁
- `formatApiKey`：将存储的 auth profile 转换为运行时 `apiKey` 字符串，而不在核心中硬编码 provider 令牌 blob
- `refreshOAuth`：为不适配共享 `pi-ai` 刷新器的 provider 自主管理 OAuth 刷新
- `buildAuthDoctorHint`：在刷新失败时追加 provider 自有的身份验证修复指导
- `isCacheTtlEligible`：决定 provider/模型组合是否应使用 cache TTL 元数据
- `buildMissingAuthMessage`：用 provider 特定恢复提示替换通用 auth-store 错误
- `suppressBuiltInModel`：隐藏过时上游条目，并可在直接解析失败时返回 provider 自有错误
- `augmentModelCatalog`：在发现和配置合并后附加合成/最终目录行
- `isBinaryThinking`：在 `/think` 中公开二元开/关推理 UX，而不硬编码 provider id
- `supportsXHighThinking`：让特定模型启用 `xhigh` 推理级别
- `resolveDefaultThinkingLevel`：将 provider/模型默认推理策略移出核心
- `isModernModelRef`：将 live/smoke 模型家族包含规则保留在 provider 中
- `prepareRuntimeAuth`：将已配置凭据交换为请求所用的实际短期运行时令牌/密钥
- `resolveUsageAuth`：为 usage/billing 端点解析 provider 自有凭据，而不在核心中硬编码令牌解析
- `fetchUsageSnapshot`：由 provider 自主管理 usage 端点抓取/解析，而核心继续负责摘要扇出和格式化

经验法则：

- provider 拥有目录或 base URL 默认值：使用 `catalog`
- provider 接受任意上游 model id：使用 `resolveDynamicModel`
- provider 在解析未知 id 前需要网络元数据：添加 `prepareDynamicModel`
- provider 需要传输重写但仍使用核心传输：使用 `normalizeResolvedModel`
- provider 需要转录/provider 家族差异：使用 `capabilities`
- provider 需要默认请求参数或按 provider 清理参数：使用 `prepareExtraParams`
- provider 需要请求 header/body/model 兼容包装而不使用自定义传输：使用 `wrapStreamFn`
- provider 在 auth profile 中存储额外元数据并需要自定义运行时令牌格式：使用 `formatApiKey`
- provider 需要自定义 OAuth 刷新端点或刷新失败策略：使用 `refreshOAuth`
- provider 在刷新失败后需要 provider 自有身份验证修复指导：使用 `buildAuthDoctorHint`
- provider 需要特定于代理的 cache TTL 门控：使用 `isCacheTtlEligible`
- provider 需要 provider 特定的缺失身份验证恢复提示：使用 `buildMissingAuthMessage`
- provider 需要隐藏过时上游条目或用厂商提示替换它们：使用 `suppressBuiltInModel`
- provider 需要在 `models list` 和选择器中添加合成的前向兼容条目：使用 `augmentModelCatalog`
- provider 仅提供二元 thinking 开/关：使用 `isBinaryThinking`
- provider 只希望部分模型启用 `xhigh`：使用 `supportsXHighThinking`
- provider 拥有某个模型家族默认 `/think` 策略：使用 `resolveDefaultThinkingLevel`
- provider 拥有 live/smoke 首选模型匹配：使用 `isModernModelRef`
- provider 需要令牌交换或短期请求凭据：使用 `prepareRuntimeAuth`
- provider 需要自定义 usage/quota 令牌解析或不同的 usage 凭据：使用 `resolveUsageAuth`
- provider 需要 provider 特定的 usage 端点或负载解析器：使用 `fetchUsageSnapshot`

如果 provider 需要完全自定义的线协议或自定义请求执行器，那属于另一类扩展。这些 hooks 适用于仍运行在 OpenClaw 常规推理循环上的 provider 行为。

### Provider 示例

```ts
api.registerProvider({
  id: "example-proxy",
  label: "Example Proxy",
  auth: [],
  catalog: {
    order: "simple",
    run: async (ctx) => {
      const apiKey = ctx.resolveProviderApiKey("example-proxy").apiKey;
      if (!apiKey) {
        return null;
      }
      return {
        provider: {
          baseUrl: "https://proxy.example.com/v1",
          apiKey,
          api: "openai-completions",
          models: [{ id: "auto", name: "Auto" }],
        },
      };
    },
  },
  resolveDynamicModel: (ctx) => ({
    id: ctx.modelId,
    name: ctx.modelId,
    provider: "example-proxy",
    api: "openai-completions",
    baseUrl: "https://proxy.example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  }),
  prepareRuntimeAuth: async (ctx) => {
    const exchanged = await exchangeToken(ctx.apiKey);
    return {
      apiKey: exchanged.token,
      baseUrl: exchanged.baseUrl,
      expiresAt: exchanged.expiresAt,
    };
  },
  resolveUsageAuth: async (ctx) => {
    const auth = await ctx.resolveOAuthToken();
    return auth ? { token: auth.token } : null;
  },
  fetchUsageSnapshot: async (ctx) => {
    return await fetchExampleProxyUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn);
  },
});
```

### 内置示例

- Anthropic 使用 `resolveDynamicModel`、`capabilities`、`buildAuthDoctorHint`、`resolveUsageAuth`、`fetchUsageSnapshot`、`isCacheTtlEligible`、`resolveDefaultThinkingLevel` 和 `isModernModelRef`，因为它拥有 Claude 4.6 前向兼容、provider 家族提示、身份验证修复指导、usage 端点集成、提示词缓存资格以及 Claude 默认/自适应 thinking 策略。
- OpenAI 使用 `resolveDynamicModel`、`normalizeResolvedModel` 和 `capabilities`，以及 `buildMissingAuthMessage`、`suppressBuiltInModel`、`augmentModelCatalog`、`supportsXHighThinking` 和 `isModernModelRef`，因为它拥有 GPT-5.4 前向兼容、直接 OpenAI `openai-completions` -> `openai-responses` 规范化、支持 Codex 的身份验证提示、Spark 抑制、合成 OpenAI 列表行以及 GPT-5 thinking / live-model 策略。
- OpenRouter 使用 `catalog` 以及 `resolveDynamicModel` 和 `prepareDynamicModel`，因为该 provider 是透传型的，可能会在 OpenClaw 静态目录更新之前暴露新的 model id。
- GitHub Copilot 使用 `catalog`、`auth`、`resolveDynamicModel` 和 `capabilities`，以及 `prepareRuntimeAuth` 和 `fetchUsageSnapshot`，因为它需要 provider 自有设备登录、模型回退行为、Claude 转录差异、GitHub token -> Copilot token 交换，以及 provider 自有 usage 端点。
- OpenAI Codex 使用 `catalog`、`resolveDynamicModel`、`normalizeResolvedModel`、`refreshOAuth` 和 `augmentModelCatalog`，以及 `prepareExtraParams`、`resolveUsageAuth` 和 `fetchUsageSnapshot`，因为它仍运行在核心 OpenAI 传输之上，但拥有自己的传输/base URL 规范化、OAuth 刷新后备策略、默认传输选择、合成 Codex 目录行以及 ChatGPT usage 端点集成。
- Google AI Studio 和 Gemini CLI OAuth 使用 `resolveDynamicModel` 和 `isModernModelRef`，因为它们拥有 Gemini 3.1 前向兼容后备和现代模型匹配；Gemini CLI OAuth 还使用 `formatApiKey`、`resolveUsageAuth` 和 `fetchUsageSnapshot` 来处理令牌格式化、令牌解析和 quota 端点接线。
- OpenRouter 使用 `capabilities`、`wrapStreamFn` 和 `isCacheTtlEligible`，以便将 provider 特定的请求头、路由元数据、reasoning 补丁和提示词缓存策略从核心中移出。
- Moonshot 使用 `catalog` 和 `wrapStreamFn`，因为它仍使用共享 OpenAI 传输，但需要 provider 自有 thinking 负载规范化。
- Kilocode 使用 `catalog`、`capabilities`、`wrapStreamFn` 和 `isCacheTtlEligible`，因为它需要 provider 自有请求头、reasoning 负载规范化、Gemini 转录提示和 Anthropic cache-TTL 门控。
- Z.AI 使用 `resolveDynamicModel`、`prepareExtraParams`、`wrapStreamFn`、`isCacheTtlEligible`、`isBinaryThinking`、`isModernModelRef`、`resolveUsageAuth` 和 `fetchUsageSnapshot`，因为它拥有 GLM-5 后备、`tool_stream` 默认值、二元 thinking UX、现代模型匹配，以及 usage 身份验证 + quota 抓取。
- Mistral、OpenCode Zen 和 OpenCode Go 仅使用 `capabilities`，以便将转录/工具差异移出核心。
- 仅目录型的捆绑 provider，例如 `byteplus`、`cloudflare-ai-gateway`、`huggingface`、`kimi-coding`、`modelstudio`、`nvidia`、`qianfan`、`synthetic`、`together`、`venice`、`vercel-ai-gateway` 和 `volcengine`，仅使用 `catalog`。
- Qwen portal 使用 `catalog`、`auth` 和 `refreshOAuth`。
- MiniMax 和 Xiaomi 使用 `catalog` 加 usage hooks，因为尽管推理仍通过共享传输运行，但它们的 `/usage` 行为由插件拥有。

## 加载流水线

启动时，OpenClaw 大致会执行以下步骤：

1. 发现候选插件根目录
2. 读取原生或兼容 bundle 的 manifest 和包元数据
3. 拒绝不安全的候选项
4. 规范化插件配置（`plugins.enabled`、`allow`、`deny`、`entries`、`slots`、`load.paths`）
5. 决定每个候选项的启用状态
6. 通过 jiti 加载已启用的原生模块
7. 调用原生 `register(api)` hooks，并将注册内容收集到插件注册表中
8. 将注册表暴露给命令/运行时表面

安全门会在运行时执行 **之前** 发生。
当条目逃逸出插件根目录、路径对所有人可写，或对于非捆绑插件来说路径所有权看起来可疑时，候选项会被阻止。

### 清单优先行为

Manifest 是控制面的事实来源。OpenClaw 用它来：

- 识别插件
- 发现声明的渠道/skills/配置 schema 或 bundle 能力
- 验证 `plugins.entries.<id>.config`
- 增强 Control UI 标签/占位符
- 显示安装/目录元数据

对于原生插件，运行时模块是数据面部分。它注册实际行为，例如 hooks、工具、命令或 provider 流程。

### 加载器缓存了什么

OpenClaw 会保留短期进程内缓存，用于：

- 发现结果
- manifest 注册表数据
- 已加载的插件注册表

这些缓存可以减少突发启动和重复命令开销。你可以将它们理解为短生命周期的性能缓存，而不是持久化存储。

## 运行时辅助工具

插件可以通过 `api.runtime` 访问部分核心辅助工具。对于电话 TTS：

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

说明：

- 使用核心 `messages.tts` 配置（OpenAI 或 ElevenLabs）。
- 返回 PCM 音频缓冲区 + 采样率。插件必须为 provider 重新采样/编码。
- Edge TTS 不支持电话场景。

对于 STT/转录，插件可以调用：

```ts
const { text } = await api.runtime.stt.transcribeAudioFile({
  filePath: "/tmp/inbound-audio.ogg",
  cfg: api.config,
  // 当无法可靠推断 MIME 时可选：
  mime: "audio/ogg",
});
```

说明：

- 使用核心媒体理解音频配置（`tools.media.audio`）和 provider 后备顺序。
- 当没有生成转录输出时（例如输入被跳过/不受支持），返回 `{ text: undefined }`。

## Gateway HTTP 路由

插件可以使用 `api.registerHttpRoute(...)` 公开 HTTP 端点。

```ts
api.registerHttpRoute({
  path: "/acme/webhook",
  auth: "plugin",
  match: "exact",
  handler: async (_req, res) => {
    res.statusCode = 200;
    res.end("ok");
    return true;
  },
});
```

路由字段：

- `path`：Gateway 网关 HTTP 服务器下的路由路径。
- `auth`：必填。使用 `"gateway"` 以要求常规 gateway 身份验证，或使用 `"plugin"` 以进行插件管理的身份验证/webhook 验证。
- `match`：可选。`"exact"`（默认）或 `"prefix"`。
- `replaceExisting`：可选。允许同一插件替换自身现有的路由注册。
- `handler`：当路由处理了请求时返回 `true`。

说明：

- `api.registerHttpHandler(...)` 已过时。请使用 `api.registerHttpRoute(...)`。
- 插件路由必须显式声明 `auth`。
- 除非设置 `replaceExisting: true`，否则精确 `path + match` 冲突会被拒绝，而且一个插件不能替换另一个插件的路由。
- 具有不同 `auth` 级别的重叠路由会被拒绝。请仅在相同 auth 级别上保留 `exact`/`prefix` 贯穿链。

## Plugin SDK 导入路径

编写插件时，请使用 SDK 子路径，而不是单体式 `openclaw/plugin-sdk` 导入：

- `openclaw/plugin-sdk/core` 用于通用插件 API、provider 身份验证类型和共享辅助工具。
- `openclaw/plugin-sdk/compat` 用于比 `core` 需要更广泛共享运行时辅助工具的捆绑/内部插件代码。
- `openclaw/plugin-sdk/telegram` 用于 Telegram 渠道插件。
- `openclaw/plugin-sdk/discord` 用于 Discord 渠道插件。
- `openclaw/plugin-sdk/slack` 用于 Slack 渠道插件。
- `openclaw/plugin-sdk/signal` 用于 Signal 渠道插件。
- `openclaw/plugin-sdk/imessage` 用于 iMessage 渠道插件。
- `openclaw/plugin-sdk/whatsapp` 用于 WhatsApp 渠道插件。
- `openclaw/plugin-sdk/line` 用于 LINE 渠道插件。
- `openclaw/plugin-sdk/msteams` 用于捆绑的 Microsoft Teams 插件表面。
- 也提供捆绑扩展专用子路径：
  `openclaw/plugin-sdk/acpx`、`openclaw/plugin-sdk/bluebubbles`、
  `openclaw/plugin-sdk/copilot-proxy`、`openclaw/plugin-sdk/device-pair`、
  `openclaw/plugin-sdk/diagnostics-otel`、`openclaw/plugin-sdk/diffs`、
  `openclaw/plugin-sdk/feishu`、`openclaw/plugin-sdk/googlechat`、
  `openclaw/plugin-sdk/irc`、`openclaw/plugin-sdk/llm-task`、
  `openclaw/plugin-sdk/lobster`、`openclaw/plugin-sdk/matrix`、
  `openclaw/plugin-sdk/mattermost`、`openclaw/plugin-sdk/memory-core`、
  `openclaw/plugin-sdk/memory-lancedb`、
  `openclaw/plugin-sdk/minimax-portal-auth`、
  `openclaw/plugin-sdk/nextcloud-talk`、`openclaw/plugin-sdk/nostr`、
  `openclaw/plugin-sdk/open-prose`、`openclaw/plugin-sdk/phone-control`、
  `openclaw/plugin-sdk/synology-chat`、
  `openclaw/plugin-sdk/talk-voice`、`openclaw/plugin-sdk/test-utils`、
  `openclaw/plugin-sdk/thread-ownership`、`openclaw/plugin-sdk/tlon`、
  `openclaw/plugin-sdk/twitch`、`openclaw/plugin-sdk/voice-call`、
  `openclaw/plugin-sdk/zalo` 和 `openclaw/plugin-sdk/zalouser`。

## Provider 目录

Provider 插件可以使用
`registerProvider({ catalog: { run(...) { ... } } })`
定义用于推理的模型目录。

`catalog.run(...)` 返回与 OpenClaw 写入
`models.providers` 相同的结构：

- `{ provider }` 表示一个 provider 条目
- `{ providers }` 表示多个 provider 条目

当插件拥有 provider 特定的 model id、base URL 默认值或由身份验证控制的模型元数据时，请使用 `catalog`。

`catalog.order` 控制插件目录相对于 OpenClaw 内置隐式 provider 的合并时机：

- `simple`：纯 API 密钥或环境变量驱动的 provider
- `profile`：当存在 auth profile 时出现的 provider
- `paired`：会合成多个相关 provider 条目的 provider
- `late`：最后一轮，在其他隐式 provider 之后

后出现的 provider 会在键冲突时胜出，因此插件可以有意用相同 provider id 覆盖内置 provider 条目。

兼容性：

- `discovery` 仍可作为旧版别名使用
- 如果同时注册了 `catalog` 和 `discovery`，OpenClaw 会使用 `catalog`

兼容性说明：

- `openclaw/plugin-sdk` 仍支持现有外部插件。
- 新的和已迁移的捆绑插件应使用渠道或扩展专用子路径；通用表面使用 `core`，只有在确实需要更广泛共享辅助工具时才使用 `compat`。

## 只读渠道检查

如果你的插件注册了一个渠道，建议与 `resolveAccount(...)` 一起实现
`plugin.config.inspectAccount(cfg, accountId)`。

原因：

- `resolveAccount(...)` 是运行时路径。它可以假定凭据已完全实体化，并在缺少所需 secret 时快速失败。
- 只读命令路径，例如 `openclaw status`、`openclaw status --all`、
  `openclaw channels status`、`openclaw channels resolve` 以及 Doctor/配置修复流程，不应仅为了描述配置就必须实体化运行时凭据。

推荐的 `inspectAccount(...)` 行为：

- 仅返回描述性的账户状态。
- 保留 `enabled` 和 `configured`。
- 在相关时包含凭据来源/状态字段，例如：
  - `tokenSource`、`tokenStatus`
  - `botTokenSource`、`botTokenStatus`
  - `appTokenSource`、`appTokenStatus`
  - `signingSecretSource`、`signingSecretStatus`
- 你无需为了报告只读可用性而返回原始令牌值。返回 `tokenStatus: "available"`（以及匹配的 source 字段）就足够支持状态类命令。
- 当凭据通过 SecretRef 配置，但在当前命令路径中不可用时，请使用 `configured_unavailable`。

这使得只读命令可以报告“已配置，但在此命令路径中不可用”，而不是崩溃或错误地将账户报告为未配置。

性能说明：

- 插件发现和 manifest 元数据使用短期进程内缓存，以减少突发启动/重载工作。
- 设置 `OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE=1` 或
  `OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE=1` 可禁用这些缓存。
- 使用 `OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS` 和
  `OPENCLAW_PLUGIN_MANIFEST_CACHE_MS` 调整缓存窗口。

## 设备发现 + 传输协议优先级

OpenClaw 按以下顺序扫描：

1. 配置路径

- `plugins.load.paths`（文件或目录）

2. 工作区扩展

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. 全局扩展

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. 捆绑扩展（随 OpenClaw 一起提供；默认开启/关闭混合）

- `<openclaw>/extensions/*`

许多捆绑的 provider 插件默认启用，这样模型目录/运行时 hooks 无需额外设置即可使用。其他插件仍需要通过 `plugins.entries.<id>.enabled` 或
`openclaw plugins enable <id>` 显式启用。

默认开启的捆绑插件示例：

- `byteplus`
- `cloudflare-ai-gateway`
- `device-pair`
- `github-copilot`
- `huggingface`
- `kilocode`
- `kimi-coding`
- `minimax`
- `minimax`
- `modelstudio`
- `moonshot`
- `nvidia`
- `ollama`
- `openai`
- `openrouter`
- `phone-control`
- `qianfan`
- `sglang`
- `synthetic`
- `talk-voice`
- `together`
- `venice`
- `vercel-ai-gateway`
- `vllm`
- `volcengine`
- `xiaomi`
- 活跃的 memory 插槽插件（默认插槽：`memory-core`）

已安装的插件默认启用，但也可以用同样方式禁用。

工作区插件 **默认禁用**，除非你显式启用它们或将其加入 allowlist。这是有意设计的：已检出的仓库不应悄悄变成生产 gateway 代码。

加固说明：

- 如果 `plugins.allow` 为空且可发现非捆绑插件，OpenClaw 会在启动时记录一条警告，其中包含 plugin id 和来源。
- 候选路径在被接受进入发现流程前会经过安全检查。当出现以下情况时，OpenClaw 会阻止候选项：
  - 扩展条目解析到插件根目录之外（包括符号链接/路径遍历逃逸），
  - 插件根目录/来源路径对所有人可写，
  - 对于非捆绑插件来说，路径所有权可疑（POSIX owner 既不是当前 uid 也不是 root）。
- 对于缺少安装/加载路径来源信息的已加载非捆绑插件，会发出警告，以便你固定信任（`plugins.allow`）或安装跟踪（`plugins.installs`）。

每个原生 OpenClaw 插件都必须在其根目录中包含一个 `openclaw.plugin.json` 文件。
如果某条路径指向一个文件，则插件根目录是该文件所在目录，并且该目录必须包含该 manifest。

兼容的 bundle 可以改为提供以下之一：

- `.codex-plugin/plugin.json`
- `.claude-plugin/plugin.json`

Bundle 目录会从与原生插件相同的根目录中被发现。

如果多个插件解析为同一个 id，则以上顺序中的第一个匹配项胜出，优先级更低的副本会被忽略。

这意味着：

- 工作区插件会有意覆盖具有相同 id 的捆绑插件
- `plugins.allow: ["foo"]` 按 id 授权活动的 `foo` 插件，即使活动副本来自工作区而非捆绑扩展根目录
- 如果你需要更严格的来源控制，请使用显式安装/加载路径，并在启用前检查解析后的插件来源

### 启用规则

启用状态在发现后解析：

- `plugins.enabled: false` 会禁用所有插件
- `plugins.deny` 总是优先
- `plugins.entries.<id>.enabled: false` 会禁用该插件
- 来源于工作区的插件默认禁用
- 当 `plugins.allow` 非空时，allowlist 会限制活动集合
- allowlist 是 **基于 id** 的，而不是基于来源
- 捆绑插件默认禁用，除非：
  - 捆绑 id 位于内置默认开启集合中，或
  - 你显式启用了它，或
  - 渠道配置隐式启用了捆绑渠道插件
- 独占插槽可强制启用为该插槽选择的插件

在当前核心中，默认开启的捆绑 id 包括上面的本地/provider 辅助工具以及当前活跃的 memory 插槽插件。

### 包集合

插件目录可以包含带有 `openclaw.extensions` 的 `package.json`：

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"],
    "setupEntry": "./src/setup-entry.ts"
  }
}
```

每个条目都会成为一个插件。如果该集合列出多个扩展，则插件 id 将变为 `name/<fileBase>`。

如果你的插件导入 npm 依赖，请在该目录中安装它们，以便 `node_modules` 可用（`npm install` / `pnpm install`）。

安全护栏：每个 `openclaw.extensions` 条目在解析符号链接后都必须保持在插件目录内。逃逸出包目录的条目会被拒绝。

安全说明：`openclaw plugins install` 会使用
`npm install --ignore-scripts` 安装插件依赖（不会运行生命周期脚本）。
请保持插件依赖树为“纯 JS/TS”，并避免需要 `postinstall` 构建的包。

可选项：`openclaw.setupEntry` 可以指向一个轻量级、仅用于 setup 的模块。
当 OpenClaw 需要为一个已禁用的渠道插件提供 setup 表面，或某个渠道插件虽然已启用但仍未配置时，它会加载 `setupEntry`，而不是完整插件入口。
当你的主插件入口还连接了工具、hooks 或其他仅运行时代码时，这能让启动和 setup 更轻量。

### 渠道目录元数据

渠道插件可以通过 `openclaw.channel` 公布 setup/discovery 元数据，并通过 `openclaw.install` 公布安装提示。这使核心目录保持无数据化。

示例：

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk (self-hosted)",
      "docsPath": "/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "通过 Nextcloud Talk webhook bot 提供的自托管聊天。",
      "order": 65,
      "aliases": ["nc-talk", "nc"]
    },
    "install": {
      "npmSpec": "@openclaw/nextcloud-talk",
      "localPath": "extensions/nextcloud-talk",
      "defaultChoice": "npm"
    }
  }
}
```

OpenClaw 还可以合并 **外部渠道目录**（例如 MPM registry 导出）。
将 JSON 文件放到以下任一位置：

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

或者将 `OPENCLAW_PLUGIN_CATALOG_PATHS`（或 `OPENCLAW_MPM_CATALOG_PATHS`）指向一个或多个 JSON 文件（用逗号/分号/`PATH` 分隔）。
每个文件应包含
`{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`。

## Plugin ID

默认 plugin id：

- 包集合：`package.json` 中的 `name`
- 独立文件：文件基础名（`~/.../voice-call.ts` → `voice-call`）

如果插件导出 `id`，OpenClaw 会使用它，但如果它与配置的 id 不匹配，则会发出警告。

## 注册表模型

已加载的插件不会直接修改任意核心全局对象。它们会注册到一个中央插件注册表中。

该注册表跟踪：

- 插件记录（身份、来源、出处、状态、诊断）
- 工具
- 旧版 hooks 和类型化 hooks
- 渠道
- providers
- Gateway RPC 处理器
- HTTP 路由
- CLI 注册器
- 后台服务
- 插件自有命令

然后，核心功能会从这个注册表中读取，而不是直接与插件模块交互。这样可以保持单向加载：

- 插件模块 -> 注册表注册
- 核心运行时 -> 注册表消费

这种分离对可维护性非常重要。这意味着大多数核心表面只需要一个集成点：“读取注册表”，而不是“为每个插件模块做特殊处理”。

## 配置

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-extension"] },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } },
    },
  },
}
```

字段：

- `enabled`：总开关（默认：true）
- `allow`：allowlist（可选）
- `deny`：denylist（可选；deny 优先）
- `load.paths`：额外的插件文件/目录
- `slots`：独占插槽选择器，例如 `memory` 和 `contextEngine`
- `entries.<id>`：每插件开关 + 配置

配置更改 **需要重启 gateway**。

验证规则（严格）：

- `entries`、`allow`、`deny` 或 `slots` 中出现未知 plugin id 都是 **错误**。
- 未知的 `channels.<id>` 键都是 **错误**，除非某个插件 manifest 声明了该渠道 id。
- 原生插件配置使用嵌入在 `openclaw.plugin.json` 中的 JSON Schema（`configSchema`）进行验证。
- 兼容的 bundle 当前不公开原生 OpenClaw 配置 schema。
- 如果某个插件被禁用，其配置会被保留，并发出 **警告**。

### 禁用 vs 缺失 vs 无效

这些状态有意区分：

- **disabled**：插件存在，但启用规则将其关闭
- **missing**：配置引用了某个 plugin id，但发现过程没有找到它
- **invalid**：插件存在，但其配置与声明的 schema 不匹配

OpenClaw 会保留已禁用插件的配置，因此重新启用它们不会造成破坏。

## Plugin 插槽（独占类别）

某些插件类别是 **独占的**（一次只能有一个处于活动状态）。使用
`plugins.slots` 选择由哪个插件拥有该插槽：

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // 或 "none" 以禁用 memory 插件
      contextEngine: "legacy", // 或某个 plugin id，例如 "lossless-claw"
    },
  },
}
```

支持的独占插槽：

- `memory`：活动 memory 插件（`"none"` 会禁用 memory 插件）
- `contextEngine`：活动上下文引擎插件（`"legacy"` 是内置默认值）

如果多个插件声明了 `kind: "memory"` 或 `kind: "context-engine"`，则只有为该插槽选中的插件会加载。其他插件会被禁用并附带诊断信息。

### 上下文引擎插件

上下文引擎插件拥有会话上下文编排能力，包括摄取、组装和压缩。
通过插件中的 `api.registerContextEngine(id, factory)` 注册它们，然后使用
`plugins.slots.contextEngine` 选择活动引擎。

当你的插件需要替换或扩展默认上下文流水线，而不是仅添加内存搜索或 hooks 时，请使用此方式。

## Control UI（schema + 标签）

Control UI 使用 `config.schema`（JSON Schema + `uiHints`）来渲染更好的表单。

OpenClaw 会在运行时根据已发现的插件增强 `uiHints`：

- 为 `plugins.entries.<id>` / `.enabled` / `.config` 添加每插件标签
- 合并可选的插件提供配置字段提示，路径为：
  `plugins.entries.<id>.config.<field>`

如果你希望插件配置字段显示更好的标签/占位符（并将 secret 标记为敏感），请在插件 manifest 中连同 JSON Schema 一起提供 `uiHints`。

示例：

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": { "type": "string" },
      "region": { "type": "string" }
    }
  },
  "uiHints": {
    "apiKey": { "label": "API Key", "sensitive": true },
    "region": { "label": "Region", "placeholder": "us-east-1" }
  }
}
```

## CLI

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins install <path>                 # 将本地文件/目录复制到 ~/.openclaw/extensions/<id>
openclaw plugins install ./extensions/voice-call # 支持相对路径
openclaw plugins install ./plugin.tgz           # 从本地 tarball 安装
openclaw plugins install ./plugin.zip           # 从本地 zip 安装
openclaw plugins install -l ./extensions/voice-call # link（不复制），用于开发
openclaw plugins install @openclaw/voice-call # 从 npm 安装
openclaw plugins install @openclaw/voice-call --pin # 存储精确解析后的 name@version
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`openclaw plugins list` 会将顶层格式显示为 `openclaw` 或 `bundle`。
详细列表/info 输出还会显示 bundle 子类型（`codex` 或 `claude`）以及已检测到的 bundle 能力。

`plugins update` 仅适用于在 `plugins.installs` 下跟踪的 npm 安装。
如果更新之间存储的完整性元数据发生变化，OpenClaw 会发出警告并要求确认（使用全局 `--yes` 可绕过提示）。

插件也可以注册自己的顶层命令（例如：`openclaw voicecall`）。

## Plugin API（概览）

插件导出形式可以是：

- 一个函数：`(api) => { ... }`
- 一个对象：`{ id, name, configSchema, register(api) { ... } }`

`register(api)` 是插件挂接行为的地方。常见注册包括：

- `registerTool`
- `registerHook`
- `on(...)` 用于类型化生命周期 hooks
- `registerChannel`
- `registerProvider`
- `registerHttpRoute`
- `registerCommand`
- `registerCli`
- `registerContextEngine`
- `registerService`

上下文引擎插件还可以注册一个由运行时拥有的上下文管理器：

```ts
export default function (api) {
  api.registerContextEngine("lossless-claw", () => ({
    info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
    async ingest() {
      return { ingested: true };
    },
    async assemble({ messages }) {
      return { messages, estimatedTokens: 0 };
    },
    async compact() {
      return { ok: true, compacted: false };
    },
  }));
}
```

如果你的引擎**并不拥有**压缩算法，仍然要实现 `compact()`，并显式委托给运行时：

```ts
import { delegateCompactionToRuntime } from "openclaw/plugin-sdk";

export default function (api) {
  api.registerContextEngine("my-memory-engine", () => ({
    info: {
      id: "my-memory-engine",
      name: "My Memory Engine",
      ownsCompaction: false,
    },
    async ingest() {
      return { ingested: true };
    },
    async assemble({ messages }) {
      return { messages, estimatedTokens: 0 };
    },
    async compact(params) {
      return await delegateCompactionToRuntime(params);
    },
  }));
}
```

`ownsCompaction: false` 不会自动回退到 legacy 压缩路径。
只要该引擎处于激活状态，它自己的 `compact()` 仍然会处理 `/compact`
和溢出恢复。

然后在配置中启用它：

```json5
{
  plugins: {
    slots: {
      contextEngine: "lossless-claw",
    },
  },
}
```

## Plugin hooks

插件可以在运行时注册 hooks。这让插件能够打包事件驱动自动化，而无需单独安装 hook pack。

### 示例

```ts
export default function register(api) {
  api.registerHook(
    "command:new",
    async () => {
      // Hook 逻辑写在这里。
    },
    {
      name: "my-plugin.command-new",
      description: "当 /new 被调用时运行",
    },
  );
}
```

说明：

- 通过 `api.registerHook(...)` 显式注册 hooks。
- Hook 资格规则仍然适用（OS/bins/env/config 要求）。
- 插件管理的 hooks 会在 `openclaw hooks list` 中显示为 `plugin:<id>`。
- 你不能通过 `openclaw hooks` 启用/禁用插件管理的 hooks；应改为启用/禁用插件本身。

### 智能体生命周期 hooks（`api.on`）

对于类型化运行时生命周期 hooks，请使用 `api.on(...)`：

```ts
export default function register(api) {
  api.on(
    "before_prompt_build",
    (event, ctx) => {
      return {
        prependSystemContext: "Follow company style guide.",
      };
    },
    { priority: 10 },
  );
}
```

用于提示词构建的重要 hooks：

- `before_model_resolve`：在加载会话之前运行（`messages` 不可用）。用它来确定性地覆盖 `modelOverride` 或 `providerOverride`。
- `before_prompt_build`：在加载会话之后运行（`messages` 可用）。用它来塑造提示词输入。
- `before_agent_start`：旧版兼容 hook。优先使用上面两个更明确的 hooks。

核心强制执行的 hook 策略：

- 操作员可以通过 `plugins.entries.<id>.hooks.allowPromptInjection: false` 按插件禁用提示词变更 hooks。
- 禁用后，OpenClaw 会阻止 `before_prompt_build`，并忽略旧版 `before_agent_start` 返回的提示词变更字段，同时保留旧版 `modelOverride` 和 `providerOverride`。

`before_prompt_build` 结果字段：

- `prependContext`：为本次运行在用户提示词前插入文本。最适合按轮次变化或动态内容。
- `systemPrompt`：完整的系统提示词覆盖。
- `prependSystemContext`：在当前系统提示词前插入文本。
- `appendSystemContext`：在当前系统提示词后追加文本。

嵌入式运行时中的提示词构建顺序：

1. 将 `prependContext` 应用到用户提示词。
2. 如果提供了 `systemPrompt`，则应用其覆盖。
3. 应用 `prependSystemContext + 当前系统提示词 + appendSystemContext`。

合并与优先级说明：

- Hook 处理器按优先级运行（高者优先）。
- 对于合并型上下文字段，值会按执行顺序拼接。
- `before_prompt_build` 的值会在旧版 `before_agent_start` 后备值之前应用。

迁移指导：

- 将静态指导从 `prependContext` 移到 `prependSystemContext`（或 `appendSystemContext`），这样 provider 就可以缓存稳定的系统前缀内容。
- 将 `prependContext` 保留给每轮动态上下文，这类内容应继续与用户消息绑定。

## Provider 插件（模型身份验证）

插件可以注册 **模型 providers**，从而让用户能够在 OpenClaw 内完成 OAuth 或 API 密钥设置、在新手引导/模型选择器中显示 provider 设置，并参与隐式 provider 发现。

Provider 插件现在是模型 provider 设置的模块化扩展接缝。它们不再只是“OAuth 辅助工具”。

### Provider 插件生命周期

一个 provider 插件可以参与五个不同阶段：

1. **身份验证**
   `auth[].run(ctx)` 执行 OAuth、API 密钥采集、设备码或自定义设置，并返回 auth profile 以及可选的配置补丁。
2. **非交互式设置**
   `auth[].runNonInteractive(ctx)` 处理 `openclaw onboard --non-interactive`，且不进行提示。当 provider 需要超出内置简单 API 密钥路径之外的自定义无头设置时，请使用它。
3. **向导集成**
   `wizard.setup` 会向 `openclaw onboard` 添加一个条目。
   `wizard.modelPicker` 会向模型选择器添加一个 setup 条目。
4. **隐式发现**
   `discovery.run(ctx)` 可以在模型解析/列出期间自动贡献 provider 配置。
5. **选择后跟进**
   `onModelSelected(ctx)` 会在模型被选中后运行。可用于 provider 特定的后续工作，例如下载本地模型。

这是推荐的拆分方式，因为这些阶段具有不同的生命周期要求：

- auth 是交互式的，并会写入凭据/配置
- 非交互式设置由 flag/env 驱动，且不能提示
- 向导元数据是静态且面向 UI 的
- discovery 应安全、快速且能容忍失败
- 选择后 hooks 是与所选模型绑定的副作用

### Provider 身份验证契约

`auth[].run(ctx)` 返回：

- `profiles`：要写入的 auth profile
- `configPatch`：可选的 `openclaw.json` 变更
- `defaultModel`：可选的 `provider/model` 引用
- `notes`：可选的面向用户备注

然后核心会：

1. 写入返回的 auth profile
2. 应用 auth-profile 配置接线
3. 合并配置补丁
4. 可选地应用默认模型
5. 在适当时运行 provider 的 `onModelSelected` hook

这意味着 provider 插件拥有 provider 特定的设置逻辑，而核心拥有通用的持久化和配置合并路径。

### Provider 非交互式契约

`auth[].runNonInteractive(ctx)` 是可选的。当 provider 需要无法通过内置通用 API 密钥流表达的无头设置时，请实现它。

非交互式上下文包括：

- 当前配置和基础配置
- 解析后的 onboarding CLI 选项
- 运行时日志/错误辅助工具
- 智能体/工作区目录，以便 provider 将 auth 持久化到与其余 onboarding 相同的作用域存储中
- `resolveApiKey(...)`：在遵守 `--secret-input-mode` 的同时，从 flags、环境变量或现有 auth profile 中读取 provider 密钥
- `toApiKeyCredential(...)`：将解析后的密钥转换为 auth-profile 凭据，并使用正确的明文或 secret-ref 存储方式

适合使用此表面的 provider 包括：

- 需要 `--custom-base-url` + `--custom-model-id` 的自托管 OpenAI 兼容运行时
- 需要 provider 特定非交互式验证或配置合成的场景

不要从 `runNonInteractive` 中发出提示。对于缺失输入，请改为返回可操作的错误。

### Provider 向导元数据

`wizard.setup` 控制 provider 在分组新手引导中的显示方式：

- `choiceId`：auth-choice 值
- `choiceLabel`：选项标签
- `choiceHint`：简短提示
- `groupId`：分组桶 id
- `groupLabel`：分组标签
- `groupHint`：分组提示
- `methodId`：要运行的身份验证方法

`wizard.modelPicker` 控制 provider 在模型选择中作为“现在设置它”条目的显示方式：

- `label`
- `hint`
- `methodId`

当 provider 具有多种身份验证方法时，向导可以显式指向其中一种方法，也可以让 OpenClaw 为每种方法自动生成选择项。

在插件注册时，OpenClaw 会验证 provider 向导元数据：

- 重复或空白的 auth-method id 会被拒绝
- 当 provider 没有身份验证方法时，向导元数据会被忽略
- 无效的 `methodId` 绑定会降级为警告，并回退到 provider 剩余的身份验证方法

### Provider discovery 契约

`discovery.run(ctx)` 返回以下之一：

- `{ provider }`
- `{ providers }`
- `null`

当插件拥有一个 provider id 时，请使用 `{ provider }` 这一常见情况。
当插件发现多个 provider 条目时，请使用 `{ providers }`。

Discovery 上下文包括：

- 当前配置
- 智能体/工作区目录
- 进程环境变量
- 一个用于解析 provider API 密钥以及发现安全 API 密钥值的辅助工具

Discovery 应该：

- 快速
- 尽力而为
- 在失败时可安全跳过
- 谨慎处理副作用

它不应依赖提示或长时间运行的设置。

### 发现顺序

Provider discovery 按有序阶段运行：

- `simple`
- `profile`
- `paired`
- `late`

使用建议：

- `simple`：用于廉价的纯环境变量发现
- `profile`：当发现依赖 auth profile 时使用
- `paired`：用于需要与另一步发现协作的 provider
- `late`：用于昂贵或本地网络探测

大多数自托管 provider 应使用 `late`。

### 良好的 provider-plugin 边界

适合做成 provider 插件的情况：

- 具有自定义设置流程的本地/自托管 providers
- provider 特定的 OAuth/设备码登录
- 对本地模型服务器的隐式发现
- 选择后的副作用，例如拉取模型

不太有说服力的情况：

- 仅在 env var、base URL 和一个默认模型上不同的简单 API 密钥型 provider

这些仍然可以做成插件，但最大的模块化收益来自先抽离那些行为丰富的 providers。

通过 `api.registerProvider(...)` 注册 provider。每个 provider 暴露一个或多个身份验证方法（OAuth、API key、device code 等）。这些方法可以驱动：

- `openclaw models auth login --provider <id> [--method <id>]`
- `openclaw onboard`
- 模型选择器中的“自定义 provider”设置条目
- 模型解析/列出期间的隐式 provider 发现

示例：

```ts
api.registerProvider({
  id: "acme",
  label: "AcmeAI",
  auth: [
    {
      id: "oauth",
      label: "OAuth",
      kind: "oauth",
      run: async (ctx) => {
        // 运行 OAuth 流并返回 auth profile。
        return {
          profiles: [
            {
              profileId: "acme:default",
              credential: {
                type: "oauth",
                provider: "acme",
                access: "...",
                refresh: "...",
                expires: Date.now() + 3600 * 1000,
              },
            },
          ],
          defaultModel: "acme/opus-1",
        };
      },
    },
  ],
  wizard: {
    setup: {
      choiceId: "acme",
      choiceLabel: "AcmeAI",
      groupId: "acme",
      groupLabel: "AcmeAI",
      methodId: "oauth",
    },
    modelPicker: {
      label: "AcmeAI（自定义）",
      hint: "连接一个自托管 AcmeAI 端点",
      methodId: "oauth",
    },
  },
  discovery: {
    order: "late",
    run: async () => ({
      provider: {
        baseUrl: "https://acme.example/v1",
        api: "openai-completions",
        apiKey: "${ACME_API_KEY}",
        models: [],
      },
    }),
  },
});
```

说明：

- `run` 会接收一个 `ProviderAuthContext`，其中包含 `prompter`、`runtime`、
  `openUrl`、`oauth.createVpsAwareHandlers`、`secretInputMode` 和
  `allowSecretRefPrompt` 辅助工具/状态。新手引导/配置流程可以用它们来遵守 `--secret-input-mode`，或提供 env/file/exec secret-ref 采集，而 `openclaw models auth` 会保持更严格的提示表面。
- `runNonInteractive` 会接收一个 `ProviderAuthMethodNonInteractiveContext`，
  其中包含 `opts`、`agentDir`、`resolveApiKey` 和 `toApiKeyCredential` 辅助工具，用于无头 onboarding。
- 当你需要添加默认模型或 provider 配置时，请返回 `configPatch`。
- 返回 `defaultModel`，这样 `--set-default` 就能更新智能体默认值。
- `wizard.setup` 会向 `openclaw onboard` 添加一个 provider 选项。
- `wizard.modelPicker` 会向模型选择器添加一个“设置此 provider”条目。
- `discovery.run` 对于插件自有 provider id 返回 `{ provider }`，对于多 provider 发现返回 `{ providers }`。
- `discovery.order` 控制该 provider 相对于内置发现阶段的运行时机：`simple`、`profile`、`paired` 或 `late`。
- `onModelSelected` 是选择后的 hook，用于 provider 特定的后续工作，例如拉取本地模型。

### 注册一个消息渠道

插件可以注册 **渠道插件**，其行为类似内置渠道
（WhatsApp、Telegram 等）。渠道配置位于 `channels.<id>` 下，并由你的渠道插件代码进行验证。

```ts
const myChannel = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "演示渠道插件。",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async () => ({ ok: true }),
  },
};

export default function (api) {
  api.registerChannel({ plugin: myChannel });
}
```

说明：

- 将配置放在 `channels.<id>` 下（而不是 `plugins.entries`）。
- `meta.label` 用于 CLI/UI 列表中的标签。
- `meta.aliases` 会为规范化和 CLI 输入添加备用 id。
- `meta.preferOver` 列出当两者都已配置时应跳过自动启用的渠道 id。
- `meta.detailLabel` 和 `meta.systemImage` 让 UI 能显示更丰富的渠道标签/图标。

### 渠道 setup hooks

推荐的 setup 拆分：

- `plugin.setup` 负责账户 id 规范化、验证和配置写入。
- `plugin.setupWizard` 让宿主运行通用向导流程，而渠道只提供状态、凭据、私信 allowlist 和渠道访问描述符。

`plugin.setupWizard` 最适合符合共享模式的渠道：

- 一个由 `plugin.config.listAccountIds` 驱动的账户选择器
- 在提示前执行可选的预检/准备步骤（例如安装器/引导工作）
- 为捆绑凭据集提供可选的环境变量快捷提示（例如成对 bot/app token）
- 一个或多个凭据提示，每一步要么通过 `plugin.setup.applyAccountConfig` 写入，要么通过渠道自有部分补丁写入
- 可选的非 secret 文本提示（例如 CLI 路径、base URL、账户 id）
- 可选的由宿主解析的渠道/群组访问 allowlist 提示
- 可选的私信 allowlist 解析（例如 `@username` -> 数字 id）
- setup 完成后的可选完成说明

### 编写一个新的消息渠道（分步说明）

当你想要一个 **新的聊天表面**（即“消息渠道”），而不是模型 provider 时，请使用本节。
模型 provider 文档位于 `/providers/*`。

1. 选择一个 id + 配置结构

- 所有渠道配置都位于 `channels.<id>` 下。
- 对于多账户设置，优先使用 `channels.<id>.accounts.<accountId>`。

2. 定义渠道元数据

- `meta.label`、`meta.selectionLabel`、`meta.docsPath`、`meta.blurb` 控制 CLI/UI 列表。
- `meta.docsPath` 应指向类似 `/channels/<id>` 的文档页面。
- `meta.preferOver` 允许一个插件替换另一个渠道（自动启用时优先它）。
- `meta.detailLabel` 和 `meta.systemImage` 供 UI 用于详情文字/图标。

3. 实现所需适配器

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities`（聊天类型、媒体、线程等）
- `outbound.deliveryMode` + `outbound.sendText`（基础发送）

4. 视需要添加可选适配器

- `setup`（验证 + 配置写入）、`setupWizard`（宿主拥有的向导）、`security`（私信策略）、`status`（健康/诊断）
- `gateway`（启动/停止/登录）、`mentions`、`threading`、`streaming`
- `actions`（消息动作）、`commands`（原生命令行为）

5. 在你的插件中注册该渠道

- `api.registerChannel({ plugin })`

最小配置示例：

```json5
{
  channels: {
    acmechat: {
      accounts: {
        default: { token: "ACME_TOKEN", enabled: true },
      },
    },
  },
}
```

最小渠道插件（仅出站）：

```ts
const plugin = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "AcmeChat 消息渠道。",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text }) => {
      // 在这里将 `text` 发送到你的渠道
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

加载插件（扩展目录或 `plugins.load.paths`），重启 gateway，
然后在配置中设置 `channels.<id>`。

### 智能体工具

请参阅专门指南：[Plugin agent tools](/plugins/agent-tools)。

### 注册一个 Gateway RPC 方法

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### 注册 CLI 命令

```ts
export default function (api) {
  api.registerCli(
    ({ program }) => {
      program.command("mycmd").action(() => {
        console.log("Hello");
      });
    },
    { commands: ["mycmd"] },
  );
}
```

### 注册自动回复命令

插件可以注册自定义 slash 命令，这些命令 **无需调用 AI 智能体** 即可执行。
这对开关命令、状态检查或不需要 LLM 处理的快捷操作非常有用。

```ts
export default function (api) {
  api.registerCommand({
    name: "mystatus",
    description: "显示插件状态",
    handler: (ctx) => ({
      text: `插件正在运行！渠道：${ctx.channel}`,
    }),
  });
}
```

命令处理器上下文：

- `senderId`：发送者的 ID（如果可用）
- `channel`：发送命令的渠道
- `isAuthorizedSender`：发送者是否为已授权用户
- `args`：命令后的参数（如果 `acceptsArgs: true`）
- `commandBody`：完整命令文本
- `config`：当前 OpenClaw 配置

命令选项：

- `name`：命令名（不含前导 `/`）
- `nativeNames`：可选的原生命令别名，用于 slash/menu 表面。对所有原生 provider 使用 `default`，或使用如 `discord` 这样的 provider 特定键
- `description`：在命令列表中显示的帮助文本
- `acceptsArgs`：命令是否接受参数（默认：false）。如果为 false 且提供了参数，则命令不会匹配，消息会继续传递给其他处理器
- `requireAuth`：是否要求发送者已授权（默认：true）
- `handler`：返回 `{ text: string }` 的函数（可以是异步）

带授权和参数的示例：

```ts
api.registerCommand({
  name: "setmode",
  description: "设置插件模式",
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx) => {
    const mode = ctx.args?.trim() || "default";
    await saveMode(mode);
    return { text: `模式已设置为：${mode}` };
  },
});
```

说明：

- 插件命令会在内置命令和 AI 智能体 **之前** 处理
- 命令是全局注册的，适用于所有渠道
- 命令名不区分大小写（`/MyStatus` 可匹配 `/mystatus`）
- 命令名必须以字母开头，并且只能包含字母、数字、连字符和下划线
- 保留命令名（如 `help`、`status`、`reset` 等）不能被插件覆盖
- 插件间重复注册命令会因诊断错误而失败

### 注册后台服务

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## 命名约定

- Gateway 方法：`pluginId.action`（例如：`voicecall.status`）
- 工具：`snake_case`（例如：`voice_call`）
- CLI 命令：kebab 或 camel，但避免与核心命令冲突

## Skills

插件可以在仓库中附带一个 skill（`skills/<name>/SKILL.md`）。
通过 `plugins.entries.<id>.enabled`（或其他配置门控）启用它，并确保它存在于你的工作区/托管 skills 位置中。

## 分发（npm）

推荐打包方式：

- 主包：`openclaw`（本仓库）
- 插件：位于 `@openclaw/*` 下的独立 npm 包（例如：`@openclaw/voice-call`）

发布契约：

- 插件 `package.json` 必须包含 `openclaw.extensions`，并指向一个或多个入口文件。
- 可选：`openclaw.setupEntry` 可指向一个轻量级的仅 setup 入口，用于已禁用或尚未配置完成的渠道 setup。
- 入口文件可以是 `.js` 或 `.ts`（jiti 会在运行时加载 TS）。
- `openclaw plugins install <npm-spec>` 会使用 `npm pack`，提取到 `~/.openclaw/extensions/<id>/`，并在配置中启用它。
- 配置键稳定性：带 scope 的包会被规范化为 **无 scope** 的 id，用于 `plugins.entries.*`。

## 示例插件：Voice Call

本仓库包含一个 voice-call 插件（Twilio 或日志回退）：

- 源码：`extensions/voice-call`
- Skill：`skills/voice-call`
- CLI：`openclaw voicecall start|status`
- 工具：`voice_call`
- RPC：`voicecall.start`、`voicecall.status`
- 配置（twilio）：`provider: "twilio"` + `twilio.accountSid/authToken/from`（可选 `statusCallbackUrl`、`twimlUrl`）
- 配置（开发）：`provider: "log"`（无网络）

有关设置和用法，请参阅 [Voice Call](/plugins/voice-call) 和 `extensions/voice-call/README.md`。

## 安全说明

插件与 Gateway 网关在同一进程内运行。请将它们视为受信任代码：

- 只安装你信任的插件。
- 优先使用 `plugins.allow` allowlist。
- 请记住，`plugins.allow` 是基于 id 的，因此已启用的工作区插件可以有意覆盖具有相同 id 的捆绑插件。
- 更改后请重启 Gateway 网关。

## 测试插件

插件可以（也应该）附带测试：

- 仓库内插件可以将 Vitest 测试放在 `src/**` 下（例如：`src/plugins/voice-call.plugin.test.ts`）。
- 单独发布的插件应运行自己的 CI（lint/build/test），并验证 `openclaw.extensions` 指向构建后的入口点（`dist/index.js`）。
