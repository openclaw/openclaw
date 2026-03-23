---
read_when:
  - 你想减少工具输出导致的 LLM 上下文增长
  - 你正在调整 agents.defaults.contextPruning
summary: 会话剪枝：工具结果修剪以减少上下文膨胀
x-i18n:
  generated_at: "2026-02-03T07:46:35Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 9b0aa2d1abea7050ba848a2db038ccc3e6e2d83c6eb4e3843a2ead0ab847574a
  source_path: concepts/session-pruning.md
  workflow: 15
---

# 会话剪枝

会话剪枝在每次 LLM 调用之前从内存上下文中修剪**旧的工具结果**。它**不会**重写磁盘上的会话历史（`*.jsonl`）。

## 运行时机

- 当启用 `mode: "cache-ttl"` 且该会话的最后一次 Anthropic 调用早于 `ttl` 时。
- 仅影响该请求发送给模型的消息。
- 仅对 Anthropic API 调用（和 OpenRouter Anthropic 模型）生效。
- 为获得最佳效果，请将 `ttl` 与你的模型 `cacheControlTtl` 匹配。
- 剪枝后，TTL 窗口会重置，因此后续请求会保持缓存直到 `ttl` 再次过期。

## 智能默认值（Anthropic）

- **OAuth 或 setup-token** 配置文件：启用 `cache-ttl` 剪枝并将心跳设置为 `1h`。
- **API 密钥**配置文件：启用 `cache-ttl` 剪枝，将心跳设置为 `30m`，并将 Anthropic 模型的 `cacheControlTtl` 默认为 `1h`。
- 如果你显式设置了这些值中的任何一个，OpenClaw **不会**覆盖它们。

## 改进内容（成本 + 缓存行为）

- **为什么要剪枝：** Anthropic 提示缓存仅在 TTL 内适用。如果会话空闲超过 TTL，下一个请求会重新缓存完整提示，除非你先修剪它。
- **什么变得更便宜：** 剪枝减少了 TTL 过期后第一个请求的 **cacheWrite** 大小。
- **为什么 TTL 重置很重要：** 一旦剪枝运行，缓存窗口会重置，因此后续请求可以重用新缓存的提示，而不是再次重新缓存完整历史。
- **它不做什么：** 剪枝不会添加 token 或"双倍"成本；它只改变该 TTL 后第一个请求缓存的内容。

## 可以剪枝的内容

- 仅 `toolResult` 消息。
- 用户 + 助手消息**永远不会**被修改。
- 最后 `keepLastAssistants` 条助手消息受保护；该截止点之后的工具结果不会被剪枝。
- 如果没有足够的助手消息来确定截止点，则跳过剪枝。
- 包含**图像块**的工具结果会被跳过（永不修剪/清除）。

## 上下文窗口估算

剪枝使用估算的上下文窗口（字符 ≈ token × 4）。基础窗口按以下顺序解析：

1. `models.providers.*.models[].contextWindow` 覆盖。
2. 模型定义 `contextWindow`（来自模型注册表）。
3. 默认 `200000` token。

如果设置了 `agents.defaults.contextTokens`，它将被视为解析窗口的上限（最小值）。

## 模式

### cache-ttl

- 仅当最后一次 Anthropic 调用早于 `ttl`（默认 `5m`）时才运行剪枝。
- 运行时：与之前相同的软修剪 + 硬清除行为。

## 软剪枝 vs 硬剪枝

- **软修剪**：仅用于过大的工具结果。
  - 保留头部 + 尾部，插入 `...`，并附加一个包含原始大小的注释。
  - 跳过包含图像块的结果。
- **硬清除**：用 `hardClear.placeholder` 替换整个工具结果。

## 工具选择

- `tools.allow` / `tools.deny` 支持 `*` 通配符。
- 拒绝优先。
- 匹配不区分大小写。
- 允许列表为空 => 允许所有工具。

## 与其他限制的交互

- 内置工具已经截断自己的输出；会话剪枝是一个额外的层，防止长时间运行的聊天在模型上下文中累积过多的工具输出。
- 压缩是独立的：压缩进行总结并持久化，剪枝是每个请求的临时操作。参阅 [/concepts/compaction](/concepts/compaction)。

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

启用 TTL 感知剪枝：

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

限制剪枝到特定工具：

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

参阅配置参考：[Gateway 网关配置](/gateway/configuration)
