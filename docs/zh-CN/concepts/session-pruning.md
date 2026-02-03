---
read_when:
  - 你想减少工具输出导致的 LLM 上下文增长
  - 你正在调优 agents.defaults.contextPruning
summary: 会话裁剪：通过修剪工具结果来减少上下文膨胀
x-i18n:
  generated_at: "2026-02-01T20:23:53Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 9b0aa2d1abea7050ba848a2db038ccc3e6e2d83c6eb4e3843a2ead0ab847574a
  source_path: concepts/session-pruning.md
  workflow: 14
---

# 会话裁剪

会话裁剪在每次 LLM 调用之前修剪内存上下文中的**旧工具结果**。它**不会**重写磁盘上的会话历史（`*.jsonl`）。

## 运行时机

- 当启用 `mode: "cache-ttl"` 且该会话的上次 Anthropic 调用时间超过 `ttl` 时触发。
- 仅影响该请求发送给模型的消息。
- 仅对 Anthropic API 调用（以及 OpenRouter Anthropic 模型）生效。
- 为获得最佳效果，请将 `ttl` 与模型的 `cacheControlTtl` 保持一致。
- 裁剪后，TTL 窗口会重置，后续请求将继续使用缓存直到 `ttl` 再次过期。

## 智能默认值（Anthropic）

- **OAuth 或 setup-token** 配置文件：启用 `cache-ttl` 裁剪，并将心跳设置为 `1h`。
- **API 密钥**配置文件：启用 `cache-ttl` 裁剪，将心跳设置为 `30m`，并将 Anthropic 模型的 `cacheControlTtl` 默认设为 `1h`。
- 如果你显式设置了这些值中的任何一个，OpenClaw **不会**覆盖它们。

## 改善效果（成本 + 缓存行为）

- **为什么要裁剪：** Anthropic 提示缓存仅在 TTL 内生效。如果会话空闲超过 TTL，下一次请求将重新缓存完整提示，除非你先对其进行修剪。
- **哪些费用会降低：** 裁剪减少了 TTL 过期后首次请求的 **cacheWrite** 大小。
- **为什么 TTL 重置很重要：** 裁剪运行后，缓存窗口会重置，因此后续请求可以复用新缓存的提示，而不是再次重新缓存完整历史。
- **它不会做什么：** 裁剪不会增加令牌或"翻倍"成本；它只改变 TTL 过期后首次请求的缓存内容。

## 可裁剪的内容

- 仅限 `toolResult` 消息。
- 用户和助手消息**永远不会**被修改。
- 最后 `keepLastAssistants` 条助手消息受保护；该截止点之后的工具结果不会被裁剪。
- 如果助手消息数量不足以确定截止点，则跳过裁剪。
- 包含**图片块**的工具结果会被跳过（永远不会被修剪/清除）。

## 上下文窗口估算

裁剪使用估算的上下文窗口（字符数 ≈ 令牌数 × 4）。基础窗口按以下顺序解析：

1. `models.providers.*.models[].contextWindow` 覆盖值。
2. 模型定义中的 `contextWindow`（来自模型注册表）。
3. 默认 `200000` 令牌。

如果设置了 `agents.defaults.contextTokens`，它将作为解析窗口的上限（取最小值）。

## 模式

### cache-ttl

- 仅当上次 Anthropic 调用时间超过 `ttl`（默认 `5m`）时才运行裁剪。
- 运行时：与之前相同的软修剪 + 硬清除行为。

## 软裁剪与硬裁剪

- **软修剪**：仅针对超大的工具结果。
  - 保留头部和尾部，插入 `...`，并附加一条包含原始大小的说明。
  - 跳过包含图片块的结果。
- **硬清除**：用 `hardClear.placeholder` 替换整个工具结果。

## 工具选择

- `tools.allow` / `tools.deny` 支持 `*` 通配符。
- 拒绝优先。
- 匹配不区分大小写。
- 允许列表为空 => 允许所有工具。

## 与其他限制的交互

- 内置工具已经会截断自身的输出；会话裁剪是一个额外的保护层，防止长时间运行的对话在模型上下文中积累过多的工具输出。
- 压缩是独立的：压缩会进行摘要并持久化，裁剪则是每次请求的临时操作。参见 [/concepts/compaction](/concepts/compaction)。

## 默认值（启用时）

- `ttl`：`"5m"`
- `keepLastAssistants`：`3`
- `softTrimRatio`：`0.3`
- `hardClearRatio`：`0.5`
- `minPrunableToolChars`：`50000`
- `softTrim`：`{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`：`{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## 示例

默认（关闭）：

```json5
{
  agent: {
    contextPruning: { mode: "off" },
  },
}
```

启用 TTL 感知裁剪：

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

将裁剪限制为特定工具：

```json5
{
  agent: {
    contextPruning: {
      mode: "cache-ttl",
      tools: { allow: ["exec", "read"], deny: ["*image*"] },
    },
  },
}
```

参见配置参考：[Gateway网关配置](/gateway/configuration)
