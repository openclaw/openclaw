---
read_when:
  - 你需要在 API 提供商故障时使用可靠的回退方案
  - 你正在运行 Claude Code CLI 或其他本地 AI CLI，并希望复用它们
  - 你需要一个纯文本、无工具的路径，同时仍支持会话和图片
summary: CLI 后端：通过本地 AI CLI 实现纯文本回退
title: CLI 后端
x-i18n:
  generated_at: "2026-02-01T20:25:48Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 56a96e83b16a4f6443cbf4a9da7a660c41a5b178af5e13f35352c9d72e1b08dd
  source_path: gateway/cli-backends.md
  workflow: 14
---

# CLI 后端（回退运行时）

OpenClaw 可以将**本地 AI CLI** 作为**纯文本回退**运行，适用于 API 提供商宕机、被限流或暂时异常的情况。该方案设计上有意保持保守：

- **工具已禁用**（不进行工具调用）。
- **文本输入 → 文本输出**（可靠）。
- **支持会话**（后续对话轮次保持连贯）。
- **可传递图片**（如果 CLI 接受图片路径）。

这被设计为**安全兜底方案**，而非主要路径。当你希望在不依赖外部 API 的情况下获得"始终可用"的文本响应时，可以使用它。

## 新手快速入门

你可以**无需任何配置**直接使用 Claude Code CLI（OpenClaw 内置了默认配置）：

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.5
```

Codex CLI 同样开箱即用：

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.2-codex
```

如果你的 Gateway网关在 launchd/systemd 下运行且 PATH 较精简，只需添加命令路径：

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

就这样。除了 CLI 本身之外，无需密钥，无需额外的认证配置。

## 用作回退方案

将 CLI 后端添加到回退列表中，这样它只在主模型失败时运行：

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

- 如果使用了 `agents.defaults.models`（白名单），必须包含 `claude-cli/...`。
- 如果主提供商失败（认证、限流、超时），OpenClaw 将尝试使用 CLI 后端。

## 配置概览

所有 CLI 后端位于：

```
agents.defaults.cliBackends
```

每个条目以**提供商 ID** 为键（例如 `claude-cli`、`my-cli`）。
提供商 ID 成为模型引用的左半部分：

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

1. **根据提供商前缀选择后端**（`claude-cli/...`）。
2. **构建系统提示词**，使用相同的 OpenClaw 提示词 + 工作区上下文。
3. **执行 CLI**，附带会话 ID（如支持），以保持历史记录一致。
4. **解析输出**（JSON 或纯文本），返回最终文本。
5. **持久化会话 ID**（按后端分别存储），后续对话复用同一 CLI 会话。

## 会话

- 如果 CLI 支持会话，设置 `sessionArg`（例如 `--session-id`），或设置 `sessionArgs`（占位符 `{sessionId}`）以将 ID 插入多个标志中。
- 如果 CLI 使用带有不同标志的**恢复子命令**，设置 `resumeArgs`（恢复时替换 `args`），并可选设置 `resumeOutput`（用于非 JSON 恢复）。
- `sessionMode`：
  - `always`：始终发送会话 ID（如无存储则生成新 UUID）。
  - `existing`：仅在之前已存储会话 ID 时才发送。
  - `none`：从不发送会话 ID。

## 图片（透传）

如果你的 CLI 接受图片路径，设置 `imageArg`：

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw 会将 base64 图片写入临时文件。如果设置了 `imageArg`，这些路径将作为 CLI 参数传递。如果未设置 `imageArg`，OpenClaw 会将文件路径追加到提示词中（路径注入），这对于能从纯文本路径自动加载本地文件的 CLI 已经足够（Claude Code CLI 的行为即是如此）。

## 输入 / 输出

- `output: "json"`（默认）尝试解析 JSON 并提取文本 + 会话 ID。
- `output: "jsonl"` 解析 JSONL 流（Codex CLI `--json`），提取最后一条智能体消息以及 `thread_id`（如存在）。
- `output: "text"` 将标准输出作为最终响应。

输入模式：

- `input: "arg"`（默认）将提示词作为最后一个 CLI 参数传递。
- `input: "stdin"` 通过标准输入发送提示词。
- 如果提示词很长且设置了 `maxPromptArgChars`，将使用标准输入。

## 默认值（内置）

OpenClaw 为 `claude-cli` 内置了默认配置：

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw 还为 `codex-cli` 内置了默认配置：

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

仅在需要时覆盖（常见情况：绝对 `command` 路径）。

## 限制

- **无 OpenClaw 工具**（CLI 后端不会接收工具调用）。某些 CLI 可能仍会运行自身的智能体工具。
- **无流式传输**（CLI 输出收集完毕后一次性返回）。
- **结构化输出**取决于 CLI 的 JSON 格式。
- **Codex CLI 会话**通过文本输出恢复（非 JSONL），其结构化程度不如初始的 `--json` 运行。OpenClaw 会话仍正常工作。

## 故障排除

- **找不到 CLI**：将 `command` 设置为完整路径。
- **模型名称错误**：使用 `modelAliases` 将 `provider/model` 映射为 CLI 模型名。
- **无会话连续性**：确保已设置 `sessionArg` 且 `sessionMode` 不是 `none`（Codex CLI 目前无法以 JSON 输出恢复会话）。
- **图片被忽略**：设置 `imageArg`（并确认 CLI 支持文件路径）。
