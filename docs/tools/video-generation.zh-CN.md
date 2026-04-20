---
summary: "使用 14 个提供者后端从文本、图像或现有视频生成视频"
read_when:
  - 通过代理生成视频
  - 配置视频生成提供者和模型
  - 了解 video_generate 工具参数
title: "视频生成"
---

# 视频生成

OpenClaw 代理可以从文本提示、参考图像或现有视频生成视频。支持 14 个提供者后端，每个后端都有不同的模型选项、输入模式和功能集。代理会根据您的配置和可用的 API 密钥自动选择合适的提供者。

<Note>
只有当至少有一个视频生成提供者可用时，`video_generate` 工具才会出现。如果您在代理工具中没有看到它，请设置提供者 API 密钥或配置 `agents.defaults.videoGenerationModel`。
</Note>

OpenClaw 将视频生成视为三种运行时模式：

- `generate` 用于没有参考媒体的文本到视频请求
- `imageToVideo` 当请求包含一个或多个参考图像时
- `videoToVideo` 当请求包含一个或多个参考视频时

提供者可以支持这些模式的任何子集。该工具在提交前验证活动模式，并在 `action=list` 中报告支持的模式。

## 快速开始

1. 为任何支持的提供者设置 API 密钥：

```bash
export GEMINI_API_KEY="your-key"
```

2. 可选地固定默认模型：

```bash
openclaw config set agents.defaults.videoGenerationModel.primary "google/veo-3.1-fast-generate-preview"
```

3. 询问代理：

> 生成一个 5 秒的电影风格视频，内容是一只友好的龙虾在日落时冲浪。

代理会自动调用 `video_generate`。不需要工具允许列表。

## 生成视频时会发生什么

视频生成是异步的。当代理在会话中调用 `video_generate` 时：

1. OpenClaw 将请求提交给提供者，并立即返回一个任务 ID。
2. 提供者在后台处理作业（通常需要 30 秒到 5 分钟，取决于提供者和分辨率）。
3. 当视频准备就绪时，OpenClaw 会通过内部完成事件唤醒同一个会话。
4. 代理将完成的视频发布回原始对话。

当作业进行中时，同一会话中的重复 `video_generate` 调用会返回当前任务状态，而不是开始另一次生成。使用 `openclaw tasks list` 或 `openclaw tasks show <taskId>` 从 CLI 检查进度。

在会话支持的代理运行之外（例如，直接工具调用），该工具会回退到内联生成，并在同一回合中返回最终媒体路径。

### 任务生命周期

每个 `video_generate` 请求都会经历四个状态：

1. **queued** -- 任务创建，等待提供者接受。
2. **running** -- 提供者正在处理（通常需要 30 秒到 5 分钟，取决于提供者和分辨率）。
3. **succeeded** -- 视频准备就绪；代理唤醒并将其发布到对话。
4. **failed** -- 提供者错误或超时；代理唤醒并显示错误详情。

从 CLI 检查状态：

```bash
openclaw tasks list
openclaw tasks show <taskId>
openclaw tasks cancel <taskId>
```

重复预防：如果当前会话的视频任务已经处于 `queued` 或 `running` 状态，`video_generate` 会返回现有任务状态，而不是开始新的生成。使用 `action: "status"` 明确检查而不触发新的生成。

## 支持的提供者

| 提供者                | 默认模型                        | 文本 | 图像参考                                        | 视频参考       | API 密钥                                 |
| --------------------- | ------------------------------- | ---- | ----------------------------------------------- | -------------- | ---------------------------------------- |
| Alibaba               | `wan2.6-t2v`                    | 是   | 是（远程 URL）                                  | 是（远程 URL） | `MODELSTUDIO_API_KEY`                    |
| BytePlus (1.0)        | `seedance-1-0-pro-250528`       | 是   | 最多 2 张图像（仅 I2V 模型；第一帧 + 最后一帧） | 否             | `BYTEPLUS_API_KEY`                       |
| BytePlus Seedance 1.5 | `seedance-1-5-pro-251215`       | 是   | 最多 2 张图像（通过角色的第一帧 + 最后一帧）    | 否             | `BYTEPLUS_API_KEY`                       |
| BytePlus Seedance 2.0 | `dreamina-seedance-2-0-260128`  | 是   | 最多 9 张参考图像                               | 最多 3 个视频  | `BYTEPLUS_API_KEY`                       |
| ComfyUI               | `workflow`                      | 是   | 1 张图像                                        | 否             | `COMFY_API_KEY` 或 `COMFY_CLOUD_API_KEY` |
| fal                   | `fal-ai/minimax/video-01-live`  | 是   | 1 张图像                                        | 否             | `FAL_KEY`                                |
| Google                | `veo-3.1-fast-generate-preview` | 是   | 1 张图像                                        | 1 个视频       | `GEMINI_API_KEY`                         |
| MiniMax               | `MiniMax-Hailuo-2.3`            | 是   | 1 张图像                                        | 否             | `MINIMAX_API_KEY`                        |
| OpenAI                | `sora-2`                        | 是   | 1 张图像                                        | 1 个视频       | `OPENAI_API_KEY`                         |
| Qwen                  | `wan2.6-t2v`                    | 是   | 是（远程 URL）                                  | 是（远程 URL） | `QWEN_API_KEY`                           |
| Runway                | `gen4.5`                        | 是   | 1 张图像                                        | 1 个视频       | `RUNWAYML_API_SECRET`                    |
| Together              | `Wan-AI/Wan2.2-T2V-A14B`        | 是   | 1 张图像                                        | 否             | `TOGETHER_API_KEY`                       |
| Vydra                 | `veo3`                          | 是   | 1 张图像（`kling`）                             | 否             | `VYDRA_API_KEY`                          |
| xAI                   | `grok-imagine-video`            | 是   | 1 张图像                                        | 1 个视频       | `XAI_API_KEY`                            |

一些提供者接受额外或替代的 API 密钥环境变量。有关详细信息，请参阅各个[提供者页面](#related)。

运行 `video_generate action=list` 以在运行时检查可用的提供者、模型和运行时模式。

### 声明的能力矩阵

这是 `video_generate`、契约测试和共享实时扫描使用的显式模式契约。

| 提供者   | `generate` | `imageToVideo` | `videoToVideo` | 今天的共享实时通道                                                                                            |
| -------- | ---------- | -------------- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| Alibaba  | 是         | 是             | 是             | `generate`、`imageToVideo`；跳过 `videoToVideo`，因为此提供者需要远程 `http(s)` 视频 URL                      |
| BytePlus | 是         | 是             | 否             | `generate`、`imageToVideo`                                                                                    |
| ComfyUI  | 是         | 是             | 否             | 不在共享扫描中；特定于工作流的覆盖范围与 Comfy 测试一起存在                                                   |
| fal      | 是         | 是             | 否             | `generate`、`imageToVideo`                                                                                    |
| Google   | 是         | 是             | 是             | `generate`、`imageToVideo`；跳过共享 `videoToVideo`，因为当前基于缓冲区的 Gemini/Veo 扫描不接受该输入         |
| MiniMax  | 是         | 是             | 否             | `generate`、`imageToVideo`                                                                                    |
| OpenAI   | 是         | 是             | 是             | `generate`、`imageToVideo`；跳过共享 `videoToVideo`，因为此组织/输入路径目前需要提供者端的 inpaint/remix 访问 |
| Qwen     | 是         | 是             | 是             | `generate`、`imageToVideo`；跳过 `videoToVideo`，因为此提供者需要远程 `http(s)` 视频 URL                      |
| Runway   | 是         | 是             | 是             | `generate`、`imageToVideo`；`videoToVideo` 仅在选择的模型为 `runway/gen4_aleph` 时运行                        |
| Together | 是         | 是             | 否             | `generate`、`imageToVideo`                                                                                    |
| Vydra    | 是         | 是             | 否             | `generate`；跳过共享 `imageToVideo`，因为捆绑的 `veo3` 仅支持文本，而捆绑的 `kling` 需要远程图像 URL          |
| xAI      | 是         | 是             | 是             | `generate`、`imageToVideo`；跳过 `videoToVideo`，因为此提供者目前需要远程 MP4 URL                             |

## 工具参数

### 必需

| 参数     | 类型   | 描述                                                |
| -------- | ------ | --------------------------------------------------- |
| `prompt` | string | 要生成的视频的文本描述（`action: "generate"` 必需） |

### 内容输入

| 参数         | 类型     | 描述                                                                                             |
| ------------ | -------- | ------------------------------------------------------------------------------------------------ |
| `image`      | string   | 单个参考图像（路径或 URL）                                                                       |
| `images`     | string[] | 多个参考图像（最多 9 个）                                                                        |
| `imageRoles` | string[] | 与组合图像列表平行的可选每个位置角色提示。规范值：`first_frame`、`last_frame`、`reference_image` |
| `video`      | string   | 单个参考视频（路径或 URL）                                                                       |
| `videos`     | string[] | 多个参考视频（最多 4 个）                                                                        |
| `videoRoles` | string[] | 与组合视频列表平行的可选每个位置角色提示。规范值：`reference_video`                              |
| `audioRef`   | string   | 单个参考音频（路径或 URL）。当提供者支持音频输入时，用于例如背景音乐或语音参考                   |
| `audioRefs`  | string[] | 多个参考音频（最多 3 个）                                                                        |
| `audioRoles` | string[] | 与组合音频列表平行的可选每个位置角色提示。规范值：`reference_audio`                              |

角色提示按原样转发给提供者。规范值来自 `VideoGenerationAssetRole` 联合，但提供者可能接受额外的角色字符串。`*Roles` 数组的条目数不得超过相应参考列表的条目数；差一错误会以明确的错误失败。使用空字符串来保留插槽未设置。

### 样式控制

| 参数              | 类型    | 描述                                                                                  |
| ----------------- | ------- | ------------------------------------------------------------------------------------- |
| `aspectRatio`     | string  | `1:1`、`2:3`、`3:2`、`3:4`、`4:3`、`4:5`、`5:4`、`9:16`、`16:9`、`21:9` 或 `adaptive` |
| `resolution`      | string  | `480P`、`720P`、`768P` 或 `1080P`                                                     |
| `durationSeconds` | number  | 目标持续时间（秒）（四舍五入到最接近的提供者支持值）                                  |
| `size`            | string  | 当提供者支持时的大小提示                                                              |
| `audio`           | boolean | 当支持时在输出中启用生成的音频。与 `audioRef*`（输入）不同                            |
| `watermark`       | boolean | 当支持时切换提供者水印                                                                |

`adaptive` 是提供者特定的标记：它被按原样转发给在其能力中声明 `adaptive` 的提供者（例如，BytePlus Seedance 使用它从输入图像维度自动检测比例）。未声明它的提供者通过工具结果中的 `details.ignoredOverrides` 显示该值，以便可见丢弃。

### 高级

| 参数              | 类型   | 描述                                                                                                                                                                                                                                         |
| ----------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`          | string | `"generate"`（默认）、`"status"` 或 `"list"`                                                                                                                                                                                                 |
| `model`           | string | 提供者/模型覆盖（例如 `runway/gen4.5`）                                                                                                                                                                                                      |
| `filename`        | string | 输出文件名提示                                                                                                                                                                                                                               |
| `providerOptions` | object | 提供者特定选项作为 JSON 对象（例如 `{"seed": 42, "draft": true}`）。声明类型化架构的提供者验证键和类型；未知键或不匹配在回退期间跳过候选者。没有声明架构的提供者按原样接收选项。运行 `video_generate action=list` 以查看每个提供者接受的内容 |

并非所有提供者都支持所有参数。OpenClaw 已经将持续时间标准化为最接近的提供者支持值，并且在回退提供者暴露不同控制表面时，它还会重新映射转换后的几何提示，例如大小到宽高比。真正不支持的覆盖会在尽力而为的基础上被忽略，并在工具结果中报告为警告。硬能力限制（例如过多的参考输入）会在提交前失败。

工具结果报告应用的设置。当 OpenClaw 在提供者回退期间重新映射持续时间或几何时，返回的 `durationSeconds`、`size`、`aspectRatio` 和 `resolution` 值反映提交的内容，`details.normalization` 捕获请求到应用的转换。

参考输入还选择运行时模式：

- 无参考媒体：`generate`
- 任何图像参考：`imageToVideo`
- 任何视频参考：`videoToVideo`
- 参考音频输入不会改变解析的模式；它们应用于图像/视频参考选择的任何模式之上，并且仅适用于声明 `maxInputAudios` 的提供者

混合图像和视频参考不是稳定的共享能力表面。每次请求首选一种参考类型。

#### 回退和类型化选项

一些能力检查在回退层而不是工具边界应用，以便超过主要提供者限制的请求仍然可以在有能力的回退上运行：

- 如果活动候选者未声明 `maxInputAudios`（或声明为 `0`），当请求包含音频参考时，它会被跳过，并尝试下一个候选者。
- 如果活动候选者的 `maxDurationSeconds` 低于请求的 `durationSeconds` 且候选者未声明 `supportedDurationSeconds` 列表，则它会被跳过。
- 如果请求包含 `providerOptions` 且活动候选者明确声明了类型化的 `providerOptions` 架构，当提供的键不在架构中或值类型不匹配时，候选者会被跳过。尚未声明架构的提供者按原样接收选项（向后兼容的传递）。提供者可以通过声明空架构（`capabilities.providerOptions: {}`）明确选择退出所有提供者选项，这会导致与类型不匹配相同的跳过。

请求中的第一个跳过原因以 `warn` 级别记录，以便操作员看到他们的主要提供者何时被跳过；后续跳过以 `debug` 级别记录，以保持长回退链的安静。如果每个候选者都被跳过，聚合错误会包含每个的跳过原因。

## 操作

- **generate**（默认）-- 从给定的提示和可选的参考输入创建视频。
- **status** -- 检查当前会话的进行中视频任务的状态，而不开始另一次生成。
- **list** -- 显示可用的提供者、模型及其能力。

## 模型选择

生成视频时，OpenClaw 按以下顺序解析模型：

1. **`model` 工具参数** -- 如果代理在调用中指定了一个。
2. **`videoGenerationModel.primary`** -- 来自配置。
3. **`videoGenerationModel.fallbacks`** -- 按顺序尝试。
4. **自动检测** -- 使用具有有效身份验证的提供者，从当前默认提供者开始，然后按字母顺序排列其余提供者。

如果提供者失败，会自动尝试下一个候选者。如果所有候选者都失败，错误会包含每次尝试的详细信息。

如果您希望视频生成仅使用显式的 `model`、`primary` 和 `fallbacks` 条目，请设置 `agents.defaults.mediaGenerationAutoProviderFallback: false`。

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "google/veo-3.1-fast-generate-preview",
        fallbacks: ["runway/gen4.5", "qwen/wan2.6-t2v"],
      },
    },
  },
}
```

## 提供者说明

| 提供者                | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alibaba               | 使用 DashScope/Model Studio 异步端点。参考图像和视频必须是远程 `http(s)` URL。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| BytePlus (1.0)        | 提供者 ID `byteplus`。模型：`seedance-1-0-pro-250528`（默认）、`seedance-1-0-pro-t2v-250528`、`seedance-1-0-pro-fast-251015`、`seedance-1-0-lite-t2v-250428`、`seedance-1-0-lite-i2v-250428`。T2V 模型（`*-t2v-*`）不接受图像输入；I2V 模型和一般 `*-pro-*` 模型支持单个参考图像（第一帧）。按位置传递图像或设置 `role: "first_frame"`。当提供图像时，T2V 模型 ID 会自动切换到相应的 I2V 变体。支持的 `providerOptions` 键：`seed`（数字）、`draft`（布尔值，强制 480p）、`camera_fixed`（布尔值）。                                                                                                    |
| BytePlus Seedance 1.5 | 需要 [`@openclaw/byteplus-modelark`](https://www.npmjs.com/package/@openclaw/byteplus-modelark) 插件。提供者 ID `byteplus-seedance15`。模型：`seedance-1-5-pro-251215`。使用统一的 `content[]` API。最多支持 2 个输入图像（first_frame + last_frame）。所有输入必须是远程 `https://` URL。在每个图像上设置 `role: "first_frame"` / `"last_frame"`，或按位置传递图像。`aspectRatio: "adaptive"` 从输入图像自动检测比例。`audio: true` 映射到 `generate_audio`。`providerOptions.seed`（数字）被转发。                                                                                                    |
| BytePlus Seedance 2.0 | 需要 [`@openclaw/byteplus-modelark`](https://www.npmjs.com/package/@openclaw/byteplus-modelark) 插件。提供者 ID `byteplus-seedance2`。模型：`dreamina-seedance-2-0-260128`、`dreamina-seedance-2-0-fast-260128`。使用统一的 `content[]` API。支持最多 9 个参考图像、3 个参考视频和 3 个参考音频。所有输入必须是远程 `https://` URL。在每个资产上设置 `role` — 支持的值：`"first_frame"`、`"last_frame"`、`"reference_image"`、`"reference_video"`、`"reference_audio"`。`aspectRatio: "adaptive"` 从输入图像自动检测比例。`audio: true` 映射到 `generate_audio`。`providerOptions.seed`（数字）被转发。 |
| ComfyUI               | 工作流驱动的本地或云执行。通过配置的图支持文本到视频和图像到视频。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| fal                   | 对长时间运行的作业使用队列支持的流程。仅支持单个图像参考。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Google                | 使用 Gemini/Veo。支持一个图像或一个视频参考。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| MiniMax               | 仅支持单个图像参考。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| OpenAI                | 仅转发 `size` 覆盖。其他样式覆盖（`aspectRatio`、`resolution`、`audio`、`watermark`）被忽略并显示警告。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Qwen                  | 与 Alibaba 使用相同的 DashScope 后端。参考输入必须是远程 `http(s)` URL；本地文件会在前端被拒绝。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Runway                | 通过数据 URI 支持本地文件。视频到视频需要 `runway/gen4_aleph`。纯文本运行暴露 `16:9` 和 `9:16` 宽高比。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Together              | 仅支持单个图像参考。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Vydra                 | 直接使用 `https://www.vydra.ai/api/v1` 以避免身份验证丢弃重定向。`veo3` 捆绑为仅文本到视频；`kling` 需要远程图像 URL。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| xAI                   | 支持文本到视频、图像到视频和远程视频编辑/扩展流程。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 提供者能力模式

共享视频生成契约现在允许提供者声明特定于模式的能力，而不仅仅是扁平的聚合限制。新的提供者实现应首选显式模式块：

```typescript
capabilities: {
  generate: {
    maxVideos: 1,
    maxDurationSeconds: 10,
    supportsResolution: true,
  },
  imageToVideo: {
    enabled: true,
    maxVideos: 1,
    maxInputImages: 1,
    maxDurationSeconds: 5,
  },
  videoToVideo: {
    enabled: true,
    maxVideos: 1,
    maxInputVideos: 1,
    maxDurationSeconds: 5,
  },
}
```

扁平聚合字段如 `maxInputImages` 和 `maxInputVideos` 不足以宣传转换模式支持。提供者应明确声明 `generate`、`imageToVideo` 和 `videoToVideo`，以便实时测试、契约测试和共享的 `video_generate` 工具可以确定性地验证模式支持。

## 实时测试

共享捆绑提供者的选择性加入实时覆盖：

```bash
OPENCLAW_LIVE_TEST=1 pnpm test:live -- extensions/video-generation-providers.live.test.ts
```

仓库包装器：

```bash
pnpm test:live:media video
```

此实时文件从 `~/.profile` 加载缺失的提供者环境变量，默认情况下优先选择 live/env API 密钥而不是存储的身份验证配置文件，并默认运行发布安全的冒烟测试：

- 扫描中每个非 FAL 提供者的 `generate`
- 一秒钟的龙虾提示
- 来自 `OPENCLAW_LIVE_VIDEO_GENERATION_TIMEOUT_MS` 的每个提供者操作上限（默认为 `180000`）

FAL 是选择性加入的，因为提供者端队列延迟可能会主导发布时间：

```bash
pnpm test:live:media video --video-providers fal
```

设置 `OPENCLAW_LIVE_VIDEO_GENERATION_FULL_MODES=1` 以运行共享扫描可以使用本地媒体安全执行的已声明转换模式：

- 当 `capabilities.imageToVideo.enabled` 时的 `imageToVideo`
- 当 `capabilities.videoToVideo.enabled` 且提供者/模型在共享扫描中接受基于缓冲区的本地视频输入时的 `videoToVideo`

今天共享的 `videoToVideo` 实时通道覆盖：

- 仅当您选择 `runway/gen4_aleph` 时的 `runway`

## 配置

在 OpenClaw 配置中设置默认视频生成模型：

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "qwen/wan2.6-t2v",
        fallbacks: ["qwen/wan2.6-r2v-flash"],
      },
    },
  },
}
```

或通过 CLI：

```bash
openclaw config set agents.defaults.videoGenerationModel.primary "qwen/wan2.6-t2v"
```

<a id="related"></a>

## 相关

- [工具概述](/tools)
- [后台任务](/automation/tasks) -- 异步视频生成的任务跟踪
- [Alibaba Model Studio](/providers/alibaba)
- [BytePlus](/concepts/model-providers#byteplus-international)
- [ComfyUI](/providers/comfy)
- [fal](/providers/fal)
- [Google (Gemini)](/providers/google)
- [MiniMax](/providers/minimax)
- [OpenAI](/providers/openai)
- [Qwen](/providers/qwen)
- [Runway](/providers/runway)
- [Together AI](/providers/together)
- [Vydra](/providers/vydra)
- [xAI](/providers/xai)
- [配置参考](/gateway/configuration-reference#agent-defaults)
- [模型](/concepts/models)
