---
summary: "上下文引擎：可插拔的上下文组装、压缩和子代理生命周期"
read_when:
  - 你想了解 OpenClaw 如何组装模型上下文
  - 你正在在传统引擎和插件引擎之间切换
  - 你正在构建上下文引擎插件
---

# 上下文引擎

**上下文引擎**控制 OpenClaw 如何为每次运行构建模型上下文。它决定包含哪些消息，如何总结较旧的历史记录，以及如何跨子代理边界管理上下文。

OpenClaw 附带一个内置的 `legacy` 引擎。插件可以注册替代引擎，以替换活动的上下文引擎生命周期。

## 快速开始

检查哪个引擎处于活动状态：

```bash
openclaw doctor
# 或直接检查配置：
cat ~/.openclaw/openclaw.json | jq '.plugins.slots.contextEngine'
```

### 安装上下文引擎插件

上下文引擎插件的安装方式与任何其他 OpenClaw 插件一样。先安装，然后在插槽中选择引擎：

```bash
# 从 npm 安装
openclaw plugins install @martian-engineering/lossless-claw

# 或从本地路径安装（用于开发）
openclaw plugins install -l ./my-context-engine
```

然后在配置中启用插件并将其选择为活动引擎：

```json5
// openclaw.json
{
  plugins: {
    slots: {
      contextEngine: "lossless-claw", // 必须与插件注册的引擎 ID 匹配
    },
    entries: {
      "lossless-claw": {
        enabled: true,
        // 插件特定的配置在这里（见插件的文档）
      },
    },
  },
}
```

安装和配置后重启网关。

要切换回内置引擎，将 `contextEngine` 设置为 `"legacy"`（或完全删除该键 — `"legacy"` 是默认值）。

## 工作原理

每次 OpenClaw 运行模型提示时，上下文引擎会在四个生命周期点参与：

1. **摄取** — 当新消息添加到会话时调用。引擎可以在自己的数据存储中存储或索引消息。
2. **组装** — 在每次模型运行前调用。引擎返回一组有序的消息（和可选的 `systemPromptAddition`），这些消息适合令牌预算。
3. **压缩** — 当上下文窗口已满或用户运行 `/compact` 时调用。引擎总结较旧的历史记录以释放空间。
4. **回合后** — 在运行完成后调用。引擎可以持久化状态、触发后台压缩或更新索引。

### 子代理生命周期（可选）

OpenClaw 当前调用一个子代理生命周期钩子：

- **onSubagentEnded** — 当子代理会话完成或被清理时进行清理。

`prepareSubagentSpawn` 钩子是未来使用的接口的一部分，但运行时尚未调用它。

### 系统提示添加

`assemble` 方法可以返回 `systemPromptAddition` 字符串。OpenClaw 将其添加到运行的系统提示的开头。这允许引擎注入动态回忆指导、检索指令或上下文感知提示，而不需要静态工作区文件。

## 传统引擎

内置的 `legacy` 引擎保留了 OpenClaw 的原始行为：

- **摄取**：无操作（会话管理器直接处理消息持久化）。
- **组装**：传递（运行时中现有的清理 → 验证 → 限制管道处理上下文组装）。
- **压缩**：委托给内置的摘要压缩，它创建较旧消息的单个摘要并保持最近消息完整。
- **回合后**：无操作。

传统引擎不注册工具或提供 `systemPromptAddition`。

当未设置 `plugins.slots.contextEngine`（或设置为 `"legacy"`）时，会自动使用此引擎。

## 插件引擎

插件可以使用插件 API 注册上下文引擎：

```ts
import { buildMemorySystemPromptAddition } from "openclaw/plugin-sdk/core";

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

    async assemble({ sessionId, messages, tokenBudget, availableTools, citationsMode }) {
      // 返回适合预算的消息
      return {
        messages: buildContext(messages, tokenBudget),
        estimatedTokens: countTokens(messages),
        systemPromptAddition: buildMemorySystemPromptAddition({
          availableTools: availableTools ?? new Set(),
          citationsMode,
        }),
      };
    },

    async compact({ sessionId, force }) {
      // 总结较旧的上下文
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

| 成员               | 类型 | 用途                                          |
| ------------------ | ---- | --------------------------------------------- |
| `info`             | 属性 | 引擎 ID、名称、版本以及它是否拥有压缩         |
| `ingest(params)`   | 方法 | 存储单个消息                                  |
| `assemble(params)` | 方法 | 为模型运行构建上下文（返回 `AssembleResult`） |
| `compact(params)`  | 方法 | 总结/减少上下文                               |

`assemble` 返回带有以下内容的 `AssembleResult`：

- `messages` — 发送给模型的有序消息。
- `estimatedTokens`（必需，`number`）— 引擎对组装上下文中总令牌数的估计。OpenClaw 使用此值进行压缩阈值决策和诊断报告。
- `systemPromptAddition`（可选，`string`）— 添加到系统提示的开头。

可选成员：

| 成员                           | 类型 | 用途                                                                   |
| ------------------------------ | ---- | ---------------------------------------------------------------------- |
| `bootstrap(params)`            | 方法 | 为会话初始化引擎状态。当引擎首次看到会话时调用一次（例如，导入历史）。 |
| `ingestBatch(params)`          | 方法 | 以批次形式摄取完成的回合。在运行完成后调用，一次获取该回合的所有消息。 |
| `afterTurn(params)`            | 方法 | 运行后的生命周期工作（持久化状态，触发后台压缩）。                     |
| `prepareSubagentSpawn(params)` | 方法 | 为子会话设置共享状态。                                                 |
| `onSubagentEnded(params)`      | 方法 | 子代理结束后进行清理。                                                 |
| `dispose()`                    | 方法 | 释放资源。在网关关闭或插件重新加载期间调用 — 不是每个会话。            |

### ownsCompaction

`ownsCompaction` 控制 Pi 的内置尝试内自动压缩是否为运行保持启用：

- `true` — 引擎拥有压缩行为。OpenClaw 为该运行禁用 Pi 的内置自动压缩，引擎的 `compact()` 实现负责 `/compact`、溢出恢复压缩以及它想在 `afterTurn()` 中执行的任何主动压缩。
- `false` 或未设置 — Pi 的内置自动压缩仍可能在提示执行期间运行，但活动引擎的 `compact()` 方法仍会为 `/compact` 和溢出恢复调用。

`ownsCompaction: false` **不**意味着 OpenClaw 会自动回退到传统引擎的压缩路径。

这意味着有两种有效的插件模式：

- **拥有模式** — 实现你自己的压缩算法并设置 `ownsCompaction: true`。
- **委托模式** — 设置 `ownsCompaction: false` 并让 `compact()` 调用 `openclaw/plugin-sdk/core` 中的 `delegateCompactionToRuntime(...)` 以使用 OpenClaw 的内置压缩行为。

对于活动的非拥有引擎，无操作的 `compact()` 是不安全的，因为它会禁用该引擎插槽的正常 `/compact` 和溢出恢复压缩路径。

## 配置参考

```json5
{
  plugins: {
    slots: {
      // 选择活动的上下文引擎。默认值："legacy"。
      // 设置为插件 ID 以使用插件引擎。
      contextEngine: "legacy",
    },
  },
}
```

该插槽在运行时是独占的 — 对于给定的运行或压缩操作，只解析一个注册的上下文引擎。其他启用的 `kind: "context-engine"` 插件仍然可以加载并运行其注册代码；`plugins.slots.contextEngine` 只选择 OpenClaw 在需要上下文引擎时解析哪个注册的引擎 ID。

## 与压缩和内存的关系

- **压缩**是上下文引擎的一项职责。传统引擎委托给 OpenClaw 的内置摘要。插件引擎可以实现任何压缩策略（DAG 摘要、向量检索等）。
- **内存插件**（`plugins.slots.memory`）与上下文引擎分开。内存插件提供搜索/检索；上下文引擎控制模型看到的内容。它们可以一起工作 — 上下文引擎可能在组装期间使用内存插件数据。想要活动内存提示路径的插件引擎应该首选 `openclaw/plugin-sdk/core` 中的 `buildMemorySystemPromptAddition(...)`，它将活动内存提示部分转换为准备好添加的 `systemPromptAddition`。如果引擎需要更底层的控制，它仍然可以通过 `buildActiveMemoryPromptSection(...)` 从 `openclaw/plugin-sdk/memory-host-core` 提取原始行。
- **会话修剪**（在内存中修剪旧工具结果）仍然运行，无论哪个上下文引擎处于活动状态。

## 提示

- 使用 `openclaw doctor` 验证你的引擎是否正确加载。
- 如果切换引擎，现有会话会继续使用其当前历史记录。新引擎接管未来的运行。
- 引擎错误会记录并在诊断中显示。如果插件引擎注册失败或无法解析所选引擎 ID，OpenClaw 不会自动回退；运行会失败，直到你修复插件或将 `plugins.slots.contextEngine` 切换回 `"legacy"`。
- 对于开发，使用 `openclaw plugins install -l ./my-engine` 链接本地插件目录而不复制。

另请参阅：[压缩](/concepts/compaction)、[上下文](/concepts/context)、[插件](/tools/plugin)、[插件清单](/plugins/manifest)。

## 相关

- [上下文](/concepts/context) — 如何为代理回合构建上下文
- [插件架构](/plugins/architecture) — 注册上下文引擎插件
- [压缩](/concepts/compaction) — 总结长对话
