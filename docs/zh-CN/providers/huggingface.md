---
read_when:
  - 你想将 Hugging Face Inference 与 OpenClaw 一起使用
  - 你需要 HF token 环境变量或 CLI 认证选项
summary: Hugging Face Inference 设置（认证 + 模型选择）
title: Hugging Face（Inference）
x-i18n:
  generated_at: "2026-03-16T06:25:40Z"
  model: gpt-5.4
  provider: openai
  source_hash: e62b74915c9a26ab21954abcd9c03442cdd2133fba3371ddb9bcfc3a3458a002
  source_path: providers/huggingface.md
  workflow: 15
---

# Hugging Face（Inference）

[Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers) 通过单一路由器 API 提供与 OpenAI 兼容的 chat completions。你只需一个 token，即可访问许多模型（DeepSeek、Llama 等）。OpenClaw 使用 **OpenAI 兼容端点**（仅 chat completions）；如果要使用 text-to-image、embeddings 或 speech，请直接使用 [HF inference clients](https://huggingface.co/docs/api-inference/quicktour)。

- 提供商：`huggingface`
- 认证：`HUGGINGFACE_HUB_TOKEN` 或 `HF_TOKEN`（带有 **Make calls to Inference Providers** 权限的细粒度 token）
- API：OpenAI 兼容（`https://router.huggingface.co/v1`）
- 计费：单个 HF token；[定价](https://huggingface.co/docs/inference-providers/pricing) 按提供商费率执行，并带有免费层。

## 快速开始

1. 在 [Hugging Face → Settings → Tokens](https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained) 创建一个细粒度 token，并授予 **Make calls to Inference Providers** 权限。
2. 运行新手引导，并在提供商下拉菜单中选择 **Hugging Face**，然后在提示时输入你的 API key：

```bash
openclaw onboard --auth-choice huggingface-api-key
```

3. 在 **Default Hugging Face model** 下拉菜单中，选择你想使用的模型（当你有有效 token 时，列表会从 Inference API 加载；否则会显示内置列表）。你的选择会保存为默认模型。
4. 你也可以稍后在配置中设置或更改默认模型：

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/deepseek-ai/DeepSeek-R1" },
    },
  },
}
```

## 非交互式示例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice huggingface-api-key \
  --huggingface-api-key "$HF_TOKEN"
```

这会将 `huggingface/deepseek-ai/DeepSeek-R1` 设置为默认模型。

## 环境说明

如果 Gateway 网关作为守护进程运行（launchd/systemd），请确保 `HUGGINGFACE_HUB_TOKEN` 或 `HF_TOKEN`
对此进程可用（例如放在 `~/.openclaw/.env` 中，或通过
`env.shellEnv` 提供）。

## 模型发现和新手引导下拉菜单

OpenClaw 通过直接调用 **Inference 端点** 来发现模型：

```bash
GET https://router.huggingface.co/v1/models
```

（可选：发送 `Authorization: Bearer $HUGGINGFACE_HUB_TOKEN` 或 `$HF_TOKEN` 以获取完整列表；某些端点在未认证时只返回子集。）响应采用 OpenAI 风格：`{ "object": "list", "data": [ { "id": "Qwen/Qwen3-8B", "owned_by": "Qwen", ... }, ... ] }`。

当你配置 Hugging Face API key 时（通过新手引导、`HUGGINGFACE_HUB_TOKEN` 或 `HF_TOKEN`），OpenClaw 会使用这个 GET 请求来发现可用的 chat-completion 模型。在**交互式设置**期间，你输入 token 后会看到一个 **Default Hugging Face model** 下拉菜单，其内容来自该列表（如果请求失败，则使用内置目录）。在运行时（例如 Gateway 网关启动时），只要存在 key，OpenClaw 就会再次调用 **GET** `https://router.huggingface.co/v1/models` 来刷新目录。该列表会与内置目录合并（以补充上下文窗口和成本等元数据）。如果请求失败或未设置 key，则只使用内置目录。

## 模型名称和可编辑选项

- **来自 API 的名称：** 当 API 返回 `name`、`title` 或 `display_name` 时，模型显示名称会从 **GET /v1/models** 中补全；否则会从模型 id 推导（例如 `deepseek-ai/DeepSeek-R1` → “DeepSeek R1”）。
- **覆盖显示名称：** 你可以在配置中为每个模型设置自定义标签，使其在 CLI 和 UI 中按你希望的方式显示：

```json5
{
  agents: {
    defaults: {
      models: {
        "huggingface/deepseek-ai/DeepSeek-R1": { alias: "DeepSeek R1 (fast)" },
        "huggingface/deepseek-ai/DeepSeek-R1:cheapest": { alias: "DeepSeek R1 (cheap)" },
      },
    },
  },
}
```

- **提供商 / 策略选择：** 在**模型 id** 后附加后缀，以选择路由器如何挑选后端：
  - **`:fastest`** — 最高吞吐量（由路由器选择；提供商选择会被**锁定** —— 不会显示交互式后端选择器）。
  - **`:cheapest`** — 每输出 token 成本最低（由路由器选择；提供商选择会被**锁定**）。
  - **`:provider`** — 强制使用特定后端（例如 `:sambanova`、`:together`）。

  当你选择 **:cheapest** 或 **:fastest** 时（例如在新手引导的模型下拉菜单中），提供商会被锁定：路由器会按成本或速度决定，不会显示可选的“偏好特定后端”步骤。你可以将这些作为单独条目添加到 `models.providers.huggingface.models` 中，或为 `model.primary` 设置带后缀的值。你也可以在 [Inference Provider settings](https://hf.co/settings/inference-providers) 中设置默认顺序（无后缀 = 使用该顺序）。

- **配置合并：** 当配置被合并时，`models.providers.huggingface.models` 中已有的条目（例如在 `models.json` 中）会被保留。因此，你在其中设置的任何自定义 `name`、`alias` 或模型选项都会保留。

## 模型 ID 和配置示例

模型引用使用 `huggingface/<org>/<model>` 形式（Hub 风格 ID）。下面的列表来自 **GET** `https://router.huggingface.co/v1/models`；你的目录中可能包含更多内容。

**示例 ID（来自 inference 端点）：**

| 模型                   | 引用（加上 `huggingface/` 前缀）    |
| ---------------------- | ----------------------------------- |
| DeepSeek R1            | `deepseek-ai/DeepSeek-R1`           |
| DeepSeek V3.2          | `deepseek-ai/DeepSeek-V3.2`         |
| Qwen3 8B               | `Qwen/Qwen3-8B`                     |
| Qwen2.5 7B Instruct    | `Qwen/Qwen2.5-7B-Instruct`          |
| Qwen3 32B              | `Qwen/Qwen3-32B`                    |
| Llama 3.3 70B Instruct | `meta-llama/Llama-3.3-70B-Instruct` |
| Llama 3.1 8B Instruct  | `meta-llama/Llama-3.1-8B-Instruct`  |
| GPT-OSS 120B           | `openai/gpt-oss-120b`               |
| GLM 4.7                | `zai-org/GLM-4.7`                   |
| Kimi K2.5              | `moonshotai/Kimi-K2.5`              |

你可以在模型 id 后附加 `:fastest`、`:cheapest` 或 `:provider`（例如 `:together`、`:sambanova`）。请在 [Inference Provider settings](https://hf.co/settings/inference-providers) 中设置默认顺序；完整列表请参阅 [Inference Providers](https://huggingface.co/docs/inference-providers) 和 **GET** `https://router.huggingface.co/v1/models`。

### 完整配置示例

**以 DeepSeek R1 为主模型，Qwen 作为回退：**

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "huggingface/deepseek-ai/DeepSeek-R1",
        fallbacks: ["huggingface/Qwen/Qwen3-8B"],
      },
      models: {
        "huggingface/deepseek-ai/DeepSeek-R1": { alias: "DeepSeek R1" },
        "huggingface/Qwen/Qwen3-8B": { alias: "Qwen3 8B" },
      },
    },
  },
}
```

**以 Qwen 为默认模型，并包含 `:cheapest` 和 `:fastest` 变体：**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/Qwen/Qwen3-8B" },
      models: {
        "huggingface/Qwen/Qwen3-8B": { alias: "Qwen3 8B" },
        "huggingface/Qwen/Qwen3-8B:cheapest": { alias: "Qwen3 8B（最便宜）" },
        "huggingface/Qwen/Qwen3-8B:fastest": { alias: "Qwen3 8B（最快）" },
      },
    },
  },
}
```

**带有别名的 DeepSeek + Llama + GPT-OSS：**

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "huggingface/deepseek-ai/DeepSeek-V3.2",
        fallbacks: [
          "huggingface/meta-llama/Llama-3.3-70B-Instruct",
          "huggingface/openai/gpt-oss-120b",
        ],
      },
      models: {
        "huggingface/deepseek-ai/DeepSeek-V3.2": { alias: "DeepSeek V3.2" },
        "huggingface/meta-llama/Llama-3.3-70B-Instruct": { alias: "Llama 3.3 70B" },
        "huggingface/openai/gpt-oss-120b": { alias: "GPT-OSS 120B" },
      },
    },
  },
}
```

**使用 `:provider` 强制指定特定后端：**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/deepseek-ai/DeepSeek-R1:together" },
      models: {
        "huggingface/deepseek-ai/DeepSeek-R1:together": { alias: "DeepSeek R1 (Together)" },
      },
    },
  },
}
```

**多个 Qwen 和 DeepSeek 模型，带策略后缀：**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/Qwen/Qwen2.5-7B-Instruct:cheapest" },
      models: {
        "huggingface/Qwen/Qwen2.5-7B-Instruct": { alias: "Qwen2.5 7B" },
        "huggingface/Qwen/Qwen2.5-7B-Instruct:cheapest": { alias: "Qwen2.5 7B（便宜）" },
        "huggingface/deepseek-ai/DeepSeek-R1:fastest": { alias: "DeepSeek R1（快速）" },
        "huggingface/meta-llama/Llama-3.1-8B-Instruct": { alias: "Llama 3.1 8B" },
      },
    },
  },
}
```
