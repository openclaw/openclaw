---
summary: "CLI 后端：具有可选 MCP 工具桥接的本地 AI CLI 回退"
read_when:
  - 当 API 提供商失败时，您需要可靠的回退方案
  - 您正在运行 Codex CLI 或其他本地 AI CLI 并希望重用它们
  - 您想了解用于 CLI 后端工具访问的 MCP 环回桥接
title: "CLI 后端"
---

# CLI 后端（回退运行时）

当 API 提供商宕机、限速或暂时行为异常时，OpenClaw 可以运行**本地 AI CLI**作为**纯文本回退**。这是有意保守的：

- **OpenClaw 工具不会直接注入**，但具有 `bundleMcp: true` 的后端可以通过环回 MCP 桥接接收网关工具。
- **JSONL 流式传输**用于支持它的 CLI。
- **支持会话**（因此后续回合保持连贯）。
- **图像可以传递**，如果 CLI 接受图像路径。

这被设计为**安全网**，而不是主要路径。当您希望“始终有效”的文本响应而不依赖外部 API 时使用它。

如果您想要一个具有 ACP 会话控制、后台任务、线程/对话绑定和持久外部编码会话的完整测试运行时，请使用[ACP 代理](/tools/acp-agents)。CLI 后端不是 ACP。

## 初学者友好的快速入门

您可以**无需任何配置**使用 Codex CLI（捆绑的 OpenAI 插件注册默认后端）：

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.4
```

如果您的网关在 launchd/systemd 下运行且 PATH 最小，请仅添加命令路径：

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "codex-cli": {
          command: "/opt/homebrew/bin/codex",
        },
      },
    },
  },
}
```

就是这样。不需要密钥，除了 CLI 本身外不需要额外的身份验证配置。

如果您在网关主机上将捆绑的 CLI 后端用作**主要消息提供商**，当您的配置在模型引用中或在 `agents.defaults.cliBackends` 下明确引用该后端时，OpenClaw 现在会自动加载拥有该后端的捆绑插件。

## 将其用作回退

将 CLI 后端添加到您的回退列表中，使其仅在主模型失败时运行：

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["codex-cli/gpt-5.4"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "codex-cli/gpt-5.4": {},
      },
    },
  },
}
```

注意：

- 如果您使用 `agents.defaults.models`（允许列表），您也必须在其中包含您的 CLI 后端模型。
- 如果主提供商失败（身份验证、限速、超时），OpenClaw 将接下来尝试 CLI 后端。

## 配置概述

所有 CLI 后端都位于：

```
agents.defaults.cliBackends
```

每个条目都由**提供商 ID**（例如 `codex-cli`、`my-cli`）作为键。提供商 ID 成为模型引用的左侧：

```
<provider>/<model>
```

### 示例配置

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "codex-cli": {
          command: "/opt/homebrew/bin/codex",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          input: "arg",
          modelArg: "--model",
          modelAliases: {
            "claude-opus-4-6": "opus",
            "claude-sonnet-4-6": "sonnet",
          },
          sessionArg: "--session",
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptArg: "--system",
          // Codex 风格的 CLI 可以指向提示文件：
          // systemPromptFileConfigArg: "-c",
          // systemPromptFileConfigKey: "model_instructions_file",
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

1. **根据提供商前缀选择后端**（`codex-cli/...`）。
2. **使用相同的 OpenClaw 提示 + 工作区上下文构建系统提示**。
3. **使用会话 ID 执行 CLI**（如果支持），以便历史保持一致。
4. **解析输出**（JSON 或纯文本）并返回最终文本。
5. **按后端持久化会话 ID**，以便后续使用同一个 CLI 会话。

<Note>
捆绑的 Anthropic `claude-cli` 后端再次受到支持。Anthropic 工作人员告诉我们，OpenClaw 风格的 Claude CLI 使用再次被允许，因此 OpenClaw 将 `claude -p` 使用视为对此集成的认可，除非 Anthropic 发布新政策。
</Note>

捆绑的 OpenAI `codex-cli` 后端通过 Codex 的 `model_instructions_file` 配置覆盖（`-c model_instructions_file="..."`）传递 OpenClaw 的系统提示。Codex 不公开 Claude 风格的 `--append-system-prompt` 标志，因此 OpenClaw 为每个新的 Codex CLI 会话将组装的提示写入临时文件。

捆绑的 Anthropic `claude-cli` 后端通过两种方式接收 OpenClaw 技能快照：附加系统提示中的紧凑 OpenClaw 技能目录，以及通过 `--plugin-dir` 传递的临时 Claude Code 插件。该插件仅包含该代理/会话的合格技能，因此 Claude Code 的原生技能解析器看到的是与 OpenClaw 原本会在提示中宣传的相同过滤集。技能环境/API 密钥覆盖仍然由 OpenClaw 应用到运行的子进程环境。

## 会话

- 如果 CLI 支持会话，设置 `sessionArg`（例如 `--session-id`）或 `sessionArgs`（当 ID 需要插入到多个标志中时的占位符 `{sessionId}`）。
- 如果 CLI 使用带有不同标志的**恢复子命令**，设置 `resumeArgs`（恢复时替换 `args`）和可选的 `resumeOutput`（用于非 JSON 恢复）。
- `sessionMode`：
  - `always`：始终发送会话 ID（如果没有存储则为新 UUID）。
  - `existing`：仅在之前存储过会话 ID 时发送。
  - `none`：从不发送会话 ID。

序列化注意事项：

- `serialize: true` 保持同车道运行有序。
- 大多数 CLI 在一个提供商车道上序列化。
- 当后端身份验证状态更改时，包括重新登录、令牌轮换或更改的身份验证配置文件凭据，OpenClaw 会放弃存储的 CLI 会话重用。

## 图像（传递）

如果您的 CLI 接受图像路径，设置 `imageArg`：

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw 将 base64 图像写入临时文件。如果设置了 `imageArg`，这些路径作为 CLI 参数传递。如果缺少 `imageArg`，OpenClaw 会将文件路径附加到提示（路径注入），这对于自动从纯路径加载本地文件的 CLI 来说足够了。

## 输入/输出

- `output: "json"`（默认）尝试解析 JSON 并提取文本 + 会话 ID。
- 对于 Gemini CLI JSON 输出，当 `usage` 缺失或为空时，OpenClaw 从 `response` 读取回复文本并从 `stats` 读取使用情况。
- `output: "jsonl"` 解析 JSONL 流（例如 Codex CLI `--json`）并提取最终代理消息以及会话标识符（如果存在）。
- `output: "text"` 将 stdout 视为最终响应。

输入模式：

- `input: "arg"`（默认）将提示作为最后一个 CLI 参数传递。
- `input: "stdin"` 通过 stdin 发送提示。
- 如果提示很长且设置了 `maxPromptArgChars`，则使用 stdin。

## 默认值（插件拥有）

捆绑的 OpenAI 插件还为 `codex-cli` 注册默认值：

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","workspace-write","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","-c","sandbox_mode=\"workspace-write\"","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

捆绑的 Google 插件还为 `google-gemini-cli` 注册默认值：

- `command: "gemini"`
- `args: ["--output-format", "json", "--prompt", "{prompt}"]`
- `resumeArgs: ["--resume", "{sessionId}", "--output-format", "json", "--prompt", "{prompt}"]`
- `imageArg: "@"`
- `imagePathScope: "workspace"`
- `modelArg: "--model"`
- `sessionMode: "existing"`
- `sessionIdFields: ["session_id", "sessionId"]`

前提条件：本地 Gemini CLI 必须已安装并在 `PATH` 上可用为 `gemini`（`brew install gemini-cli` 或 `npm install -g @google/gemini-cli`）。

Gemini CLI JSON 注意事项：

- 回复文本从 JSON `response` 字段读取。
- 当 `usage` 不存在或为空时，使用情况回退到 `stats`。
- `stats.cached` 被归一化为 OpenClaw `cacheRead`。
- 如果 `stats.input` 缺失，OpenClaw 从 `stats.input_tokens - stats.cached` 派生输入令牌。

仅在需要时覆盖（常见：绝对 `command` 路径）。

## 插件拥有的默认值

CLI 后端默认值现在是插件表面的一部分：

- 插件使用 `api.registerCliBackend(...)` 注册它们。
- 后端 `id` 成为模型引用中的提供商前缀。
- `agents.defaults.cliBackends.<id>` 中的用户配置仍然覆盖插件默认值。
- 后端特定的配置清理通过可选的 `normalizeConfig` 钩子保持插件拥有。

需要微小提示/消息兼容性垫片的插件可以声明双向文本转换，而无需替换提供商或 CLI 后端：

```typescript
api.registerTextTransforms({
  input: [
    { from: /red basket/g, to: "blue basket" },
    { from: /paper ticket/g, to: "digital ticket" },
    { from: /left shelf/g, to: "right shelf" },
  ],
  output: [
    { from: /blue basket/g, to: "red basket" },
    { from: /digital ticket/g, to: "paper ticket" },
    { from: /right shelf/g, to: "left shelf" },
  ],
});
```

`input` 重写传递给 CLI 的系统提示和用户提示。`output` 重写流式助手增量和解析的最终文本，然后 OpenClaw 处理其自己的控制标记和通道传递。

对于发出 Claude Code stream-json 兼容 JSONL 的 CLI，在该后端的配置上设置 `jsonlDialect: "claude-stream-json"`。

## 捆绑 MCP 覆盖

CLI 后端**不会**直接接收 OpenClaw 工具调用，但后端可以通过 `bundleMcp: true` 选择加入生成的 MCP 配置覆盖。

当前捆绑行为：

- `claude-cli`：生成严格的 MCP 配置文件
- `codex-cli`：`mcp_servers` 的内联配置覆盖
- `google-gemini-cli`：生成 Gemini 系统设置文件

当启用捆绑 MCP 时，OpenClaw：

- 生成一个环回 HTTP MCP 服务器，向 CLI 进程公开网关工具
- 使用每个会话令牌（`OPENCLAW_MCP_TOKEN`）验证桥接
- 将工具访问范围限定为当前会话、账户和通道上下文
- 为当前工作区加载启用的捆绑 MCP 服务器
- 将它们与任何现有的后端 MCP 配置/设置形状合并
- 使用拥有扩展的后端拥有的集成模式重写启动配置

如果没有启用 MCP 服务器，当后端选择加入捆绑 MCP 时，OpenClaw 仍然会注入严格的配置，以便后台运行保持隔离。

## 限制

- **无直接 OpenClaw 工具调用**。OpenClaw 不会将工具调用注入 CLI 后端协议。后端只有在选择加入 `bundleMcp: true` 时才会看到网关工具。
- **流式传输是后端特定的**。一些后端流式传输 JSONL；其他后端缓冲直到退出。
- **结构化输出**取决于 CLI 的 JSON 格式。
- **Codex CLI 会话**通过文本输出恢复（无 JSONL），这比初始 `--json` 运行的结构少。OpenClaw 会话仍然正常工作。

## 故障排除

- **未找到 CLI**：将 `command` 设置为完整路径。
- **模型名称错误**：使用 `modelAliases` 将 `provider/model` → CLI 模型映射。
- **无会话连续性**：确保设置了 `sessionArg` 且 `sessionMode` 不是 `none`（Codex CLI 当前无法使用 JSON 输出恢复）。
- **图像被忽略**：设置 `imageArg`（并验证 CLI 支持文件路径）。
