---
read_when:
  - 添加或修改 models CLI（models list/set/scan/aliases/fallbacks）
  - 更改模型回退行为或选择 UX
  - 更新模型扫描探测（tools/images）
summary: Models CLI：列出、设置、别名、回退、扫描、状态
title: Models CLI
x-i18n:
  generated_at: "2026-03-16T06:22:01Z"
  model: gpt-5.4
  provider: openai
  source_hash: 26150aef638bc3375866dec736b98eac32384466a8ef2b0a471fb7ff7729b13c
  source_path: concepts/models.md
  workflow: 15
---

# Models CLI

关于凭证配置轮换、冷却时间以及它们如何与回退交互，请参阅 [/concepts/model-failover](/concepts/model-failover)。
快速提供商概览 + 示例：[/concepts/model-providers](/concepts/model-providers)。

## 模型选择的工作方式

OpenClaw 按以下顺序选择模型：

1. **主模型**（`agents.defaults.model.primary` 或 `agents.defaults.model`）。
2. `agents.defaults.model.fallbacks` 中的 **回退模型**（按顺序）。
3. **提供商凭证故障切换** 会在单个提供商内部发生，然后才会移动到下一个模型。

相关内容：

- `agents.defaults.models` 是 OpenClaw 可使用的模型允许列表/目录（以及别名）。
- `agents.defaults.imageModel` **仅在** 主模型无法接受图像时使用。
- 每个智能体的默认值可以通过 `agents.list[].model` 加上绑定来覆盖 `agents.defaults.model`（见 [/concepts/multi-agent](/concepts/multi-agent)）。

## 快速模型策略

- 将你的主模型设置为你可用的、最新一代中最强的模型。
- 对于对成本/延迟敏感的任务和风险较低的聊天，使用回退模型。
- 对于启用了工具的智能体或不受信任的输入，避免使用较旧/较弱的模型层级。

## 设置向导（推荐）

如果你不想手动编辑配置，请运行设置向导：

```bash
openclaw onboard
```

它可以为常见提供商设置模型 + 凭证，包括 **OpenAI Code (Codex)**
订阅（OAuth）和 **Anthropic**（API key 或 `claude setup-token`）。

## 配置键（概览）

- `agents.defaults.model.primary` 和 `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` 和 `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models`（允许列表 + 别名 + 提供商参数）
- `models.providers`（写入 `models.json` 的自定义提供商）

模型引用会被规范化为小写。像 `z.ai/*` 这样的提供商别名会被规范化
为 `zai/*`。

提供商配置示例（包括 OpenCode）位于
[/gateway/configuration](/gateway/configuration#opencode)。

## “Model is not allowed”（以及为什么回复会停止）

如果设置了 `agents.defaults.models`，它就会成为 `/model` 和会话覆盖的 **允许列表**。当用户选择了不在该允许列表中的模型时，
OpenClaw 会返回：

```
Model "provider/model" is not allowed. Use /model to list available models.
```

这会在生成正常回复 **之前** 发生，因此消息可能会让人觉得
它“没有响应”。修复方法是：

- 将该模型添加到 `agents.defaults.models`，或者
- 清除允许列表（移除 `agents.defaults.models`），或者
- 从 `/model list` 中选择一个模型。

允许列表示例配置：

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## 在聊天中切换模型（`/model`）

你可以在不重启的情况下为当前会话切换模型：

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

说明：

- `/model`（以及 `/model list`）是一个紧凑的编号选择器（模型家族 + 可用提供商）。
- 在 Discord 上，`/model` 和 `/models` 会打开一个交互式选择器，其中包含提供商和模型下拉菜单，以及一个 Submit 步骤。
- `/model <#>` 会从该选择器中进行选择。
- `/model status` 是详细视图（凭证候选项，以及在已配置时显示提供商端点 `baseUrl` + `api` 模式）。
- 模型引用是通过按 **第一个** `/` 进行分割来解析的。输入 `/model <ref>` 时请使用 `provider/model`。
- 如果模型 ID 本身包含 `/`（OpenRouter 风格），你必须包含提供商前缀（示例：`/model openrouter/moonshotai/kimi-k2`）。
- 如果你省略提供商，OpenClaw 会将输入视为别名或 **默认提供商** 的模型（仅在模型 ID 中没有 `/` 时有效）。

完整命令行为/配置： [Slash commands](/tools/slash-commands)。

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

默认显示已配置的模型。常用标志：

- `--all`：完整目录
- `--local`：仅本地提供商
- `--provider <name>`：按提供商筛选
- `--plain`：每行一个模型
- `--json`：机器可读输出

### `models status`

显示已解析的主模型、回退模型、图像模型，以及已配置提供商的凭证概览。它还会显示凭证存储中找到的配置文件的 OAuth 过期状态
（默认会在 24 小时内到期时警告）。`--plain` 仅打印已解析的
主模型。
OAuth 状态始终会显示（并包含在 `--json` 输出中）。如果某个已配置的
提供商没有凭证，`models status` 会打印一个 **Missing auth** 部分。
JSON 包含 `auth.oauth`（警告窗口 + 配置文件）和 `auth.providers`
（每个提供商的有效凭证）。
自动化场景请使用 `--check`（缺失/已过期时退出码为 `1`，即将过期时为 `2`）。

凭证选择取决于提供商/账号。对于始终在线的 Gateway 网关主机，API key 通常最可预测；也支持订阅 token 流程。

示例（Anthropic setup-token）：

```bash
claude setup-token
openclaw models status
```

## 扫描（OpenRouter 免费模型）

`openclaw models scan` 会检查 OpenRouter 的 **免费模型目录**，并且可以
选择性地探测模型对工具和图像的支持。

关键标志：

- `--no-probe`：跳过实时探测（仅元数据）
- `--min-params <b>`：最小参数规模（十亿）
- `--max-age-days <days>`：跳过较旧模型
- `--provider <name>`：提供商前缀筛选
- `--max-candidates <n>`：回退列表大小
- `--set-default`：将 `agents.defaults.model.primary` 设置为第一个选择项
- `--set-image`：将 `agents.defaults.imageModel.primary` 设置为第一个图像选择项

探测需要 OpenRouter API key（来自凭证配置文件或
`OPENROUTER_API_KEY`）。如果没有 key，请使用 `--no-probe` 仅列出候选项。

扫描结果按以下顺序排序：

1. 图像支持
2. 工具延迟
3. 上下文大小
4. 参数数量

输入

- OpenRouter `/models` 列表（筛选 `:free`）
- 需要来自凭证配置文件或 `OPENROUTER_API_KEY` 的 OpenRouter API key（见 [/environment](/help/environment)）
- 可选筛选器：`--max-age-days`、`--min-params`、`--provider`、`--max-candidates`
- 探测控制：`--timeout`、`--concurrency`

在 TTY 中运行时，你可以交互式选择回退模型。在非交互
模式下，传入 `--yes` 以接受默认值。

## 模型注册表（`models.json`）

`models.providers` 中的自定义提供商会写入
智能体目录下的 `models.json`（默认是 `~/.openclaw/agents/<agentId>/agent/models.json`）。默认会合并此文件，除非将 `models.mode` 设置为 `replace`。

匹配提供商 ID 时的合并模式优先级：

- 智能体 `models.json` 中已存在的非空 `baseUrl` 优先。
- 智能体 `models.json` 中的非空 `apiKey` 仅在该提供商在当前配置/凭证配置文件上下文中不是 SecretRef 管理时才优先。
- 由 SecretRef 管理的提供商 `apiKey` 值会从源标记（环境变量引用使用 `ENV_VAR_NAME`，文件/exec 引用使用 `secretref-managed`）刷新，而不是持久化已解析的 secret。
- 由 SecretRef 管理的提供商 header 值会从源标记（环境变量引用使用 `secretref-env:ENV_VAR_NAME`，文件/exec 引用使用 `secretref-managed`）刷新。
- 智能体中为空或缺失的 `apiKey`/`baseUrl` 会回退到配置中的 `models.providers`。
- 其他提供商字段会从配置和规范化后的目录数据中刷新。

标记持久化以源为准：OpenClaw 会根据活动源配置快照（预解析）写入标记，而不是根据运行时已解析的 secret 值写入。
这适用于 OpenClaw 重新生成 `models.json` 的所有情况，包括像 `openclaw agent` 这样的命令驱动路径。
