---
description: Typed workflow runtime for OpenClaw — composable pipelines with approval gates.
read_when:
  - 你想要具有显式审批的确定性多步骤工作流
  - 你需要恢复工作流而不重新运行早期步骤
summary: OpenClaw 的类型化工作流运行时，支持可恢复的审批关卡。
title: Lobster
x-i18n:
  generated_at: "2026-02-03T10:11:30Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: ff84e65f4be162ad98f16ddf0882f23b3198f05b4d9e8dc03d07e9b2bf0fd5ad
  source_path: tools/lobster.md
  workflow: 15
---

# Lobster

Lobster 是一个工作流外壳，让 OpenClaw 能够将多步骤工具序列作为单个确定性操作运行，并带有显式审批检查点。

## 亮点

你的助手可以构建管理自身的工具。请求一个工作流，30 分钟后你就有了一个 CLI 和作为单次调用运行的管道。Lobster 是缺失的那一块：确定性管道、显式审批和可恢复状态。

## 为什么

如今，复杂的工作流需要多次来回的工具调用。每次调用都消耗 token，LLM 必须编排每一步。Lobster 将这种编排移入类型化运行时：

- **一次调用代替多次**：OpenClaw 运行一次 Lobster 工具调用并获得结构化结果。
- **内置审批**：副作用（发送邮件、发布评论）会暂停工作流，直到明确批准。
- **可恢复**：暂停的工作流返回一个令牌；批准并恢复而无需重新运行所有内容。

## 为什么用 DSL 而不是普通程序？

Lobster 故意很小。目标不是"一种新语言"，而是一个可预测的、AI 友好的管道规范，具有一流的审批和恢复令牌。

- **内置批准/恢复**：普通程序可以提示人类，但它无法*暂停和恢复*并带有持久令牌，除非你自己发明那个运行时。
- **确定性 + 可审计性**：管道是数据，所以它们易于记录、比较、重放和审查。
- **AI 的受限表面**：微小的语法 + JSON 管道减少了"创造性"代码路径，使验证变得现实可行。
- **内置安全策略**：超时、输出上限、沙箱检查和白名单由运行时强制执行，而不是每个脚本。
- **仍然可编程**：每个步骤都可以调用任何 CLI 或脚本。如果你想要 JS/TS，可以从代码生成 `.lobster` 文件。

## 工作原理

OpenClaw 以**工具模式**启动本地 `lobster` CLI，并从 stdout 解析 JSON 信封。
如果管道暂停等待审批，工具会返回一个 `resumeToken`，以便你稍后继续。

## 模式：小型 CLI + JSON 管道 + 审批

构建输出 JSON 的小命令，然后将它们链接成单个 Lobster 调用。（下面是示例命令名称——替换成你自己的。）

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

如果管道请求审批，使用令牌恢复：

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI 触发工作流；Lobster 执行步骤。审批关卡使副作用显式且可审计。

示例：将输入项映射到工具调用：

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## 纯 JSON 的 LLM 步骤（llm-task）

对于需要**结构化 LLM 步骤**的工作流，启用可选的
`llm-task` 插件工具并从 Lobster 调用它。这保持了工作流的
确定性，同时仍然允许你使用模型进行分类/摘要/起草。

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

在管道中使用它：

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
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

参见 [LLM Task](/tools/llm-task) 了解详情和配置选项。

## 工作流文件（.lobster）

Lobster 可以运行包含 `name`、`args`、`steps`、`env`、`condition` 和 `approval` 字段的 YAML/JSON 工作流文件。在 OpenClaw 工具调用中，将 `pipeline` 设置为文件路径。

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

注意事项：

- `stdin: $step.stdout` 和 `stdin: $step.json` 传递前一步骤的输出。
- `condition`（或 `when`）可以根据 `$step.approved` 控制步骤。

## 安装 Lobster

在运行 OpenClaw Gateway 网关的**同一主机**上安装 Lobster CLI（参见 [Lobster 仓库](https://github.com/openclaw/lobster)），并确保 `lobster` 在 `PATH` 中。
如果你想使用自定义二进制位置，在工具调用中传递**绝对**路径 `lobsterPath`。

## 启用工具

Lobster 是一个**可选**的插件工具（默认未启用）。

推荐（附加，安全）：

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

或每个智能体：

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

避免使用 `tools.allow: ["lobster"]`，除非你打算在限制性白名单模式下运行。

注意：白名单对于可选插件是自愿加入的。如果你的白名单只包含
插件工具（如 `lobster`），OpenClaw 会保持核心工具启用。要限制核心
工具，也要在白名单中包含你想要的核心工具或组。

## 示例：邮件分类

不使用 Lobster：

```
用户："检查我的邮件并起草回复"
→ openclaw 调用 gmail.list
→ LLM 总结
→ 用户："给 #2 和 #5 起草回复"
→ LLM 起草
→ 用户："发送 #2"
→ openclaw 调用 gmail.send
（每天重复，不记得已分类的内容）
```

使用 Lobster：

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

返回一个 JSON 信封（已截断）：

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

以工具模式运行管道。

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "/path/to/workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

使用参数运行工作流文件：

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

在审批后继续暂停的工作流。

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### 可选输入

- `lobsterPath`：Lobster 二进制文件的绝对路径（省略则使用 `PATH`）。
- `cwd`：管道的工作目录（默认为当前进程工作目录）。
- `timeoutMs`：如果子进程超过此持续时间则终止（默认：20000）。
- `maxStdoutBytes`：如果 stdout 超过此大小则终止子进程（默认：512000）。
- `argsJson`：传递给 `lobster run --args-json` 的 JSON 字符串（仅限工作流文件）。

## 输出信封

Lobster 返回一个具有三种状态之一的 JSON 信封：

- `ok` → 成功完成
- `needs_approval` → 已暂停；需要 `requiresApproval.resumeToken` 才能恢复
- `cancelled` → 明确拒绝或取消

工具在 `content`（格式化 JSON）和 `details`（原始对象）中都显示信封。

## 审批

如果存在 `requiresApproval`，检查提示并决定：

- `approve: true` → 恢复并继续副作用
- `approve: false` → 取消并终结工作流

使用 `approve --preview-from-stdin --limit N` 将 JSON 预览附加到审批请求，无需自定义 jq/heredoc 粘合代码。恢复令牌现在很紧凑：Lobster 在其状态目录下存储工作流恢复状态，并返回一个小令牌键。

## OpenProse

OpenProse 与 Lobster 配合良好：使用 `/prose` 编排多智能体准备，然后运行 Lobster 管道进行确定性审批。如果 Prose 程序需要 Lobster，通过 `tools.subagents.tools` 为子智能体允许 `lobster` 工具。参见 [OpenProse](/prose)。

## 安全

- **仅限本地子进程** — 插件本身不进行网络调用。
- **无密钥** — Lobster 不管理 OAuth；它调用管理 OAuth 的 OpenClaw 工具。
- **沙箱感知** — 当工具上下文处于沙箱隔离状态时禁用。
- **加固** — 如果指定，`lobsterPath` 必须是绝对路径；强制执行超时和输出上限。

## 故障排除

- **`lobster subprocess timed out`** → 增加 `timeoutMs`，或拆分长管道。
- **`lobster output exceeded maxStdoutBytes`** → 提高 `maxStdoutBytes` 或减少输出大小。
- **`lobster returned invalid JSON`** → 确保管道以工具模式运行并只打印 JSON。
- **`lobster failed (code …)`** → 在终端中运行相同的管道以检查 stderr。

## 了解更多

- [插件](/tools/plugin)
- [插件工具开发](/plugins/agent-tools)

## 案例研究：社区工作流

一个公开示例：一个"第二大脑" CLI + Lobster 管道，管理三个 Markdown 库（个人、伴侣、共享）。CLI 为统计、收件箱列表和过时扫描输出 JSON；Lobster 将这些命令链接成 `weekly-review`、`inbox-triage`、`memory-consolidation` 和 `shared-task-sync` 等工作流，每个都有审批关卡。AI 在可用时处理判断（分类），不可用时回退到确定性规则。

- 帖子：https://x.com/plattenschieber/status/2014508656335770033
- 仓库：https://github.com/bloomedai/brain-cli
