---
title: "插件 SDK 概述"
sidebarTitle: "SDK 概述"
summary: "导入映射、注册 API 参考和 SDK 架构"
read_when:
  - 您需要知道从哪个 SDK 子路径导入
  - 您想要 OpenClawPluginApi 上所有注册方法的参考
  - 您正在查找特定的 SDK 导出
---

# 插件 SDK 概述

插件 SDK 是插件和核心之间的类型化契约。本页面是**导入什么**和**可以注册什么**的参考。

<Tip>
  **正在寻找操作指南？**
  - 第一个插件？从 [入门](/plugins/building-plugins) 开始
  - 通道插件？请参阅 [通道插件](/plugins/sdk-channel-plugins)
  - 提供者插件？请参阅 [提供者插件](/plugins/sdk-provider-plugins)
</Tip>

## 导入约定

始终从特定子路径导入：

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
```

每个子路径都是一个小的、自包含的模块。这保持启动快速并
防止循环依赖问题。对于通道特定的入口/构建助手，
优先使用 `openclaw/plugin-sdk/channel-core`；将 `openclaw/plugin-sdk/core` 用于
更广泛的伞形表面和共享助手，如
`buildChannelConfigSchema`。

不要添加或依赖提供者命名的便利接缝，如
`openclaw/plugin-sdk/slack`、`openclaw/plugin-sdk/discord`、
`openclaw/plugin-sdk/signal`、`openclaw/plugin-sdk/whatsapp` 或
通道品牌化的助手接缝。捆绑插件应在其自己的 `api.ts` 或 `runtime-api.ts` 桶中组合通用
SDK 子路径，核心
应使用这些插件本地桶或在需求真正跨通道时添加狭窄的通用 SDK
契约。

生成的导出映射仍然包含一小组捆绑插件助手
接缝，如 `plugin-sdk/feishu`、`plugin-sdk/feishu-setup`、
`plugin-sdk/zalo`、`plugin-sdk/zalo-setup` 和 `plugin-sdk/matrix*`。这些
子路径仅用于捆绑插件维护和兼容性；它们
有意从下面的公共表中省略，不是新第三方插件的推荐
导入路径。

## 子路径参考

按用途分组的最常用子路径。200+ 个子路径的生成完整列表位于 `scripts/lib/plugin-sdk-entrypoints.json` 中。

保留的捆绑插件助手子路径仍然出现在该生成列表中。
将这些视为实现细节/兼容性表面，除非文档页面
明确将其中一个提升为公共。

### 插件入口

| 子路径                      | 主要导出                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin-sdk/plugin-entry`   | `definePluginEntry`                                                                                                                    |
| `plugin-sdk/core`           | `defineChannelPluginEntry`、`createChatChannelPlugin`、`createChannelPluginBase`、`defineSetupPluginEntry`、`buildChannelConfigSchema` |
| `plugin-sdk/config-schema`  | `OpenClawSchema`                                                                                                                       |
| `plugin-sdk/provider-entry` | `defineSingleProviderPluginEntry`                                                                                                      |

<AccordionGroup>
  <Accordion title="通道子路径">
    | 子路径 | 主要导出 |
    | --- | --- |
    | `plugin-sdk/channel-core` | `defineChannelPluginEntry`、`defineSetupPluginEntry`、`createChatChannelPlugin`、`createChannelPluginBase` |
    | `plugin-sdk/config-schema` | 根 `openclaw.json` Zod 模式导出 (`OpenClawSchema`) |
    | `plugin-sdk/channel-setup` | `createOptionalChannelSetupSurface`、`createOptionalChannelSetupAdapter`、`createOptionalChannelSetupWizard`，以及 `DEFAULT_ACCOUNT_ID`、`createTopLevelChannelDmPolicy`、`setSetupChannelEnabled`、`splitSetupEntries` |
    | `plugin-sdk/setup` | 共享设置向导助手、允许列表提示、设置状态构建器 |
    | `plugin-sdk/setup-runtime` | `createPatchedAccountSetupAdapter`、`createEnvPatchedAccountSetupAdapter`、`createSetupInputPresenceValidator`、`noteChannelLookupFailure`、`noteChannelLookupSummary`、`promptResolvedAllowFrom`、`splitSetupEntries`、`createAllowlistSetupWizardProxy`、`createDelegatedSetupWizardProxy` |
    | `plugin-sdk/setup-adapter-runtime` | `createEnvPatchedAccountSetupAdapter` |
    | `plugin-sdk/setup-tools` | `formatCliCommand`、`detectBinary`、`extractArchive`、`resolveBrewExecutable`、`formatDocsLink`、`CONFIG_DIR` |
    | `plugin-sdk/account-core` | 多账户配置/动作门助手、默认账户回退助手 |
    | `plugin-sdk/account-id` | `DEFAULT_ACCOUNT_ID`、账户 ID 规范化助手 |
    | `plugin-sdk/account-resolution` | 账户查找 + 默认回退助手 |
    | `plugin-sdk/account-helpers` | 狭窄的账户列表/账户动作助手 |
    | `plugin-sdk/channel-pairing` | `createChannelPairingController` |
    | `plugin-sdk/channel-reply-pipeline` | `createChannelReplyPipeline` |
    | `plugin-sdk/channel-config-helpers` | `createHybridChannelConfigAdapter` |
    | `plugin-sdk/channel-config-schema` | 通道配置模式类型 |
    | `plugin-sdk/telegram-command-config` | Telegram 自定义命令规范化/验证助手，带有捆绑契约回退 |
    | `plugin-sdk/command-gating` | 狭窄的命令授权门助手 |
    | `plugin-sdk/channel-policy` | `resolveChannelGroupRequireMention` |
    | `plugin-sdk/channel-lifecycle` | `createAccountStatusSink` |
    | `plugin-sdk/inbound-envelope` | 共享入站路由 + 信封构建器助手 |
    | `plugin-sdk/inbound-reply-dispatch` | 共享入站记录和调度助手 |
    | `plugin-sdk/messaging-targets` | 目标解析/匹配助手 |
    | `plugin-sdk/outbound-media` | 共享出站媒体加载助手 |
    | `plugin-sdk/outbound-runtime` | 出站身份/发送委托助手 |
    | `plugin-sdk/poll-runtime` | 狭窄的轮询规范化助手 |
    | `plugin-sdk/thread-bindings-runtime` | 线程绑定生命周期和适配器助手 |
    | `plugin-sdk/agent-media-payload` | 遗留代理媒体有效载荷构建器 |
    | `plugin-sdk/conversation-runtime` | 对话/线程绑定、配对和配置绑定助手 |
    | `plugin-sdk/runtime-config-snapshot` | 运行时配置快照助手 |
    | `plugin-sdk/runtime-group-policy` | 运行时组策略解析助手 |
    | `plugin-sdk/channel-status` | 共享通道状态快照/摘要助手 |
    | `plugin-sdk/channel-config-primitives` | 狭窄的通道配置模式原语 |
    | `plugin-sdk/channel-config-writes` | 通道配置写入授权助手 |
    | `plugin-sdk/channel-plugin-common` | 共享通道插件前奏导出 |
    | `plugin-sdk/allowlist-config-edit` | 允许列表配置编辑/读取助手 |
    | `plugin-sdk/group-access` | 共享组访问决策助手 |
    | `plugin-sdk/direct-dm` | 共享直接 DM 认证/保护助手 |
    | `plugin-sdk/interactive-runtime` | 交互式回复有效载荷规范化/减少助手 |
    | `plugin-sdk/channel-inbound` | 入站去抖动、提及匹配、提及策略助手和信封助手的兼容性桶 |
    | `plugin-sdk/channel-mention-gating` | 狭窄的提及策略助手，无更广泛的入站运行时表面 |
    | `plugin-sdk/channel-location` | 通道位置上下文和格式化助手 |
    | `plugin-sdk/channel-logging` | 通道日志助手，用于入站丢弃和打字/确认失败 |
    | `plugin-sdk/channel-send-result` | 回复结果类型 |
    | `plugin-sdk/channel-actions` | `createMessageToolButtonsSchema`、`createMessageToolCardSchema` |
    | `plugin-sdk/channel-targets` | 目标解析/匹配助手 |
    | `plugin-sdk/channel-contract` | 通道契约类型 |
    | `plugin-sdk/channel-feedback` | 反馈/反应接线 |
    | `plugin-sdk/channel-secret-runtime` | 狭窄的秘密契约助手，如 `collectSimpleChannelFieldAssignments`、`getChannelSurface`、`pushAssignment` 和秘密目标类型 |
  </Accordion>

  <Accordion title="提供者子路径">
    | 子路径 | 主要导出 |
    | --- | --- |
    | `plugin-sdk/provider-entry` | `defineSingleProviderPluginEntry` |
    | `plugin-sdk/provider-setup` | 精选的本地/自托管提供者设置助手 |
    | `plugin-sdk/self-hosted-provider-setup` | 专注的 OpenAI 兼容自托管提供者设置助手 |
    | `plugin-sdk/cli-backend` | CLI 后端默认值 + 看门狗常量 |
    | `plugin-sdk/provider-auth-runtime` | 提供者插件的运行时 API 密钥解析助手 |
    | `plugin-sdk/provider-auth-api-key` | API 密钥入职/配置文件写入助手，如 `upsertApiKeyProfile` |
    | `plugin-sdk/provider-auth-result` | 标准 OAuth 认证结果构建器 |
    | `plugin-sdk/provider-auth-login` | 提供者插件的共享交互式登录助手 |
    | `plugin-sdk/provider-env-vars` | 提供者认证环境变量查找助手 |
    | `plugin-sdk/provider-auth` | `createProviderApiKeyAuthMethod`、`ensureApiKeyFromOptionEnvOrPrompt`、`upsertAuthProfile`、`upsertApiKeyProfile`、`writeOAuthCredentials` |
    | `plugin-sdk/provider-model-shared` | `ProviderReplayFamily`、`buildProviderReplayFamilyHooks`、`normalizeModelCompat`、共享重放策略构建器、提供者端点助手，以及模型 ID 规范化助手，如 `normalizeNativeXaiModelId` |
    | `plugin-sdk/provider-catalog-shared` | `findCatalogTemplate`、`buildSingleProviderApiKeyCatalog`、`supportsNativeStreamingUsageCompat`、`applyProviderNativeStreamingUsageCompat` |
    | `plugin-sdk/provider-http` | 通用提供者 HTTP/端点能力助手 |
    | `plugin-sdk/provider-web-fetch-contract` | 狭窄的网络获取配置/选择契约助手，如 `enablePluginInConfig` 和 `WebFetchProviderPlugin` |
    | `plugin-sdk/provider-web-fetch` | 网络获取提供者注册/缓存助手 |
    | `plugin-sdk/provider-web-search-config-contract` | 狭窄的网络搜索配置/凭证助手，适用于不需要插件启用接线的提供者 |
    | `plugin-sdk/provider-web-search-contract` | 狭窄的网络搜索配置/凭证契约助手，如 `createWebSearchProviderContractFields`、`enablePluginInConfig`、`resolveProviderWebSearchPluginConfig` 和范围凭证设置器/获取器 |
    | `plugin-sdk/provider-web-search` | 网络搜索提供者注册/缓存/运行时助手 |
    | `plugin-sdk/provider-tools` | `ProviderToolCompatFamily`、`buildProviderToolCompatFamilyHooks`、Gemini 模式清理 + 诊断，以及 xAI 兼容助手，如 `resolveXaiModelCompatPatch` / `applyXaiModelCompat` |
    | `plugin-sdk/provider-usage` | `fetchClaudeUsage` 等 |
    | `plugin-sdk/provider-stream` | `ProviderStreamFamily`、`buildProviderStreamFamilyHooks`、`composeProviderStreamWrappers`、流包装器类型，以及共享 Anthropic/Bedrock/Google/Kilocode/Moonshot/OpenAI/OpenRouter/Z.A.I/MiniMax/Copilot 包装器助手 |
    | `plugin-sdk/provider-transport-runtime` | 原生提供者传输助手，如受保护的 fetch、传输消息转换和可写传输事件流 |
    | `plugin-sdk/provider-onboard` | 入职配置补丁助手 |
    | `plugin-sdk/global-singleton` | 进程本地单例/映射/缓存助手 |
  </Accordion>

  <Accordion title="认证和安全子路径">
    | 子路径 | 主要导出 |
    | --- | --- |
    | `plugin-sdk/command-auth` | `resolveControlCommandGate`、命令注册表助手、发送者授权助手 |
    | `plugin-sdk/command-status` | 命令/帮助消息构建器，如 `buildCommandsMessagePaginated` 和 `buildHelpMessage` |
    | `plugin-sdk/approval-auth-runtime` | 审批者解析和同聊动作认证助手 |
    | `plugin-sdk/approval-client-runtime` | 原生执行审批配置文件/过滤器助手 |
    | `plugin-sdk/approval-delivery-runtime` | 原生审批能力/交付适配器 |
    | `plugin-sdk/approval-gateway-runtime` | 共享审批网关解析助手 |
    | `plugin-sdk/approval-handler-adapter-runtime` | 轻量级原生审批适配器加载助手，用于热通道入口点 |
    | `plugin-sdk/approval-handler-runtime` | 更广泛的审批处理程序运行时助手；当足够时，优先使用更窄的适配器/网关接缝 |
    | `plugin-sdk/approval-native-runtime` | 原生审批目标 + 账户绑定助手 |
    | `plugin-sdk/approval-reply-runtime` | 执行/插件审批回复有效载荷助手 |
    | `plugin-sdk/command-auth-native` | 原生命令认证 + 原生会话目标助手 |
    | `plugin-sdk/command-detection` | 共享命令检测助手 |
    | `plugin-sdk/command-surface` | 命令体规范化和命令表面助手 |
    | `plugin-sdk/allow-from` | `formatAllowFromLowercase` |
    | `plugin-sdk/channel-secret-runtime` | 通道/插件秘密表面的狭窄秘密契约收集助手 |
    | `plugin-sdk/secret-ref-runtime` | 用于秘密契约/配置解析的狭窄 `coerceSecretRef` 和 SecretRef 类型化助手 |
    | `plugin-sdk/security-runtime` | 共享信任、DM 门控、外部内容和秘密收集助手 |
    | `plugin-sdk/ssrf-policy` | 主机允许列表和私有网络 SSRF 策略助手 |
    | `plugin-sdk/ssrf-dispatcher` | 狭窄的固定调度器助手，无广泛的基础设施运行时表面 |
    | `plugin-sdk/ssrf-runtime` | 固定调度器、SSRF 保护的 fetch 和 SSRF 策略助手 |
    | `plugin-sdk/secret-input` | 秘密输入解析助手 |
    | `plugin-sdk/webhook-ingress` | Webhook 请求/目标助手 |
    | `plugin-sdk/webhook-request-guards` | 请求体大小/超时助手 |
  </Accordion>

  <Accordion title="运行时和存储子路径">
    | 子路径 | 主要导出 |
    | --- | --- |
    | `plugin-sdk/runtime` | 广泛的运行时/日志记录/备份/插件安装助手 |
    | `plugin-sdk/runtime-env` | 狭窄的运行时环境、日志记录器、超时、重试和退避助手 |
    | `plugin-sdk/channel-runtime-context` | 通用通道运行时上下文注册和查找助手 |
    | `plugin-sdk/runtime-store` | `createPluginRuntimeStore` |
    | `plugin-sdk/plugin-runtime` | 共享插件命令/钩子/HTTP/交互式助手 |
    | `plugin-sdk/hook-runtime` | 共享 webhook/内部钩子管道助手 |
    | `plugin-sdk/lazy-runtime` | 惰性运行时导入/绑定助手，如 `createLazyRuntimeModule`、`createLazyRuntimeMethod` 和 `createLazyRuntimeSurface` |
    | `plugin-sdk/process-runtime` | 进程执行助手 |
    | `plugin-sdk/cli-runtime` | CLI 格式化、等待和版本助手 |
    | `plugin-sdk/gateway-runtime` | 网关客户端和通道状态补丁助手 |
    | `plugin-sdk/config-runtime` | 配置加载/写入助手 |
    | `plugin-sdk/telegram-command-config` | Telegram 命令名称/描述规范化和重复/冲突检查，即使捆绑的 Telegram 契约表面不可用 |
    | `plugin-sdk/text-autolink-runtime` | 文件引用自动链接检测，无广泛的文本运行时桶 |
    | `plugin-sdk/approval-runtime` | 执行/插件审批助手、审批能力构建器、认证/配置文件助手、原生路由/运行时助手 |
    | `plugin-sdk/reply-runtime` | 共享入站/回复运行时助手、分块、调度、心跳、回复计划器 |
    | `plugin-sdk/reply-dispatch-runtime` | 狭窄的回复调度/最终化助手 |
    | `plugin-sdk/reply-history` | 共享短窗口回复历史助手，如 `buildHistoryContext`、`recordPendingHistoryEntry` 和 `clearHistoryEntriesIfEnabled` |
    | `plugin-sdk/reply-reference` | `createReplyReferencePlanner` |
    | `plugin-sdk/reply-chunking` | 狭窄的文本/Markdown 分块助手 |
    | `plugin-sdk/session-store-runtime` | 会话存储路径 + 更新时间助手 |
    | `plugin-sdk/state-paths` | 状态/OAuth 目录路径助手 |
    | `plugin-sdk/routing` | 路由/会话键/账户绑定助手，如 `resolveAgentRoute`、`buildAgentSessionKey` 和 `resolveDefaultAgentBoundAccountId` |
    | `plugin-sdk/status-helpers` | 共享通道/账户状态摘要助手、运行时状态默认值和问题元数据助手 |
    | `plugin-sdk/target-resolver-runtime` | 共享目标解析器助手 |
    | `plugin-sdk/string-normalization-runtime` | slug/字符串规范化助手 |
    | `plugin-sdk/request-url` | 从 fetch/请求类输入中提取字符串 URL |
    | `plugin-sdk/run-command` | 带规范化 stdout/stderr 结果的定时命令运行器 |
    | `plugin-sdk/param-readers` | 通用工具/CLI 参数读取器 |
    | `plugin-sdk/tool-payload` | 从工具结果对象中提取规范化有效载荷 |
    | `plugin-sdk/tool-send` | 从工具参数中提取规范发送目标字段 |
    | `plugin-sdk/temp-path` | 共享临时下载路径助手 |
    | `plugin-sdk/logging-core` | 子系统日志记录器和编辑助手 |
    | `plugin-sdk/markdown-table-runtime` | Markdown 表格模式助手 |
    | `plugin-sdk/json-store` | 小型 JSON 状态读/写助手 |
    | `plugin-sdk/file-lock` | 可重入文件锁助手 |
    | `plugin-sdk/persistent-dedupe` | 磁盘支持的去重缓存助手 |
    | `plugin-sdk/acp-runtime` | ACP 运行时/会话和回复调度助手 |
    | `plugin-sdk/acp-binding-resolve-runtime` | 只读 ACP 绑定解析，无生命周期启动导入 |
    | `plugin-sdk/agent-config-primitives` | 狭窄的代理运行时配置模式原语 |
    | `plugin-sdk/boolean-param` | 宽松的布尔参数读取器 |
    | `plugin-sdk/dangerous-name-runtime` | 危险名称匹配解析助手 |
    | `plugin-sdk/device-bootstrap` | 设备引导和配对令牌助手 |
    | `plugin-sdk/extension-shared` | 共享被动通道、状态和环境代理助手原语 |
    | `plugin-sdk/models-provider-runtime` | `/models` 命令/提供者回复助手 |
    | `plugin-sdk/skill-commands-runtime` | 技能命令列表助手 |
    | `plugin-sdk/native-command-registry` | 原生命令注册表/构建/序列化助手 |
    | `plugin-sdk/agent-harness` | 低级别代理 harness 的实验性受信任插件表面：harness 类型、活动运行引导/中止助手、OpenClaw 工具桥助手和尝试结果实用程序 |
    | `plugin-sdk/provider-zai-endpoint` | Z.A.I 端点检测助手 |
    | `plugin-sdk/infra-runtime` | 系统事件/心跳助手 |
    | `plugin-sdk/collection-runtime` | 小型有界缓存助手 |
    | `plugin-sdk/diagnostic-runtime` | 诊断标志和事件助手 |
    | `plugin-sdk/error-runtime` | 错误图、格式化、共享错误分类助手、`isApprovalNotFoundError` |
    | `plugin-sdk/fetch-runtime` | 包装的 fetch、代理和固定查找助手 |
    | `plugin-sdk/runtime-fetch` | 调度器感知的运行时 fetch，无代理/受保护 fetch 导入 |
    | `plugin-sdk/response-limit-runtime` | 有界响应体读取器，无广泛的媒体运行时表面 |
    | `plugin-sdk/session-binding-runtime` | 当前对话绑定状态，无配置绑定路由或配对存储 |
    | `plugin-sdk/session-store-runtime` | 会话存储读取助手，无广泛的配置写入/维护导入 |
    | `plugin-sdk/context-visibility-runtime` | 上下文可见性解析和补充上下文过滤，无广泛的配置/安全导入 |
    | `plugin-sdk/string-coerce-runtime` | 狭窄的原语记录/字符串强制和规范化助手，无 Markdown/日志记录导入 |
    | `plugin-sdk/host-runtime` | 主机名和 SCP 主机规范化助手 |
    | `plugin-sdk/retry-runtime` | 重试配置和重试运行器助手 |
    | `plugin-sdk/agent-runtime` | 代理目录/身份/工作区助手 |
    | `plugin-sdk/directory-runtime` | 基于配置的目录查询/去重 |
    | `plugin-sdk/keyed-async-queue` | `KeyedAsyncQueue` |
  </Accordion>

  <Accordion title="能力和测试子路径">
    | 子路径 | 主要导出 |
    | --- | --- |
    | `plugin-sdk/media-runtime` | 共享媒体获取/转换/存储助手以及媒体有效载荷构建器 |
    | `plugin-sdk/media-generation-runtime` | 共享媒体生成故障转移助手、候选选择和缺失模型消息 |
    | `plugin-sdk/media-understanding` | 媒体理解提供者类型以及面向提供者的图像/音频助手导出 |
    | `plugin-sdk/text-runtime` | 共享文本/Markdown/日志记录助手，如助手可见文本剥离、Markdown 渲染/分块/表格助手、编辑助手、指令标签助手和安全文本实用程序 |
    | `plugin-sdk/text-chunking` | 出站文本分块助手 |
    | `plugin-sdk/speech` | 语音提供者类型以及面向提供者的指令、注册表和验证助手 |
    | `plugin-sdk/speech-core` | 共享语音提供者类型、注册表、指令和规范化助手 |
    | `plugin-sdk/realtime-transcription` | 实时转录提供者类型和注册表助手 |
    | `plugin-sdk/realtime-voice` | 实时语音提供者类型和注册表助手 |
    | `plugin-sdk/image-generation` | 图像生成提供者类型 |
    | `plugin-sdk/image-generation-core` | 共享图像生成类型、故障转移、认证和注册表助手 |
    | `plugin-sdk/music-generation` | 音乐生成提供者/请求/结果类型 |
    | `plugin-sdk/music-generation-core` | 共享音乐生成类型、故障转移助手、提供者查找和模型引用解析 |
    | `plugin-sdk/video-generation` | 视频生成提供者/请求/结果类型 |
    | `plugin-sdk/video-generation-core` | 共享视频生成类型、故障转移助手、提供者查找和模型引用解析 |
    | `plugin-sdk/webhook-targets` | Webhook 目标注册表和路由安装助手 |
    | `plugin-sdk/webhook-path` | Webhook 路径规范化助手 |
    | `plugin-sdk/web-media` | 共享远程/本地媒体加载助手 |
    | `plugin-sdk/zod` | 为插件 SDK 消费者重新导出的 `zod` |
    | `plugin-sdk/testing` | `installCommonResolveTargetErrorCases`、`shouldAckReaction` |
  </Accordion>

  <Accordion title="内存子路径">
    | 子路径 | 主要导出 |
    | --- | --- |
    | `plugin-sdk/memory-core` | 捆绑的 memory-core 助手表面，用于管理器/配置/文件/CLI 助手 |
    | `plugin-sdk/memory-core-engine-runtime` | 内存索引/搜索运行时外观 |
    | `plugin-sdk/memory-core-host-engine-foundation` | 内存主机基础引擎导出 |
    | `plugin-sdk/memory-core-host-engine-embeddings` | 内存主机嵌入契约、注册表访问、本地提供者和通用批处理/远程助手 |
    | `plugin-sdk/memory-core-host-engine-qmd` | 内存主机 QMD 引擎导出 |
    | `plugin-sdk/memory-core-host-engine-storage` | 内存主机存储引擎导出 |
    | `plugin-sdk/memory-core-host-multimodal` | 内存主机多模态助手 |
    | `plugin-sdk/memory-core-host-query` | 内存主机查询助手 |
    | `plugin-sdk/memory-core-host-secret` | 内存主机秘密助手 |
    | `plugin-sdk/memory-core-host-events` | 内存主机事件日志助手 |
    | `plugin-sdk/memory-core-host-status` | 内存主机状态助手 |
    | `plugin-sdk/memory-core-host-runtime-cli` | 内存主机 CLI 运行时助手 |
    | `plugin-sdk/memory-core-host-runtime-core` | 内存主机核心运行时助手 |
    | `plugin-sdk/memory-core-host-runtime-files` | 内存主机文件/运行时助手 |
    | `plugin-sdk/memory-host-core` | 内存主机核心运行时助手的供应商中立别名 |
    | `plugin-sdk/memory-host-events` | 内存主机事件日志助手的供应商中立别名 |
    | `plugin-sdk/memory-host-files` | 内存主机文件/运行时助手的供应商中立别名 |
    | `plugin-sdk/memory-host-markdown` | 内存相邻插件的共享托管 Markdown 助手 |
    | `plugin-sdk/memory-host-search` | 搜索管理器访问的活动内存运行时外观 |
    | `plugin-sdk/memory-host-status` | 内存主机状态助手的供应商中立别名 |
    | `plugin-sdk/memory-lancedb` | 捆绑的 memory-lancedb 助手表面 |
  </Accordion>

  <Accordion title="保留的捆绑助手子路径">
    | 系列 | 当前子路径 | 预期用途 |
    | --- | --- | --- |
    | 浏览器 | `plugin-sdk/browser-cdp`、`plugin-sdk/browser-config-runtime`、`plugin-sdk/browser-config-support`、`plugin-sdk/browser-control-auth`、`plugin-sdk/browser-node-runtime`、`plugin-sdk/browser-profiles`、`plugin-sdk/browser-security-runtime`、`plugin-sdk/browser-setup-tools`、`plugin-sdk/browser-support` | 捆绑的浏览器插件支持助手（`browser-support` 仍然是兼容性桶） |
    | Matrix | `plugin-sdk/matrix`、`plugin-sdk/matrix-helper`、`plugin-sdk/matrix-runtime-heavy`、`plugin-sdk/matrix-runtime-shared`、`plugin-sdk/matrix-runtime-surface`、`plugin-sdk/matrix-surface`、`plugin-sdk/matrix-thread-bindings` | 捆绑的 Matrix 助手/运行时表面 |
    | Line | `plugin-sdk/line`、`plugin-sdk/line-core`、`plugin-sdk/line-runtime`、`plugin-sdk/line-surface` | 捆绑的 LINE 助手/运行时表面 |
    | IRC | `plugin-sdk/irc`、`plugin-sdk/irc-surface` | 捆绑的 IRC 助手表面 |
    | 通道特定助手 | `plugin-sdk/googlechat`、`plugin-sdk/zalouser`、`plugin-sdk/bluebubbles`、`plugin-sdk/bluebubbles-policy`、`plugin-sdk/mattermost`、`plugin-sdk/mattermost-policy`、`plugin-sdk/feishu-conversation`、`plugin-sdk/msteams`、`plugin-sdk/nextcloud-talk`、`plugin-sdk/nostr`、`plugin-sdk/tlon`、`plugin-sdk/twitch` | 捆绑的通道兼容性/助手接缝 |
    | 认证/插件特定助手 | `plugin-sdk/github-copilot-login`、`plugin-sdk/github-copilot-token`、`plugin-sdk/diagnostics-otel`、`plugin-sdk/diffs`、`plugin-sdk/llm-task`、`plugin-sdk/thread-ownership`、`plugin-sdk/voice-call` | 捆绑的功能/插件助手接缝；`plugin-sdk/github-copilot-token` 当前导出 `DEFAULT_COPILOT_API_BASE_URL`、`deriveCopilotApiBaseUrlFromToken` 和 `resolveCopilotApiToken` |
  </Accordion>
</AccordionGroup>

## 注册 API

`register(api)` 回调接收一个带有以下方法的 `OpenClawPluginApi` 对象：

### 能力注册

| 方法                                             | 它注册什么             |
| ------------------------------------------------ | ---------------------- |
| `api.registerProvider(...)`                      | 文本推理（LLM）        |
| `api.registerAgentHarness(...)`                  | 实验性低级别代理执行器 |
| `api.registerCliBackend(...)`                    | 本地 CLI 推理后端      |
| `api.registerChannel(...)`                       | 消息通道               |
| `api.registerSpeechProvider(...)`                | 文本到语音 / STT 合成  |
| `api.registerRealtimeTranscriptionProvider(...)` | 流式实时转录           |
| `api.registerRealtimeVoiceProvider(...)`         | 双工实时语音会话       |
| `api.registerMediaUnderstandingProvider(...)`    | 图像/音频/视频分析     |
| `api.registerImageGenerationProvider(...)`       | 图像生成               |
| `api.registerMusicGenerationProvider(...)`       | 音乐生成               |
| `api.registerVideoGenerationProvider(...)`       | 视频生成               |
| `api.registerWebFetchProvider(...)`              | 网络获取 / 抓取提供者  |
| `api.registerWebSearchProvider(...)`             | 网络搜索               |

### 工具和命令

| 方法                            | 它注册什么                              |
| ------------------------------- | --------------------------------------- |
| `api.registerTool(tool, opts?)` | 代理工具（必需或 `{ optional: true }`） |
| `api.registerCommand(def)`      | 自定义命令（绕过 LLM）                  |

### 基础设施

| 方法                                           | 它注册什么              |
| ---------------------------------------------- | ----------------------- |
| `api.registerHook(events, handler, opts?)`     | 事件钩子                |
| `api.registerHttpRoute(params)`                | 网关 HTTP 端点          |
| `api.registerGatewayMethod(name, handler)`     | 网关 RPC 方法           |
| `api.registerCli(registrar, opts?)`            | CLI 子命令              |
| `api.registerService(service)`                 | 后台服务                |
| `api.registerInteractiveHandler(registration)` | 交互式处理程序          |
| `api.registerMemoryPromptSupplement(builder)`  | 附加内存相邻提示部分    |
| `api.registerMemoryCorpusSupplement(adapter)`  | 附加内存搜索/读取语料库 |

保留的核心管理命名空间（`config.*`、`exec.approvals.*`、`wizard.*`、
`update.*`）始终保持 `operator.admin`，即使插件尝试分配
更窄的网关方法范围。为
插件拥有的方法优先使用插件特定的前缀。

### CLI 注册元数据

`api.registerCli(registrar, opts?)` 接受两种顶级元数据：

- `commands`：注册商拥有的显式命令根
- `descriptors`：用于根 CLI 帮助、
  路由和惰性插件 CLI 注册的解析时命令描述符

如果您希望插件命令在正常的根 CLI 路径中保持惰性加载，
提供覆盖该注册商公开的每个顶级命令根的 `descriptors`。

```typescript
api.registerCli(
  async ({ program }) => {
    const { registerMatrixCli } = await import("./src/cli.js");
    registerMatrixCli({ program });
  },
  {
    descriptors: [
      {
        name: "matrix",
        description: "Manage Matrix accounts, verification, devices, and profile state",
        hasSubcommands: true,
      },
    ],
  },
);
```

仅在不需要惰性根 CLI 注册时单独使用 `commands`。
该急切兼容性路径仍然受支持，但它不会安装
用于解析时惰性加载的基于描述符的占位符。

### CLI 后端注册

`api.registerCliBackend(...)` 允许插件拥有本地
AI CLI 后端（如 `codex-cli`）的默认配置。

- 后端 `id` 成为模型引用中的提供者前缀，如 `codex-cli/gpt-5`。
- 后端 `config` 使用与 `agents.defaults.cliBackends.<id>` 相同的形状。
- 用户配置仍然优先。OpenClaw 在运行 CLI 之前将 `agents.defaults.cliBackends.<id>` 合并到
  插件默认值之上。
- 当后端在合并后需要兼容性重写时使用 `normalizeConfig`
  （例如规范化旧标志形状）。

### 独占插槽

| 方法                                       | 它注册什么                                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `api.registerContextEngine(id, factory)`   | 上下文引擎（一次激活一个）。`assemble()` 回调接收 `availableTools` 和 `citationsMode`，以便引擎可以定制提示添加。 |
| `api.registerMemoryCapability(capability)` | 统一内存能力                                                                                                      |
| `api.registerMemoryPromptSection(builder)` | 内存提示部分构建器                                                                                                |
| `api.registerMemoryFlushPlan(resolver)`    | 内存刷新计划解析器                                                                                                |
| `api.registerMemoryRuntime(runtime)`       | 内存运行时适配器                                                                                                  |

### 内存嵌入适配器

| 方法                                           | 它注册什么               |
| ---------------------------------------------- | ------------------------ |
| `api.registerMemoryEmbeddingProvider(adapter)` | 活动插件的内存嵌入适配器 |

- `registerMemoryCapability` 是首选的独占内存插件 API。
- `registerMemoryCapability` 还可以公开 `publicArtifacts.listArtifacts(...)`
  以便伴随插件可以通过
  `openclaw/plugin-sdk/memory-host-core` 消费导出的内存工件，而不是进入特定
  内存插件的私有布局。
- `registerMemoryPromptSection`、`registerMemoryFlushPlan` 和
  `registerMemoryRuntime` 是遗留兼容的独占内存插件 API。
- `registerMemoryEmbeddingProvider` 允许活动内存插件注册一个
  或多个嵌入适配器 ID（例如 `openai`、`gemini` 或自定义
  插件定义的 ID）。
- 用户配置如 `agents.defaults.memorySearch.provider` 和
  `agents.defaults.memorySearch.fallback` 针对这些注册的
  适配器 ID 解析。

### 事件和生命周期

| 方法                                         | 它做什么           |
| -------------------------------------------- | ------------------ |
| `api.on(hookName, handler, opts?)`           | 类型化生命周期钩子 |
| `api.onConversationBindingResolved(handler)` | 对话绑定回调       |

### 钩子决策语义

- `before_tool_call`：返回 `{ block: true }` 是终端的。一旦任何处理程序设置它，较低优先级的处理程序将被跳过。
- `before_tool_call`：返回 `{ block: false }` 被视为无决策（与省略 `block` 相同），而不是覆盖。
- `before_install`：返回 `{ block: true }` 是终端的。一旦任何处理程序设置它，较低优先级的处理程序将被跳过。
- `before_install`：返回 `{ block: false }` 被视为无决策（与省略 `block` 相同），而不是覆盖。
- `reply_dispatch`：返回 `{ handled: true, ... }` 是终端的。一旦任何处理程序声称调度，较低优先级的处理程序和默认模型调度路径将被跳过。
- `message_sending`：返回 `{ cancel: true }` 是终端的。一旦任何处理程序设置它，较低优先级的处理程序将被跳过。
- `message_sending`：返回 `{ cancel: false }` 被视为无决策（与省略 `cancel` 相同），而不是覆盖。

### API 对象字段

| 字段                     | 类型                      | 描述                                                            |
| ------------------------ | ------------------------- | --------------------------------------------------------------- |
| `api.id`                 | `string`                  | 插件 ID                                                         |
| `api.name`               | `string`                  | 显示名称                                                        |
| `api.version`            | `string?`                 | 插件版本（可选）                                                |
| `api.description`        | `string?`                 | 插件描述（可选）                                                |
| `api.source`             | `string`                  | 插件源路径                                                      |
| `api.rootDir`            | `string?`                 | 插件根目录（可选）                                              |
| `api.config`             | `OpenClawConfig`          | 当前配置快照（可用时为活动的内存中运行时快照）                  |
| `api.pluginConfig`       | `Record<string, unknown>` | 来自 `plugins.entries.<id>.config` 的插件特定配置               |
| `api.runtime`            | `PluginRuntime`           | [运行时助手](/plugins/sdk-runtime)                              |
| `api.logger`             | `PluginLogger`            | 作用域日志记录器（`debug`、`info`、`warn`、`error`）            |
| `api.registrationMode`   | `PluginRegistrationMode`  | 当前加载模式；`"setup-runtime"` 是轻量级预完整入口启动/设置窗口 |
| `api.resolvePath(input)` | `(string) => string`      | 解析相对于插件根的路径                                          |

## 内部模块约定

在插件内，使用本地桶文件进行内部导入：

```
my-plugin/
  api.ts            # 外部消费者的公共导出
  runtime-api.ts    # 仅内部运行时导出
  index.ts          # 插件入口点
  setup-entry.ts    # 轻量级仅设置入口（可选）
```

<Warning>
  永远不要通过 `openclaw/plugin-sdk/<your-plugin>` 从生产代码中导入您自己的插件。通过 `./api.ts` 或
  `./runtime-api.ts` 路由内部导入。SDK 路径仅为外部契约。
</Warning>

外观加载的捆绑插件公共表面（`api.ts`、`runtime-api.ts`、
`index.ts`、`setup-entry.ts` 和类似的公共入口文件）现在在 OpenClaw 已运行时优先使用
活动运行时配置快照。如果尚未存在运行时
快照，它们会回退到磁盘上解析的配置文件。

当助手有意提供者特定且尚未属于通用 SDK
子路径时，提供者插件也可以公开狭窄的插件本地契约桶。当前捆绑示例：Anthropic 提供者将其 Claude
流助手保留在其自己的公共 `api.ts` / `contract-api.ts` 接缝中，而不是
将 Anthropic 测试版头和 `service_tier` 逻辑提升到通用
`plugin-sdk/*` 契约中。

其他当前捆绑示例：

- `@openclaw/openai-provider`：`api.ts` 导出提供者构建器、
  默认模型助手和实时提供者构建器
- `@openclaw/openrouter-provider`：`api.ts` 导出提供者构建器以及
  入职/配置助手

<Warning>
  扩展生产代码也应避免 `openclaw/plugin-sdk/<other-plugin>`
  导入。如果助手确实共享，将其提升到中立的 SDK 子路径
  如 `openclaw/plugin-sdk/speech`、`.../provider-model-shared` 或另一个
  面向能力的表面，而不是将两个插件耦合在一起。
</Warning>

## 相关

- [入口点](/plugins/sdk-entrypoints) — `definePluginEntry` 和 `defineChannelPluginEntry` 选项
- [运行时助手](/plugins/sdk-runtime) — 完整的 `api.runtime` 命名空间参考
- [设置和配置](/plugins/sdk-setup) — 打包、清单、配置模式
- [测试](/plugins/sdk-testing) — 测试实用程序和 lint 规则
- [SDK 迁移](/plugins/sdk-migration) — 从已弃用表面迁移
- [插件内部结构](/plugins/architecture) — 深度架构和能力模型
