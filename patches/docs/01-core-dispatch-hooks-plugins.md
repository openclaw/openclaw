# Patch 01: 核心派发管道 channelData 透传、Hook 元数据增强与插件基础设施加固

## 为什么要改 (Why)

### 问题 1: 出站消息管道缺失 channelData 透传

飞书等渠道在发送消息时，API 返回的 `chatId`、`channelId` 等字段不会出现在原始 `to` 地址中（例如飞书 DM 用 `open_id` 寻址，但 API 解析后返回 `chat_id`）。这些渠道特定字段在 `message_sent` hook 中完全不可见，导致下游 hook 消费者无法获取投递结果的关键元数据。同时 `message_sending` hook 也缺少 `replyToId` 和 `threadId` 上下文，无法实现基于线程的消息过滤。

### 问题 2: LLM slug 生成器不支持模型别名和 CLI provider

`llm-slug-generator` 直接调用 `parseModelRef` 解析模型引用，不支持配置中定义的模型别名（如 `fast` -> `claude-haiku-4-5`），且无法识别 CLI provider（如 `claude-cli`），导致 slug 生成在使用别名或 CLI 后端时失败或使用错误模型。超时时间硬编码为 15 秒，无法通过配置调整。

### 问题 3: Hook runner 在插件热重载时丢失已注册 hook

当 provider 解析或 channel bootstrap 触发二次 `initializeGlobalHookRunner` 调用时，新 registry 可能不包含 gateway 启动阶段注册的插件 hook。旧实现直接覆盖 registry，导致早期注册的 hook 被静默丢弃。

### 问题 4: 渠道解析路径冗余且 session transcript 缺少消息元数据

`channel-resolution.ts` 中 `resolveDirectFromActiveRegistry` 作为二次查找路径引入了对 `getActivePluginRegistry` 的耦合依赖，但实际场景中 `getChannelPlugin` + bootstrap 已足够。session transcript 中助理消息缺少 channel/chatId/threadId 等投递元数据，无法追溯消息的渠道投递链路。

## 改了什么 (What Changed)

| 文件 | 关键修改 |
|------|----------|
| `src/infra/outbound/deliver.ts` | 新增 `buildMirrorMessageMeta`、`buildDeliveryResultMetadata`、`resolveMirrorFallbackContent` 函数；`message_sent` 事件携带 `metadata`；`message_sending` hook 增加 `replyToId`/`threadId`；mirror 写入 transcript 时附带 `messageMeta` |
| `src/infra/outbound/deliver.test.ts` | 新增 `metadata` 字段透传和 mirror fallback 内容的测试 |
| `src/hooks/message-hook-mappers.ts` | `CanonicalInboundMessageHookContext` 增加 `channelData`；`CanonicalSentMessageHookContext` 增加 `metadata`；`toPluginMessageSentEvent` 输出 `messageId`/`metadata` |
| `src/hooks/message-hook-mappers.test.ts` | 对应新字段的测试覆盖 |
| `src/hooks/llm-slug-generator.ts` | 使用 `buildModelAliasIndex` + `resolveModelRefFromString` 替代 `parseModelRef`；支持 hook 级别 model override；新增可配置超时 `resolveSlugTimeoutMs`；CLI provider 自动 fallback |
| `src/hooks/llm-slug-generator.test.ts` | 别名解析、CLI provider fallback、超时配置的测试 |
| `src/plugins/hook-runner-global.ts` | `initializeGlobalHookRunner` 检测新旧 registry 差异，合并缺失 plugin hook；使用 `typedHooks.length` 替代 `hooks.length` |
| `src/plugins/hook-runner-global.test.ts` | hook 合并保护的测试用例 |
| `src/plugins/hooks.ts` | 新增 `runChatMemberUserAdded/Deleted/Withdrawn`、`runChatMemberBotAdded/Deleted` 五个 chat member hook；`runMessageSending` 返回值增加 `metadata` 合并 |
| `src/plugins/manifest-registry.ts` | 注入 `__OPENCLAW_EMBEDDED_PLUGINS__` 全局变量中的嵌入式插件到 manifest registry；`PluginManifestRecord` 增加 `cliBackends` |
| `src/infra/outbound/channel-resolution.ts` | 移除 `resolveDirectFromActiveRegistry` 冗余查找路径，简化为 `getChannelPlugin` + bootstrap |
| `src/infra/outbound/channel-selection.ts` | fallback 渠道解析从 `resolveAvailableKnownChannel` 简化为 `resolveKnownChannel` |
| `src/infra/outbound/outbound-send-service.ts` | 新增 `isCancelledPluginActionPayload` 检测，cancelled payload 跳过 `onHandled` 回调 |
| `src/config/sessions/transcript.ts` | 新增 `SessionTranscriptMessageMeta` 类型；新增 `appendCliTurnToSessionTranscript` 写入 CLI 会话轮次；`appendAssistantMessageToSessionTranscript` 支持 `messageMeta` 和 `branchWithSummary` 防止 delivery-mirror 影响主链；`transcriptFindIdempotencyKey` 从异步改为同步并导出 |
| `src/config/sessions/types.ts` | 新增 `CliSessionBinding`、`CliPromptLoadStatus` 类型；`SessionEntry` 增加 `cliSessionBindings`/`cliSessionIds`/`cliPromptLoad` |
| `src/config/sessions/disk-budget.ts` | 新增 `resolveReferencedSessionPromptPaths`；磁盘预算清理同步删除关联的 prompt 文件 |
| `src/config/sessions/disk-budget.test.ts` | prompt 文件清理的测试 |
| `src/config/sessions/sessions.test.ts` | CLI session binding 和 transcript append 的测试 |
| `src/config/sessions/artifacts.ts` | 新增 prompt 文件名识别和转换辅助函数 |
| `src/config/schema.base.generated.ts` | 新增 `compaction`、`cliBackends`、`imageModel`、`contextInjection` 等配置 schema 定义 |
| `src/config/schema.help.ts` | 新增配置项帮助文本 |
| `src/config/schema.labels.ts` | 新增配置项 UI 标签 |
| `src/config/types.agent-defaults.ts` | 新增 `AgentCompactionConfig`、`AgentCliBackendConfig`、`AgentImageModelConfig`、`ContextInjectionConfig` 类型 |
| `src/config/types.gateway.ts` | `GatewayNodesConfig` 增加 `overrides` 字段；新增 `GatewayNodeOverrideConfig` |
| `src/config/types.skills.ts` | 新增 `SkillSlotConfig` 类型 |
| `src/config/types.tools.ts` | 新增 `allowReadOutsideWorkspace` 工具配置 |
| `src/config/zod-schema.agent-defaults.ts` | zod schema 中新增 compaction/cliBackends 等字段验证 |
| `src/config/zod-schema.core.ts` | 核心 zod schema 增加 `overrides`、`contextInjection` |
| `src/config/zod-schema.ts` | 全局 zod schema 增加新字段导出 |
| `src/channels/plugins/registry.ts` | 使用 `requireActivePluginRegistry` 替代 `requireActivePluginChannelRegistry`；增加 `sourceSignature` 缓存失效因子 |
| `src/plugins/schema-validator.ts` | 从 `createRequire` 改为直接 ESM import `Ajv` |
| `src/security/audit-extra.sync.ts` | 审计逻辑支持 per-node override 的 allow/deny 命令检查；新增 `listConfiguredNodeAllowCommandEntries`/`listConfiguredNodeDenyCommandEntries` |
| `src/security/audit.test.ts` | per-node override 审计的测试 |
| `src/hooks/bundled/session-memory/HOOK.md` | 文档更新 `llmSlugTimeoutMs` 和 `model` 配置 |
| `src/hooks/bundled/session-memory/handler.test.ts` | session-memory handler 的新测试 |
| `src/hooks/bundled/session-memory/transcript.ts` | transcript 辅助函数更新 |
| `src/infra/outbound/conversation-id.ts` | 对话 ID 解析小修正 |
| `src/infra/outbound/conversation-id.test.ts` | 对应测试 |
| `src/infra/outbound/current-conversation-bindings.ts` | 当前对话绑定小修正 |
| `src/config/config-misc.test.ts` | 配置 misc 测试更新 |
| `src/config/zod-schema.agent-runtime.ts` | agent runtime schema 小调整 |
| `src/channels/plugins/setup-wizard-helpers.test.ts` | 测试更新适配新 registry API |

## 伪代码 (Pseudocode)

### 1. 投递结果元数据构建 (buildDeliveryResultMetadata)

```javascript
// src/infra/outbound/deliver.ts:380
function buildDeliveryResultMetadata(result) {
  // 从渠道 API 返回的 delivery result 中提取元数据
  if (!result) return undefined

  const meta = {}
  // adapter meta 先铺底，避免被已知字段覆盖
  if (result.meta) Object.assign(meta, result.meta)
  // 已知关键字段显式设置（优先级高于 adapter meta）
  if (result.chatId)    meta.chatId = result.chatId
  if (result.channelId) meta.channelId = result.channelId

  return Object.keys(meta).length > 0 ? meta : undefined
}
```

### 2. Mirror 消息元数据构建 (buildMirrorMessageMeta)

```javascript
// src/infra/outbound/deliver.ts:325
function buildMirrorMessageMeta({ channel, accountId, replyToId, threadId, mirror, results }) {
  // 从投递结果中收集去重的 providerMessageId 和 chatId
  const providerMessageIds = unique(results.map(r => r.messageId).filter(Boolean))
  const chatIds = unique(results.map(r => r.chatId).filter(Boolean))

  // 构建 SessionTranscriptMessageMeta
  return {
    channel,
    accountId,
    chatId: chatIds.length === 1 ? chatIds[0] : undefined,
    chatType: mirror?.isGroup ? "group" : "direct",
    providerMessageId: providerMessageIds.at(-1),
    providerMessageIds,
    parentId: replyToId || undefined,
    threadId: threadId || undefined,
  }
}
```

### 3. Hook Runner 合并保护 (initializeGlobalHookRunner)

```javascript
// src/plugins/hook-runner-global.ts:38
function initializeGlobalHookRunner(registry) {
  const prev = state.registry
  if (prev && prev !== registry && prev.typedHooks.length > 0) {
    // 找出新 registry 中缺失的插件 ID
    const newPluginIds = new Set(registry.typedHooks.map(h => h.pluginId))
    const missingPluginIds = prev.typedHooks
      .filter(h => !newPluginIds.has(h.pluginId))
      .map(h => h.pluginId)

    if (missingPluginIds.length > 0) {
      // 构建合并 registry（不修改原始对象，避免污染缓存）
      registry = {
        ...registry,
        typedHooks: [...registry.typedHooks, ...prev.typedHooks.filter(缺失的)],
        plugins: [...registry.plugins, ...prev.plugins.filter(缺失的)],
      }
      log.info(`carried forward hooks from ${missingPluginIds.size} plugin(s)`)
    }
  }
  state.registry = registry
  state.hookRunner = createHookRunner(registry, options)
}
```

### 4. LLM Slug 生成器别名解析

```javascript
// src/hooks/llm-slug-generator.ts:75
async function generateSessionSlug(params) {
  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: DEFAULT_PROVIDER })

  // 优先级 1: hook 级别 model override
  const hookModel = cfg.hooks.internal.entries["session-memory"].model
  const hookResolved = resolveModelRefFromString({ raw: hookModel, aliasIndex })
  if (hookResolved && !isCliProvider(hookResolved.ref.provider)) {
    provider = hookResolved.ref.provider
    model = hookResolved.ref.model
  } else {
    // 优先级 2: agent 有效模型 (fallback)
    const agentRef = resolveAgentEffectiveModelPrimary(cfg, agentId)
    const resolved = resolveModelRefFromString({ raw: agentRef, aliasIndex })
    // CLI provider 自动降级到默认 provider
    provider = isCliProvider(resolved.provider) ? DEFAULT_PROVIDER : resolved.provider
    model = isCliProvider(resolved.provider) ? DEFAULT_MODEL : resolved.model
  }
  const timeoutMs = resolveSlugTimeoutMs(cfg) // 可配置，5s~300s，默认45s
  return runEmbeddedPiAgent({ provider, model, timeoutMs, ... })
}
```

### 5. Transcript delivery-mirror 分支保护

```javascript
// src/config/sessions/transcript.ts:218
async function appendAssistantMessageToSessionTranscript(params) {
  const sessionManager = SessionManager.open(sessionFile)
  // 保存当前 leafId，防止 delivery-mirror 影响主链
  const savedLeafId = sessionManager.getLeafId()

  // 写入 delivery-mirror 消息（含 messageMeta）
  sessionManager.appendMessage({
    role: "assistant",
    text: mirrorText,
    openclawMessageMeta: params.messageMeta, // 渠道/chatId/threadId 等
    ...
  })

  // 恢复 leafId：使用 branchWithSummary 持久化分支点
  // 这样 buildSessionContext 从 savedLeafId 开始遍历时跳过 delivery-mirror
  if (savedLeafId !== null) {
    sessionManager.branchWithSummary(savedLeafId, "", undefined, false)
  }
}
```

## 数据流程图 (Data Flow Diagram)

### 出站消息 channelData 透传流程

```
┌──────────────────┐     ┌─────────────────────┐
│  ReplyPayload    │     │  message_sending     │
│  .channelData    │────>│  hook                │
│  .replyToId      │     │  + replyToId         │
│  .threadId       │     │  + threadId          │
└──────────────────┘     └─────────┬───────────┘
                                   │
                         ┌─────────▼───────────┐
                         │  Channel Adapter     │
                         │  (e.g. feishu)       │
                         │  send() -> result    │
                         └─────────┬───────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │  OutboundDeliveryResult      │
                    │  .chatId  .channelId  .meta  │
                    └──────────────┬──────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                    │
    ┌─────────▼─────────┐ ┌──────▼──────────┐ ┌──────▼──────────────┐
    │ buildDelivery-     │ │ message_sent    │ │ buildMirrorMessage- │
    │ ResultMetadata()   │ │ hook            │ │ Meta()              │
    │ -> metadata        │ │ + metadata      │ │ -> messageMeta      │
    └─────────┬─────────┘ └──────┬──────────┘ └──────┬──────────────┘
              │                  │                    │
              └──────────────────┘                    │
                                            ┌────────▼───────────────┐
                                            │ Session Transcript     │
                                            │ .openclawMessageMeta   │
                                            │ (channel, chatId,      │
                                            │  providerMessageId,    │
                                            │  threadId, ...)        │
                                            └────────────────────────┘
```

### Hook Runner 合并保护流程

```
┌─────────────────────┐     ┌─────────────────────┐
│  Gateway Startup    │     │  Provider Bootstrap  │
│  Plugin Load        │     │  / Channel Bootstrap │
│  -> Registry A      │     │  -> Registry B       │
│  (plugin X, Y, Z)   │     │  (plugin Y, Z only)  │
└──────────┬──────────┘     └──────────┬──────────┘
           │                           │
           │  initializeGlobal-        │  initializeGlobal-
           │  HookRunner(A)            │  HookRunner(B)
           │                           │
           ▼                           ▼
┌──────────────────────────────────────────────────┐
│              合并检查逻辑                          │
│  newPluginIds = {Y, Z}                           │
│  missingPluginIds = {X}  (X 在 A 中但不在 B 中)   │
│                                                  │
│  合并结果: Registry B' = {X(from A), Y, Z}       │
│  日志: "carried forward hooks from 1 plugin(s)"   │
└──────────────────────────────────────────────────┘
```

## 参考代码行号 (Reference Line Numbers)

| 文件 | 行号 | 内容 |
|------|------|------|
| `src/infra/outbound/deliver.ts` | 325 | `function buildMirrorMessageMeta(params)` - 构建 mirror 消息元数据 |
| `src/infra/outbound/deliver.ts` | 380 | `function buildDeliveryResultMetadata(result)` - 提取投递结果元数据 |
| `src/infra/outbound/deliver.ts` | 485 | `function createMessageSentEmitter(params)` - 发送 message_sent 事件 |
| `src/infra/outbound/deliver.ts` | 546 | `async function applyMessageSendingHook(params)` - 增加 replyToId/threadId |
| `src/infra/outbound/deliver.ts` | 685 | `async function deliverOutboundPayloadsCore(...)` - 核心投递管道入口 |
| `src/hooks/llm-slug-generator.ts` | 33 | `function resolveSlugTimeoutMs(cfg)` - 可配置 slug 超时解析 |
| `src/hooks/message-hook-mappers.ts` | 42-47 | `CanonicalInboundMessageHookContext` 增加 `channelData` |
| `src/hooks/message-hook-mappers.ts` | 56-57 | `CanonicalSentMessageHookContext` 增加 `metadata` |
| `src/plugins/hook-runner-global.ts` | 38 | `initializeGlobalHookRunner(registry)` - 合并保护逻辑入口 |
| `src/plugins/hooks.ts` | 712 | `runMessageSending()` - metadata 合并到返回值 |
| `src/plugins/hooks.ts` | 762-817 | `runChatMemberUserAdded/Deleted/Withdrawn`, `runChatMemberBotAdded/Deleted` - 五个新 hook |
| `src/plugins/manifest-registry.ts` | 601-632 | `__OPENCLAW_EMBEDDED_PLUGINS__` 嵌入式插件注入 |
| `src/config/sessions/transcript.ts` | 106 | `SessionTranscriptMessageMeta` 类型定义 |
| `src/config/sessions/transcript.ts` | 168 | `appendCliTurnToSessionTranscript()` - CLI 会话轮次写入 |
| `src/config/sessions/transcript.ts` | 218 | `appendAssistantMessageToSessionTranscript()` - 含 messageMeta 和分支保护 |
| `src/config/sessions/transcript.ts` | 328 | `transcriptFindIdempotencyKey()` - 同步幂等键查找 |
| `src/config/sessions/types.ts` | 70 | `CliSessionBinding` 类型定义 |
| `src/config/sessions/types.ts` | 86 | `CliPromptLoadStatus` 类型定义 |
| `src/config/sessions/disk-budget.ts` | 138 | `resolveReferencedSessionPromptPaths()` - prompt 文件引用追踪 |
| `src/config/sessions/disk-budget.ts` | 248 | `enforceSessionDiskBudget()` - 含 prompt 文件同步清理 |
| `src/channels/plugins/registry.ts` | 38 | `buildChannelPluginSourceSignature()` - 缓存签名函数 |
| `src/channels/plugins/registry.ts` | 46 | `resolveCachedChannelPlugins()` - 含 sourceSignature 校验 |
| `src/infra/outbound/outbound-send-service.ts` | 60 | `isCancelledPluginActionPayload()` - cancelled payload 检测 |
| `src/security/audit-extra.sync.ts` | 213 | `listConfiguredNodeAllowCommandEntries()` - 含 per-node override |
| `src/security/audit-extra.sync.ts` | 248 | `listConfiguredNodeDenyCommandEntries()` - 含 per-node override |
| `src/security/audit-extra.sync.ts` | 1065 | `collectNodeDenyCommandPatternFindings()` - 重构为多源 entry 格式 |
| `src/security/audit-extra.sync.ts` | 1135 | `collectNodeDangerousAllowCommandFindings()` - 支持 per-node override |
| `src/agents/model-selection.ts` | 113 | `isCliProvider()` - CLI provider 检测 |
| `src/agents/model-selection.ts` | 307 | `buildModelAliasIndex()` - 模型别名索引 |
| `src/agents/model-selection.ts` | 338 | `resolveModelRefFromString()` - 字符串模型引用解析 |
