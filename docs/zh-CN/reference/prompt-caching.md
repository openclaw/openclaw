---
title: "提示词缓存"
summary: "提示词缓存配置、合并顺序、提供商行为和调优模式"
read_when:
  - 想要通过缓存保留降低提示词 token 成本
  - 需要在多代理设置中配置每个代理的缓存行为
  - 正在联合调优心跳和 cache-ttl 修剪
---

# 提示词缓存

提示词缓存意味着模型提供商可以跨轮次复用未变更的提示词前缀（通常是系统/开发者指令和其他稳定上下文），而不是每次都重新处理。第一个匹配的请求会写入缓存 token（`cacheWrite`），后续匹配的请求可以读取它们（`cacheRead`）。

为什么这很重要：更低的 token 成本、更快的响应速度，以及长时间运行会话中更可预测的性能。如果没有缓存，即使大部分输入没有变化，重复的提示词也要在每轮支付完整的提示词费用。

本页涵盖所有影响提示词复用和 token 成本的缓存相关配置。

有关 Anthropic 定价详情，请参阅：
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

## 主要配置

### `cacheRetention`（全局默认、模型和每代理级别）

为所有模型设置全局默认的缓存保留策略：

```yaml
agents:
  defaults:
    params:
      cacheRetention: "long" # none | short | long
```

按模型覆盖：

```yaml
agents:
  defaults:
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "short" # none | short | long
```

按代理覆盖：

```yaml
agents:
  list:
    - id: "alerts"
      params:
        cacheRetention: "none"
```

配置合并顺序：

1. `agents.defaults.params`（全局默认 — 适用于所有模型）
2. `agents.defaults.models["provider/model"].params`（按模型覆盖）
3. `agents.list[].params`（匹配的代理 id；按键覆盖）

### 旧版 `cacheControlTtl`

旧版值仍然被接受并自动映射：

- `5m` -> `short`
- `1h` -> `long`

新配置请优先使用 `cacheRetention`。

### `contextPruning.mode: "cache-ttl"`

在缓存 TTL 窗口后修剪旧的工具结果上下文，避免空闲后的请求重新缓存过大的历史记录。

```yaml
agents:
  defaults:
    contextPruning:
      mode: "cache-ttl"
      ttl: "1h"
```

完整行为请参阅[会话修剪](/concepts/session-pruning)。

### 心跳保温

心跳可以保持缓存窗口活跃，减少空闲间隔后的重复缓存写入。

```yaml
agents:
  defaults:
    heartbeat:
      every: "55m"
```

支持在 `agents.list[].heartbeat` 配置每代理心跳。

## 提供商行为

### Anthropic（直接 API）

- 支持 `cacheRetention`。
- 使用 Anthropic API-key 认证配置时，OpenClaw 会在未设置的情况下为 Anthropic 模型引用预设 `cacheRetention: "short"`。

### Amazon Bedrock

- Anthropic Claude 模型引用（`amazon-bedrock/*anthropic.claude*`）支持显式 `cacheRetention` 透传。
- 非 Anthropic Bedrock 模型在运行时被强制设为 `cacheRetention: "none"`。

### OpenRouter Anthropic 模型

对于 `openrouter/anthropic/*` 模型引用，OpenClaw 会在系统/开发者提示词块上注入 Anthropic `cache_control`，以提高提示词缓存复用率。

### 其他提供商

如果提供商不支持此缓存模式，`cacheRetention` 不会生效。

## 调优模式

### 混合流量（推荐默认方案）

为主代理保持长期缓存基线，为突发通知代理禁用缓存：

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

- 设置基线 `cacheRetention: "short"`。
- 启用 `contextPruning.mode: "cache-ttl"`。
- 仅为受益于缓存保温的代理将心跳保持在 TTL 以下。

## 缓存诊断

OpenClaw 为嵌入式代理运行提供专用的缓存追踪诊断功能。

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

### 环境变量开关（一次性调试）

- `OPENCLAW_CACHE_TRACE=1` 启用缓存追踪。
- `OPENCLAW_CACHE_TRACE_FILE=/path/to/cache-trace.jsonl` 覆盖输出路径。
- `OPENCLAW_CACHE_TRACE_MESSAGES=0|1` 切换完整消息载荷捕获。
- `OPENCLAW_CACHE_TRACE_PROMPT=0|1` 切换提示词文本捕获。
- `OPENCLAW_CACHE_TRACE_SYSTEM=0|1` 切换系统提示词捕获。

### 检查内容

- 缓存追踪事件为 JSONL 格式，包括 `session:loaded`、`prompt:before`、`stream:context` 和 `session:after` 等阶段快照。
- 每轮缓存 token 影响可通过常规使用界面的 `cacheRead` 和 `cacheWrite` 查看（例如 `/usage full` 和会话用量摘要）。

## 快速故障排除

- 大多数轮次的 `cacheWrite` 很高：检查是否有易变的系统提示词输入，并确认模型/提供商支持你的缓存设置。
- `cacheRetention` 没有效果：确认模型键匹配 `agents.defaults.models["provider/model"]`。
- Bedrock Nova/Mistral 请求带有缓存设置：运行时会被预期强制为 `none`。

相关文档：

- [Anthropic](/providers/anthropic)
- [Token 用量与成本](/reference/token-use)
- [会话修剪](/concepts/session-pruning)
- [Gateway 配置参考](/gateway/configuration-reference)
