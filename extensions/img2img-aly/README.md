# Img2Img Aly

Demo OpenClaw plugin that provides `img2img_aly` tool for Aliyun qwen-image-edit.

You must set `apiKey` and `baseUrl` in plugin config. Plugin config takes precedence over env vars.

## Tool contract

- Tool name: `img2img_aly`
- Input fields: `model`, `input_`, optional `parameters`
- `input_.messages[0].content` must include 1-3 image items and exactly 1 text item
- image supports public URL, OSS URL, or base64 `data:image/...`
- `parameters` can be an object or a JSON string that parses to an object
- currently runtime enforces `model` as `qwen-image-edit-max`

## Development

```bash
pnpm test extensions/img2img-aly/index.test.ts
```
