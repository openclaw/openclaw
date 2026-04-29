---
summary: "Prompt caching 旋钮、合并顺序、提供商行为和调优模式"
title: "Prompt caching"
read_when:
  - 您想用 cache retention 降低 prompt token 成本
  - 您需要在多 Agent 设置中设置每个 Agent 的 cache 行为
  - 您正在一起调优 heartbeat 和 cache-ttl pruning
---

Prompt caching 意味着模型提供商可以跨 turn 重用不变的 prompt 前缀（通常是 system/developer 指令和其他稳定上下文），而不是每次都重新处理。OpenClaw 将提供商使用规范化为 `cacheRead` 和 `cacheWrite`，其中上游 API 直接暴露这些计数器。

状态 surface 也可以从最近的 transcript 使用日志中恢复 cache 计数器，当 live session snapshot 缺少它们时，这样 `/status` 可以在部分 session 元数据丢失后继续显示 cache 行。已存在的非零 live cache 值仍优先于 transcript 回退值。

为什么这很重要：更低的 token 成本、更快的响应，以及更可预测的长会话性能。没有 caching，重复的 prompts 在每次 turn 都要支付完整 prompt 成本，即使大部分输入没有改变。

以下部分涵盖每个影响 prompt 重用和 token 成本的 cache 相关旋钮。

提供商参考：

- Anthropic prompt caching: [https://platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- OpenAI prompt caching: [https://developers.openai.com/api/docs/guides/prompt-caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- OpenAI API headers and request IDs: [https://developers.openai.com/api/reference/overview](https://developers.openai.com/api/reference/overview)
- Anthropic request IDs and errors: [https://platform.claude.com/docs/en/api/errors](https://platform.claude.com/docs/en/api/errors)

## 主要旋钮

### `cacheRetention`（全局默认、模型和每个 Agent）

为所有模型设置 cache retention 全局默认值：

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

每个 Agent 覆盖：

```yaml
agents:
  list:
    - id: "alerts"
      params:
        cacheRetention: "none"
```

配置合并顺序：

1. `agents.defaults.params`（全局默认 —— 适用于所有模型）
2. `agents.defaults.models["provider/model"].params`（每个模型覆盖）
3. `agents.list[].params`（匹配的 agent id；按键覆盖）

### `contextPruning.mode: "cache-ttl"`

在 cache TTL 窗口后剪枝旧的 tool-result 上下文，使 idle 后请求不会重新缓存过大的历史。

```yaml
agents:
  defaults:
    contextPruning:
      mode: "cache-ttl"
      ttl: "1h"
```

参见 [Session Pruning](/concepts/session-pruning) 获取完整行为。

### Heartbeat keep-warm

Heartbeat 可以保持 cache 窗口 warm，减少 idle 间隔后的重复 cache 写入。

```yaml
agents:
  defaults:
    heartbeat:
      every: "55m"
```

在 `agents.list[].heartbeat` 支持每个 Agent heartbeat。

## 提供商行为

### Anthropic（直接 API）

- 支持 `cacheRetention`。
- 使用 Anthropic API-key auth profiles 时，OpenClaw 在未设置时为 Anthropic 模型引用植入 `cacheRetention: "short"`。
- Anthropic 原生 Messages 响应暴露 `cache_read_input_tokens` 和 `cache_creation_input_tokens`，所以 OpenClaw 可以同时显示 `cacheRead` 和 `cacheWrite`。
- 对于原生 Anthropic 请求，`cacheRetention: "short"` 映射到默认的 5 分钟 ephemeral cache，`cacheRetention: "long"` 在直接 `api.anthropic.com` 主机上升级到 1 小时 TTL。

### OpenAI（直接 API）

- Prompt caching 在支持的新模型上自动启用。OpenClaw 不需要注入 block 级 cache 标记。
- OpenClaw 使用 `prompt_cache_key` 保持 cache 路由跨 turn 稳定，仅当在直接 OpenAI 主机上选择 `cacheRetention: "long"` 时才使用 `prompt_cache_retention: "24h"`。
- OpenAI-compatible Completions 提供商仅在其模型配置显式设置 `compat.supportsPromptCacheKey: true` 时才接收 `prompt_cache_key`；`cacheRetention: "none"` 仍会抑制它。
- OpenAI 响应通过 `usage.prompt_tokens_details.cached_tokens`（或在 Responses API 事件上 `input_tokens_details.cached_tokens`）暴露缓存的 prompt tokens。OpenClaw 将其映射到 `cacheRead`。
- OpenAI 不暴露单独的 cache-write token 计数器，所以即使提供商正在预热 cache，`cacheWrite` 在 OpenAI 路径上保持为 `0`。
- OpenAI 返回有用的 tracing 和 rate-limit headers 如 `x-request-id`、`openai-processing-ms` 和 `x-ratelimit-*`，但 cache-hit 计费应来自 usage payload，而不是 headers。
- 实际上，OpenAI 通常表现得像 initial-prefix cache 而不是 Anthropic 风格的移动全历史重用。稳定的 long-prefix 文本 turn 可以在当前 live probe 中达到接近 `4864` 的缓存 token plateau，而 tool-heavy 或 MCP-style transcripts 即使在完全重复时也经常 plateau 在 `4608` 左右。

### Anthropic Vertex

- Vertex AI 上的 Anthropic 模型（`anthropic-vertex/*`）以与直接 Anthropic 相同的方式支持 `cacheRetention`。
- `cacheRetention: "long"` 映射到 Vertex AI 端点上的真实 1 小时 prompt-cache TTL。
- `anthropic-vertex` 的默认 cache retention 与直接 Anthropic 默认值匹配。
- Vertex 请求通过 boundary-aware cache shaping 路由，因此 cache 重用与提供商实际接收的内容保持一致。

### Amazon Bedrock

- Anthropic Claude 模型引用（`amazon-bedrock/*anthropic.claude*`）支持显式 `cacheRetention` 直通。
- 非 Anthropic Bedrock 模型在运行时强制为 `cacheRetention: "none"`。

### OpenRouter 模型

对于 `openrouter/anthropic/*` 模型引用，OpenClaw 在 system/developer prompt blocks 上注入 Anthropic `cache_control`，以仅在请求仍指向验证的 OpenRouter 路由（`openrouter` 在其默认端点，或解析为 `openrouter.ai` 的任何 provider/base URL）时改善 prompt-cache 重用。

对于 `openrouter/deepseek/*`、`openrouter/moonshot*/*` 和 `openrouter/zai/*` 模型引用，允许 `contextPruning.mode: "cache-ttl"`，因为 OpenRouter 自动处理提供商端 prompt caching。OpenClaw 不会向这些请求注入 Anthropic `cache_control` 标记。

DeepSeek cache 构建是 best-effort，可能需要几秒钟。立即跟进可能仍显示 `cached_tokens: 0`；在短延迟后用重复的相同前缀请求验证，并使用 `usage.prompt_tokens_details.cached_tokens` 作为 cache-hit 信号。

如果您将模型重新指向任意 OpenAI-compatible 代理 URL，OpenClaw 停止注入那些 OpenRouter 特定的 Anthropic cache 标记。

### 其他提供商

如果提供商不支持此 cache 模式，`cacheRetention` 没有效果。

### Google Gemini 直接 API

- 直接 Gemini transport（`api: "google-generative-ai"`）通过上游 `cachedContentTokenCount` 报告 cache hits；OpenClaw 将其映射到 `cacheRead`。
- 当在直接 Gemini 模型上设置 `cacheRetention` 时，OpenClaw 自动为 Google AI Studio runs 的 system prompts 创建、重用和刷新 `cachedContents` 资源。这意味着您不再需要手动预创建 cached-content handle。
- 您仍可以通过 `params.cachedContent`（或 legacy `params.cached_content`）传递预存在的 Gemini cached-content handle。
- 这与 Anthropic/OpenAI 风格的 prompt-prefix caching 是分开的。对于 Gemini，OpenClaw 管理 provider-native `cachedContents` 资源，而不是在请求中注入 cache 标记。

### Gemini CLI JSON usage

- Gemini CLI JSON 输出也可以通过 `stats.cached` 显示 cache hits；OpenClaw 将其映射到 `cacheRead`。
- 如果 CLI 省略了显式的 `stats.input` 值，OpenClaw 从 `stats.input_tokens - stats.cached` 派生 input tokens。
- 这只是 usage 规范化。并不意味着 OpenClaw 为 Gemini 创建 Anthropic/OpenAI 风格的 prompt-cache 标记。

## System-prompt cache boundary

OpenClaw 将 system prompt 分隔为**稳定前缀**和**不稳定后缀**，由内部 cache-prefix boundary 分隔。boundary 上的内容（工具定义、skills 元数据、工作区文件和其他相对静态上下文）是有序的，因此跨 turn 保持字节相同。boundary 下的内容（例如 `HEARTBEAT.md`、运行时时间戳和其他每 turn 元数据）允许更改而不会使缓存前缀失效。

关键设计选择：

- 稳定的工作区项目上下文文件在 `HEARTBEAT.md` 之前排序，因此 heartbeat 变动不会破坏稳定前缀。
- boundary 跨 Anthropic-family、OpenAI-family、Google 和 CLI transport shaping 应用，因此所有支持的提供商都从相同的前缀稳定性中受益。
- Codex Responses 和 Anthropic Vertex 请求通过 boundary-aware cache shaping 路由，因此 cache 重用与提供商实际接收的内容保持一致。
- System-prompt 指纹是规范化的（空白、换行、hook 添加的上下文、运行时能力排序），因此语义上未更改的 prompts 跨 turn 共享 KV/cache。

如果您在配置或工作区更改后看到意外的 `cacheWrite` 峰值，请检查更改是否落在 boundary 上方或下方。将不稳定内容移到 boundary 下方（或稳定它）通常可以解决此问题。

## OpenClaw cache-stability guards

OpenClaw 也在请求到达提供商之前保持多个 cache-sensitive payload shapes 确定性：

- Bundle MCP tool catalogs 在工具注册前进行确定性排序，因此 `listTools()` 顺序更改不会搅动 tools block 并破坏 prompt-cache 前缀。
- 带有持久化 image blocks 的 legacy sessions 保持**最近 3 个完成的 turns** 完整；较旧的已处理 image blocks 可能被替换为标记，以便 image-heavy 跟进不会继续重新发送大型 stale payloads。

## 调优模式

### 混合流量（推荐默认）

在主 Agent 上保持长期基线，在突发通知 Agent 上禁用 caching：

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
- 将 heartbeat 保持在 TTL 以下，仅对受益于 warm caches 的 Agent。

## Cache 诊断

OpenClaw 为嵌入式 Agent 运行暴露专用 cache-trace 诊断。

对于正常的面向用户的诊断，`/status` 和其他 usage 摘要可以在 live session 条目没有这些计数器时使用最新 transcript usage 条目作为 `cacheRead`/`cacheWrite` 的回退源。

## Live 回归测试

OpenClaw 为重复前缀、tool turns、image turns、MCP-style tool transcripts 和 Anthropic no-cache 控制保持一个组合 live cache 回归 gate。

- `src/agents/live-cache-regression.live.test.ts`
- `src/agents/live-cache-regression-baseline.ts`

用以下命令运行 narrow live gate：

```sh
OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_CACHE_TEST=1 pnpm test:live:cache
```

基线文件存储最近观察的 live numbers 加上测试使用的提供商特定回归 floor。
runner 也使用新鲜的 per-run session IDs 和 prompt namespaces，所以之前的 cache 状态不会污染当前回归样本。

这些测试故意不在提供商之间使用相同的成功标准。

### Anthropic live 期望

- 通过 `cacheWrite` 期望显式的预热写入。
- 期望在重复 turns 上接近全历史重用，因为 Anthropic cache control 通过对话推进 cache  breakpoint。
- 当前 live 断言仍对 stable、tool 和 image 路径使用高 hit-rate 阈值。

### OpenAI live 期望

- 仅期望 `cacheRead`。`cacheWrite` 保持为 `0`。
- 将重复 turn cache 重用视为提供商特定的 plateau，而不是 Anthropic 风格的移动全历史重用。
- 当前 live 断言使用从 `gpt-5.4-mini` 上观察到的 live 行为派生的保守 floor checks：
  - stable prefix: `cacheRead >= 4608`, hit rate `>= 0.90`
  - tool transcript: `cacheRead >= 4096`, hit rate `>= 0.85`
  - image transcript: `cacheRead >= 3840`, hit rate `>= 0.82`
  - MCP-style transcript: `cacheRead >= 4096`, hit rate `>= 0.85`

2026-04-04 的最新组合 live 验证结果为：

- stable prefix: `cacheRead=4864`, hit rate `0.966`
- tool transcript: `cacheRead=4608`, hit rate `0.896`
- image transcript: `cacheRead=4864`, hit rate `0.954`
- MCP-style transcript: `cacheRead=4608`, hit rate `0.891`

组合 gate 的最近本地 wall-clock 时间约为 `88s`。

为什么断言不同：

- Anthropic 暴露显式 cache breakpoints 和移动对话历史重用。
- OpenAI prompt caching 仍然是精确前缀敏感的，但 live Responses 流量中有效可重用前缀可能比完整 prompt 更早 plateau。
- 正因为如此，通过单一跨提供商百分比阈值比较 Anthropic 和 OpenAI 会产生误报回归。

### `diagnostics.cacheTrace` 配置

```yaml
diagnostics:
  cacheTrace:
    enabled: true
    filePath: "~/.openclaw/logs/cache-trace.jsonl" # 可选
    includeMessages: false # 默认为 true
    includePrompt: false # 默认为 true
    includeSystem: false # 默认为 true
```

默认值：

- `filePath`: `$OPENCLAW_STATE_DIR/logs/cache-trace.jsonl`
- `includeMessages`: `true`
- `includePrompt`: `true`
- `includeSystem`: `true`

### Env 切换（一次性调试）

- `OPENCLAW_CACHE_TRACE=1` 启用 cache tracing。
- `OPENCLAW_CACHE_TRACE_FILE=/path/to/cache-trace.jsonl` 覆盖输出路径。
- `OPENCLAW_CACHE_TRACE_MESSAGES=0|1` 切换完整 message payload 捕获。
- `OPENCLAW_CACHE_TRACE_PROMPT=0|1` 切换 prompt text 捕获。
- `OPENCLAW_CACHE_TRACE_SYSTEM=0|1` 切换 system prompt 捕获。

### 检查什么

- Cache trace 事件是 JSONL，包含 staged snapshots 如 `session:loaded`、`prompt:before`、`stream:context` 和 `session:after`。
- 每 turn cache token 影响可以通过 `cacheRead` 和 `cacheWrite` 在正常使用 surface 中看到（例如 `/usage full` 和 session usage summaries）。
- 对于 Anthropic，同时有 `cacheRead` 和 `cacheWrite`（当 caching 激活时）。
- 对于 OpenAI，cache hits 时有 `cacheRead`，`cacheWrite` 保持为 `0`；OpenAI 不发布单独的 cache-write token 字段。
- 如果您需要 request tracing，从 cache metrics 分别记录 request IDs 和 rate-limit headers。OpenClaw 当前的 cache-trace 输出侧重于 prompt/session shape 和规范化 token usage，而不是原始提供商响应 headers。

## 快速故障排除

- 大多数 turns 上高 `cacheWrite`：检查不稳定 system-prompt 输入并验证模型/提供商支持您的 cache 设置。
- Anthropic 上高 `cacheWrite`：通常意味着 cache breakpoint 落在每次请求都更改的内容上。
- 低 OpenAI `cacheRead`：验证 stable prefix 在前面，重复前缀至少 1024 tokens，并且相同的 `prompt_cache_key` 用于应该共享 cache 的 turns。
- `cacheRetention` 没有效果：确认模型 key 与 `agents.defaults.models["provider/model"]` 匹配。
- Bedrock Nova/Mistral 请求的 cache 设置：预期运行时强制为 `none`。

相关文档：

- [Anthropic](/providers/anthropic)
- [Token use and costs](/reference/token-use)
- [Session pruning](/concepts/session-pruning)
- [Gateway configuration reference](/gateway/configuration-reference)

## 相关

- [Token use and costs](/reference/token-use)
- [API usage and costs](/reference/api-usage-costs)
