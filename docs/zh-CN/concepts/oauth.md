---
read_when:
  - 你想端到端了解 OpenClaw OAuth
  - 你遇到了令牌失效/登出问题
  - 你想使用 setup-token 或 OAuth 认证流程
  - 你想使用多个账户或配置文件路由
summary: OpenClaw 中的 OAuth：令牌交换、存储和多账户模式
title: OAuth
x-i18n:
  generated_at: "2026-03-16T06:22:05Z"
  model: gpt-5.4
  provider: openai
  source_hash: 976668c3e02ee50500fcaaa585a89af718398dc41988318ec3a583c2d5449df3
  source_path: concepts/oauth.md
  workflow: 15
---

# OAuth

OpenClaw 通过 OAuth 支持提供商提供的“订阅认证”，适用于支持此方式的提供商（尤其是 **OpenAI Codex（ChatGPT OAuth）**）。对于 Anthropic 订阅，请使用 **setup-token** 流程。过去有些用户在 Claude Code 之外使用 Anthropic 订阅时曾受限，因此这应视为用户自行选择承担的风险，你应自行核实 Anthropic 当前的政策。OpenAI Codex OAuth 明确支持在 OpenClaw 这样的外部工具中使用。本页说明：

对于生产环境中的 Anthropic，相比订阅 setup-token 认证，API 密钥认证是更安全、也更推荐的路径。

- OAuth **令牌交换** 如何工作（PKCE）
- 令牌**存储**在哪里（以及为什么）
- 如何处理**多个账户**（配置文件 + 按会话覆盖）

OpenClaw 也支持自带 OAuth 或 API 密钥流程的**提供商插件**。运行方式如下：

```bash
openclaw models auth login --provider <id>
```

## 令牌汇点（为什么需要它）

OAuth 提供商通常会在登录/刷新流程中签发一个**新的刷新令牌**。某些提供商（或 OAuth 客户端）会在为同一用户/应用签发新令牌时使旧的刷新令牌失效。

实际症状：

- 你同时通过 OpenClaw _和_ Claude Code / Codex CLI 登录 → 之后其中一个会随机“被登出”

为减少这种情况，OpenClaw 将 `auth-profiles.json` 视为一个**令牌汇点**：

- 运行时从**同一个地方**读取凭证
- 我们可以保留多个配置文件，并进行确定性路由

## 存储（令牌存放位置）

密钥按**每个智能体**存储：

- 认证配置文件（OAuth + API 密钥 + 可选的值级引用）：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- 旧版兼容文件：`~/.openclaw/agents/<agentId>/agent/auth.json`
  （发现静态 `api_key` 条目时会进行清理）

仅用于旧版导入的文件（仍受支持，但不是主存储）：

- `~/.openclaw/credentials/oauth.json`（首次使用时会导入到 `auth-profiles.json`）

以上所有位置也都遵循 `$OPENCLAW_STATE_DIR`（状态目录覆盖）。完整参考：[/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

有关静态密钥引用和运行时快照激活行为，请参见 [Secrets Management](/gateway/secrets)。

## Anthropic setup-token（订阅认证）

<Warning>
Anthropic setup-token 支持是技术兼容性，并非策略保证。
Anthropic 过去曾阻止过某些在 Claude Code 之外的订阅使用。
是否使用订阅认证由你自行决定，并请核实 Anthropic 当前的条款。
</Warning>

在任意机器上运行 `claude setup-token`，然后将其粘贴到 OpenClaw 中：

```bash
openclaw models auth setup-token --provider anthropic
```

如果你是在其他地方生成的令牌，可手动粘贴：

```bash
openclaw models auth paste-token --provider anthropic
```

验证：

```bash
openclaw models status
```

## OAuth 交换（登录如何工作）

OpenClaw 的交互式登录流程在 `@mariozechner/pi-ai` 中实现，并接入到各类向导/命令中。

### Anthropic setup-token

流程形态：

1. 运行 `claude setup-token`
2. 将令牌粘贴到 OpenClaw
3. 存储为令牌认证配置文件（不刷新）

向导路径为 `openclaw onboard` → 认证选择 `setup-token`（Anthropic）。

### OpenAI Codex（ChatGPT OAuth）

OpenAI Codex OAuth 明确支持在 Codex CLI 之外使用，包括 OpenClaw 工作流。

流程形态（PKCE）：

1. 生成 PKCE verifier/challenge 和随机 `state`
2. 打开 `https://auth.openai.com/oauth/authorize?...`
3. 尝试在 `http://127.0.0.1:1455/auth/callback` 捕获回调
4. 如果回调无法绑定（或你是在远程/无头环境中），则粘贴重定向 URL/code
5. 在 `https://auth.openai.com/oauth/token` 交换令牌
6. 从访问令牌中提取 `accountId` 并存储 `{ access, refresh, expires, accountId }`

向导路径为 `openclaw onboard` → 认证选择 `openai-codex`。

## 刷新和过期

配置文件会存储一个 `expires` 时间戳。

在运行时：

- 如果 `expires` 尚未到期 → 使用已存储的访问令牌
- 如果已过期 → 在文件锁下刷新，并覆盖已存储的凭证

刷新流程是自动的；通常你不需要手动管理令牌。

## 多个账户（配置文件）+ 路由

有两种模式：

### 1）推荐：分离的智能体

如果你希望“个人”和“工作”永不交叉，请使用隔离的智能体（独立的会话 + 凭证 + 工作区）：

```bash
openclaw agents add work
openclaw agents add personal
```

然后按智能体配置认证（使用向导），并将聊天路由到正确的智能体。

### 2）高级：单个智能体中的多个配置文件

`auth-profiles.json` 支持同一提供商下的多个配置文件 ID。

选择使用哪个配置文件：

- 通过配置排序全局选择（`auth.order`）
- 通过 `/model ...@<profileId>` 按会话选择

示例（会话覆盖）：

- `/model Opus@anthropic:work`

查看现有配置文件 ID 的方法：

- `openclaw channels list --json`（显示 `auth[]`）

相关文档：

- [/concepts/model-failover](/concepts/model-failover)（轮换 + 冷却规则）
- [/tools/slash-commands](/tools/slash-commands)（命令入口）
