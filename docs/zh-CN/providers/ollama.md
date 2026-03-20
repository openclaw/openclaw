---
read_when:
  - 你想通过 Ollama 在 OpenClaw 中运行云端或本地模型
  - 你需要 Ollama 设置和配置指南
summary: 通过 Ollama 运行 OpenClaw（云端和本地模型）
title: Ollama
x-i18n:
  generated_at: "2026-03-16T06:26:42Z"
  model: gpt-5.4
  provider: openai
  source_hash: 226b71bfd59614552f0b9cf1c9b1d18d82121a5fb05f6c71b11cc3cf4c23fd4e
  source_path: providers/ollama.md
  workflow: 15
---

# Ollama

Ollama 是一个本地 LLM 运行时，可以让你轻松在自己的机器上运行开源模型。OpenClaw 集成了 Ollama 的原生 API（`/api/chat`），支持流式传输和工具调用，并且在你选择使用 `OLLAMA_API_KEY`（或凭证配置文件）且未定义显式 `models.providers.ollama` 条目时，可以自动发现本地 Ollama 模型。

<Warning>
**远程 Ollama 用户：** 不要在 OpenClaw 中使用 `/v1` 的 OpenAI 兼容 URL（`http://host:11434/v1`）。这会破坏工具调用，而且模型可能会把原始工具 JSON 当作纯文本输出。请改用原生 Ollama API URL：`baseUrl: "http://host:11434"`（不要加 `/v1`）。
</Warning>

## 快速开始

### 新手引导向导（推荐）

通过设置向导配置 Ollama 是最快的方法：

```bash
openclaw onboard
```

从提供商列表中选择 **Ollama**。向导将会：

1. 询问你的 Ollama base URL，也就是可以访问你的实例的地址（默认 `http://127.0.0.1:11434`）。
2. 让你选择 **Cloud + Local**（云端模型和本地模型）或 **Local**（仅本地模型）。
3. 如果你选择 **Cloud + Local** 且尚未登录 ollama.com，则打开浏览器登录流程。
4. 发现可用模型并建议默认值。
5. 如果所选模型本地不可用，则自动拉取它。

也支持非交互模式：

```bash
openclaw onboard --non-interactive \
  --auth-choice ollama \
  --accept-risk
```

也可以选择指定自定义 base URL 或模型：

```bash
openclaw onboard --non-interactive \
  --auth-choice ollama \
  --custom-base-url "http://ollama-host:11434" \
  --custom-model-id "qwen3.5:27b" \
  --accept-risk
```

### 手动设置

1. 安装 Ollama：[https://ollama.com/download](https://ollama.com/download)

2. 如果你想进行本地推理，先拉取一个本地模型：

```bash
ollama pull glm-4.7-flash
# 或
ollama pull gpt-oss:20b
# 或
ollama pull llama3.3
```

3. 如果你也想使用云端模型，请先登录：

```bash
ollama signin
```

4. 运行新手引导并选择 `Ollama`：

```bash
openclaw onboard
```

- `Local`：仅本地模型
- `Cloud + Local`：本地模型加云端模型
- 云端模型如 `kimi-k2.5:cloud`、`minimax-m2.5:cloud` 和 `glm-5:cloud` **不需要** 本地执行 `ollama pull`

OpenClaw 当前建议：

- 本地默认：`glm-4.7-flash`
- 云端默认：`kimi-k2.5:cloud`、`minimax-m2.5:cloud`、`glm-5:cloud`

5. 如果你更喜欢手动设置，也可以直接为 OpenClaw 启用 Ollama（任意值都可以；Ollama 不需要真实 key）：

```bash
# 设置环境变量
export OLLAMA_API_KEY="ollama-local"

# 或在配置文件中设置
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

6. 查看或切换模型：

```bash
openclaw models list
openclaw models set ollama/glm-4.7-flash
```

7. 或者在配置中设置默认值：

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/glm-4.7-flash" },
    },
  },
}
```

## 模型发现（隐式提供商）

当你设置 `OLLAMA_API_KEY`（或凭证配置文件），并且**未**定义 `models.providers.ollama` 时，OpenClaw 会从 `http://127.0.0.1:11434` 上的本地 Ollama 实例发现模型：

- 查询 `/api/tags`
- 在可用时，尽力通过 `/api/show` 查找 `contextWindow`
- 通过模型名称启发式规则标记 `reasoning`（`r1`、`reasoning`、`think`）
- 将 `maxTokens` 设置为 OpenClaw 使用的默认 Ollama 最大 token 上限
- 将所有成本设置为 `0`

这样无需手动维护模型条目，同时又能让目录与本地 Ollama 实例保持一致。

查看有哪些可用模型：

```bash
ollama list
openclaw models list
```

添加新模型时，只需通过 Ollama 拉取它：

```bash
ollama pull mistral
```

新模型会被自动发现，并可立即使用。

如果你显式设置了 `models.providers.ollama`，则会跳过自动发现，你必须手动定义模型（见下文）。

## 配置

### 基本设置（隐式发现）

启用 Ollama 的最简单方式是通过环境变量：

```bash
export OLLAMA_API_KEY="ollama-local"
```

### 显式设置（手动模型）

以下情况适合使用显式配置：

- Ollama 运行在其他主机/端口上。
- 你想强制指定特定的上下文窗口或模型列表。
- 你希望完全手动定义模型。

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434",
        apiKey: "ollama-local",
        api: "ollama",
        models: [
          {
            id: "gpt-oss:20b",
            name: "GPT-OSS 20B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 8192 * 10
          }
        ]
      }
    }
  }
}
```

如果设置了 `OLLAMA_API_KEY`，你可以在提供商条目中省略 `apiKey`，OpenClaw 会在可用性检查时自动填充它。

### 自定义 base URL（显式配置）

如果 Ollama 运行在不同的主机或端口上（显式配置会禁用自动发现，因此你需要手动定义模型）：

```json5
{
  models: {
    providers: {
      ollama: {
        apiKey: "ollama-local",
        baseUrl: "http://ollama-host:11434", // 不要加 /v1 - 使用原生 Ollama API URL
        api: "ollama", // 显式设置，以确保原生工具调用行为
      },
    },
  },
}
```

<Warning>
不要在 URL 中添加 `/v1`。`/v1` 路径会启用 OpenAI 兼容模式，而在该模式下工具调用并不可靠。请使用不带路径后缀的基础 Ollama URL。
</Warning>

### 模型选择

配置完成后，你的所有 Ollama 模型都可用：

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "ollama/gpt-oss:20b",
        fallbacks: ["ollama/llama3.3", "ollama/qwen2.5-coder:32b"],
      },
    },
  },
}
```

## 云端模型

云端模型让你可以将云托管模型（例如 `kimi-k2.5:cloud`、`minimax-m2.5:cloud`、`glm-5:cloud`）与本地模型一起使用。

要使用云端模型，请在设置期间选择 **Cloud + Local** 模式。向导会检查你是否已登录，并在需要时打开浏览器登录流程。如果无法验证认证状态，向导会回退到本地模型默认值。

你也可以直接在 [ollama.com/signin](https://ollama.com/signin) 登录。

## 高级用法

### 推理模型

OpenClaw 默认会将名称中包含 `deepseek-r1`、`reasoning` 或 `think` 的模型视为支持推理的模型：

```bash
ollama pull deepseek-r1:32b
```

### 模型成本

Ollama 是免费的，并且在本地运行，因此所有模型成本都设置为 $0。

### 流式传输配置

OpenClaw 的 Ollama 集成默认使用 **原生 Ollama API**（`/api/chat`），它完全支持同时进行流式传输和工具调用。无需任何特殊配置。

#### 旧版 OpenAI 兼容模式

<Warning>
**在 OpenAI 兼容模式下，工具调用并不可靠。** 只有当你需要为代理使用 OpenAI 格式，并且不依赖原生工具调用行为时，才使用这种模式。
</Warning>

如果你确实需要改用 OpenAI 兼容端点（例如，在只支持 OpenAI 格式的代理之后），请显式设置 `api: "openai-completions"`：

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434/v1",
        api: "openai-completions",
        injectNumCtxForOpenAICompat: true, // 默认：true
        apiKey: "ollama-local",
        models: [...]
      }
    }
  }
}
```

这种模式可能不支持同时进行流式传输 + 工具调用。你可能需要在模型配置中通过 `params: { streaming: false }` 禁用流式传输。

当 Ollama 使用 `api: "openai-completions"` 时，OpenClaw 默认会注入 `options.num_ctx`，这样 Ollama 就不会静默回退到 4096 上下文窗口。如果你的代理/上游拒绝未知的 `options` 字段，请禁用此行为：

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434/v1",
        api: "openai-completions",
        injectNumCtxForOpenAICompat: false,
        apiKey: "ollama-local",
        models: [...]
      }
    }
  }
}
```

### 上下文窗口

对于自动发现的模型，OpenClaw 会在 Ollama 提供时使用其报告的上下文窗口，否则回退到 OpenClaw 使用的默认 Ollama 上下文窗口。你可以在显式提供商配置中覆盖 `contextWindow` 和 `maxTokens`。

## 故障排除

### 未检测到 Ollama

请确认 Ollama 正在运行，并且你已设置 `OLLAMA_API_KEY`（或凭证配置文件），而且**没有**定义显式的 `models.providers.ollama` 条目：

```bash
ollama serve
```

并确认 API 可访问：

```bash
curl http://localhost:11434/api/tags
```

### 没有可用模型

如果没有列出你的模型，可以：

- 在本地拉取该模型，或者
- 在 `models.providers.ollama` 中显式定义该模型。

添加模型：

```bash
ollama list  # 查看已安装的模型
ollama pull glm-4.7-flash
ollama pull gpt-oss:20b
ollama pull llama3.3     # 或其他模型
```

### 连接被拒绝

检查 Ollama 是否正在正确的端口上运行：

```bash
# 检查 Ollama 是否正在运行
ps aux | grep ollama

# 或重启 Ollama
ollama serve
```

## 另请参阅

- [Model Providers](/concepts/model-providers) - 所有提供商的概览
- [Model Selection](/concepts/models) - 如何选择模型
- [Configuration](/gateway/configuration) - 完整配置参考
