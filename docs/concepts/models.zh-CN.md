---
summary: "Models CLI: 列表、设置、别名、回退、扫描、状态"
read_when:
  - 添加或修改 models CLI（models list/set/scan/aliases/fallbacks）
  - 更改模型回退行为或选择 UX
  - 更新模型扫描探针（工具/图像）
title: "Models CLI"
---

# Models CLI

有关身份验证配置文件轮换、冷却以及它们如何与回退交互，请参阅 [/concepts/model-failover](/concepts/model-failover)。
快速提供者概述 + 示例：[/concepts/model-providers](/concepts/model-providers)。

## 模型选择如何工作

OpenClaw 按以下顺序选择模型：

1. **主要**模型（`agents.defaults.model.primary` 或 `agents.defaults.model`）。
2. `agents.defaults.model.fallbacks` 中的**回退**（按顺序）。
3. **提供者身份验证回退**在提供者内部发生，然后再移动到下一个模型。

相关：

- `agents.defaults.models` 是 OpenClaw 可以使用的模型的允许列表/目录（加上别名）。
- `agents.defaults.imageModel` **仅在**主要模型无法接受图像时使用。
- `agents.defaults.pdfModel` 由 `pdf` 工具使用。如果省略，该工具会回退到 `agents.defaults.imageModel`，然后是解析的会话/默认模型。
- `agents.defaults.imageGenerationModel` 由共享的图像生成功能使用。如果省略，`image_generate` 仍然可以推断出支持身份验证的提供者默认值。它首先尝试当前默认提供者，然后按提供者 ID 顺序尝试剩余的已注册图像生成提供者。如果您设置了特定的提供者/模型，还请配置该提供者的身份验证/API 密钥。
- `agents.defaults.musicGenerationModel` 由共享的音乐生成功能使用。如果省略，`music_generate` 仍然可以推断出支持身份验证的提供者默认值。它首先尝试当前默认提供者，然后按提供者 ID 顺序尝试剩余的已注册音乐生成提供者。如果您设置了特定的提供者/模型，还请配置该提供者的身份验证/API 密钥。
- `agents.defaults.videoGenerationModel` 由共享的视频生成功能使用。如果省略，`video_generate` 仍然可以推断出支持身份验证的提供者默认值。它首先尝试当前默认提供者，然后按提供者 ID 顺序尝试剩余的已注册视频生成提供者。如果您设置了特定的提供者/模型，还请配置该提供者的身份验证/API 密钥。
- 每个代理的默认值可以通过 `agents.list[].model` 加上绑定覆盖 `agents.defaults.model`（请参阅 [/concepts/multi-agent](/concepts/multi-agent)）。

## 快速模型策略

- 将您的主要模型设置为您可用的最强大的最新一代模型。
- 使用回退处理对成本/延迟敏感的任务和低风险聊天。
- 对于启用工具的代理或不受信任的输入，避免使用较旧/较弱的模型层级。

## 入职（推荐）

如果您不想手动编辑配置，请运行入职：

```bash
openclaw onboard
```

它可以为常见提供者设置模型 + 身份验证，包括 **OpenAI Code (Codex) 订阅**（OAuth）和 **Anthropic**（API 密钥或 Claude CLI）。

## 配置键（概述）

- `agents.defaults.model.primary` 和 `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` 和 `agents.defaults.imageModel.fallbacks`
- `agents.defaults.pdfModel.primary` 和 `agents.defaults.pdfModel.fallbacks`
- `agents.defaults.imageGenerationModel.primary` 和 `agents.defaults.imageGenerationModel.fallbacks`
- `agents.defaults.videoGenerationModel.primary` 和 `agents.defaults.videoGenerationModel.fallbacks`
- `agents.defaults.models`（允许列表 + 别名 + 提供者参数）
- `models.providers`（写入 `models.json` 的自定义提供者）

模型引用被标准化为小写。提供者别名如 `z.ai/*` 标准化为 `zai/*`。

提供者配置示例（包括 OpenCode）位于 [/providers/opencode](/providers/opencode)。

## "Model is not allowed"（以及为什么回复停止）

如果设置了 `agents.defaults.models`，它将成为 `/model` 和会话覆盖的**允许列表**。当用户选择不在该允许列表中的模型时，OpenClaw 返回：

```
Model "provider/model" is not allowed. Use /model to list available models.
```

这发生在**生成正常回复之前**，因此消息可能感觉“没有响应”。修复方法是：

- 将模型添加到 `agents.defaults.models`，或
- 清除允许列表（删除 `agents.defaults.models`），或
- 从 `/model list` 中选择模型。

示例允许列表配置：

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-sonnet-4-6" },
      models: {
        "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
    },
  },
}
```

## 在聊天中切换模型（`/model`）

您可以在不重启的情况下为当前会话切换模型：

```
/model
/model list
/model 3
/model openai/gpt-5.4
/model status
```

注意：

- `/model`（和 `/model list`）是一个紧凑的编号选择器（模型系列 + 可用提供者）。
- 在 Discord 上，`/model` 和 `/models` 打开一个交互式选择器，带有提供者和模型下拉菜单以及提交步骤。
- `/model <#>` 从该选择器中选择。
- `/model` 立即保存新的会话选择。
- 如果代理空闲，下一次运行会立即使用新模型。
- 如果运行已经处于活动状态，OpenClaw 会将实时切换标记为待处理，并且只在干净的重试点重新启动到新模型。
- 如果工具活动或回复输出已经开始，待处理的切换可能会保持排队状态，直到稍后的重试机会或下一个用户回合。
- `/model status` 是详细视图（身份验证候选者，以及配置时的提供者端点 `baseUrl` + `api` 模式）。
- 模型引用通过在**第一个** `/` 上分割来解析。输入 `/model <ref>` 时使用 `provider/model`。
- 如果模型 ID 本身包含 `/`（OpenRouter 风格），您必须包含提供者前缀（例如：`/model openrouter/moonshotai/kimi-k2`）。
- 如果您省略提供者，OpenClaw 按以下顺序解析输入：
  1. 别名匹配
  2. 该确切无前缀模型 ID 的唯一配置提供者匹配
  3. 已弃用的回退到配置的默认提供者
     如果该提供者不再公开配置的默认模型，OpenClaw 会改为回退到第一个配置的提供者/模型，以避免显示已删除的提供者默认值。

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
- `--local`：仅本地提供者
- `--provider <name>`：按提供者过滤
- `--plain`：每行一个模型
- `--json`：机器可读输出

### `models status`

显示解析的主要模型、回退、图像模型以及已配置提供者的身份验证概述。它还会显示在身份验证存储中找到的配置文件的 OAuth 过期状态（默认情况下在 24 小时内警告）。`--plain` 仅打印解析的主要模型。
始终显示 OAuth 状态（并包含在 `--json` 输出中）。如果已配置的提供者没有凭据，`models status` 会打印 **Missing auth** 部分。
JSON 包含 `auth.oauth`（警告窗口 + 配置文件）和 `auth.providers`（每个提供者的有效身份验证，包括环境支持的凭据）。`auth.oauth` 仅包含身份验证存储配置文件健康状况；仅环境提供者不会出现在那里。
使用 `--check` 进行自动化（缺少/过期时退出 `1`，即将过期时退出 `2`）。
使用 `--probe` 进行实时身份验证检查；探测行可以来自身份验证配置文件、环境凭据或 `models.json`。
如果显式 `auth.order.<provider>` 省略了存储的配置文件，探测会报告 `excluded_by_auth_order` 而不是尝试它。如果存在身份验证但无法为该提供者解析可探测的模型，探测会报告 `status: no_model`。

身份验证选择取决于提供者/账户。对于始终开启的网关主机，API 密钥通常是最可预测的；也支持 Claude CLI 重用和现有的 Anthropic OAuth/令牌配置文件。

示例（Claude CLI）：

```bash
claude auth login
openclaw models status
```

## 扫描（OpenRouter 免费模型）

`openclaw models scan` 检查 OpenRouter 的**免费模型目录**，并可以选择性地探测模型的工具和图像支持。

关键标志：

- `--no-probe`：跳过实时探测（仅元数据）
- `--min-params <b>`：最小参数大小（十亿）
- `--max-age-days <days>`：跳过较旧的模型
- `--provider <name>`：提供者前缀过滤器
- `--max-candidates <n>`：回退列表大小
- `--set-default`：将 `agents.defaults.model.primary` 设置为第一个选择
- `--set-image`：将 `agents.defaults.imageModel.primary` 设置为第一个图像选择

探测需要 OpenRouter API 密钥（来自身份验证配置文件或 `OPENROUTER_API_KEY`）。没有密钥时，使用 `--no-probe` 仅列出候选者。

扫描结果按以下顺序排序：

1. 图像支持
2. 工具延迟
3. 上下文大小
4. 参数计数

输入

- OpenRouter `/models` 列表（过滤 `:free`）
- 需要来自身份验证配置文件或 `OPENROUTER_API_KEY` 的 OpenRouter API 密钥（请参阅 [/environment](/help/environment)）
- 可选过滤器：`--max-age-days`、`--min-params`、`--provider`、`--max-candidates`
- 探测控制：`--timeout`、`--concurrency`

在 TTY 中运行时，您可以交互式选择回退。在非交互式模式下，传递 `--yes` 以接受默认值。

## 模型注册表（`models.json`）

`models.providers` 中的自定义提供者被写入代理目录下的 `models.json`（默认 `~/.openclaw/agents/<agentId>/agent/models.json`）。除非 `models.mode` 设置为 `replace`，否则默认合并此文件。

匹配提供者 ID 的合并模式优先级：

- 代理 `models.json` 中已存在的非空 `baseUrl` 获胜。
- 代理 `models.json` 中的非空 `apiKey` 仅在该提供者在当前配置/身份验证配置文件上下文中不是 SecretRef 管理时获胜。
- SecretRef 管理的提供者 `apiKey` 值从源标记刷新（环境引用为 `ENV_VAR_NAME`，文件/执行引用为 `secretref-managed`），而不是持久化解析的密钥。
- SecretRef 管理的提供者头部值从源标记刷新（环境引用为 `secretref-env:ENV_VAR_NAME`，文件/执行引用为 `secretref-managed`）。
- 空或缺失的代理 `apiKey`/`baseUrl` 回退到配置 `models.providers`。
- 其他提供者字段从配置和标准化目录数据刷新。

标记持久性是源权威的：OpenClaw 从活动源配置快照（预解析）写入标记，而不是从解析的运行时密钥值。
这适用于 OpenClaw 重新生成 `models.json` 的任何时候，包括命令驱动的路径，如 `openclaw agent`。

## 相关

- [模型提供者](/concepts/model-providers) — 提供者路由和身份验证
- [模型回退](/concepts/model-failover) — 回退链
- [图像生成](/tools/image-generation) — 图像模型配置
- [音乐生成](/tools/music-generation) — 音乐模型配置
- [视频生成](/tools/video-generation) — 视频模型配置
- [配置参考](/gateway/configuration-reference#agent-defaults) — 模型配置键
