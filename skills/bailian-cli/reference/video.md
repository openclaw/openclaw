# `bl video` commands

> Auto-generated from `packages/cli/src/commands/catalog.ts`. Do not edit by hand.
> Regenerate: `pnpm --filter bailian-cli run generate:reference` (runs automatically on `build`).

Index: [index.md](index.md)

## Commands in this group

| Command | Description |
| --- | --- |
| `bl video download` | Download a completed video by task ID |
| `bl video edit` | Edit a video with happyhorse-1.0-video-edit (style transfer, object replacement, etc.) |
| `bl video generate` | Generate a video from text or image (happyhorse-1.0-t2v / happyhorse-1.0-i2v / wan2.6-t2v) |
| `bl video ref` | Reference-to-video generation (happyhorse-1.0-r2v / wan2.6-r2v): multi-subject, multi-shot with voice |
| `bl video task get` | Query async task status |

## Command details

### `bl video download`

| Field | Value |
| --- | --- |
| **Name** | `video download` |
| **Description** | Download a completed video by task ID |
| **Usage** | `bl video download --task-id <id> --out <path>` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--task-id <id>` | string | no | Task ID to download from |
| `--out <path>` | string | no | Output file path |

#### Examples

```bash
bl video download --task-id 3b256896-xxxx --out video.mp4
```

```bash
bl video download --task-id 3b256896-xxxx --out video.mp4 --quiet
```

### `bl video edit`

| Field | Value |
| --- | --- |
| **Name** | `video edit` |
| **Description** | Edit a video with happyhorse-1.0-video-edit (style transfer, object replacement, etc.) |
| **Usage** | `bl video edit --video <url> --prompt <text> [flags]` |
| **API docs** | [/best-practice/wanx/video-edit](https://help.aliyun.com/zh/model-studio/best-practice/wanx/video-edit) |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--model <model>` | string | no | Model ID (default: happyhorse-1.0-video-edit) |
| `--video <url>` | string | yes | Input video URL or local file (mp4/mov, 2-10s) |
| `--prompt <text>` | string | no | Edit instruction (e.g. "将画面转换为黏土风格") |
| `--ref-image <url>` | string | no | Reference image URL (up to 4, comma-separated) |
| `--negative-prompt <text>` | string | no | Negative prompt to exclude unwanted content |
| `--resolution <res>` | string | no | Resolution: 720P or 1080P (default: 1080P) |
| `--ratio <ratio>` | string | no | Aspect ratio (16:9, 9:16, 1:1, 4:3, 3:4) |
| `--duration <seconds>` | number | no | Output video duration in seconds (2-10) |
| `--audio-setting <mode>` | string | no | Audio: auto (default) or origin (keep original) |
| `--prompt-extend` | boolean | no | Enable prompt intelligent rewriting (default: true) |
| `--no-prompt-extend` | boolean | no | Disable prompt intelligent rewriting |
| `--watermark` | boolean | no | Add "AI生成" watermark |
| `--seed <n>` | number | no | Random seed for reproducible generation |
| `--download <path>` | string | no | Save video to file on completion |
| `--no-wait` | boolean | no | Return task ID immediately without waiting |
| `--async` | boolean | no | Return task ID immediately (agent/CI mode, same as --no-wait) |
| `--poll-interval <seconds>` | number | no | Polling interval when waiting (default: 15) |

#### Examples

```bash
bl video edit --video https://example.com/input.mp4 --prompt "将整个画面转换为黏土风格"
```

```bash
bl video edit --video https://example.com/input.mp4 --prompt "替换衣服为图片中的款式" --ref-image https://example.com/clothes.png
```

```bash
bl video edit --video https://example.com/input.mp4 --prompt "Convert to anime style" --resolution 720P --download output.mp4
```

### `bl video generate`

| Field | Value |
| --- | --- |
| **Name** | `video generate` |
| **Description** | Generate a video from text or image (happyhorse-1.0-t2v / happyhorse-1.0-i2v / wan2.6-t2v) |
| **Usage** | `bl video generate --prompt <text> [--image <url>] [flags]` |
| **API docs** | [/best-practice/wanx/text-to-video](https://help.aliyun.com/zh/model-studio/best-practice/wanx/text-to-video) |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--model <model>` | string | no | Model ID (default: happyhorse-1.0-t2v, or happyhorse-1.0-i2v with --image) |
| `--prompt <text>` | string | yes | Video description |
| `--image <url>` | string | no | Input image URL for image-to-video generation |
| `--negative-prompt <text>` | string | no | Negative prompt to exclude unwanted content |
| `--resolution <res>` | string | no | Resolution (e.g. 1280*720, 960*960) |
| `--ratio <ratio>` | string | no | Aspect ratio (e.g. 16:9, 1:1) |
| `--duration <seconds>` | number | no | Video duration in seconds (default: 5) |
| `--prompt-extend` | boolean | no | Automatically extend prompt for better results |
| `--watermark` | boolean | no | Add watermark to generated video |
| `--seed <n>` | number | no | Random seed for reproducible generation |
| `--download <path>` | string | no | Save video to file on completion |
| `--no-wait` | boolean | no | Return task ID immediately without waiting |
| `--async` | boolean | no | Return task ID immediately (agent/CI mode, same as --no-wait) |
| `--poll-interval <seconds>` | number | no | Polling interval when waiting (default: 5) |

#### Examples

```bash
bl video generate --prompt "一个人在读书，静态镜头"
```

```bash
bl video generate --prompt "Ocean waves at sunset." --download sunset.mp4
```

```bash
bl video generate --image https://example.com/cat.png --prompt "让画面中的猫动起来"
```

```bash
bl video generate --prompt "Mountain landscape" --resolution 1280*720 --duration 5
```

### `bl video ref`

| Field | Value |
| --- | --- |
| **Name** | `video ref` |
| **Description** | Reference-to-video generation (happyhorse-1.0-r2v / wan2.6-r2v): multi-subject, multi-shot with voice |
| **Usage** | `bl video ref --prompt <text> --image <url>... [--ref-video <url>...] [flags]` |
| **API docs** | [/best-practice/wanx/video-reference](https://help.aliyun.com/zh/model-studio/best-practice/wanx/video-reference) |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--model <model>` | string | no | Model ID (default: happyhorse-1.0-r2v) |
| `--prompt <text>` | string | yes | Video description with reference markers (图1, 视频1, etc.) |
| `--image <url>` | array | no | Reference image URL or local file (repeatable for multiple subjects) |
| `--ref-video <url>` | array | no | Reference video URL or local file (repeatable) |
| `--image-voice <url>` | array | no | Voice URL for corresponding image (pairs by position) |
| `--video-voice <url>` | array | no | Voice URL for corresponding ref-video (pairs by position) |
| `--resolution <res>` | string | no | Resolution: 720P or 1080P (default: 720P) |
| `--ratio <ratio>` | string | no | Aspect ratio (16:9, 9:16, 1:1) |
| `--duration <seconds>` | number | no | Video duration in seconds (2-10, default: 5) |
| `--prompt-extend` | boolean | no | Enable prompt intelligent rewriting |
| `--no-prompt-extend` | boolean | no | Disable prompt intelligent rewriting |
| `--watermark` | boolean | no | Add watermark to generated video |
| `--seed <n>` | number | no | Random seed for reproducible generation |
| `--download <path>` | string | no | Save video to file on completion |
| `--no-wait` | boolean | no | Return task ID immediately without waiting |
| `--async` | boolean | no | Return task ID immediately (agent/CI mode, same as --no-wait) |
| `--poll-interval <seconds>` | number | no | Polling interval when waiting (default: 15) |

#### Examples

```bash
bl video ref --prompt "图1在草地上奔跑" --image person.jpg
```

```bash
bl video ref --prompt "视频1在弹吉他，图1走过来" --ref-video scene.mp4 --image person.jpg
```

```bash
bl video ref --prompt "图1说话" --image person.jpg --image-voice voice.mp3 --resolution 1080P
```

```bash
bl video ref --prompt "图1和图2在对话" --image a.jpg --image b.jpg --image-voice va.mp3 --image-voice vb.mp3
```

### `bl video task get`

| Field | Value |
| --- | --- |
| **Name** | `video task get` |
| **Description** | Query async task status |
| **Usage** | `bl video task get --task-id <id>` |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--task-id <id>` | string | no | Async task ID |

#### Examples

```bash
bl video task get --task-id 3b256896-3e70-xxxx-xxxx-xxxxxxxxxxxx
```

```bash
bl video task get --task-id 3b256896-3e70-xxxx --output json
```
