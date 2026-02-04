---
read_when:
  - 添加或修改模型 CLI（models list/set/scan/aliases/fallbacks）
  - 更改模型回退行为或选择用户体验
  - 更新模型扫描探测（工具/图像）
summary: 模型 CLI：列表、设置、别名、回退、扫描、状态
title: 模型 CLI
x-i18n:
  generated_at: "2026-02-03T10:05:42Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: e8b54bb370b4f63a9b917594fb0f6ff48192e168196d30c713b8bbe72b78fef6
  source_path: concepts/models.md
  workflow: 15
---

# 模型 CLI

参见 [/concepts/model-failover](/concepts/model-failover) 了解认证配置文件轮换、冷却时间及其与回退的交互。
快速提供商概述 + 示例：[/concepts/model-providers](/concepts/model-providers)。

## 模型选择工作原理

OpenClaw 按以下顺序选择模型：

1. **主要**模型（`agents.defaults.model.primary` 或 `agents.defaults.model`）。
2. `agents.defaults.model.fallbacks` 中的**回退**（按顺序）。
3. **提供商认证故障转移**在移动到下一个模型之前在提供商内部发生。

相关：

- `agents.defaults.models` 是 OpenClaw 可使用的模型白名单/目录（加上别名）。
- `agents.defaults.imageModel` **仅在**主要模型无法接受图像时使用。
- 每个智能体的默认值可以通过 `agents.list[].model` 加绑定覆盖 `agents.defaults.model`（参见 [/concepts/multi-agent](/concepts/multi-agent)）。

## 快速模型推荐（经验之谈）

- **GLM**：在编程/工具调用方面稍好。
- **MiniMax**：在写作和氛围方面更好。

## 设置向导（推荐）

如果你不想手动编辑配置，请运行新手引导向导：

```bash
openclaw onboard
```

它可以为常见提供商设置模型 + 认证，包括 **OpenAI Code（Codex）订阅**（OAuth）和 **Anthropic**（推荐使用 API 密钥；也支持 `claude setup-token`）。

## 配置键（概述）

- `agents.defaults.model.primary` 和 `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` 和 `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models`（白名单 + 别名 + 提供商参数）
- `models.providers`（写入 `models.json` 的自定义提供商）

模型引用会规范化为小写。提供商别名如 `z.ai/*` 会规范化为 `zai/*`。

提供商配置示例（包括 OpenCode Zen）在 [/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy)。

## "Model is not allowed"（以及为什么回复停止）

如果设置了 `agents.defaults.models`，它将成为 `/model` 和会话覆盖的**白名单**。当用户选择不在该白名单中的模型时，OpenClaw 返回：

```
Model "provider/model" is not allowed. Use /model to list available models.
```

这发生在正常回复生成**之前**，所以消息可能感觉像"没有响应"。修复方法是：

- 将模型添加到 `agents.defaults.models`，或
- 清除白名单（删除 `agents.defaults.models`），或
- 从 `/model list` 中选择一个模型。

白名单配置示例：

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-5": { alias: "Opus" },
    },
  },
}
```

## 在聊天中切换模型（`/model`）

你可以在不重启的情况下切换当前会话的模型：

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

注意事项：

- `/model`（和 `/model list`）是紧凑的编号选择器（模型系列 + 可用提供商）。
- `/model <#>` 从该选择器中选择。
- `/model status` 是详细视图（认证候选项，以及配置时的提供商端点 `baseUrl` + `api` 模式）。
- 模型引用通过在**第一个** `/` 处分割来解析。输入 `/model <ref>` 时使用 `provider/model`。
- 如果模型 ID 本身包含 `/`（OpenRouter 风格），你必须包含提供商前缀（例如：`/model openrouter/moonshotai/kimi-k2`）。
- 如果省略提供商，OpenClaw 将输入视为别名或**默认提供商**的模型（仅在模型 ID 中没有 `/` 时有效）。

完整命令行为/配置：[斜杠命令](/tools/slash-commands)。

## CLI 命令

```bash
openclaw models list
openclaw models status
openclaw models set <provider/model>
openclaw models set-image <provider/model>

openclaw models aliases list
openclaw models aliases add <alias> <provider/model>
openclaw models aliases remove <alias>

openclaw models fallbacks list
openclaw models fallbacks add <provider/model>
openclaw models fallbacks remove <provider/model>
openclaw models fallbacks clear

openclaw models image-fallbacks list
openclaw models image-fallbacks add <provider/model>
openclaw models image-fallbacks remove <provider/model>
openclaw models image-fallbacks clear
```

`openclaw models`（无子命令）是 `models status` 的快捷方式。

### `models list`

默认显示已配置的模型。有用的标志：

- `--all`：完整目录
- `--local`：仅本地提供商
- `--provider <name>`：按提供商筛选
- `--plain`：每行一个模型
- `--json`：机器可读输出

### `models status`

显示已解析的主要模型、回退、图像模型，以及已配置提供商的认证概述。它还显示认证存储中找到的配置文件的 OAuth 过期状态（默认在 24 小时内警告）。`--plain` 仅打印已解析的主要模型。
OAuth 状态始终显示（并包含在 `--json` 输出中）。如果已配置的提供商没有凭证，`models status` 会打印 **Missing auth** 部分。
JSON 包括 `auth.oauth`（警告窗口 + 配置文件）和 `auth.providers`（每个提供商的有效认证）。
使用 `--check` 进行自动化（缺失/过期时退出 `1`，即将过期时退出 `2`）。

首选的 Anthropic 认证是 Claude Code CLI setup-token（在任何地方运行；如需要在 Gateway 网关主机上粘贴）：

```bash
claude setup-token
openclaw models status
```

## 扫描（OpenRouter 免费模型）

`openclaw models scan` 检查 OpenRouter 的**免费模型目录**，并可选择性地探测模型的工具和图像支持。

关键标志：

- `--no-probe`：跳过实时探测（仅元数据）
- `--min-params <b>`：最小参数量（十亿）
- `--max-age-days <days>`：跳过较旧的模型
- `--provider <name>`：提供商前缀筛选
- `--max-candidates <n>`：回退列表大小
- `--set-default`：将 `agents.defaults.model.primary` 设置为第一个选择
- `--set-image`：将 `agents.defaults.imageModel.primary` 设置为第一个图像选择

探测需要 OpenRouter API 密钥（来自认证配置文件或 `OPENROUTER_API_KEY`）。没有密钥时，使用 `--no-probe` 仅列出候选项。

扫描结果按以下顺序排名：

1. 图像支持
2. 工具延迟
3. 上下文大小
4. 参数数量

输入

- OpenRouter `/models` 列表（筛选 `:free`）
- 需要来自认证配置文件或 `OPENROUTER_API_KEY` 的 OpenRouter API 密钥（参见 [/environment](/environment)）
- 可选筛选器：`--max-age-days`、`--min-params`、`--provider`、`--max-candidates`
- 探测控制：`--timeout`、`--concurrency`

在 TTY 中运行时，你可以交互式选择回退。在非交互模式下，传递 `--yes` 接受默认值。

## 模型注册表（`models.json`）

`models.providers` 中的自定义提供商会写入智能体目录下的 `models.json`（默认 `~/.openclaw/agents/<agentId>/models.json`）。除非 `models.mode` 设置为 `replace`，否则此文件默认会被合并。
