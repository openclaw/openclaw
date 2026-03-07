---
read_when:
  - 你想要一个在 API 提供商失败时的可靠回退
  - 你正在运行 Claude Code CLI 或其他本地 AI CLI 并想要复用它们
  - 你需要一个纯文本、无工具的路径，但仍支持会话和图像
summary: CLI 后端：通过本地 AI CLI 实现纯文本回退
title: CLI 后端
x-i18n:
  generated_at: "2026-02-03T07:47:52Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 56a96e83b16a4f6443cbf4a9da7a660c41a5b178af5e13f35352c9d72e1b08dd
  source_path: gateway/cli-backends.md
  workflow: 15
---

# CLI 后端（回退运行时）

当 API 提供商宕机、被限流或暂时异常时，OpenClaw 可以运行**本地 AI CLI** 作为**纯文本回退**。这是有意保守的设计：

- **工具被禁用**（无工具调用）。
- **文本输入 → 文本输出**（可靠）。
- **支持会话**（因此后续轮次保持连贯）。
- 如果 CLI 接受图像路径，**图像可以传递**。

这被设计为**安全网**而非主要路径。当你想要"始终有效"的文本响应而不依赖外部 API 时使用它。

## 新手友好快速开始

你可以**无需任何配置**使用 Claude Code CLI（OpenClaw 自带内置默认值）：

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.5
```

Codex CLI 也可以开箱即用：

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.2-codex
```

如果你的 Gateway 网关在 launchd/systemd 下运行且 PATH 很精简，只需添加命令路径：

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
      },
    },
  },
}
```

就这样。除了 CLI 本身外，不需要密钥，不需要额外的认证配置。

## 作为回退使用

将 CLI 后端添加到你的回退列表中，这样它只在主要模型失败时运行：

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-5",
        fallbacks: ["claude-cli/opus-4.5"],
      },
      models: {
        "anthropic/claude-opus-4-5": { alias: "Opus" },
        "claude-cli/opus-4.5": {},
      },
    },
  },
}
```

注意事项：

- 如果你使用 `agents.defaults.models`（允许列表），必须包含 `claude-cli/...`。
- 如果主要提供商失败（认证、限流、超时），OpenClaw 将接着尝试 CLI 后端。

## 配置概览

所有 CLI 后端位于：

```
agents.defaults.cliBackends
```

每个条目以**提供商 ID**（例如 `claude-cli`、`my-cli`）为键。提供商 ID 成为你的模型引用的左侧部分：

```
<provider>/<model>
```

### 配置示例

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          input: "arg",
          modelArg: "--model",
          modelAliases: {
            "claude-opus-4-5": "opus",
            "claude-sonnet-4-5": "sonnet",
          },
          sessionArg: "--session",
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          serialize: true,
        },
      },
    },
  },
}
```

## 工作原理

1. **选择后端**基于提供商前缀（`claude-cli/...`）。
2. **构建系统提示**使用相同的 OpenClaw 提示 + 工作区上下文。
3. **执行 CLI**并带有会话 ID（如果支持），使历史记录保持一致。
4. **解析输出**（JSON 或纯文本）并返回最终文本。
5. **持久化会话 ID**按后端，使后续请求复用相同的 CLI 会话。

## 会话

- 如果 CLI 支持会话，设置 `sessionArg`（例如 `--session-id`）或 `sessionArgs`（占位符 `{sessionId}`）当 ID 需要插入到多个标志中时。
- 如果 CLI 使用带有不同标志的**恢复子命令**，设置 `resumeArgs`（恢复时替换 `args`）以及可选的 `resumeOutput`（用于非 JSON 恢复）。
- `sessionMode`：
  - `always`：始终发送会话 ID（如果没有存储则使用新 UUID）。
  - `existing`：仅在之前存储了会话 ID 时才发送。
  - `none`：从不发送会话 ID。

## 图像（传递）

如果你的 CLI 接受图像路径，设置 `imageArg`：

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw 会将 base64 图像写入临时文件。如果设置了 `imageArg`，这些路径作为 CLI 参数传递。如果缺少 `imageArg`，OpenClaw 会将文件路径附加到提示中（路径注入），这对于从纯路径自动加载本地文件的 CLI 来说已经足够（Claude Code CLI 行为）。

## 输入 / 输出

- `output: "json"`（默认）尝试解析 JSON 并提取文本 + 会话 ID。
- `output: "jsonl"` 解析 JSONL 流（Codex CLI `--json`）并提取最后一条智能体消息以及存在时的 `thread_id`。
- `output: "text"` 将 stdout 视为最终响应。

输入模式：

- `input: "arg"`（默认）将提示作为最后一个 CLI 参数传递。
- `input: "stdin"` 通过 stdin 发送提示。
- 如果提示很长且设置了 `maxPromptArgChars`，则使用 stdin。

## 默认值（内置）

OpenClaw 自带 `claude-cli` 的默认值：

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw 也自带 `codex-cli` 的默认值：

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

仅在需要时覆盖（常见：绝对 `command` 路径）。

## 限制

- **无 OpenClaw 工具**（CLI 后端永远不会收到工具调用）。某些 CLI 可能仍会运行它们自己的智能体工具。
- **无流式传输**（CLI 输出被收集后返回）。
- **结构化输出**取决于 CLI 的 JSON 格式。
- **Codex CLI 会话**通过文本输出恢复（无 JSONL），这比初始的 `--json` 运行结构化程度低。OpenClaw 会话仍然正常工作。

## 故障排除

- **找不到 CLI**：将 `command` 设置为完整路径。
- **模型名称错误**：使用 `modelAliases` 将 `provider/model` 映射到 CLI 模型。
- **无会话连续性**：确保设置了 `sessionArg` 且 `sessionMode` 不是 `none`（Codex CLI 目前无法使用 JSON 输出恢复）。
- **图像被忽略**：设置 `imageArg`（并验证 CLI 支持文件路径）。
