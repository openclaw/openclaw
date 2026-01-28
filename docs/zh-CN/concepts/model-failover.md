---
read_when:
  - 诊断认证配置文件轮换、冷却期或模型回退行为
  - 更新认证配置文件或模型的故障转移规则
summary: OpenClaw 如何轮换认证配置文件并在模型之间进行故障回退
title: 模型故障转移
x-i18n:
  generated_at: "2026-02-01T20:23:02Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: eab7c0633824d941cf0d6ce4294f0bc8747fbba2ce93650e9643eca327cd04a9
  source_path: concepts/model-failover.md
  workflow: 14
---

# 模型故障转移

OpenClaw 分两个阶段处理故障：

1. 在当前提供商内进行**认证配置文件轮换**。
2. **模型回退**到 `agents.defaults.model.fallbacks` 中的下一个模型。

本文档介绍运行时规则及其背后的数据。

## 认证存储（密钥 + OAuth）

OpenClaw 对 API 密钥和 OAuth 令牌都使用**认证配置文件**。

- 密钥存储在 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`（旧版路径：`~/.openclaw/agent/auth-profiles.json`）。
- 配置项 `auth.profiles` / `auth.order` **仅包含元数据和路由信息**（不含密钥）。
- 旧版仅导入的 OAuth 文件：`~/.openclaw/credentials/oauth.json`（首次使用时导入到 `auth-profiles.json`）。

更多详情：[/concepts/oauth](/concepts/oauth)

凭证类型：

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }`（部分提供商还包含 `projectId`/`enterpriseUrl`）

## 配置文件 ID

OAuth 登录会创建不同的配置文件，以便多个账户共存。

- 默认值：当没有可用邮箱时为 `provider:default`。
- 带邮箱的 OAuth：`provider:<email>`（例如 `google-antigravity:user@gmail.com`）。

配置文件存储在 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` 的 `profiles` 下。

## 轮换顺序

当一个提供商有多个配置文件时，OpenClaw 按如下方式选择顺序：

1. **显式配置**：`auth.order[provider]`（如果已设置）。
2. **已配置的配置文件**：按提供商过滤的 `auth.profiles`。
3. **已存储的配置文件**：`auth-profiles.json` 中该提供商的条目。

如果未配置显式顺序，OpenClaw 使用轮询顺序：

- **主排序键：** 配置文件类型（**OAuth 优先于 API 密钥**）。
- **次排序键：** `usageStats.lastUsed`（同类型内最旧的优先）。
- **冷却中/已禁用的配置文件**被移到末尾，按最早到期时间排序。

### 会话粘性（缓存友好）

OpenClaw 会**在每个会话中固定选定的认证配置文件**，以保持提供商缓存活跃。
它**不会**在每次请求时轮换。固定的配置文件会持续使用，直到：

- 会话被重置（`/new` / `/reset`）
- 压缩完成（压缩计数递增）
- 配置文件处于冷却中/已禁用状态

通过 `/model …@<profileId>` 手动选择会为该会话设置一个**用户覆盖**，
在新会话开始前不会自动轮换。

自动固定的配置文件（由会话路由器选择）被视为一种**偏好**：
它们会优先尝试，但 OpenClaw 可能在遇到速率限制/超时时轮换到其他配置文件。
用户固定的配置文件会锁定在该配置文件上；如果它失败且配置了模型回退，
OpenClaw 会转移到下一个模型，而不是切换配置文件。

### 为什么 OAuth 可能"看起来丢失了"

如果你对同一个提供商同时拥有 OAuth 配置文件和 API 密钥配置文件，轮询可能在消息之间切换它们（除非已固定）。要强制使用单个配置文件：

- 通过 `auth.order[provider] = ["provider:profileId"]` 固定，或
- 通过 `/model …` 使用按会话覆盖并指定配置文件（当你的 UI/聊天界面支持时）。

## 冷却期

当配置文件因认证/速率限制错误（或看起来像速率限制的超时）而失败时，
OpenClaw 会将其标记为冷却状态并移至下一个配置文件。
格式/无效请求错误（例如 Cloud Code Assist 工具调用 ID
验证失败）也被视为可故障转移的，并使用相同的冷却机制。

冷却期使用指数退避：

- 1 分钟
- 5 分钟
- 25 分钟
- 1 小时（上限）

状态存储在 `auth-profiles.json` 的 `usageStats` 下：

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

计费/额度失败（例如"额度不足"/"信用余额过低"）被视为可故障转移的，但通常不是临时性的。OpenClaw 不会使用短冷却期，而是将配置文件标记为**已禁用**（使用更长的退避时间）并轮换到下一个配置文件/提供商。

状态存储在 `auth-profiles.json` 中：

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

- 计费退避从 **5 小时**开始，每次计费失败加倍，上限为 **24 小时**。
- 如果配置文件在 **24 小时**内未失败，退避计数器将重置（可配置）。

## 模型回退

如果某个提供商的所有配置文件都失败，OpenClaw 会移至
`agents.defaults.model.fallbacks` 中的下一个模型。这适用于认证失败、速率限制和
耗尽配置文件轮换的超时情况（其他错误不会触发回退）。

当运行以模型覆盖（钩子或 CLI）启动时，回退仍会在尝试所有已配置的回退后
止于 `agents.defaults.model.primary`。

## 相关配置

参阅 [Gateway网关配置](/gateway/configuration) 了解：

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` 路由

参阅[模型](/concepts/models)了解更广泛的模型选择和回退概述。
