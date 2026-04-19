---
summary: "OpenClaw如何轮换认证配置文件并跨模型回退"
read_when:
  - 诊断认证配置文件轮换、冷却或模型回退行为
  - 更新认证配置文件或模型的回退规则
  - 理解会话模型覆盖如何与回退重试交互
title: "模型回退"
---

# 模型回退

OpenClaw分两个阶段处理故障：

1. **认证配置文件轮换** 在当前提供者内。
2. **模型回退** 到 `agents.defaults.model.fallbacks` 中的下一个模型。

本文档解释了运行时规则和支持它们的数据。

## 运行时流程

对于正常的文本运行，OpenClaw按以下顺序评估候选模型：

1. 当前选择的会话模型。
2. 配置的 `agents.defaults.model.fallbacks` 按顺序。
3. 当运行从覆盖开始时，末尾的配置主模型。

在每个候选模型内，OpenClaw在前进到下一个模型候选之前尝试认证配置文件回退。

高级序列：

1. 解析活动会话模型和认证配置文件偏好。
2. 构建模型候选链。
3. 尝试当前提供者，使用认证配置文件轮换/冷却规则。
4. 如果该提供者因值得回退的错误而耗尽，移动到下一个模型候选。
5. 在重试开始前持久化选定的回退覆盖，以便其他会话读取者看到运行器即将使用的相同提供者/模型。
6. 如果回退候选失败，仅当它们仍然匹配该失败候选时，回滚仅由回退拥有的会话覆盖字段。
7. 如果每个候选都失败，抛出 `FallbackSummaryError`，包含每次尝试的详细信息和已知的最早冷却过期时间。

这故意比"保存和恢复整个会话"更窄。回复运行器仅持久化它为回退拥有的模型选择字段：

- `providerOverride`
- `modelOverride`
- `authProfileOverride`
- `authProfileOverrideSource`
- `authProfileOverrideCompactionCount`

这防止失败的回退重试覆盖较新的不相关会话突变，例如手动 `/model` 更改或在尝试运行时发生的会话轮换更新。

## 认证存储（密钥 + OAuth）

OpenClaw对API密钥和OAuth令牌都使用**认证配置文件**。

- 密钥存储在 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`（旧版：`~/.openclaw/agent/auth-profiles.json`）。
- 运行时认证路由状态存储在 `~/.openclaw/agents/<agentId>/agent/auth-state.json`。
- 配置 `auth.profiles` / `auth.order` 仅是**元数据 + 路由**（无密钥）。
- 仅导入的旧版OAuth文件：`~/.openclaw/credentials/oauth.json`（首次使用时导入到 `auth-profiles.json`）。

更多详情：[/concepts/oauth](/concepts/oauth)

凭证类型：

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }`（+ 某些提供者的 `projectId`/`enterpriseUrl`）

## 配置文件ID

OAuth登录创建不同的配置文件，以便多个账户可以共存。

- 默认：当没有电子邮件可用时为 `provider:default`。
- 带电子邮件的OAuth：`provider:<email>`（例如 `google-antigravity:user@gmail.com`）。

配置文件存储在 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` 的 `profiles` 下。

## 轮换顺序

当提供者有多个配置文件时，OpenClaw选择如下顺序：

1. **显式配置**：`auth.order[provider]`（如果设置）。
2. **配置的配置文件**：按提供者过滤的 `auth.profiles`。
3. **存储的配置文件**：提供者在 `auth-profiles.json` 中的条目。

如果没有显式配置顺序，OpenClaw使用轮询顺序：

- **主键**：配置文件类型（**OAuth在API密钥之前**）。
- **次键**：`usageStats.lastUsed`（每种类型内最旧的优先）。
- **冷却/禁用的配置文件** 移到末尾，按最早过期时间排序。

### 会话粘性（缓存友好）

OpenClaw **按会话固定选择的认证配置文件** 以保持提供者缓存温暖。它**不会**在每个请求上轮换。固定的配置文件会被重用，直到：

- 会话被重置（`/new` / `/reset`）
- 压缩完成（压缩计数递增）
- 配置文件处于冷却/禁用状态

通过 `/model …@<profileId>` 手动选择为该会话设置**用户覆盖**，并且在新会话开始之前不会自动轮换。

自动固定的配置文件（由会话路由器选择）被视为**偏好**：它们首先被尝试，但OpenClaw可能在速率限制/超时时轮换到另一个配置文件。用户固定的配置文件保持锁定到该配置文件；如果它失败并且配置了模型回退，OpenClaw会移动到下一个模型而不是切换配置文件。

### 为什么OAuth可能"看起来丢失"

如果你对同一提供者同时有OAuth配置文件和API密钥配置文件，轮询可能会在消息之间切换它们，除非固定。要强制使用单个配置文件：

- 使用 `auth.order[provider] = ["provider:profileId"]` 固定，或
- 通过带有配置文件覆盖的 `/model …` 使用每会话覆盖（当你的UI/聊天表面支持时）。

## 冷却

当配置文件因认证/速率限制错误（或看起来像速率限制的超时）失败时，OpenClaw将其标记为冷却并移动到下一个配置文件。该速率限制桶比普通 `429` 更广泛：它还包括提供者消息，如 `Too many concurrent requests`、`ThrottlingException`、`concurrency limit reached`、`workers_ai ... quota limit exceeded`、`throttled`、`resource exhausted`，以及周期性使用窗口限制，如 `weekly/monthly limit reached`。
格式/无效请求错误（例如Cloud Code Assist工具调用ID验证失败）被视为值得回退，并使用相同的冷却。
OpenAI兼容的停止原因错误，如 `Unhandled stop reason: error`、`stop reason: error` 和 `reason: error` 被分类为超时/回退信号。
提供者范围的通用服务器文本也可以在源匹配已知瞬态模式时进入该超时桶。例如，Anthropic的 `An unknown error occurred` 和带有瞬态服务器文本（如 `internal server error`、`unknown error, 520`、`upstream error` 或 `backend error`）的JSON `api_error` 有效负载被视为值得回退的超时。OpenRouter特定的通用上游文本，如 `Provider returned error` 仅在提供者上下文实际为OpenRouter时也被视为超时。通用内部回退文本，如 `LLM request failed with an unknown error.` 保持保守，本身不会触发回退。

速率限制冷却也可以是模型范围的：

- 当失败的模型ID已知时，OpenClaw记录速率限制失败的 `cooldownModel`。
- 当冷却范围为不同模型时，同一提供者上的兄弟模型仍然可以尝试。
- 计费/禁用窗口仍然跨模型阻止整个配置文件。

冷却使用指数退避：

- 1分钟
- 5分钟
- 25分钟
- 1小时（上限）

状态存储在 `auth-state.json` 的 `usageStats` 下：

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

计费/信用失败（例如"信用不足"/"信用余额过低"）被视为值得回退，但它们通常不是瞬态的。OpenClaw不会使用短暂的冷却，而是将配置文件标记为**禁用**（具有更长的退避）并轮换到下一个配置文件/提供者。

并非每个计费形状的响应都是 `402`，也并非每个HTTP `402` 都落在这。OpenClaw即使在提供者返回 `401` 或 `403` 时也会将显式计费文本保留在计费通道中，但特定于提供者的匹配器保持限定于拥有它们的提供者（例如OpenRouter `403 Key limit exceeded`）。同时，临时 `402` 使用窗口和组织/工作区支出限制错误在消息看起来可重试时被分类为 `rate_limit`（例如 `weekly usage limit exhausted`、`daily limit reached, resets tomorrow` 或 `organization spending limit exceeded`）。这些保持在短暂的冷却/回退路径上，而不是长的计费禁用路径。

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

- 计费退避从**5小时**开始，每次计费失败翻倍，上限为**24小时**。
- 如果配置文件**24小时**未失败，退避计数器重置（可配置）。
- 过载重试允许**1次同提供者配置文件轮换**，然后是模型回退。
- 过载重试默认使用**0 ms退避**。

## 模型回退

如果提供者的所有配置文件都失败，OpenClaw移动到 `agents.defaults.model.fallbacks` 中的下一个模型。这适用于认证失败、速率限制和用尽配置文件轮换的超时（其他错误不会推进回退）。

过载和速率限制错误比计费冷却处理更积极。默认情况下，OpenClaw允许一次同提供者认证配置文件重试，然后切换到下一个配置的模型回退，无需等待。提供者繁忙信号，如 `ModelNotReadyException` 落在该过载桶中。使用 `auth.cooldowns.overloadedProfileRotations`、`auth.cooldowns.overloadedBackoffMs` 和 `auth.cooldowns.rateLimitedProfileRotations` 调整这一点。

当运行从模型覆盖（钩子或CLI）开始时，回退在尝试任何配置的回退后仍然以 `agents.defaults.model.primary` 结束。

### 候选链规则

OpenClaw从当前请求的 `provider/model` 加上配置的回退构建候选列表。

规则：

- 请求的模型始终排在第一位。
- 显式配置的回退被去重但不按模型允许列表过滤。它们被视为显式操作员意图。
- 如果当前运行已经在同一提供者系列的配置回退上，OpenClaw继续使用完整的配置链。
- 如果当前运行在与配置不同的提供者上，并且当前模型尚未成为配置回退链的一部分，OpenClaw不会附加来自另一个提供者的不相关配置回退。
- 当运行从覆盖开始时，配置的主模型被附加在末尾，以便一旦早期候选用尽，链可以回到正常默认值。

### 哪些错误推进回退

模型回退在以下情况下继续：

- 认证失败
- 速率限制和冷却用尽
- 过载/提供者繁忙错误
- 超时形状的回退错误
- 计费禁用
- `LiveSessionModelSwitchError`，被归一化为回退路径，以便过时的持久化模型不会创建外部重试循环
- 当仍有剩余候选时的其他未识别错误

模型回退在以下情况下不继续：

- 不是超时/回退形状的显式中止
- 应保持在压缩/重试逻辑内的上下文溢出错误（例如 `request_too_large`、`INVALID_ARGUMENT: input exceeds the maximum number of tokens`、`input token count exceeds the maximum number of input tokens`、`The input is too long for the model` 或 `ollama error: context length exceeded`）
- 当没有候选剩余时的最终未知错误

### 冷却跳过与探测行为

当提供者的每个认证配置文件已经处于冷却状态时，OpenClaw不会永远自动跳过该提供者。它做出每个候选的决定：

- 持久认证失败立即跳过整个提供者。
- 计费禁用通常跳过，但主要候选仍然可以在节流时被探测，以便无需重启即可恢复。
- 主要候选可能在冷却过期附近被探测，带有每个提供者的节流。
- 同提供者回退兄弟可以在失败看起来瞬态时（`rate_limit`、`overloaded` 或未知）尝试，尽管有冷却。当速率限制是模型范围的，兄弟模型可能立即恢复时，这尤其相关。
- 瞬态冷却探测限制为每个提供者每次回退运行一次，以便单个提供者不会停滞跨提供者回退。

## 会话覆盖和实时模型切换

会话模型更改是共享状态。活动运行器、`/model` 命令、压缩/会话更新和实时会话协调都读取或写入同一个会话条目的部分。

这意味着回退重试必须与实时模型切换协调：

- 只有显式用户驱动的模型更改标记待处理的实时切换。这包括 `/model`、`session_status(model=...)` 和 `sessions.patch`。
- 系统驱动的模型更改，如回退轮换、心跳覆盖或压缩，永远不会自己标记待处理的实时切换。
- 在回退重试开始之前，回复运行器将选定的回退覆盖字段持久化到会话条目。
- 实时会话协调更喜欢持久化的会话覆盖而不是过时的运行时模型字段。
- 如果回退尝试失败，运行器仅回滚它写入的覆盖字段，并且仅当它们仍然匹配该失败候选时。

这防止了经典竞争：

1. 主模型失败。
2. 回退候选在内存中被选择。
3. 会话存储仍然说旧的主模型。
4. 实时会话协调读取过时的会话状态。
5. 重试在回退尝试开始前被拉回到旧模型。

持久化的回退覆盖关闭了该窗口，而窄回滚保持了较新的手动或运行时会话更改完整。

## 可观测性和失败摘要

`runWithModelFallback(...)` 记录每次尝试的详细信息，这些信息提供日志和面向用户的冷却消息：

- 尝试的提供者/模型
- 原因（`rate_limit`、`overloaded`、`billing`、`auth`、`model_not_found` 和类似的回退原因）
- 可选的状态/代码
- 人类可读的错误摘要

当每个候选都失败时，OpenClaw抛出 `FallbackSummaryError`。外部回复运行器可以使用它构建更具体的消息，例如"所有模型暂时被速率限制"，并在已知时包含最早的冷却过期时间。

该冷却摘要是模型感知的：

- 不相关的模型范围速率限制被忽略用于尝试的提供者/模型链
- 如果剩余的块是匹配的模型范围速率限制，OpenClaw报告仍然阻止该模型的最后匹配过期

## 相关配置

请参阅[网关配置](/gateway/configuration)了解：

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `auth.cooldowns.overloadedProfileRotations` / `auth.cooldowns.overloadedBackoffMs`
- `auth.cooldowns.rateLimitedProfileRotations`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` 路由

请参阅[模型](/concepts/models)了解更广泛的模型选择和回退概述。
