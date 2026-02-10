---
read_when:
  - 你想在 OpenClaw 中使用 MiniMax 模型
  - 你需要 MiniMax 设置指南
summary: 在 OpenClaw 中使用 MiniMax M2.1
title: MiniMax
x-i18n:
  generated_at: "2026-02-03T10:08:52Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 861e1ddc3c24be88f716bfb72d6015d62875a9087f8e89ea4ba3a35f548c7fae
  source_path: providers/minimax.md
  workflow: 15
---

# MiniMax

MiniMax 是一家构建 **M2/M2.1** 模型系列的 AI 公司。当前面向编程的版本是 **MiniMax M2.1**（2025 年 12 月 23 日），专为现实世界的复杂任务而构建。

来源：[MiniMax M2.1 发布说明](https://www.minimax.io/news/minimax-m21)

## 模型概述（M2.1）

MiniMax 强调 M2.1 的以下改进：

- 更强的**多语言编程**能力（Rust、Java、Go、C++、Kotlin、Objective-C、TS/JS）。
- 更好的 **Web/应用开发**和美观输出质量（包括原生移动端）。
- 改进的**复合指令**处理，适用于办公风格的工作流程，基于交错思考和集成约束执行。
- **更简洁的响应**，更低的 token 使用量和更快的迭代循环。
- 更强的**工具/智能体框架**兼容性和上下文管理（Claude Code、Droid/Factory AI、Cline、Kilo Code、Roo Code、BlackBox）。
- 更高质量的**对话和技术写作**输出。

## MiniMax M2.1 vs MiniMax M2.1 Lightning

- **速度：** Lightning 是 MiniMax 定价文档中的"快速"变体。
- **成本：** 定价显示相同的输入成本，但 Lightning 的输出成本更高。
- **编程计划路由：** Lightning 后端在 MiniMax 编程计划中不能直接使用。MiniMax 自动将大多数请求路由到 Lightning，但在流量高峰期会回退到常规 M2.1 后端。

## 选择设置方式

### MiniMax OAuth（编程计划）— 推荐

**适用于：** 通过 OAuth 快速设置 MiniMax 编程计划，无需 API 密钥。

启用内置 OAuth 插件并进行认证：

```bash
openclaw plugins enable minimax-portal-auth  # 如果已加载则跳过
openclaw gateway restart  # 如果 Gateway 网关已在运行则重启
openclaw onboard --auth-choice minimax-portal
```

系统会提示你选择端点：

- **Global** - 国际用户（`api.minimax.io`）
- **CN** - 中国用户（`api.minimaxi.com`）

详情参见 [MiniMax OAuth 插件 README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth)。

### MiniMax M2.1（API 密钥）

**适用于：** 使用 Anthropic 兼容 API 的托管 MiniMax。

通过 CLI 配置：

- 运行 `openclaw configure`
- 选择 **Model/auth**
- 选择 **MiniMax M2.1**

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.1 作为备用（Opus 为主）

**适用于：** 保持 Opus 4.5 为主模型，故障时切换到 MiniMax M2.1。

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-5": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-5",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

### 可选：通过 LM Studio 本地运行（手动）

**适用于：** 使用 LM Studio 进行本地推理。
我们在强大硬件（例如台式机/服务器）上使用 LM Studio 的本地服务器运行 MiniMax M2.1 时看到了出色的效果。

通过 `openclaw.json` 手动配置：

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## 通过 `openclaw configure` 配置

使用交互式配置向导设置 MiniMax，无需编辑 JSON：

1. 运行 `openclaw configure`。
2. 选择 **Model/auth**。
3. 选择 **MiniMax M2.1**。
4. 在提示时选择你的默认模型。

## 配置选项

- `models.providers.minimax.baseUrl`：推荐使用 `https://api.minimax.io/anthropic`（Anthropic 兼容）；`https://api.minimax.io/v1` 可选用于 OpenAI 兼容的负载。
- `models.providers.minimax.api`：推荐使用 `anthropic-messages`；`openai-completions` 可选用于 OpenAI 兼容的负载。
- `models.providers.minimax.apiKey`：MiniMax API 密钥（`MINIMAX_API_KEY`）。
- `models.providers.minimax.models`：定义 `id`、`name`、`reasoning`、`contextWindow`、`maxTokens`、`cost`。
- `agents.defaults.models`：为你想要在允许列表中的模型设置别名。
- `models.mode`：如果你想将 MiniMax 与内置模型一起添加，保持 `merge`。

## 注意事项

- 模型引用格式为 `minimax/<model>`。
- 编程计划使用量 API：`https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains`（需要编程计划密钥）。
- 如果需要精确的成本跟踪，请更新 `models.json` 中的定价值。
- MiniMax 编程计划推荐链接（9 折优惠）：https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link
- 参见 [/concepts/model-providers](/concepts/model-providers) 了解提供商规则。
- 使用 `openclaw models list` 和 `openclaw models set minimax/MiniMax-M2.1` 切换模型。

## 故障排除

### "Unknown model: minimax/MiniMax-M2.1"

这通常意味着 **MiniMax 提供商未配置**（没有提供商条目，也没有找到 MiniMax 认证配置文件/环境变量密钥）。此检测的修复在 **2026.1.12** 中（撰写本文时尚未发布）。修复方法：

- 升级到 **2026.1.12**（或从源码 `main` 分支运行），然后重启 Gateway 网关。
- 运行 `openclaw configure` 并选择 **MiniMax M2.1**，或
- 手动添加 `models.providers.minimax` 块，或
- 设置 `MINIMAX_API_KEY`（或 MiniMax 认证配置文件）以便注入提供商。

确保模型 id **区分大小写**：

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

然后重新检查：

```bash
openclaw models list
```
