---
title: "Prompt Caching"
summary: "Prompt caching 的配置项、合并顺序、各提供商行为与调优模式"
read_when:
  - 希望通过缓存保留来降低 prompt token 成本
  - 需要在多 agent 场景下为每个 agent 单独配置缓存行为
  - 正在联合调整 heartbeat 与 cache-ttl 剪枝策略
x-i18n:
  source_path: docs/reference/prompt-caching.md
  source_hash: 7952e90d0d6eb23fee4e0046220dddc7c89dc19aae0129d0619290e081a92778
  workflow: manual
  translator: xingzihai
---

# Prompt Caching

Prompt caching 允许模型提供商在多次请求之间复用未变化的 prompt 前缀（通常是系统/开发者指令及其他稳定上下文），而无需每次重新处理。第一个匹配的请求会写入缓存 token（`cacheWrite`），后续匹配的请求则可读取缓存（`cacheRead`）。

这样做的好处：更低的 token 成本、更快的响应速度，以及长期 session 中更稳定的性能表现。若不启用缓存，即使大部分输入内容未发生变化，每次请求仍需支付完整的 prompt 费用。

本页涵盖所有影响 prompt 复用和 token 成本的缓存相关配置项。

Anthropic 定价详情请参阅：
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

## 主要配置项

### `cacheRetention`（模型级与 per-agent）

在模型参数中设置缓存保留策略：

```yaml
agents:
  defaults:
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "short" # none | short | long
```

per-agent 覆盖：

```yaml
agents:
  list:
    - id: "alerts"
      params:
        cacheRetention: "none"
```

配置合并顺序：

1. `agents.defaults.models["provider/model"].params`
2. `agents.list[].params`（匹配 agent id；按 key 覆盖）

### 旧版 `cacheControlTtl`

旧版值仍被接受，并会自动映射：

- `5m` → `short`
- `1h` → `long`

新配置建议使用 `cacheRetention`。

### `contextPruning.mode: "cache-ttl"`

在缓存 TTL 窗口过期后剪除旧的 tool-result 上下文，避免空闲后的请求重新缓存过大的历史记录。

```yaml
agents:
  defaults:
    contextPruning:
      mode: "cache-ttl"
      ttl: "1h"
```

完整行为说明请参阅 [Session Pruning](/concepts/session-pruning)。

### Heartbeat 保温

Heartbeat 可以保持缓存窗口处于活跃状态，减少空闲后重复写入缓存的次数。

```yaml
agents:
  defaults:
    heartbeat:
      every: "55m"
```

per-agent heartbeat 支持在 `agents.list[].heartbeat` 中配置。

## 各提供商行为

### Anthropic（直连 API）

- 支持 `cacheRetention`。
- 使用 Anthropic API key 认证配置时，OpenClaw 会在未设置的情况下为 Anthropic 模型引用自动填充 `cacheRetention: "short"`。

### Amazon Bedrock

- Anthropic Claude 模型引用（`amazon-bedrock/*anthropic.claude*`）支持显式传递 `cacheRetention`。
- 非 Anthropic 的 Bedrock 模型在运行时会被强制设为 `cacheRetention: "none"`。

### OpenRouter Anthropic 模型

对于 `openrouter/anthropic/*` 模型引用，OpenClaw 会在系统/开发者 prompt 块上注入 Anthropic `cache_control`，以提升 prompt 缓存复用率。

### 其他提供商

若提供商不支持此缓存模式，`cacheRetention` 将不产生任何效果。

## 调优模式

### 混合流量（推荐默认）

为主 agent 保持长效基线缓存，对突发性通知 agent 禁用缓存：

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
  list:
    - id: "research"
      default: true
      heartbeat:
        every: "55m"
    - id: "alerts"
      params:
        cacheRetention: "none"
```

### 成本优先基线

- 将基线设为 `cacheRetention: "short"`。
- 启用 `contextPruning.mode: "cache-ttl"`。
- 仅对需要保持缓存热度的 agent 将 heartbeat 间隔设置在 TTL 以内。

## 缓存诊断

OpenClaw 为嵌入式 agent 运行提供专用的缓存追踪诊断功能。

### `diagnostics.cacheTrace` 配置

```yaml
diagnostics:
  cacheTrace:
    enabled: true
    filePath: "~/.openclaw/logs/cache-trace.jsonl" # 可选
    includeMessages: false # 默认 true
    includePrompt: false # 默认 true
    includeSystem: false # 默认 true
```

默认值：

- `filePath`：`$OPENCLAW_STATE_DIR/logs/cache-trace.jsonl`
- `includeMessages`：`true`
- `includePrompt`：`true`
- `includeSystem`：`true`

### 环境变量（临时调试）

- `OPENCLAW_CACHE_TRACE=1`：启用缓存追踪。
- `OPENCLAW_CACHE_TRACE_FILE=/path/to/cache-trace.jsonl`：覆盖输出路径。
- `OPENCLAW_CACHE_TRACE_MESSAGES=0|1`：切换完整消息内容捕获。
- `OPENCLAW_CACHE_TRACE_PROMPT=0|1`：切换 prompt 文本捕获。
- `OPENCLAW_CACHE_TRACE_SYSTEM=0|1`：切换系统 prompt 捕获。

### 查看内容

- 缓存追踪事件为 JSONL 格式，包含 `session:loaded`、`prompt:before`、`stream:context`、`session:after` 等阶段快照。
- 每次请求的缓存 token 影响可通过 `cacheRead` 和 `cacheWrite` 在常规使用界面查看（例如 `/usage full` 和 session 用量摘要）。

## 快速排障

- **大多数请求 `cacheWrite` 偏高**：检查系统 prompt 输入是否存在易变内容，并确认模型/提供商支持当前缓存设置。
- **`cacheRetention` 无效**：确认模型 key 与 `agents.defaults.models["provider/model"]` 完全匹配。
- **Bedrock Nova/Mistral 请求带有缓存设置**：运行时会被强制设为 `none`，属于预期行为。

相关文档：

- [Anthropic](/providers/anthropic)
- [Token 用量与费用](/reference/token-use)
- [Session Pruning](/concepts/session-pruning)
- [Gateway 配置参考](/gateway/configuration-reference)
