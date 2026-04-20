---
summary: "使用共享提供者生成音乐，包括工作流支持的插件"
read_when:
  - 通过代理生成音乐或音频
  - 配置音乐生成提供者和模型
  - 理解 music_generate 工具参数
title: "音乐生成"
---

# 音乐生成

`music_generate` 工具允许代理通过与配置的提供者（如 Google、MiniMax 和工作流配置的 ComfyUI）共享的音乐生成功能创建音乐或音频。

对于共享提供者支持的代理会话，OpenClaw 将音乐生成为后台任务，在任务分类账中跟踪它，然后在曲目准备就绪时再次唤醒代理，以便代理可以将完成的音频发布回原始通道。

<Note>
内置共享工具仅在至少有一个音乐生成提供者可用时出现。如果在代理的工具中没有看到 `music_generate`，请配置 `agents.defaults.musicGenerationModel` 或设置提供者 API 密钥。
</Note>

## 快速入门

### 共享提供者支持的生成

1. 为至少一个提供者设置 API 密钥，例如 `GEMINI_API_KEY` 或 `MINIMAX_API_KEY`。
2. 可选地设置你首选的模型：

```json5
{
  agents: {
    defaults: {
      musicGenerationModel: {
        primary: "google/lyria-3-clip-preview",
      },
    },
  },
}
```

3. 询问代理：_"生成一首关于夜间驾驶穿过霓虹城市的 upbeat 合成流行曲目。"_

代理会自动调用 `music_generate`。不需要工具允许列表。

对于没有会话支持的代理运行的直接同步上下文，内置工具仍然回退到内联生成，并在工具结果中返回最终媒体路径。

示例提示：

```text
生成带有柔和弦乐且无 vocals 的电影钢琴曲目。
```

```text
生成一首关于在日出时发射火箭的充满活力的 chiptune 循环。
```

### 工作流驱动的 Comfy 生成

捆绑的 `comfy` 插件通过音乐生成提供者注册表插入到共享的 `music_generate` 工具中。

1. 使用工作流 JSON 和提示/输出节点配置 `models.providers.comfy.music`。
2. 如果你使用 Comfy Cloud，请设置 `COMFY_API_KEY` 或 `COMFY_CLOUD_API_KEY`。
3. 向代理请求音乐或直接调用工具。

示例：

```text
/tool music_generate prompt="Warm ambient synth loop with soft tape texture"
```

## 共享捆绑提供者支持

| 提供者 | 默认模型          | 参考输入 | 支持的控制                                        | API 密钥                                |
| -------- | ---------------------- | ---------------- | --------------------------------------------------------- | -------------------------------------- |
| ComfyUI  | `workflow`             | 最多 1 张图片    | 工作流定义的音乐或音频                           | `COMFY_API_KEY`, `COMFY_CLOUD_API_KEY` |
| Google   | `lyria-3-clip-preview` | 最多 10 张图片  | `lyrics`, `instrumental`, `format`                        | `GEMINI_API_KEY`, `GOOGLE_API_KEY`     |
| MiniMax  | `music-2.5+`           | 无             | `lyrics`, `instrumental`, `durationSeconds`, `format=mp3` | `MINIMAX_API_KEY`                      |

### 声明的能力矩阵

这是 `music_generate`、合同测试和共享实时扫描使用的显式模式合同。

| 提供者 | `generate` | `edit` | 编辑限制 | 共享实时通道                                                         |
| -------- | ---------- | ------ | ---------- | ------------------------------------------------------------------------- |
| ComfyUI  | 是        | 是    | 1 张图片    | 不在共享扫描中；由 `extensions/comfy/comfy.live.test.ts` 覆盖 |
| Google   | 是        | 是    | 10 张图片  | `generate`, `edit`                                                        |
| MiniMax  | 是        | 否     | 无       | `generate`                                                                |

使用 `action: "list"` 在运行时检查可用的共享提供者和模型：

```text
/tool music_generate action=list
```

使用 `action: "status"` 检查活动会话支持的音乐任务：

```text
/tool music_generate action=status
```

直接生成示例：

```text
/tool music_generate prompt="Dreamy lo-fi hip hop with vinyl texture and gentle rain" instrumental=true
```

## 内置工具参数

| 参数         | 类型     | 描述                                                                                       |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `prompt`          | 字符串   | 音乐生成提示（`action: "generate"` 必需）                                       |
| `action`          | 字符串   | `"generate"`（默认），`"status"` 用于当前会话任务，或 `"list"` 用于检查提供者 |
| `model`           | 字符串   | 提供者/模型覆盖，例如 `google/lyria-3-pro-preview` 或 `comfy/workflow`                    |
| `lyrics`          | 字符串   | 当提供者支持显式歌词输入时的可选歌词                                   |
| `instrumental`    | 布尔值  | 当提供者支持时请求仅器乐输出                                    |
| `image`           | 字符串   | 单个参考图片路径或 URL                                                                |
| `images`          | 字符串[] | 多个参考图片（最多 10 个）                                                              |
| `durationSeconds` | 数字   | 当提供者支持持续时间提示时的目标持续时间（秒）                              |
| `format`          | 字符串   | 当提供者支持时的输出格式提示（`mp3` 或 `wav`）                                 |
| `filename`        | 字符串   | 输出文件名提示                                                                              |

并非所有提供者都支持所有参数。OpenClaw 仍然在提交前验证硬限制，如输入计数。当提供者支持持续时间但使用比请求值更短的最大值时，OpenClaw 会自动限制为最接近的支持持续时间。当所选提供者或模型无法满足真正不支持的可选提示时，会忽略它们并发出警告。

工具结果报告应用的设置。当 OpenClaw 在提供者回退期间限制持续时间时，返回的 `durationSeconds` 反映提交的值，`details.normalization.durationSeconds` 显示请求到应用的映射。

## 共享提供者支持路径的异步行为

- 会话支持的代理运行：`music_generate` 创建后台任务，立即返回已启动/任务响应，并稍后在后续代理消息中发布完成的曲目。
- 重复预防：当该后台任务仍处于 `queued` 或 `running` 状态时，同一会话中后来的 `music_generate` 调用返回任务状态，而不是开始另一次生成。
- 状态查找：使用 `action: "status"` 检查活动会话支持的音乐任务，而不启动新任务。
- 任务跟踪：使用 `openclaw tasks list` 或 `openclaw tasks show <taskId>` 检查生成的排队、运行和终端状态。
- 完成唤醒：OpenClaw 将内部完成事件注入到同一会话中，以便模型可以自己编写面向用户的后续内容。
- 提示提示：当音乐任务已经在进行中时，同一会话中后来的用户/手动回合会获得小的运行时提示，以便模型不会盲目再次调用 `music_generate`。
- 无会话回退：没有真实代理会话的直接/本地上下文仍然内联运行，并在同一回合中返回最终音频结果。

### 任务生命周期

每个 `music_generate` 请求经历四个状态：

1. **queued** — 任务创建，等待提供者接受它。
2. **running** — 提供者正在处理（通常为 30 秒到 3 分钟，取决于提供者和持续时间）。
3. **succeeded** — 曲目准备就绪；代理唤醒并将其发布到会话中。
4. **failed** — 提供者错误或超时；代理唤醒并提供错误详情。

从 CLI 检查状态：

```bash
openclaw tasks list
openclaw tasks show <taskId>
openclaw tasks cancel <taskId>
```

重复预防：如果当前会话的音乐任务已经处于 `queued` 或 `running` 状态，`music_generate` 返回现有任务状态，而不是开始新任务。使用 `action: "status"` 明确检查而不触发新生成。

## 配置

### 模型选择

```json5
{
  agents: {
    defaults: {
      musicGenerationModel: {
        primary: "google/lyria-3-clip-preview",
        fallbacks: ["minimax/music-2.5+"],
      },
    },
  },
}
```

### 提供者选择顺序

生成音乐时，OpenClaw 按以下顺序尝试提供者：

1. 工具调用中的 `model` 参数（如果代理指定）
2. 配置中的 `musicGenerationModel.primary`
3. 顺序中的 `musicGenerationModel.fallbacks`
4. 仅使用基于认证的提供者默认值的自动检测：
   - 当前默认提供者优先
   - 按提供者 ID 顺序排列的其余注册音乐生成提供者

如果提供者失败，会自动尝试下一个候选者。如果所有都失败，错误将包含每次尝试的详情。

如果你希望音乐生成仅使用显式的 `model`、`primary` 和 `fallbacks` 条目，请设置 `agents.defaults.mediaGenerationAutoProviderFallback: false`。

## 提供者说明

- Google 使用 Lyria 3 批处理生成。当前捆绑流程支持提示、可选歌词文本和可选参考图片。
- MiniMax 使用批处理 `music_generation` 端点。当前捆绑流程支持提示、可选歌词、器乐模式、持续时间控制和 mp3 输出。
- ComfyUI 支持是工作流驱动的，取决于配置的图和提示/输出字段的节点映射。

## 提供者能力模式

共享音乐生成合同现在支持显式模式声明：

- `generate` 用于仅提示生成
- `edit` 当请求包含一个或多个参考图片时

新的提供者实现应首选显式模式块：

```typescript
capabilities: {
  generate: {
    maxTracks: 1,
    supportsLyrics: true,
    supportsFormat: true,
  },
  edit: {
    enabled: true,
    maxTracks: 1,
    maxInputImages: 1,
    supportsFormat: true,
  },
}
```

遗留的平面字段（如 `maxInputImages`、`supportsLyrics` 和 `supportsFormat`）不足以宣传编辑支持。提供者应明确声明 `generate` 和 `edit`，以便实时测试、合同测试和共享的 `music_generate` 工具可以确定性地验证模式支持。

## 选择正确的路径

- 当你想要模型选择、提供者故障转移和内置异步任务/状态流时，使用共享提供者支持的路径。
- 当你需要自定义工作流图或不属于共享捆绑音乐功能的提供者时，使用 ComfyUI 等插件路径。
- 如果你正在调试 ComfyUI 特定行为，请参阅 [ComfyUI](/providers/comfy)。如果你正在调试共享提供者行为，请从 [Google (Gemini)](/providers/google) 或 [MiniMax](/providers/minimax) 开始。

## 实时测试

共享捆绑提供者的可选实时覆盖：

```bash
OPENCLAW_LIVE_TEST=1 pnpm test:live -- extensions/music-generation-providers.live.test.ts
```

仓库包装器：

```bash
pnpm test:live:media music
```

此实时文件从 `~/.profile` 加载缺失的提供者环境变量，默认优先使用 live/env API 密钥而不是存储的认证配置文件，并在提供者启用编辑模式时运行 `generate` 和声明的 `edit` 覆盖。

今天这意味着：

- `google`：`generate` 加 `edit`
- `minimax`：仅 `generate`
- `comfy`：单独的 Comfy 实时覆盖，不是共享提供者扫描

捆绑 ComfyUI 音乐路径的可选实时覆盖：

```bash
OPENCLAW_LIVE_TEST=1 COMFY_LIVE_TEST=1 pnpm test:live -- extensions/comfy/comfy.live.test.ts
```

当配置这些部分时，Comfy 实时文件还覆盖 comfy 图像和视频工作流。

## 相关

- [后台任务](/automation/tasks) - 分离的 `music_generate` 运行的任务跟踪
- [配置参考](/gateway/configuration-reference#agent-defaults) - `musicGenerationModel` 配置
- [ComfyUI](/providers/comfy)
- [Google (Gemini)](/providers/google)
- [MiniMax](/providers/minimax)
- [模型](/concepts/models) - 模型配置和故障转移
- [工具概述](/tools)