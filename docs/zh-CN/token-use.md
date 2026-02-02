---
read_when:
  - 解释 token 使用量、费用或上下文窗口时
  - 调试上下文增长或压缩行为时
summary: OpenClaw 如何构建提示上下文以及报告 token 使用量和费用
title: Token 使用与费用
x-i18n:
  generated_at: "2026-02-01T21:39:26Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: aee417119851db9e36890487517ed9602d214849e412127e7f534ebec5c9e105
  source_path: token-use.md
  workflow: 15
---

# Token 使用与费用

OpenClaw 跟踪的是 **token**，而非字符。Token 因模型而异，但大多数 OpenAI 风格的模型对英文文本平均约 4 个字符对应 1 个 token。

## 系统提示的构建方式

OpenClaw 在每次运行时组装自己的系统提示。它包括：

- 工具列表 + 简短描述
- Skills 列表（仅元数据；指令通过 `read` 按需加载）
- 自更新指令
- 工作区 + 引导文件（`AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`、`BOOTSTRAP.md`（仅新会话时加载））。大文件会被 `agents.defaults.bootstrapMaxChars`（默认值：20000）截断。
- 时间（UTC + 用户时区）
- 回复标签 + 心跳行为
- 运行时元数据（主机/操作系统/模型/思考）

完整分解请参阅[系统提示](/concepts/system-prompt)。

## 上下文窗口中计入的内容

模型接收的所有内容都计入上下文限制：

- 系统提示（上面列出的所有部分）
- 对话历史（用户 + 助手消息）
- 工具调用和工具结果
- 附件/转录（图片、音频、文件）
- 压缩摘要和裁剪产物
- 提供商包装器或安全头部（不可见，但仍然计入）

如需了解实际分解（按注入文件、工具、Skills 和系统提示大小），请使用 `/context list` 或 `/context detail`。参见[上下文](/concepts/context)。

## 如何查看当前 token 使用量

在聊天中使用以下命令：

- `/status` → **富表情状态卡片**，显示会话模型、上下文使用量、上次响应的输入/输出 token 数以及**估算费用**（仅 API 密钥模式）。
- `/usage off|tokens|full` → 在每条回复后附加**逐条响应使用量页脚**。
  - 按会话持久化（存储为 `responseUsage`）。
  - OAuth 认证下**隐藏费用**（仅显示 token 数）。
- `/usage cost` → 显示来自 OpenClaw 会话日志的本地费用摘要。

其他界面：

- **TUI/Web TUI：** 支持 `/status` + `/usage`。
- **CLI：** `openclaw status --usage` 和 `openclaw channels list` 显示提供商配额窗口（非逐条响应费用）。

## 费用估算（何时显示）

费用根据你的模型定价配置进行估算：

```
models.providers.<provider>.models[].cost
```

这些是 `input`、`output`、`cacheRead` 和 `cacheWrite` 的**每百万 token 美元价格**。如果缺少定价信息，OpenClaw 仅显示 token 数。OAuth token 永远不显示美元费用。

## 缓存 TTL 与裁剪影响

提供商的提示缓存仅在缓存 TTL 窗口内有效。OpenClaw 可以选择性地运行**缓存 TTL 裁剪**：在缓存 TTL 过期后裁剪会话，然后重置缓存窗口，使后续请求可以复用新缓存的上下文，而不是重新缓存完整历史。这可以在会话空闲超过 TTL 后降低缓存写入费用。

在 [Gateway网关配置](/gateway/configuration)中进行配置，并在[会话裁剪](/concepts/session-pruning)中查看行为详情。

心跳可以在空闲间隙中保持缓存**热活**。如果你的模型缓存 TTL 为 `1h`，将心跳间隔设置为略短于此的值（例如 `55m`），可以避免重新缓存完整提示，从而降低缓存写入费用。

关于 Anthropic API 定价，缓存读取比输入 token 便宜得多，而缓存写入则按更高的倍率计费。请参阅 Anthropic 的提示缓存定价了解最新费率和 TTL 倍率：
https://docs.anthropic.com/docs/build-with-claude/prompt-caching

### 示例：用心跳保持 1 小时缓存热活

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-5"
    models:
      "anthropic/claude-opus-4-5":
        params:
          cacheRetention: "long"
    heartbeat:
      every: "55m"
```

## 降低 token 压力的技巧

- 使用 `/compact` 来摘要长会话。
- 在工作流中裁剪大型工具输出。
- 保持 Skills 描述简短（Skills 列表会注入到提示中）。
- 对于冗长的探索性工作，优先选择较小的模型。

Skills 列表开销的精确计算公式请参阅[Skills](/tools/skills)。
