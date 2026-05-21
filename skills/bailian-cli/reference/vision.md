# `bl vision` commands

> Auto-generated from `packages/cli/src/commands/catalog.ts`. Do not edit by hand.
> Regenerate: `pnpm --filter bailian-cli run generate:reference` (runs automatically on `build`).

Index: [index.md](index.md)

## Commands in this group

| Command | Description |
| --- | --- |
| `bl vision describe` | Describe an image or video using Qwen-VL |

## Command details

### `bl vision describe`

| Field | Value |
| --- | --- |
| **Name** | `vision describe` |
| **Description** | Describe an image or video using Qwen-VL |
| **Usage** | `bl vision describe --image <path-or-url> [--video <url>] [--prompt <text>]` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--image <path-or-url>` | string | no | Local image path or URL |
| `--video <url>` | array | no | Video file URL or local path (mp4/mov/avi/mkv/webm) |
| `--prompt <text>` | string | no | Question about the content (default: auto-detected) |
| `--model <model>` | string | no | Vision model (default: qwen-vl-max) |

#### Examples

```bash
bl vision describe --image photo.jpg
```

```bash
bl vision describe --image https://example.com/photo.jpg --prompt "这只狗是什么品种？"
```

```bash
bl vision describe --video https://example.com/video.mp4 --prompt "总结视频内容"
```

```bash
bl vision describe --video ./local-video.mp4
```

```bash
bl vision describe --image photo.png --prompt "Extract the text" --model qwen-vl-plus
```
