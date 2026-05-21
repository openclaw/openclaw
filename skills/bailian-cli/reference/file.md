# `bl file` commands

> Auto-generated from `packages/cli/src/commands/catalog.ts`. Do not edit by hand.
> Regenerate: `pnpm --filter bailian-cli run generate:reference` (runs automatically on `build`).

Index: [index.md](index.md)

## Commands in this group

| Command | Description |
| --- | --- |
| `bl file upload` | Upload a local file to DashScope temporary storage (48h) |

## Command details

### `bl file upload`

| Field | Value |
| --- | --- |
| **Name** | `file upload` |
| **Description** | Upload a local file to DashScope temporary storage (48h) |
| **Usage** | `bl file upload --file <path> --model <model>` |
| **API docs** | [/developer-reference/get-temporary-file-url](https://help.aliyun.com/zh/model-studio/developer-reference/get-temporary-file-url) |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--file <path>` | string | yes | Local file to upload (image, video, audio) |
| `--model <model>` | string | yes | Target model name (file is bound to this model) |

#### Examples

```bash
bl file upload --file photo.jpg --model qwen-vl-max
```

```bash
bl file upload --file video.mp4 --model wan2.1-t2v-plus
```

```bash
bl file upload --file audio.wav --model qwen3-asr-flash
```

```bash
bl file upload --file cat.png --model qwen-image-2.0
```
