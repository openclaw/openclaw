---
summary: "OpenClaw 中的 OAuth：令牌交换、存储和多账户模式"
read_when:
  - 您想了解 OpenClaw OAuth 的端到端流程
  - 您遇到令牌无效/登出问题
  - 您想要 Claude CLI 或 OAuth 身份验证流程
  - 您想要多个账户或配置文件路由
title: "OAuth"
---

# OAuth

OpenClaw 通过 OAuth 支持提供订阅身份验证的提供商（特别是 **OpenAI Codex (ChatGPT OAuth)**）。对于 Anthropic，现在的实际分类是：

- **Anthropic API 密钥**：正常的 Anthropic API 计费
- **Anthropic Claude CLI / OpenClaw 内的订阅身份验证**：Anthropic 工作人员告诉我们，这种使用再次被允许

OpenAI Codex OAuth 明确支持在 OpenClaw 等外部工具中使用。本页面解释：

对于生产环境中的 Anthropic，API 密钥身份验证是更安全的推荐路径。

- OAuth **令牌交换**如何工作（PKCE）
- 令牌**存储**在哪里（以及为什么）
- 如何处理**多个账户**（配置文件 + 每会话覆盖）

OpenClaw 还支持**提供商插件**，它们附带自己的 OAuth 或 API 密钥流程。通过以下方式运行它们：

```bash
openclaw models auth login --provider <id>
```

## 令牌接收器（为什么存在）

OAuth 提供商通常在登录/刷新流程中生成**新的刷新令牌**。某些提供商（或 OAuth 客户端）在为同一用户/应用程序颁发新令牌时可能会使旧的刷新令牌失效。

实际症状：

- 您通过 OpenClaw 和 Claude Code / Codex CLI 登录 → 其中一个稍后会随机"登出"

为了减少这种情况，OpenClaw 将 `auth-profiles.json` 视为**令牌接收器**：

- 运行时从**一个地方**读取凭证
- 我们可以保留多个配置文件并确定性地路由它们
- 当从 Codex CLI 等外部 CLI 重用凭证时，OpenClaw 会通过来源镜像它们，并重新读取该外部来源，而不是自己轮换刷新令牌

## 存储（令牌存储位置）

密钥**按代理**存储：

- 身份验证配置文件（OAuth + API 密钥 + 可选的值级引用）：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- 旧版兼容文件：`~/.openclaw/agents/<agentId>/agent/auth.json`
  （发现静态 `api_key` 条目时会被清理）

仅导入的旧版文件（仍然支持，但不是主要存储）：

- `~/.openclaw/credentials/oauth.json`（首次使用时导入到 `auth-profiles.json`）

上述所有文件也尊重 `$OPENCLAW_STATE_DIR`（状态目录覆盖）。完整参考：[/gateway/configuration](/gateway/configuration-reference#auth-storage)

有关静态密钥引用和运行时快照激活行为，请参阅 [密钥管理](/gateway/secrets)。

## Anthropic 旧版令牌兼容性

<Warning>
Anthropic 的公共 Claude Code 文档说直接使用 Claude Code 保持在 Claude 订阅限制内，Anthropic 工作人员告诉我们 OpenClaw 风格的 Claude CLI 使用再次被允许。因此，OpenClaw 将 Claude CLI 重用和 `claude -p` 使用视为对此集成的认可，除非 Anthropic 发布新政策。

有关 Anthropic 当前的直接 Claude Code 计划文档，请参阅 [使用 Claude Code 与您的 Pro 或 Max 计划](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan) 和 [使用 Claude Code 与您的 Team 或 Enterprise 计划](https://support.anthropic.com/en/articles/11845131-using-claude-code-with-your-team-or-enterprise-plan/)。

如果您想在 OpenClaw 中使用其他订阅式选项，请参阅 [OpenAI Codex](/providers/openai)、[Qwen Cloud 编码计划](/providers/qwen)、[MiniMax 编码计划](/providers/minimax) 和 [Z.AI / GLM 编码计划](/providers/glm)。
</Warning>

OpenClaw 还将 Anthropic setup-token 作为支持的令牌身份验证路径公开，但现在在可用时更倾向于 Claude CLI 重用和 `claude -p`。

## Anthropic Claude CLI 迁移

OpenClaw 再次支持 Anthropic Claude CLI 重用。如果您已经在主机上本地登录了 Claude，入职/配置可以直接重用它。

## OAuth 交换（登录如何工作）

OpenClaw 的交互式登录流程在 `@mariozechner/pi-ai` 中实现，并连接到向导/命令中。

### Anthropic setup-token

流程形状：

1. 从 OpenClaw 启动 Anthropic setup-token 或粘贴令牌
2. OpenClaw 将生成的 Anthropic 凭证存储在身份验证配置文件中
3. 模型选择保持在 `anthropic/...`
4. 现有的 Anthropic 身份验证配置文件仍然可用于回滚/顺序控制

### OpenAI Codex (ChatGPT OAuth)

OpenAI Codex OAuth 明确支持在 Codex CLI 外部使用，包括 OpenClaw 工作流。

流程形状（PKCE）：

1. 生成 PKCE 验证器/挑战 + 随机 `state`
2. 打开 `https://auth.openai.com/oauth/authorize?...`
3. 尝试在 `http://127.0.0.1:1455/auth/callback` 捕获回调
4. 如果回调无法绑定（或您是远程/无头），粘贴重定向 URL/代码
5. 在 `https://auth.openai.com/oauth/token` 交换
6. 从访问令牌中提取 `accountId` 并存储 `{ access, refresh, expires, accountId }`

向导路径是 `openclaw onboard` → 身份验证选择 `openai-codex`。

## 刷新 + 过期

配置文件存储 `expires` 时间戳。

在运行时：

- 如果 `expires` 在未来 → 使用存储的访问令牌
- 如果过期 → 刷新（在文件锁下）并覆盖存储的凭证
- 例外：重用的外部 CLI 凭证保持外部管理；OpenClaw 重新读取 CLI 身份验证存储，从不自己使用复制的刷新令牌

刷新流程是自动的；您通常不需要手动管理令牌。

## 多个账户（配置文件）+ 路由

两种模式：

### 1）首选：单独的代理

如果您希望"个人"和"工作"永远不交互，请使用隔离的代理（单独的会话 + 凭证 + 工作区）：

```bash
openclaw agents add work
openclaw agents add personal
```

然后按代理配置身份验证（向导）并将聊天路由到正确的代理。

### 2）高级：一个代理中的多个配置文件

`auth-profiles.json` 支持同一提供商的多个配置文件 ID。

选择使用哪个配置文件：

- 通过配置排序全局（`auth.order`）
- 通过 `/model ...@<profileId>` 按会话

示例（会话覆盖）：

- `/model Opus@anthropic:work`

如何查看存在哪些配置文件 ID：

- `openclaw channels list --json`（显示 `auth[]`）

相关文档：

- [/concepts/model-failover](/concepts/model-failover)（轮换 + 冷却规则）
- [/tools/slash-commands](/tools/slash-commands)（命令表面）

## 相关

- [身份验证](/gateway/authentication) — 模型提供商身份验证概述
- [密钥](/gateway/secrets) — 凭证存储和 SecretRef
- [配置参考](/gateway/configuration-reference#auth-storage) — 身份验证配置键