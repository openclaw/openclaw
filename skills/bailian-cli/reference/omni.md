# `bl omni` commands

> Auto-generated from `packages/cli/src/commands/catalog.ts`. Do not edit by hand.
> Regenerate: `pnpm --filter bailian-cli run generate:reference` (runs automatically on `build`).

Index: [index.md](index.md)

## Commands in this group

| Command | Description |
| --- | --- |
| `bl omni` | Multimodal chat with text + audio output (Qwen-Omni) |

## Command details

### `bl omni`

| Field | Value |
| --- | --- |
| **Name** | `omni` |
| **Description** | Multimodal chat with text + audio output (Qwen-Omni) |
| **Usage** | `bl omni --message <text> [flags]` |
| **API docs** | [/model-studio/qwen-omni](https://help.aliyun.com/zh/model-studio/model-studio/qwen-omni) |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--message <text>` | array | yes | Message text (repeatable, prefix role: to set role) |
| `--model <model>` | string | no | Model ID (default: qwen3.5-omni-plus) |
| `--system <text>` | string | no | System prompt |
| `--image <url>` | array | no | Image URL or local file (repeatable) |
| `--audio <url>` | array | no | Audio URL or local file (repeatable) |
| `--video <url>` | array | no | Video file URL / local path, or comma-separated frame URLs |
| `--voice <voice>` | string | no | Output voice (default: Cherry). Options: Chelsie, Cherry, Ethan, Serena, Tina |
| `--audio-format <fmt>` | string | no | Audio output format (default: wav) |
| `--audio-out <path>` | string | no | Save audio to file (default: auto-generate) |
| `--text-only` | boolean | no | Output text only, no audio generation |
| `--max-tokens <n>` | number | no | Maximum tokens to generate |
| `--temperature <n>` | number | no | Sampling temperature (0.0, 2.0] |

#### Examples

```bash
bl omni --message "你好，你是谁？"
```

```bash
bl omni --message "描述这张图片" --image ./photo.jpg
```

```bash
bl omni --message "这段音频在说什么？" --audio https://example.com/audio.wav
```

```bash
bl omni --message "总结这个视频" --video https://example.com/video.mp4
```

```bash
bl omni --message "这个视频讲了什么" --video ./local-video.mp4 --text-only
```

```bash
bl omni --message "用四川话回答：今天天气怎么样" --voice Serena
```

```bash
bl omni --message "Hello" --text-only --output json
```

```bash
bl omni --message "朗读这段话" --audio-out greeting.wav
```
