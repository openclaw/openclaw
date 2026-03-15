# PR：插件 messageMeta 命名空间隔离与显示过滤机制

**分支：** `fix/memory-lancedb-meta-strip-leak`
**状态：** 待审核

## 问题

当 `memory-lancedb` 的自动召回功能向用户 prompt 注入 `<relevant-memories>` 上下文时，原始 XML 标签会暴露在聊天 UI 和 API 响应中。这些是内部脚手架，不应展示给用户。

## 解决方案

### 1. 通过 `messageMeta` 实现插件驱动的显示过滤

不再仅依赖硬编码正则，`memory-lancedb` 现在在 hook 返回结果的 `messageMeta` 中声明自己的 `displayStripPatterns`。这些模式会和消息一起持久化，UI 在显示时据此过滤注入的上下文。

插件只返回扁平的 meta 数据——**不需要知道自己的插件 ID**：

```typescript
return {
  prependContext: formatRelevantMemoriesContext(results),
  messageMeta: {
    displayStripPatterns: [
      {
        regex:
          "<\\s*relevant[-_]memories\\b[^>]*>[\\s\\S]*?<\\s*/\\s*relevant[-_]memories\\s*>\\s*",
      },
    ],
  },
};
```

### 2. 系统级命名空间隔离（防篡改）

Hook runner（`src/plugins/hooks.ts`）在**合并之前**自动将每个插件的 `messageMeta` 包装到 `{ [pluginId]: ... }` 下。这由 `runModifyingHook()` 中的 `namespaceMessageMeta()` 完成。

**插件返回：**

```typescript
{ displayStripPatterns: [...] }
```

**系统包装后变为：**

```typescript
{ "memory-lancedb": { displayStripPatterns: [...] } }
```

这意味着：

- 插件**无法**写入其他插件的命名空间——key 由 runner 控制。
- 如果恶意插件返回 `{ "memory-lancedb": { ... } }`，经过系统包装后会变成 `{ "malicious-plugin": { "memory-lancedb": { ... } } }`——完全无害。
- 每个插件的数据天然隔离，无需白名单或签名机制。

### 3. UI 层消费方式

UI（`ui/src/ui/chat/message-extract.ts`）**只读取** `messageMeta["memory-lancedb"].displayStripPatterns`。其他插件命名空间下的模式完全被忽略。

当 `messageMeta` 不存在时（例如该功能上线前创建的会话，或不传递 messageMeta 的 API 路径），仍会使用硬编码的 `stripRelevantMemoriesTags` 作为兜底。

## 关于 UI 中硬编码 `"memory-lancedb"` 的说明

UI 中读取 `messageMeta["memory-lancedb"]` 是有意为之，且**不是新模式**。代码库中已经广泛存在对 `memory-lancedb` 及其 `<relevant-memories>` 标签的硬编码处理：

| 位置                                                   | 硬编码引用                                                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `src/shared/text/assistant-visible-text.ts`            | `stripRelevantMemoriesTags()` 共享函数，包含硬编码 `MEMORY_TAG_RE` 正则，被 **5 个以上调用点**使用 |
| `src/auto-reply/reply/normalize-reply.ts`              | 硬编码调用 `stripRelevantMemoriesTags()` 作为所有渠道的出站安全兜底                                |
| `src/tui/tui-formatters.ts`                            | TUI 消息格式化中硬编码 `stripRelevantMemoriesTags()`                                               |
| `src/gateway/server-methods/chat.ts`                   | 聊天历史 API 中 **3 处独立的**硬编码 `stripRelevantMemoriesTags()` 调用                            |
| `extensions/imessage/src/monitor/reflection-guard.ts`  | 反射检测模式中硬编码 `RELEVANT_MEMORIES_TAG_RE`                                                    |
| `extensions/imessage/src/monitor/sanitize-outbound.ts` | 调用 `stripAssistantInternalScaffolding()` 内部调用 `stripRelevantMemoriesTags()`                  |
| `src/plugin-sdk/memory-lancedb.ts`                     | 内置 memory-lancedb 插件的专属 SDK 入口                                                            |
| `src/agents/pi-embedded-runner/run/attempt.ts`         | 注释中明确引用 `memory-lancedb`                                                                    |

`memory-lancedb` 是一个**第一方内置插件**，拥有自己的 SDK 子路径（`openclaw/plugin-sdk/memory-lancedb`）。`<relevant-memories>` 标签格式已经是该插件与核心显示/清洗层之间的事实标准内部协议。

我们的改动实际上**改善了**现状：与其在代码库中继续增加硬编码正则，不如让插件通过 `messageMeta` 声明自己的过滤模式，使系统更加数据驱动和可扩展。

## 文件变更（14 个文件，+418/-19）

| 文件                                             | 变更                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `extensions/memory-lancedb/index.ts`             | 在 `before_agent_start` hook 返回值中增加 `messageMeta` 的 `displayStripPatterns`      |
| `src/plugins/hooks.ts`                           | 新增 `namespaceMessageMeta()` + `mergeMessageMeta()` 实现插件命名空间隔离              |
| `src/plugins/types.ts`                           | 更新 `messageMeta` JSDoc                                                               |
| `src/agents/pi-embedded-runner/run/attempt.ts`   | 新增 `mergeShallowMeta()` + 一次性拦截器将 `messageMeta` 持久化到用户消息上            |
| `ui/src/ui/chat/message-extract.ts`              | 新增 `stripDisplayPatterns()`，从 `messageMeta["memory-lancedb"]` 读取并保留硬编码兜底 |
| `src/auto-reply/reply/normalize-reply.ts`        | 在出站回复规范化中增加 `stripRelevantMemoriesTags`                                     |
| `src/gateway/server-methods/chat.ts`             | 在聊天历史 API 清洗中增加 `stripRelevantMemoriesTags`                                  |
| `src/tui/tui-formatters.ts`                      | 在 TUI 消息格式化中增加 `stripRelevantMemoriesTags`                                    |
| `src/tui/components/assistant-message.ts`        | 从助手消息显示中过滤 `<relevant-memories>`                                             |
| `src/shared/text/assistant-visible-text.ts`      | 优化 `stripRelevantMemoriesTags` 边界情况处理                                          |
| `ui/src/ui/chat/message-extract.test.ts`         | 6 个新测试覆盖 `stripDisplayPatterns` + 命名空间隔离                                   |
| `src/auto-reply/reply/normalize-reply.test.ts`   | 出站过滤测试                                                                           |
| `src/tui/tui-formatters.test.ts`                 | TUI 过滤测试                                                                           |
| `src/shared/text/assistant-visible-text.test.ts` | 共享过滤函数测试                                                                       |
