---
summary: "`openclaw models` 的 CLI 参考（status/list/set/scan、别名、回退、身份验证）"
read_when:
  - 您想更改默认模型或查看提供商身份验证状态
  - 您想扫描可用的模型/提供商并调试身份验证配置文件

title: "models"
---

# `openclaw models`

模型发现、扫描和配置（默认模型、回退、身份验证配置文件）。

相关：

- 提供商 + 模型：[模型](/providers/models)
- 提供商身份验证设置：[入门](/start/getting-started)

## 常用命令

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` 显示解析的默认/回退以及身份验证概述。
当提供商使用快照可用时，OAuth/API 密钥状态部分包括
提供商使用窗口和配额快照。
当前使用窗口提供商：Anthropic、GitHub Copilot、Gemini CLI、OpenAI
Codex、MiniMax、小米和 z.ai。使用身份验证来自提供商特定的钩子
当可用时；否则 OpenClaw 回退到匹配 OAuth/API 密钥
来自身份验证配置文件、环境或配置的凭据。
在 `--json` 输出中，`auth.providers` 是环境/配置/存储感知的提供商
概述，而 `auth.oauth` 仅是身份验证存储配置文件健康状态。
添加 `--probe` 以对每个配置的提供商配置文件运行实时身份验证探测。
探测是真实请求（可能消耗令牌并触发速率限制）。
使用 `--agent <id>` 检查配置的代理的模型/身份验证状态。当省略时，
命令使用 `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`（如果设置），否则使用
配置的默认代理。
探测行可以来自身份验证配置文件、环境凭据或 `models.json`。

注意：

- `models set <model-or-alias>` 接受 `provider/model` 或别名。
- 模型引用通过在 **第一个** `/` 上分割来解析。如果模型 ID 包含 `/`（OpenRouter 风格），请包含提供商前缀（例如：`openrouter/moonshotai/kimi-k2`）。
- 如果您省略提供商，OpenClaw 首先将输入解析为别名，然后
  作为该确切模型 ID 的唯一配置提供商匹配，然后才
  回退到配置的默认提供商并带有弃用警告。
  如果该提供商不再公开配置的默认模型，OpenClaw
  回退到第一个配置的提供商/模型，而不是显示
  过时的已删除提供商默认值。
- `models status` 可能在身份验证输出中为非秘密占位符显示 `marker(<value>)`（例如 `OPENAI_API_KEY`、`secretref-managed`、`minimax-oauth`、`oauth:chutes`、`ollama-local`），而不是将它们作为秘密进行掩码。

### `models status`

选项：

- `--json`
- `--plain`
- `--check`（退出 1=过期/缺失，2=即将过期）
- `--probe`（对配置的身份验证配置文件进行实时探测）
- `--probe-provider <name>`（探测一个提供商）
- `--probe-profile <id>`（重复或逗号分隔的配置文件 ID）
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>`（配置的代理 ID；覆盖 `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`）

探测状态桶：

- `ok`
- `auth`
- `rate_limit`
- `billing`
- `timeout`
- `format`
- `unknown`
- `no_model`

预期的探测详情/原因代码情况：

- `excluded_by_auth_order`：存储的配置文件存在，但显式
  `auth.order.<provider>` 省略了它，因此探测报告排除而不是
  尝试它。
- `missing_credential`, `invalid_expires`, `expired`, `unresolved_ref`：
  配置文件存在但不符合条件/不可解析。
- `no_model`：提供商身份验证存在，但 OpenClaw 无法为该提供商解析可探测的模型候选。

## 别名 + 回退

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## 身份验证配置文件

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token --provider <id>
openclaw models auth paste-token
```

`models auth add` 是交互式身份验证助手。它可以启动提供商身份验证
流程（OAuth/API 密钥）或引导您进入手动令牌粘贴，具体取决于您选择的提供商。

`models auth login` 运行提供商插件的身份验证流程（OAuth/API 密钥）。使用
`openclaw plugins list` 查看安装了哪些提供商。

示例：

```bash
openclaw models auth login --provider openai-codex --set-default
```

注意：

- `setup-token` 和 `paste-token` 仍然是用于提供商的通用令牌命令
  暴露令牌身份验证方法。
- `setup-token` 需要交互式 TTY 并运行提供商的令牌身份验证
  方法（当提供商暴露时默认为该提供商的 `setup-token` 方法
  一个）。
- `paste-token` 接受在其他地方或从自动化生成的令牌字符串。
- `paste-token` 需要 `--provider`，提示输入令牌值，并将其写入
  默认配置文件 ID `<provider>:manual`，除非您传递
  `--profile-id`。
- `paste-token --expires-in <duration>` 从相对持续时间（如 `365d` 或 `12h`）存储绝对令牌过期时间。
- Anthropic 注意：Anthropic 工作人员告诉我们，OpenClaw 风格的 Claude CLI 使用再次被允许，因此 OpenClaw 将 Claude CLI 重用和 `claude -p` 使用视为
  除非 Anthropic 发布新政策，否则此集成已获批准。
- Anthropic `setup-token` / `paste-token` 仍然作为支持的 OpenClaw 令牌路径可用，但 OpenClaw 现在在可用时首选 Claude CLI 重用和 `claude -p`。
