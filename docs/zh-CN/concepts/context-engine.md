---
summary: "上下文引擎：可插拔的上下文组装、压缩和子智能体生命周期"
read_when:
  - 想要了解 OpenClaw 如何构建模型上下文
  - 在旧版引擎和插件引擎之间切换
  - 正在构建上下文引擎插件
title: "上下文引擎"
---

# 上下文引擎

**上下文引擎** 控制 OpenClaw 如何为每次运行构建模型上下文。它决定包含哪些消息、如何总结较早的历史，以及如何在子智能体边界之间管理上下文。

OpenClaw 附带了一个内置的 `legacy` 引擎。插件可以注册替代引擎，以替换活动的上下文引擎生命周期。

## 快速开始

检查哪个引擎处于活动状态：

```bash
openclaw doctor
# 或者直接检查配置：
cat ~/.openclaw/openclaw.json | jq '.plugins.slots.contextEngine'
```

### 安装上下文引擎插件

上下文引擎插件的安装方式与任何其他 OpenClaw 插件相同。先安装，然后在槽位中选择引擎：

```bash
# 从 npm 安装
openclaw plugins install @martian-engineering/lossless-claw

# 或者从本地路径安装（用于开发）
openclaw plugins install -l ./my-context-engine
```

然后在配置中启用插件并将其选为活动引擎：

```json5
// openclaw.json
{
  plugins: {
    slots: {
      contextEngine: "lossless-claw", // 必须与插件注册的引擎 id 匹配
    },
    entries: {
      "lossless-claw": {
        enabled: true,
        // 插件特定的配置放在这里（请参阅插件文档）
      },
    },
  },
}
```

安装和配置后重启 gateway。

要切换回内置引擎，请将 `contextEngine` 设置为 `"legacy"`（或完全移除该键 —— `"legacy"` 是默认值）。

## 工作原理

每次 OpenClaw 运行模型提示时，上下文引擎在四个生命周期点参与：

1. **Ingest（摄取）** — 当新消息添加到会话时调用。引擎可以在自己的数据存储中存储或索引消息。
2. **Assemble（组装）** — 每次模型运行前调用。引擎返回一组有序的消息（以及可选的 `systemPromptAddition`），这些消息适合在令牌预算内。
3. **Compact（压缩）** — 当上下文窗口已满，或用户运行 `/compact` 时调用。引擎总结较早的历史以释放空间。
4. **After turn（回合后）** — 运行完成后调用。引擎可以持久化状态、触发后台压缩或更新索引。

### 子智能体生命周期（可选）

OpenClaw 目前调用一个子智能体生命周期钩子：

- **onSubagentEnded** — 子智能体会话完成或被清理时进行清理。

`prepareSubagentSpawn` 钩子是接口的一部分，供将来使用，但运行时尚未调用它。

### 系统提示追加

`assemble` 方法可以返回 `systemPromptAddition` 字符串。OpenClaw 会在运行前将此字符串 prepend 到系统提示中。这允许引擎注入动态的召回指导、检索指令或上下文感知提示，而无需静态的工作区文件。

## 旧版引擎

内置的 `legacy` 引擎保留了 OpenClaw 的原始行为：

- **Ingest**: no-op（会话管理器直接处理消息持久化）。
- **Assemble**: 直通（运行时中现有的 sanitize → validate → limit 管道处理上下文组装）。
- **Compact**: 委托给内置的摘要压缩，它创建较早消息的单个摘要并保持最近消息完整。
- **After turn**: no-op。

旧版引擎不注册工具，也不提供 `systemPromptAddition`。

当未设置 `plugins.slots.contextEngine`（或设置为 `"legacy"`）时，此引擎会自动使用。

## 插件引擎

插件可以使用插件 API 注册上下文引擎：

```ts
export default function register(api) {
  api.registerContextEngine("my-engine", () => ({
    info: {
      id: "my-engine",
      name: "My Context Engine",
      ownsCompaction: true,
    },

    async ingest({ sessionId, message, isHeartbeat }) {
      // 在你的数据存储中存储消息
      return { ingested: true };
    },

    async assemble({ sessionId, messages, tokenBudget }) {
      // 返回适合预算的消息
      return {
        messages: buildContext(messages, tokenBudget),
        estimatedTokens: countTokens(messages),
        systemPromptAddition: "Use lcm_grep to search history...",
      };
    },

    async compact({ sessionId, force }) {
      // 总结较早的上下文
      return { ok: true, compacted: true };
    },
  }));
}
```

然后在配置中启用它：

```json5
{
  plugins: {
    slots: {
      contextEngine: "my-engine",
    },
    entries: {
      "my-engine": {
        enabled: true,
      },
    },
  },
}
```

### ContextEngine 接口

必需成员：

| 成员              | 类型     | 用途                                                        |
| ----------------- | -------- | ----------------------------------------------------------- |
| `info`            | 属性     | 引擎 id、名称、版本，以及是否拥有压缩功能 |
| `ingest(params)`  | 方法     | 存储单条消息                                   |
| `assemble(params)`| 方法     | 为模型运行构建上下文（返回 `AssembleResult`） |
| `compact(params)` | 方法     | 总结/减少上下文                                 |

`assemble` 返回包含以下内容的 `AssembleResult`：

- `messages` — 发送给模型的有序消息。
- `estimatedTokens`（必需，`number`）— 引擎对组装上下文中总令牌数的估计。OpenClaw 将此用于压缩阈值决策和诊断报告。
- `systemPromptAddition`（可选，`string`）— 追加到系统提示的前缀。

可选成员：

| 成员                           | 类型   | 用途                                                                                                         |
| ------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------- |
| `bootstrap(params)`            | 方法   | 为会话初始化引擎状态。当引擎首次看到会话时调用一次（例如，导入历史）。 |
| `ingestBatch(params)`          | 方法   | 批量摄取完成的回合。运行完成后调用，包含该回合的所有消息。     |
| `afterTurn(params)`            | 方法   | 运行后生命周期工作（持久化状态、触发后台压缩）。                                         |
| `prepareSubagentSpawn(params)` | 方法   | 为子会话设置共享状态。                                                                        |
| `onSubagentEnded(params)`      | 方法   | 子智能体结束后进行清理。                                                                                 |
| `dispose()`                    | 方法   | 释放资源。在 gateway 关闭或插件重新加载时调用 — 非每个会话。                           |

### ownsCompaction

`ownsCompaction` 控制 OpenClaw 的内置 in-attempt 自动压缩是否为该运行保持启用：

- `true` — 引擎拥有压缩行为。OpenClaw 为该运行禁用内置自动压缩，引擎的 `compact()` 实现负责 `/compact`、溢出恢复压缩以及它在 `afterTurn()` 中想要做的任何主动压缩。
- `false` 或未设置 — OpenClaw 的内置自动压缩仍可能在提示执行期间运行，但活动引擎的 `compact()` 方法仍会为 `/compact` 和溢出恢复调用。

`ownsCompaction: false` **不** 意味着 OpenClaw 自动回退到旧版引擎的压缩路径。

这意味着有两种有效的插件模式：

- **Owning mode（拥有模式）** — 实现你自己的压缩算法并设置 `ownsCompaction: true`。
- **Delegating mode（委托模式）** — 设置 `ownsCompaction: false`，并让 `compact()` 从 `openclaw/plugin-sdk/core` 调用 `delegateCompactionToRuntime(...)` 以使用 OpenClaw 的内置压缩行为。

对于活动的非拥有引擎，无操作的 `compact()` 是不安全的，因为它会禁用该引擎槽的正常 `/compact` 和溢出恢复压缩路径。

## 配置参考

```json5
{
  plugins: {
    slots: {
      // 选择活动的上下文引擎。默认："legacy"。
      // 设置为插件 id 以使用插件引擎。
      contextEngine: "legacy",
    },
  },
}
```

该槽位在运行时是排他的 —— 对于给定的运行或压缩操作，只有一个注册的上下文引擎被解析。其他启用的 `kind: "context-engine"` 插件仍然可以加载和运行它们的注册代码；`plugins.slots.contextEngine` 只选择 OpenClaw 需要上下文引擎时解析的注册引擎 id。

## 与压缩和内存的关系

- **压缩** 是上下文引擎的职责之一。旧版引擎委托给 OpenClaw 的内置摘要。插件引擎可以实现任何压缩策略（DAG 摘要、向量检索等）。
- **内存插件**（`plugins.slots.memory`）与上下文引擎分开。内存插件提供搜索/检索；上下文引擎控制模型看到的内容。它们可以协同工作 —— 上下文引擎可能在组装期间使用内存插件数据。
- **会话修剪**（修剪内存中的旧工具结果）仍然运行，无论哪个上下文引擎处于活动状态。

## 提示

- 使用 `openclaw doctor` 验证你的引擎是否正确加载。
- 如果切换引擎，现有会话将继续使用其当前历史。新引擎将在未来的运行中接管。
- 引擎错误会被记录并在诊断中显示。如果插件引擎注册失败或选定的引擎 id 无法解析，OpenClaw 不会自动回退；运行会失败，直到你修复插件或将 `plugins.slots.contextEngine` 切换回 `"legacy"`。
- 对于开发，使用 `openclaw plugins install -l ./my-engine` 链接本地插件目录而不复制。

另请参阅：[压缩](/concepts/compaction)、[上下文](/concepts/context)、[插件](/tools/plugin)、[插件清单](/plugins/manifest)。