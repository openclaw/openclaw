# `bl image` commands

> Auto-generated from `packages/cli/src/commands/catalog.ts`. Do not edit by hand.
> Regenerate: `pnpm --filter bailian-cli run generate:reference` (runs automatically on `build`).

Index: [index.md](index.md)

## Commands in this group

| Command | Description |
| --- | --- |
| `bl image edit` | Edit an existing image with text instructions (Qwen-Image) |
| `bl image generate` | Generate images (Qwen-Image / wan2.x) |

## Command details

### `bl image edit`

| Field | Value |
| --- | --- |
| **Name** | `image edit` |
| **Description** | Edit an existing image with text instructions (Qwen-Image) |
| **Usage** | `bl image edit --image <url> --prompt <text> [flags]` |
| **API docs** | [/developer-reference/qwen-image-edit-api](https://help.aliyun.com/zh/model-studio/developer-reference/qwen-image-edit-api) |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--image <url>` | array | yes | Source image URL or local file path (repeatable for multi-image merge) |
| `--prompt <text>` | string | yes | Edit instruction text |
| `--model <model>` | string | no | Model ID (default: qwen-image-2.0) |
| `--size <W*H>` | string | no | Output image size: ratio (3:4, 16:9) or pixels (2048*2048) |
| `--n <count>` | number | no | Number of images (default: 1, max: 6) |
| `--seed <n>` | number | no | Random seed for reproducible results |
| `--negative-prompt <text>` | string | no | Negative prompt to exclude unwanted content |
| `--prompt-extend` | boolean | no | Enable prompt smart rewrite (default: true) |
| `--no-prompt-extend` | boolean | no | Disable prompt extend |
| `--watermark` | boolean | no | Add watermark to output images |
| `--out-dir <dir>` | string | no | Download images to directory |
| `--out-prefix <prefix>` | string | no | Filename prefix (default: edited) |

#### Examples

```bash
bl image edit --image ./photo.png --prompt "把背景换成海滩"
```

```bash
bl image edit --image https://example.com/logo.png --prompt "Change color to blue" --n 3
```

```bash
bl image edit --image ./a.png --image ./b.png --prompt "把两张图合并成一张拼图"
```

```bash
bl image edit --image https://example.com/photo.png --prompt "Remove the person" --model qwen-image-2.0-pro
```

### `bl image generate`

| Field | Value |
| --- | --- |
| **Name** | `image generate` |
| **Description** | Generate images (Qwen-Image / wan2.x) |
| **Usage** | `bl image generate --prompt <text> [flags]` |
| **API docs** | [/best-practice/wanx/text-to-image](https://help.aliyun.com/zh/model-studio/best-practice/wanx/text-to-image) |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--prompt <text>` | string | yes | Image description |
| `--model <model>` | string | no | Model ID (default: qwen-image-2.0) |
| `--size <W*H>` | string | no | Image size: ratio (3:4, 16:9, 1:1) or pixels (2048*2048) |
| `--n <count>` | number | no | Number of images per request (default: 1, max: 6) |
| `--seed <n>` | number | no | Random seed for reproducible generation |
| `--negative-prompt <text>` | string | no | Negative prompt to exclude unwanted content |
| `--prompt-extend` | boolean | no | Automatically extend prompt for better results (default: true for qwen-image) |
| `--no-prompt-extend` | boolean | no | Disable prompt extend |
| `--watermark` | boolean | no | Add watermark to generated images |
| `--no-wait` | boolean | no | Return task ID immediately without waiting (async models only) |
| `--out-dir <dir>` | string | no | Download images to directory |
| `--out-prefix <prefix>` | string | no | Filename prefix (default: image) |
| `--poll-interval <seconds>` | number | no | Polling interval when waiting (default: 3) |

#### Examples

```bash
bl image generate --prompt "一只穿太空服的猫在火星上"
```

```bash
bl image generate --prompt "Logo design" --n 3 --out-dir ./generated/
```

```bash
bl image generate --prompt "Mountain landscape" --size 2688*1536
```

```bash
bl image generate --prompt "A castle" --seed 42 --no-prompt-extend
```

```bash
bl image generate --prompt "sunset" --model wan2.6-t2i --no-wait --quiet
```

```bash
bl image generate --prompt "Pro quality" --model qwen-image-2.0-pro
```

```bash
bl image generate --prompt "Product shots" --n 2 --concurrent 3  # 6 images in parallel
```
