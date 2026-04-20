---
summary: "OpenClaw 如何轮换身份验证配置文件并在模型之间进行故障转移"
read_when:
  - 诊断身份验证配置文件轮换、冷却或模型故障转移行为
  - 更新身份验证配置文件或模型的故障转移规则
  - 了解会话模型覆盖如何与故障转移重试交互
title: "模型故障转移"
---

# 模型故障转移

OpenClaw 在两个阶段处理故障：

1. **身份验证配置文件轮换** - 在当前提供商内部。
2. **模型故障转移** - 到 `agents.defaults.model.fallbacks` 中的下一个模型。

本文档解释了运行时规则及其背后的数据。

## 运行时流程

对于普通文本运行，OpenClaw 按以下顺序评估候选模型：

1. 当前选择的会话模型。
2. 配置的 `agents.defaults.model.fallbacks` 按顺序。
3. 当运行从覆盖开始时，最终回到运行开始时配置的主模型。

在每个候选模型内部，OpenClaw 在进入下一个模型候选之前尝试身份验证配置文件故障转移。

高级序列：

1. 解析活动会话模型和身份验证配置文件偏好。
2. 构建模型候选链。
3. 尝试当前提供商，使用身份验证配置文件轮换/冷却规则。
4. 如果该提供商因值得故障转移的错误而耗尽，移至下一个模型候选。
5. 在重试开始前持久化选定的故障转移覆盖，以便其他会话读取器看到运行器即将使用的相同提供商/模型。
6. 如果故障转移候选失败，仅当它们仍与该失败候选匹配时，回滚仅由故障转移拥有的会话覆盖字段。
7. 如果所有候选都失败，抛出 `FallbackSummaryError`，包含每次尝试的详细信息和已知的最早冷却到期时间。

这故意比"保存和恢复整个会话"更窄。回复运行器仅持久化它为故障转移拥有的模型选择字段：

- `providerOverride`
- `modelOverride`
- `authProfileOverride`
- `authProfileOverrideSource`
- `authProfileOverrideCompactionCount`

这可以防止失败的故障转移重试覆盖较新的不相关会话变更，例如在尝试运行时发生的手动 `/model` 更改或会话轮换更新。

## 身份验证存储（密钥 + OAuth）

OpenClaw 对 API 密钥和 OAuth 令牌都使用**身份验证配置文件**。

- 密钥存储在 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`（旧版：`~/.openclaw/agent/auth-profiles.json`）。
- 运行时身份验证路由状态存储在 `~/.openclaw/agents/<agentId>/agent/auth-state.json`。
- 配置 `auth.profiles` / `auth.order` 仅是**元数据 + 路由**（无密钥）。
- 仅导入的旧版 OAuth 文件：`~/.openclaw/credentials/oauth.json`（首次使用时导入到 `auth-profiles.json`）。

更多详细信息：[/concepts/oauth](/concepts/oauth)

凭证类型：

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }`（某些提供商需要 `projectId`/`enterpriseUrl`）

## 配置文件 ID

OAuth 登录创建不同的配置文件，以便多个账户可以共存。

- 默认值：当没有可用电子邮件时为 `provider:default`。
- 带电子邮件的 OAuth：`provider:<email>`（例如 `google-antigravity:user@gmail.com`）。

配置文件存储在 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` 中的 `profiles` 下。

## 轮换顺序

当提供商有多个配置文件时，OpenClaw 按如下方式选择顺序：

1. **显式配置**：`auth.order[provider]`（如果设置）。
2. **配置的配置文件**：按提供商过滤的 `auth.profiles`。
3. **存储的配置文件**：提供商在 `auth-profiles.json` 中的条目。

如果没有设置显式顺序，OpenClaw 使用轮询顺序：

- **主键**：配置文件类型（**OAuth 优先于 API 密钥**）。
- **辅助键**：`usageStats.lastUsed`（在每种类型内，最旧的优先）。
- **冷却/禁用的配置文件** 移到末尾，按最早到期时间排序。

### 会话粘性（缓存友好）

OpenClaw **按会话固定所选身份验证配置文件**以保持提供商缓存温暖。它**不会**在每个请求上轮换。固定的配置文件会被重用，直到：

- 会话被重置（`/new` / `/reset`）
- 压缩完成（压缩计数递增）
- 配置文件处于冷却/禁用状态

通过 `/model …@<profileId>` 进行的手动选择为该会话设置**用户覆盖**，并且在新会话开始之前不会自动轮换。

自动固定的配置文件（由会话路由器选择）被视为**偏好**：它们首先被尝试，但 OpenClaw 可能会在速率限制/超时时轮换到另一个配置文件。用户固定的配置文件保持锁定到该配置文件；如果它失败并且配置了模型故障转移，OpenClaw 会移至下一个模型，而不是切换配置文件。

### 为什么 OAuth 可能"看起来丢失"

如果您对同一提供商同时拥有 OAuth 配置文件和 API 密钥配置文件，除非固定，否则轮询可能会在消息之间切换它们。要强制使用单个配置文件：

- 使用 `auth.order[provider] = ["provider:profileId"]` 固定，或
- 通过带有配置文件覆盖的 `/model …` 使用会话覆盖（当您的 UI/聊天界面支持时）。

## 冷却

当配置文件因身份验证/速率限制错误（或看起来像速率限制的超时）而失败时，OpenClaw 将其标记为冷却并移至下一个配置文件。该速率限制存储桶比普通 `429` 更广泛：它还包括提供商消息，例如 `Too many concurrent requests`、`ThrottlingException`、`concurrency limit reached`、`workers_ai ... quota limit exceeded`、`throttled`、`resource exhausted` 以及定期使用窗口限制，例如 `weekly/monthly limit reached`。格式/无效请求错误（例如 Cloud Code Assist 工具调用 ID 验证失败）被视为值得故障转移，并使用相同的冷却。OpenAI 兼容的停止原因错误，例如 `Unhandled stop reason: error`、`stop reason: error` 和 `reason: error` 被归类为超时/故障转移信号。当源匹配已知的临时模式时，提供商范围的通用服务器文本也可以进入该超时存储桶。例如，Anthropic 裸露的 `An unknown error occurred` 和带有临时服务器文本（如 `internal server error`、`unknown error, 520`、`upstream error` 或 `backend error`）的 JSON `api_error` 有效负载被视为值得故障转移的超时。OpenRouter 特定的通用上游文本（如裸露的 `Provider returned error`）也仅在提供商上下文实际为 OpenRouter 时被视为超时。通用内部故障转移文本（如 `LLM request failed with an unknown error.`）保持保守，不会自行触发故障转移。

速率限制冷却也可以是模型范围的：

- 当失败的模型 ID 已知时，OpenClaw 记录速率限制失败的 `cooldownModel`。
- 当冷却范围为不同模型时，仍可以尝试同一提供商上的兄弟模型。
- 计费/禁用窗口仍然阻止整个配置文件跨模型。

冷却使用指数退避：

- 1 分钟
- 5 分钟
- 25 分钟
- 1 小时（上限）

状态存储在 `auth-state.json` 中的 `usageStats` 下：

```json
{
  "usageStats": {
    "provider:profile": {
      "lastUsed": 1736160000000,
      "cooldownUntil": 1736160600000,
      "errorCount": 2
    }
  }
}
```

## 计费禁用

计费/信用失败（例如"credits insufficient"/"credit balance too low"）被视为值得故障转移，但它们通常不是暂时的。OpenClaw 不是短暂冷却，而是将配置文件标记为**禁用**（具有更长的退避）并轮换到下一个配置文件/提供商。

并非每个计费形状的响应都是 `402`，也并非每个 HTTP `402` 都落在这里。OpenClaw 即使在提供商返回 `401` 或 `403` 时也会在计费通道中保留明确的计费文本，但提供商特定的匹配器保持限于拥有它们的提供商（例如 OpenRouter `403 Key limit exceeded`）。同时，临时 `402` 使用窗口和组织/工作区支出限制错误在消息看起来可重试时（例如 `weekly usage limit exhausted`、`daily limit reached, resets tomorrow` 或 `organization spending limit exceeded`）被归类为 `rate_limit`。这些停留在短暂的冷却/故障转移路径上，而不是长计费禁用路径。

状态存储在 `auth-state.json` 中：

```json
{
  "usageStats": {
    "provider:profile": {
      "disabledUntil": 1736178000000,
      "disabledReason": "billing"
    }
  }
}
```

默认值：

- 计费退避从**5小时**开始，每次计费失败加倍，上限为**24小时**。
- 如果配置文件**24小时**未失败，退避计数器重置（可配置）。
- 过载重试允许**1次同提供商配置文件轮换**，然后进行模型故障转移。
- 过载重试默认使用**0 ms退避**。

## 模型故障转移规则

如果提供商的所有配置文件都失败，OpenClaw 会移至 `agents.defaults.model.fallbacks` 中的下一个模型。这适用于身份验证失败、速率限制和耗尽配置文件轮换的超时（其他错误不会推进故障转移）。

过载和速率限制错误的处理比计费冷却更积极。默认情况下，OpenClaw 允许一次同提供商身份验证配置文件重试，然后无需等待就切换到下一个配置的模型故障转移。提供商忙碌信号（如 `ModelNotReadyException`）落入该过载存储桶。使用 `auth.cooldowns.overloadedProfileRotations`、`auth.cooldowns.overloadedBackoffMs` 和 `auth.cooldowns.rateLimitedProfileRotations` 调整此设置。

当运行从模型覆盖开始时（钩子或 CLI），故障转移仍然在尝试任何配置的故障转移后以 `agents.defaults.model.primary` 结束。

### 候选链规则

OpenClaw 从当前请求的 `provider/model` 加上配置的故障转移构建候选列表。

规则：

- 请求的模型始终排在第一位。
- 显式配置的故障转移被去重，但不按模型允许列表过滤。它们被视为显式操作员意图。
- 如果当前运行已经在同一提供商系列的配置故障转移上，OpenClaw 继续使用完整的配置链。
- 如果当前运行在与配置不同的提供商上，并且当前模型尚未成为配置故障转移链的一部分，OpenClaw 不会从另一个提供商附加不相关的配置故障转移。
- 当运行从覆盖开始时，配置的主模型被追加到末尾，以便链可以在早期候选耗尽后回到正常默认值。

### 哪些错误推进故障转移

模型故障转移在以下情况下继续：

- 身份验证失败
- 速率限制和冷却耗尽
- 过载/提供商忙碌错误
- 超时形状的故障转移错误
- 计费禁用
- `LiveSessionModelSwitchError`，它被标准化为故障转移路径，以便陈旧的持久模型不会创建外部重试循环
- 当仍有剩余候选时的其他未识别错误

模型故障转移在以下情况下不继续：

- 非超时/故障转移形状的显式中止
- 应保持在压缩/重试逻辑内的上下文溢出错误（例如 `request_too_large`、`INVALID_ARGUMENT: input exceeds the maximum number of tokens`、`input token count exceeds the maximum number of input tokens`、`The input is too long for the model` 或 `ollama error: context length exceeded`）
- 当没有候选时的最终未知错误

### 冷却跳过与探测行为

当提供商的每个身份验证配置文件都已处于冷却状态时，OpenClaw 不会永远自动跳过该提供商。它做出每个候选的决定：

- 持久身份验证失败立即跳过整个提供商。
- 计费禁用通常会跳过，但主候选仍然可以在节流时被探测，以便无需重启即可恢复。
- 主候选可能在冷却到期附近被探测，带有每个提供商的节流。
- 尽管冷却，当失败看起来是暂时的（`rate_limit`、`overloaded` 或未知）时，仍可以尝试同提供商的故障转移兄弟。当速率限制是模型范围的并且兄弟模型可能立即恢复时，这尤其相关。
- 临时冷却探测限制为每个故障转移运行每个提供商一次，因此单个提供商不会使跨提供商故障转移停滞。

## 会话覆盖和实时模型切换

会话模型更改是共享状态。活动运行器、`/model` 命令、压缩/会话更新和实时会话协调都读取或写入同一个会话条目的部分。

这意味着故障转移重试必须与实时模型切换协调：

- 只有显式用户驱动的模型更改标记待处理的实时切换。这包括 `/model`、`session_status(model=...)` 和 `sessions.patch`。
- 系统驱动的模型更改，例如故障转移轮换、心跳覆盖或压缩，本身永远不会标记待处理的实时切换。
- 在故障转移重试开始之前，回复运行器将选定的故障转移覆盖字段持久化到会话条目。
- 实时会话协调优先考虑持久化的会话覆盖，而不是陈旧的运行时模型字段。
- 如果故障转移尝试失败，运行器仅回滚它写入的覆盖字段，并且仅当它们仍与该失败候选匹配时。

这可以防止经典竞争：

1. 主模型失败。
2. 故障转移候选在内存中被选择。
3. 会话存储仍然说旧的主模型。
4. 实时会话协调读取陈旧的会话状态。
5. 重试在故障转移尝试开始之前被快照回旧模型。

持久化的故障转移覆盖关闭了该窗口，而狭窄的回滚保持较新的手动或运行时会话更改完好无损。

## 可观察性和故障摘要

`runWithModelFallback(...)` 记录每次尝试的详细信息，这些信息为日志和用户面对的冷却消息提供信息：

- 尝试的提供商/模型
- 原因（`rate_limit`、`overloaded`、`billing`、`auth`、`model_not_found` 等类似故障转移原因）
- 可选状态/代码
- 人类可读的错误摘要

当所有候选都失败时，OpenClaw 抛出 `FallbackSummaryError`。外部回复运行器可以使用它来构建更具体的消息，例如"所有模型暂时被速率限制"，并在已知时包括最早的冷却到期时间。

该冷却摘要是模型感知的：

- 不相关的模型范围速率限制被忽略，用于尝试的提供商/模型链
- 如果剩余的块是匹配的模型范围速率限制，OpenClaw 报告仍阻止该模型的最后匹配到期时间

## 相关配置

有关以下内容，请参见 [Gateway 配置](/gateway/configuration)：

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `auth.cooldowns.overloadedProfileRotations` / `auth.cooldowns.overloadedBackoffMs`
- `auth.cooldowns.rateLimitedProfileRotations`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` 路由

有关更广泛的模型选择和故障转移概述，请参见 [模型](/concepts/models)。
