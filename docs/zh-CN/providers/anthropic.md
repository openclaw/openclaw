---
read_when:
  - 你想在 OpenClaw 中使用 Anthropic 模型
  - 你想使用 setup-token 而不是 API 密钥
summary: 在 OpenClaw 中通过 API 密钥或 setup-token 使用 Anthropic Claude
title: Anthropic
x-i18n:
  generated_at: "2026-03-16T06:25:19Z"
  model: gpt-5.4
  provider: openai
  source_hash: b18eff35b652d8dc4b6d55e9051d35682511909b3168be868fa172038294d20b
  source_path: providers/anthropic.md
  workflow: 15
---

# Anthropic（Claude）

Anthropic 构建了 **Claude** 模型家族，并通过 API 提供访问。
在 OpenClaw 中，你可以使用 API 密钥或 **setup-token** 进行身份验证。

## 选项 A：Anthropic API 密钥

**最适合：** 标准 API 访问和按使用量计费。
请在 Anthropic Console 中创建你的 API 密钥。

### CLI 设置

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### 配置片段

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Thinking 默认值（Claude 4.6）

- 当未设置显式 thinking 级别时，Anthropic Claude 4.6 模型在 OpenClaw 中默认使用 `adaptive` thinking。
- 你可以按消息覆盖（`/think:<level>`），或在模型参数中覆盖：
  `agents.defaults.models["anthropic/<model>"].params.thinking`。
- 相关 Anthropic 文档：
  - [Adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)
  - [Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)

## 快速模式（Anthropic API）

OpenClaw 的共享 `/fast` 开关也支持直接 Anthropic API 密钥流量。

- `/fast on` 映射到 `service_tier: "auto"`
- `/fast off` 映射到 `service_tier: "standard_only"`
- 配置默认值：

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-sonnet-4-5": {
          params: { fastMode: true },
        },
      },
    },
  },
}
```

重要限制：

- 这**仅适用于 API 密钥**。Anthropic setup-token / OAuth 身份验证不会遵循 OpenClaw 的快速模式层级注入。
- OpenClaw 仅对直接发往 `api.anthropic.com` 的请求注入 Anthropic 服务层级。如果你通过代理或网关路由 `anthropic/*`，`/fast` 不会修改 `service_tier`。
- Anthropic 会在响应中的 `usage.service_tier` 下报告实际生效的层级。对于没有 Priority Tier 容量的账户，`service_tier: "auto"` 仍可能解析为 `standard`。

## Prompt 缓存（Anthropic API）

OpenClaw 支持 Anthropic 的 prompt 缓存功能。这**仅适用于 API**；订阅身份验证不会遵循缓存设置。

### 配置

在你的模型配置中使用 `cacheRetention` 参数：

| 值      | 缓存时长 | 说明                       |
| ------- | -------- | -------------------------- |
| `none`  | 不缓存   | 禁用 prompt 缓存           |
| `short` | 5 分钟   | API 密钥身份验证的默认值   |
| `long`  | 1 小时   | 扩展缓存（需要 beta 标志） |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

### 默认值

当使用 Anthropic API 密钥身份验证时，OpenClaw 会自动对所有 Anthropic 模型应用 `cacheRetention: "short"`（5 分钟缓存）。你可以通过在配置中显式设置 `cacheRetention` 来覆盖此行为。

### 每个智能体的 cacheRetention 覆盖

将模型级参数用作基线，然后通过 `agents.list[].params` 覆盖特定智能体。

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6" },
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" }, // 大多数智能体的基线
        },
      },
    },
    list: [
      { id: "research", default: true },
      { id: "alerts", params: { cacheRetention: "none" } }, // 仅对该智能体覆盖
    ],
  },
}
```

与缓存相关参数的配置合并顺序：

1. `agents.defaults.models["provider/model"].params`
2. `agents.list[].params`（匹配 `id`，按键覆盖）

这使得一个智能体可以保留长生命周期缓存，而同一模型上的另一个智能体可以禁用缓存，以避免在突发/低复用流量上产生写入成本。

### Bedrock Claude 说明

- 当已配置时，Bedrock 上的 Anthropic Claude 模型（`amazon-bedrock/*anthropic.claude*`）接受透传的 `cacheRetention`。
- 非 Anthropic 的 Bedrock 模型会在运行时被强制设置为 `cacheRetention: "none"`。
- 当未设置显式值时，Anthropic API 密钥的智能默认值也会为 Bedrock 上的 Claude 模型引用填入 `cacheRetention: "short"`。

### 旧版参数

旧的 `cacheControlTtl` 参数仍受支持，以保持向后兼容：

- `"5m"` 映射为 `short`
- `"1h"` 映射为 `long`

我们建议迁移到新的 `cacheRetention` 参数。

OpenClaw 会在 Anthropic API 请求中包含 `extended-cache-ttl-2025-04-11` beta 标志；
如果你覆盖了提供商请求头，请保留它（参见 [/gateway/configuration](/gateway/configuration)）。

## 1M 上下文窗口（Anthropic beta）

Anthropic 的 1M 上下文窗口受 beta 门控。在 OpenClaw 中，可通过为受支持的 Opus/Sonnet 模型
设置 `params.context1m: true` 按模型启用。

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { context1m: true },
        },
      },
    },
  },
}
```

OpenClaw 会将其映射为 Anthropic 请求上的 `anthropic-beta: context-1m-2025-08-07`。

仅当该模型的 `params.context1m` 被显式设置为 `true` 时，
此功能才会激活。

要求：Anthropic 必须允许该凭证使用长上下文
（通常是 API 密钥计费，或启用了 Extra Usage 的订阅账户）。
否则 Anthropic 会返回：
`HTTP 429: rate_limit_error: Extra usage is required for long context requests`。

注意：Anthropic 当前在使用
OAuth/订阅令牌（`sk-ant-oat-*`）时会拒绝 `context-1m-*` beta 请求。OpenClaw 会自动跳过
OAuth 身份验证的 `context1m` beta 请求头，并保留所需的 OAuth beta 标志。

## 选项 B：Claude setup-token

**最适合：** 使用你的 Claude 订阅。

### 如何获取 setup-token

setup-token 由 **Claude Code CLI** 创建，而不是在 Anthropic Console 中创建。你可以在**任何机器**上运行：

```bash
claude setup-token
```

将该令牌粘贴到 OpenClaw 中（向导：**Anthropic token（粘贴 setup-token）**），或在 Gateway 网关主机上运行：

```bash
openclaw models auth setup-token --provider anthropic
```

如果你是在另一台机器上生成该令牌，请粘贴它：

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI 设置（setup-token）

```bash
# Paste a setup-token during setup
openclaw onboard --auth-choice setup-token
```

### 配置片段（setup-token）

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 说明

- 使用 `claude setup-token` 生成 setup-token 并粘贴它，或者在 Gateway 网关主机上运行 `openclaw models auth setup-token`。
- 如果你在 Claude 订阅上看到 “OAuth token refresh failed …”，请使用 setup-token 重新进行身份验证。请参见 [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription)。
- 身份验证详情和复用规则见 [/concepts/oauth](/concepts/oauth)。

## 故障排除

**401 错误 / 令牌突然无效**

- Claude 订阅身份验证可能会过期或被撤销。请重新运行 `claude setup-token`，
  并将其粘贴到 **Gateway 网关主机** 上。
- 如果 Claude CLI 登录位于另一台机器上，请在 Gateway 网关主机上使用
  `openclaw models auth paste-token --provider anthropic`。

**No API key found for provider "anthropic"**

- 身份验证是**按智能体**区分的。新智能体不会继承主智能体的密钥。
- 请为该智能体重新运行新手引导，或在
  Gateway 网关主机上粘贴 setup-token / API 密钥，然后使用 `openclaw models status` 验证。

**No credentials found for profile `anthropic:default`**

- 运行 `openclaw models status` 查看当前活动的 auth profile。
- 重新运行新手引导，或为该配置档案粘贴 setup-token / API 密钥。

**No available auth profile (all in cooldown/unavailable)**

- 检查 `openclaw models status --json` 中的 `auth.unusableProfiles`。
- 添加另一个 Anthropic 配置档案，或等待冷却结束。

更多信息：[/gateway/troubleshooting](/gateway/troubleshooting) 和 [/help/faq](/help/faq)。
