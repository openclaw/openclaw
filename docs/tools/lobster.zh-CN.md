---
title: Lobster
summary: "OpenClaw 的类型化工作流运行时，带有可恢复的批准门控。"
read_when:
  - 你想要具有显式批准的确定性多步骤工作流
  - 你需要恢复工作流而不重新运行 earlier 步骤
---

# Lobster

Lobster 是一个工作流 shell，允许 OpenClaw 将多步骤工具序列作为单个确定性操作运行，带有显式批准检查点。

Lobster 是分离后台工作之上的一个创作层。对于单个任务之上的流编排，请参阅 [Task Flow](/automation/taskflow)（`openclaw tasks flow`）。对于任务活动分类账，请参阅 [`openclaw tasks`](/automation/tasks)。

## 钩子

你的助手可以构建管理自身的工具。请求一个工作流，30 分钟后你就有了一个 CLI 加上作为一次调用运行的管道。Lobster 是缺失的部分：确定性管道、显式批准和可恢复状态。

## 为什么

今天，复杂的工作流需要许多来回的工具调用。每个调用都消耗令牌，LLM 必须编排每一步。Lobster 将这种编排移动到类型化运行时：

- **一次调用而不是多次**：OpenClaw 运行一个 Lobster 工具调用并获得结构化结果。
- **内置批准**：副作用（发送电子邮件、发表评论）会暂停工作流，直到明确批准。
- **可恢复**：暂停的工作流返回一个令牌；批准并恢复，无需重新运行所有内容。

## 为什么使用 DSL 而不是普通程序？

Lobster 有意设计得很小。目标不是"一种新语言"，而是一个可预测的、AI 友好的管道规范，具有一流的批准和恢复令牌。

- **内置批准/恢复**：普通程序可以提示人类，但它不能 _暂停和恢复_ 并带有持久令牌，除非你自己发明该运行时。
- **确定性 + 可审计性**：管道是数据，因此它们易于记录、差异比较、重放和审查。
- **AI 的受限表面**：微小的语法 + JSON 管道减少了"创造性"代码路径并使验证变得现实。
- **内置安全策略**：超时、输出上限、沙盒检查和允许列表由运行时强制执行，而不是每个脚本。
- **仍然可编程**：每个步骤都可以调用任何 CLI 或脚本。如果你想要 JS/TS，可以从代码生成 `.lobster` 文件。

## 工作原理

OpenClaw 使用嵌入式运行器 **进程内** 运行 Lobster 工作流。不会生成外部 CLI 子进程；工作流引擎在网关进程内部执行并直接返回 JSON 信封。
如果管道暂停等待批准，工具会返回 `resumeToken`，以便你稍后可以继续。

## 模式：小型 CLI + JSON 管道 + 批准

构建使用 JSON 的小命令，然后将它们链接到单个 Lobster 调用中。（下面的示例命令名称 — 替换为你自己的。）

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

如果管道请求批准，使用令牌恢复：

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI 触发工作流；Lobster 执行步骤。批准门控使副作用明确且可审计。

示例：将输入项映射到工具调用：

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## 仅 JSON LLM 步骤（llm-task）

对于需要 **结构化 LLM 步骤** 的工作流，启用可选的
`llm-task` 插件工具并从 Lobster 调用它。这在保持工作流
确定性的同时，仍然允许你使用模型进行分类/总结/起草。

启用工具：

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

在管道中使用：

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "thinking": "low",
  "input": { "subject": "Hello", "body": "Can you help?" },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

有关详细信息和配置选项，请参阅 [LLM Task](/tools/llm-task)。

## 工作流文件（.lobster）

Lobster 可以运行带有 `name`、`args`、`steps`、`env`、`condition` 和 `approval` 字段的 YAML/JSON 工作流文件。在 OpenClaw 工具调用中，将 `pipeline` 设置为文件路径。

```yaml
name: inbox-triage
args:
  tag:
    default: "family"
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

注意：

- `stdin: $step.stdout` 和 `stdin: $step.json` 传递前一步的输出。
- `condition`（或 `when`）可以根据 `$step.approved` 控制步骤。

## 安装 Lobster

捆绑的 Lobster 工作流在进程内运行；不需要单独的 `lobster` 二进制文件。嵌入式运行器随 Lobster 插件一起提供。

如果你需要独立的 Lobster CLI 用于开发或外部管道，请从 [Lobster 仓库](https://github.com/openclaw/lobster) 安装它，并确保 `lobster` 在 `PATH` 上。

## 启用工具

Lobster 是一个 **可选** 插件工具（默认未启用）。

推荐（ additive，安全）：

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

或按代理：

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    ]
  }
}
```

除非你打算在限制性允许列表模式下运行，否则避免使用 `tools.allow: ["lobster"]`。

注意：允许列表是可选插件的选择加入。如果你的允许列表只命名
插件工具（如 `lobster`），OpenClaw 会保持核心工具启用。要限制核心
工具，请在允许列表中也包含你想要的核心工具或组。

## 示例：电子邮件分类

没有 Lobster：

```
用户："检查我的电子邮件并起草回复"
→ openclaw 调用 gmail.list
→ LLM 总结
→ 用户："起草对 #2 和 #5 的回复"
→ LLM 起草
→ 用户："发送 #2"
→ openclaw 调用 gmail.send
（每天重复，没有分类记录）
```

使用 Lobster：

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

返回 JSON 信封（截断）：

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "items": [],
    "resumeToken": "..."
  }
}
```

用户批准 → 恢复：

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

一个工作流。确定性。安全。

## 工具参数

### `run`

在工具模式下运行管道。

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

运行带有参数的工作流文件：

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

批准后继续暂停的工作流。

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### 可选输入

- `cwd`：管道的相对工作目录（必须位于网关工作目录内）。
- `timeoutMs`：如果工作流超过此持续时间则中止（默认：20000）。
- `maxStdoutBytes`：如果输出超过此大小则中止工作流（默认：512000）。
- `argsJson`：传递给 `lobster run --args-json` 的 JSON 字符串（仅工作流文件）。

## 输出信封

Lobster 返回具有三种状态之一的 JSON 信封：

- `ok` → 成功完成
- `needs_approval` → 已暂停；需要 `requiresApproval.resumeToken` 才能恢复
- `cancelled` → 被明确拒绝或取消

该工具在 `content`（美观的 JSON）和 `details`（原始对象）中显示信封。

## 批准

如果存在 `requiresApproval`，检查提示并决定：

- `approve: true` → 恢复并继续副作用
- `approve: false` → 取消并完成工作流

使用 `approve --preview-from-stdin --limit N` 将 JSON 预览附加到批准请求，而无需自定义 jq/heredoc 胶水。恢复令牌现在是紧凑的：Lobster 将工作流恢复状态存储在其状态目录下，并返回一个小的令牌键。

## OpenProse

OpenProse 与 Lobster 配合良好：使用 `/prose` 编排多代理准备，然后运行 Lobster 管道进行确定性批准。如果 Prose 程序需要 Lobster，通过 `tools.subagents.tools` 为子代理允许 `lobster` 工具。请参阅 [OpenProse](/prose)。

## 安全性

- **仅本地进程内** — 工作流在网关进程内部执行；插件本身没有网络调用。
- **无秘密** — Lobster 不管理 OAuth；它调用管理 OAuth 的 OpenClaw 工具。
- **沙盒感知** — 当工具上下文被沙盒化时禁用。
- **强化** — 嵌入式运行器强制执行超时和输出上限。

## 故障排除

- **`lobster timed out`** → 增加 `timeoutMs`，或拆分长管道。
- **`lobster output exceeded maxStdoutBytes`** → 提高 `maxStdoutBytes` 或减少输出大小。
- **`lobster returned invalid JSON`** → 确保管道在工具模式下运行并仅打印 JSON。
- **`lobster failed`** → 检查网关日志以获取嵌入式运行器错误详细信息。

## 了解更多

- [插件](/tools/plugin)
- [插件工具创作](/plugins/building-plugins#registering-agent-tools)

## 案例研究：社区工作流

一个公共示例：一个"第二大脑" CLI + Lobster 管道，管理三个 Markdown 保险库（个人、伙伴、共享）。CLI 发出统计信息、收件箱列表和过时扫描的 JSON；Lobster 将这些命令链接到 `weekly-review`、`inbox-triage`、`memory-consolidation` 和 `shared-task-sync` 等工作流中，每个都有批准门控。AI 在可用时处理判断（分类），在不可用时回退到确定性规则。

- 线程：[https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- 仓库：[https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)

## 相关

- [自动化与任务](/automation) — 调度 Lobster 工作流
- [自动化概述](/automation) — 所有自动化机制
- [工具概述](/tools) — 所有可用的代理工具
