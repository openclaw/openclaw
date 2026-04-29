---
summary: "OpenClaw 如何构建 prompt 上下文并报告 token 使用量和成本"
read_when:
  - 解释 token 使用量、成本或上下文窗口
  - 调试上下文增长或 compaction 行为
title: "Token 使用和成本"
---

# Token 使用和成本

OpenClaw 追踪**tokens**，而不是字符。Tokens 是模型特定的，但大多数 OpenAI-style 模型对于英文文本平均约每 token 4 个字符。

## System prompt 是如何构建的

OpenClaw 每次运行时组装自己的 system prompt。它包括：

- 工具列表 + 简短描述
- Skills 列表（仅元数据；指令按需用 `read` 加载）。紧凑 skills block 由 `skills.limits.maxSkillsPromptChars` 限定，可选的每个 Agent 覆盖位于 `agents.list[].skillsLimits.maxSkillsPromptChars`。
- 自我更新指令
- 工作区 + bootstrap 文件（`AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`、`BOOTSTRAP.md`（新增时），加上 `MEMORY.md`（存在时））。小写根 `memory.md` 不被注入；它是 legacy 修复输入，用于与 `MEMORY.md` 配对时的 `openclaw doctor --fix`。大文件由 `agents.defaults.bootstrapMaxChars`（默认：12000）截断，bootstrap 注入总计由 `agents.defaults.bootstrapTotalMaxChars`（默认：60000）上限。`memory/*.md` 每日文件不是正常 bootstrap prompt 的一部分；它们在普通 turns 上仍通过内存工具按需提供，但 reset/startup 模型运行可以在第一次 turn 前面 prepended 一个带有最近每日内存的一次性 startup-context block。裸聊天 `/new` 和 `/reset` 命令被确认而不调用模型。Startup prelude 由 `agents.defaults.startupContext` 控制。
- 时间（UTC + 用户时区）
- 回复 tags + heartbeat 行为
- 运行时元数据（host/OS/model/thinking）

参见 [System Prompt](/concepts/system-prompt) 中的完整分解。

## 什么计入上下文窗口

模型接收的所有内容都计入上下文限制：

- System prompt（上面列出的所有部分）
- 对话历史（用户 + assistant 消息）
- 工具调用和工具结果
- 附件/transcripts（图片、音频、文件）
- Compaction 摘要和 pruning artifacts
- 提供商 wrappers 或安全 headers（不可见，但仍然计入）

一些运行时繁重的 surface 有自己的显式上限：

- `agents.defaults.contextLimits.memoryGetMaxChars`
- `agents.defaults.contextLimits.memoryGetDefaultLines`
- `agents.defaults.contextLimits.toolResultMaxChars`
- `agents.defaults.contextLimits.postCompactionMaxChars`

每个 Agent 覆盖位于 `agents.list[].contextLimits`。这些旋钮用于有限的运行时摘录和注入的运行时拥有的 blocks。它们与 bootstrap 限制、startup-context 限制和 skills prompt 限制是分开的。

对于图片，OpenClaw 在提供商调用之前缩小 transcript/tool image payloads。使用 `agents.defaults.imageMaxDimensionPx`（默认：`1200`）来调优：

- 较低的值通常减少 vision-token 使用和 payload 大小。
- 较高的值为 OCR/UI 重截图保留更多视觉细节。

对于每个注入文件、工具、skills 和 system prompt 大小的实际分解，使用 `/context list` 或 `/context detail`。参见 [Context](/concepts/context)。

## 如何查看当前 token 使用量

在聊天中使用：

- `/status` → **emoji 丰富的状态卡**，带有会话模型、上下文使用量、最后响应 input/output tokens 和**估算成本**（仅 API key）。
- `/usage off|tokens|full` → 在每个回复后附加**每响应 usage footer**。
  - 按会话持久化（存储为 `responseUsage`）。
  - OAuth auth **隐藏成本**（仅 tokens）。
- `/usage cost` → 显示来自 OpenClaw 会话日志的本地成本摘要。

其他 surface：

- **TUI/Web TUI：** 支持 `/status` + `/usage`。
- **CLI：** `openclaw status --usage` 和 `openclaw channels list` 显示规范化提供商配额窗口（`X% left`，不是每响应成本）。当前 usage-window 提供商：Anthropic、GitHub Copilot、Gemini CLI、OpenAI Codex、MiniMax、Xiaomi 和 z.ai。

Usage surface 在显示前规范化常见提供商原生字段别名。对于 OpenAI-family Responses 流量，这包括 `input_tokens`/`output_tokens` 和 `prompt_tokens`/`completion_tokens`，因此 transport-specific 字段名不会改变 `/status`、`/usage` 或会话摘要。Gemini CLI JSON usage 也被规范化：回复文本来自 `response`，`stats.cached` 映射到 `cacheRead`，当 CLI 省略显式 `stats.input` 字段时使用 `stats.input_tokens - stats.cached`。对于原生 OpenAI-family Responses 流量，WebSocket/SSE usage 别名以相同方式规范化，当 `total_tokens` 缺失或为 `0` 时总计回退到规范化 input + output。当当前会话 snapshot 稀疏时，`/status` 和 `session_status` 也可以从最近 transcript usage 日志恢复 token/cache 计数器和活动运行时模型标签。已存在的非零 live 值仍优先于 transcript 回退值，较大的面向 prompt 的 transcript 总计可以在存储总计缺失或较小时获胜。提供商配额窗口的 usage auth 来自提供商特定的 hooks（如果有）；否则 OpenClaw 回退到从 auth profiles、env 或 config 匹配 OAuth/API-key 凭据。Assistant transcript 条目持久化相同的规范化 usage shape，包括当活动模型配置了定价且提供商返回 usage 元数据时的 `usage.cost`。这给了 `/usage cost` 和 transcript-backed 会话状态一个稳定源，即使 live 运行时状态消失后。

OpenClaw 将提供商 usage 计费与当前上下文 snapshot 分开。提供商 `usage.total` 可以包括缓存的 input、output 和多个 tool-loop 模型调用，因此对成本和遥测有用，但可能高估 live 上下文窗口。上下文显示和诊断使用最新 prompt snapshot（`promptTokens`，或者当没有 prompt snapshot 可用时的最后一个模型调用）用于 `context.used`。

## 成本估算（显示时）

成本从您的模型定价配置估算：

```
models.providers.<provider>.models[].cost
```

这些是 `input`、`output`、`cacheRead` 和 `cacheWrite` 的**每 1M tokens USD**。如果定价缺失，OpenClaw 仅显示 tokens。OAuth tokens 从不显示美元成本。

Gateway 启动时还对没有本地定价的已配置模型引用执行可选的后台定价 bootstrap。该 bootstrap 获取远程 OpenRouter 和 LiteLLM 定价目录。设置 `models.pricing.enabled: false` 以跳过离线或受限网络上的那些启动目录获取；显式 `models.providers.*.models[].cost` 条目继续驱动本地成本估算。

## Cache TTL 和 pruning 影响

提供商 prompt caching 仅在 cache TTL 窗口内适用。OpenClaw 可以选择运行 **cache-ttl pruning**：一旦 cache TTL 过期，它会修剪会话，然后重置 cache 窗口，以便后续请求可以重用 freshly cached 的上下文，而不是重新缓存完整历史。这在会话 idle 超过 TTL 时保持 cache 写入成本较低。

在 [Gateway configuration](/gateway/configuration) 中配置，行为详情参见 [Session pruning](/concepts/session-pruning)。

Heartbeat 可以跨 idle 间隔保持 cache **warm**。如果您的模型 cache TTL 是 `1h`，将 heartbeat 间隔设置在略低于该值（如 `55m`）可以避免重新缓存完整 prompt，减少 cache 写入成本。

在多 Agent 设置中，您可以保持一个共享模型配置，并用 `agents.list[].params.cacheRetention` 按 Agent 调优 cache 行为。

有关完整的旋钮指南，请参见 [Prompt Caching](/reference/prompt-caching)。

对于 Anthropic API 定价，cache 读取显著便宜于 input tokens，而 cache 写入按更高倍数计费。参见 Anthropic 的 prompt caching 定价了解最新费率和 TTL 倍数：[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### 示例：用 heartbeat 保持 1h cache warm

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
    heartbeat:
      every: "55m"
```

### 示例：混合流量与每个 Agent 的 cache 策略

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long" # 大多数 Agent 的默认基线
  list:
    - id: "research"
      default: true
      heartbeat:
        every: "55m" # 为深度会话保持 long cache warm
    - id: "alerts"
      params:
        cacheRetention: "none" # 避免突发通知的 cache 写入
```

`agents.list[].params` 在所选模型的 `params` 之上合并，因此您可以仅覆盖 `cacheRetention` 并保持其他模型默认值不变。

### 示例：启用 Anthropic 1M context beta header

Anthropic 的 1M 上下文窗口目前是 beta-gated。当您在支持的 Opus 或 Sonnet 模型上启用 `context1m` 时，OpenClaw 可以注入所需的 `anthropic-beta` 值。

```yaml
agents:
  defaults:
    models:
      "anthropic/claude-opus-4-6":
        params:
          context1m: true
```

这映射到 Anthropic 的 `context-1m-2025-08-07` beta header。

仅当在该模型条目上设置 `context1m: true` 时适用。

要求：凭据必须有资格使用长上下文。如果不能，Anthropic 会以该请求的提供商端 rate limit 错误回应。

如果您使用 OAuth/subscription tokens（`sk-ant-oat-*`）对 Anthropic 进行身份验证，OpenClaw 跳过 `context-1m-*` beta header，因为 Anthropic 目前用 HTTP 401 拒绝该组合。

## 减少 token 压力的提示

- 使用 `/compact` 总结长会话。
- 在您的工作流中修剪大型工具输出。
- 为截图繁重的会话降低 `agents.defaults.imageMaxDimensionPx`。
- 保持 skill 描述简短（skill 列表被注入 prompt）。
- 对于冗长的探索性工作，偏好使用更小的模型。

参见 [Skills](/tools/skills) 获取确切的 skill 列表开销公式。

## 相关

- [API usage and costs](/reference/api-usage-costs)
- [Prompt caching](/reference/prompt-caching)
- [Usage tracking](/concepts/usage-tracking)
