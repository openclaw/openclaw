---
read_when:
  - 你想在 OpenClaw 中使用注重隐私的推理服务
  - 你需要 Venice AI 设置指导
summary: 在 OpenClaw 中使用 Venice AI 注重隐私的模型
title: Venice AI
x-i18n:
  generated_at: "2026-02-01T21:36:03Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 2453a6ec3a715c24c460f902dec1755edcad40328de2ef895e35a614a25624cf
  source_path: providers/venice.md
  workflow: 15
---

# Venice AI（Venice 精选）

**Venice** 是我们精选的 Venice 隐私优先推理配置，支持可选的匿名化访问专有模型。

Venice AI 提供注重隐私的 AI 推理服务，支持无审查模型，并可通过其匿名代理访问主流专有模型。所有推理默认私密——不会用你的数据训练，不会记录日志。

## 为什么在 OpenClaw 中使用 Venice

- **私密推理**，适用于开源模型（无日志记录）。
- 需要时可使用**无审查模型**。
- 在质量重要时，可**匿名访问**专有模型（Opus/GPT/Gemini）。
- 兼容 OpenAI 的 `/v1` 端点。

## 隐私模式

Venice 提供两种隐私级别——理解这一点是选择模型的关键：

| 模式       | 描述                                                                                  | 模型                                        |
| ---------- | ------------------------------------------------------------------------------------- | ------------------------------------------- |
| **私密**   | 完全私密。提示词/回复**从不存储或记录**。临时性处理。                                 | Llama、Qwen、DeepSeek、Venice Uncensored 等 |
| **匿名化** | 通过 Venice 代理转发并剥离元数据。底层提供商（OpenAI、Anthropic）收到的是匿名化请求。 | Claude、GPT、Gemini、Grok、Kimi、MiniMax    |

## 功能特性

- **注重隐私**：可选择"私密"（完全私密）和"匿名化"（代理转发）模式
- **无审查模型**：访问无内容限制的模型
- **主流模型访问**：通过 Venice 匿名代理使用 Claude、GPT-5.2、Gemini、Grok
- **兼容 OpenAI API**：标准 `/v1` 端点，易于集成
- **流式输出**：✅ 所有模型均支持
- **函数调用**：✅ 部分模型支持（请检查模型能力）
- **视觉**：✅ 具有视觉能力的模型支持
- **无硬性速率限制**：极端使用情况下可能触发公平使用限流

## 设置

### 1. 获取 API 密钥

1. 在 [venice.ai](https://venice.ai) 注册
2. 前往 **Settings → API Keys → Create new key**
3. 复制你的 API 密钥（格式：`vapi_xxxxxxxxxxxx`）

### 2. 配置 OpenClaw

**方案 A：环境变量**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**方案 B：交互式设置（推荐）**

```bash
openclaw onboard --auth-choice venice-api-key
```

这将：

1. 提示输入你的 API 密钥（或使用已有的 `VENICE_API_KEY`）
2. 显示所有可用的 Venice 模型
3. 让你选择默认模型
4. 自动配置提供商

**方案 C：非交互式**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. 验证设置

```bash
openclaw chat --model venice/llama-3.3-70b "Hello, are you working?"
```

## 模型选择

设置完成后，OpenClaw 会显示所有可用的 Venice 模型。根据你的需求选择：

- **默认（我们的推荐）**：`venice/llama-3.3-70b`，私密且性能均衡。
- **最佳整体质量**：`venice/claude-opus-45`，适合复杂任务（Opus 仍然是最强的）。
- **隐私**：选择"私密"模型以获得完全私密的推理。
- **能力**：选择"匿名化"模型以通过 Venice 代理访问 Claude、GPT、Gemini。

随时更改默认模型：

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

列出所有可用模型：

```bash
openclaw models list | grep venice
```

## 通过 `openclaw configure` 配置

1. 运行 `openclaw configure`
2. 选择 **Model/auth**
3. 选择 **Venice AI**

## 应该使用哪个模型？

| 使用场景               | 推荐模型                         | 原因                         |
| ---------------------- | -------------------------------- | ---------------------------- |
| **通用对话**           | `llama-3.3-70b`                  | 综合表现好，完全私密         |
| **最佳整体质量**       | `claude-opus-45`                 | Opus 在复杂任务上仍然最强    |
| **隐私 + Claude 品质** | `claude-opus-45`                 | 通过匿名代理获得最佳推理能力 |
| **编程**               | `qwen3-coder-480b-a35b-instruct` | 代码优化，262k 上下文        |
| **视觉任务**           | `qwen3-vl-235b-a22b`             | 最佳私密视觉模型             |
| **无审查**             | `venice-uncensored`              | 无内容限制                   |
| **快速 + 低成本**      | `qwen3-4b`                       | 轻量级，仍有不错能力         |
| **复杂推理**           | `deepseek-v3.2`                  | 推理能力强，私密             |

## 可用模型（共 25 个）

### 私密模型（15 个）— 完全私密，无日志记录

| 模型 ID                          | 名称                    | 上下文（token） | 特性         |
| -------------------------------- | ----------------------- | --------------- | ------------ |
| `llama-3.3-70b`                  | Llama 3.3 70B           | 131k            | 通用         |
| `llama-3.2-3b`                   | Llama 3.2 3B            | 131k            | 快速，轻量   |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B | 131k            | 复杂任务     |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking     | 131k            | 推理         |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct     | 131k            | 通用         |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B        | 262k            | 编程         |
| `qwen3-next-80b`                 | Qwen3 Next 80B          | 262k            | 通用         |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B           | 262k            | 视觉         |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k             | 快速，推理   |
| `deepseek-v3.2`                  | DeepSeek V3.2           | 163k            | 推理         |
| `venice-uncensored`              | Venice Uncensored       | 32k             | 无审查       |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k            | 视觉         |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct    | 202k            | 视觉         |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B     | 131k            | 通用         |
| `zai-org-glm-4.7`                | GLM 4.7                 | 202k            | 推理，多语言 |

### 匿名化模型（10 个）— 通过 Venice 代理

| 模型 ID                  | 原始模型          | 上下文（token） | 特性       |
| ------------------------ | ----------------- | --------------- | ---------- |
| `claude-opus-45`         | Claude Opus 4.5   | 202k            | 推理，视觉 |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k            | 推理，视觉 |
| `openai-gpt-52`          | GPT-5.2           | 262k            | 推理       |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k            | 推理，视觉 |
| `gemini-3-pro-preview`   | Gemini 3 Pro      | 202k            | 推理，视觉 |
| `gemini-3-flash-preview` | Gemini 3 Flash    | 262k            | 推理，视觉 |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k            | 推理，视觉 |
| `grok-code-fast-1`       | Grok Code Fast 1  | 262k            | 推理，编程 |
| `kimi-k2-thinking`       | Kimi K2 Thinking  | 262k            | 推理       |
| `minimax-m21`            | MiniMax M2.1      | 202k            | 推理       |

## 模型发现

当设置了 `VENICE_API_KEY` 时，OpenClaw 会自动从 Venice API 发现模型。如果 API 不可达，则回退到静态目录。

`/models` 端点是公开的（列出模型无需认证），但推理需要有效的 API 密钥。

## 流式输出与工具支持

| 功能          | 支持情况                                                   |
| ------------- | ---------------------------------------------------------- |
| **流式输出**  | ✅ 所有模型                                                |
| **函数调用**  | ✅ 大多数模型（请检查 API 中的 `supportsFunctionCalling`） |
| **视觉/图像** | ✅ 标记为"视觉"特性的模型                                  |
| **JSON 模式** | ✅ 通过 `response_format` 支持                             |

## 定价

Venice 使用积分制。请查看 [venice.ai/pricing](https://venice.ai/pricing) 了解当前费率：

- **私密模型**：通常成本较低
- **匿名化模型**：与直接 API 定价相近 + 少量 Venice 费用

## 对比：Venice 与直接 API

| 方面     | Venice（匿名化）   | 直接 API     |
| -------- | ------------------ | ------------ |
| **隐私** | 剥离元数据，匿名化 | 关联你的账户 |
| **延迟** | +10-50ms（代理）   | 直连         |
| **功能** | 支持大部分功能     | 完整功能     |
| **计费** | Venice 积分        | 提供商计费   |

## 使用示例

```bash
# 使用默认私密模型
openclaw chat --model venice/llama-3.3-70b

# 通过 Venice 使用 Claude（匿名化）
openclaw chat --model venice/claude-opus-45

# 使用无审查模型
openclaw chat --model venice/venice-uncensored

# 使用视觉模型处理图像
openclaw chat --model venice/qwen3-vl-235b-a22b

# 使用编程模型
openclaw chat --model venice/qwen3-coder-480b-a35b-instruct
```

## 故障排除

### API 密钥无法识别

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

确保密钥以 `vapi_` 开头。

### 模型不可用

Venice 模型目录会动态更新。运行 `openclaw models list` 查看当前可用的模型。部分模型可能暂时离线。

### 连接问题

Venice API 地址为 `https://api.venice.ai/api/v1`。确保你的网络允许 HTTPS 连接。

## 配置文件示例

```json5
{
  env: { VENICE_API_KEY: "vapi_..." },
  agents: { defaults: { model: { primary: "venice/llama-3.3-70b" } } },
  models: {
    mode: "merge",
    providers: {
      venice: {
        baseUrl: "https://api.venice.ai/api/v1",
        apiKey: "${VENICE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.3-70b",
            name: "Llama 3.3 70B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## 链接

- [Venice AI](https://venice.ai)
- [API 文档](https://docs.venice.ai)
- [定价](https://venice.ai/pricing)
- [状态页](https://status.venice.ai)
