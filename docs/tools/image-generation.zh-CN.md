---
summary: "使用配置的提供者（OpenAI、Google Gemini、fal、MiniMax、ComfyUI、Vydra）生成和编辑图像"
read_when:
  - 通过代理生成图像
  - 配置图像生成提供者和模型
  - 了解 image_generate 工具参数
title: "图像生成"
---

# 图像生成

`image_generate` 工具允许代理使用你配置的提供者创建和编辑图像。生成的图像会自动作为媒体附件在代理的回复中传递。

<Note>
只有当至少有一个图像生成提供者可用时，该工具才会出现。如果你在代理的工具中没有看到 `image_generate`，请配置 `agents.defaults.imageGenerationModel` 或设置提供者 API 密钥。
</Note>

## 快速开始

1. 为至少一个提供者设置 API 密钥（例如 `OPENAI_API_KEY` 或 `GEMINI_API_KEY`）。
2. 可选地设置你首选的模型：

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "openai/gpt-image-1",
      },
    },
  },
}
```

3. 询问代理：_"生成一个友好的龙虾吉祥物图像。"_

代理会自动调用 `image_generate`。不需要工具允许列表 — 当提供者可用时，它默认启用。

## 支持的提供者

| 提供者  | 默认模型                         | 编辑支持                   | API 密钥                                              |
| ------- | -------------------------------- | -------------------------- | ----------------------------------------------------- |
| OpenAI  | `gpt-image-1`                    | 是（最多 5 张图像）        | `OPENAI_API_KEY`                                      |
| Google  | `gemini-3.1-flash-image-preview` | 是                         | `GEMINI_API_KEY` 或 `GOOGLE_API_KEY`                  |
| fal     | `fal-ai/flux/dev`                | 是                         | `FAL_KEY`                                             |
| MiniMax | `image-01`                       | 是（主题参考）             | `MINIMAX_API_KEY` 或 MiniMax OAuth (`minimax-portal`) |
| ComfyUI | `workflow`                       | 是（1 张图像，工作流配置） | `COMFY_API_KEY` 或 `COMFY_CLOUD_API_KEY`（云）        |
| Vydra   | `grok-imagine`                   | 否                         | `VYDRA_API_KEY`                                       |

使用 `action: "list"` 在运行时检查可用的提供者和模型：

```
/tool image_generate action=list
```

## 工具参数

| 参数          | 类型     | 描述                                                                            |
| ------------- | -------- | ------------------------------------------------------------------------------- |
| `prompt`      | string   | 图像生成提示（`action: "generate"` 必需）                                       |
| `action`      | string   | `"generate"`（默认）或 `"list"` 检查提供者                                      |
| `model`       | string   | 提供者/模型覆盖，例如 `openai/gpt-image-1`                                      |
| `image`       | string   | 编辑模式的单个参考图像路径或 URL                                                |
| `images`      | string[] | 编辑模式的多个参考图像（最多 5 个）                                             |
| `size`        | string   | 尺寸提示：`1024x1024`、`1536x1024`、`1024x1536`、`1024x1792`、`1792x1024`       |
| `aspectRatio` | string   | 宽高比：`1:1`、`2:3`、`3:2`、`3:4`、`4:3`、`4:5`、`5:4`、`9:16`、`16:9`、`21:9` |
| `resolution`  | string   | 分辨率提示：`1K`、`2K` 或 `4K`                                                  |
| `count`       | number   | 要生成的图像数量（1–4）                                                         |
| `filename`    | string   | 输出文件名提示                                                                  |

并非所有提供者都支持所有参数。当回退提供者支持附近的几何选项而不是确切请求的选项时，OpenClaw 在提交前会映射到最接近的支持尺寸、宽高比或分辨率。真正不支持的覆盖仍会在工具结果中报告。

工具结果报告应用的设置。当 OpenClaw 在提供者回退期间重新映射几何时，返回的 `size`、`aspectRatio` 和 `resolution` 值反映实际发送的内容，`details.normalization` 捕获请求到应用的转换。

## 配置

### 模型选择

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "openai/gpt-image-1",
        fallbacks: ["google/gemini-3.1-flash-image-preview", "fal/fal-ai/flux/dev"],
      },
    },
  },
}
```

### 提供者选择顺序

生成图像时，OpenClaw 按以下顺序尝试提供者：

1. **工具调用中的 `model` 参数**（如果代理指定）
2. **配置中的 `imageGenerationModel.primary`**
3. **`imageGenerationModel.fallbacks`** 按顺序
4. **自动检测** — 仅使用基于认证的提供者默认值：
   - 当前默认提供者优先
   - 按提供者 ID 顺序的其余已注册图像生成提供者

如果提供者失败（认证错误、速率限制等），会自动尝试下一个候选者。如果全部失败，错误会包含每次尝试的详细信息。

注意：

- 自动检测是认证感知的。提供者默认值只有在
  OpenClaw 能够实际认证该提供者时才会进入候选列表。
- 自动检测默认启用。设置
  `agents.defaults.mediaGenerationAutoProviderFallback: false` 如果你希望图像
  生成仅使用显式的 `model`、`primary` 和 `fallbacks`
  条目。
- 使用 `action: "list"` 检查当前注册的提供者、它们的
  默认模型和认证环境变量提示。

### 图像编辑

OpenAI、Google、fal、MiniMax 和 ComfyUI 支持编辑参考图像。传递参考图像路径或 URL：

```
"生成这张照片的水彩版本" + image: "/path/to/photo.jpg"
```

OpenAI 和 Google 通过 `images` 参数支持最多 5 张参考图像。fal、MiniMax 和 ComfyUI 支持 1 张。

MiniMax 图像生成可通过两种捆绑的 MiniMax 认证路径获得：

- `minimax/image-01` 用于 API 密钥设置
- `minimax-portal/image-01` 用于 OAuth 设置

## 提供者功能

| 功能               | OpenAI              | Google              | fal             | MiniMax                  | ComfyUI                    | Vydra      |
| ------------------ | ------------------- | ------------------- | --------------- | ------------------------ | -------------------------- | ---------- |
| 生成               | 是（最多 4 张）     | 是（最多 4 张）     | 是（最多 4 张） | 是（最多 9 张）          | 是（工作流定义的输出）     | 是（1 张） |
| 编辑/参考          | 是（最多 5 张图像） | 是（最多 5 张图像） | 是（1 张图像）  | 是（1 张图像，主题参考） | 是（1 张图像，工作流配置） | 否         |
| 尺寸控制           | 是                  | 是                  | 是              | 否                       | 否                         | 否         |
| 宽高比             | 否                  | 是                  | 是（仅生成）    | 是                       | 否                         | 否         |
| 分辨率（1K/2K/4K） | 否                  | 是                  | 是              | 否                       | 否                         | 否         |

## 相关

- [工具概述](/tools) — 所有可用的代理工具
- [fal](/providers/fal) — fal 图像和视频提供者设置
- [ComfyUI](/providers/comfy) — 本地 ComfyUI 和 Comfy Cloud 工作流设置
- [Google (Gemini)](/providers/google) — Gemini 图像提供者设置
- [MiniMax](/providers/minimax) — MiniMax 图像提供者设置
- [OpenAI](/providers/openai) — OpenAI 图像提供者设置
- [Vydra](/providers/vydra) — Vydra 图像、视频和语音设置
- [配置参考](/gateway/configuration-reference#agent-defaults) — `imageGenerationModel` 配置
- [模型](/concepts/models) — 模型配置和故障转移
