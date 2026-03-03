# Txt2Img Aly 1

Demo OpenClaw plugin that provides `txt2img_aly` tool for Aliyun qwen-image-max.

## Required env

- `OPENCLAW_ALY_API_KEY`
- `OPENCLAW_ALY_BASE_URL` (optional, defaults to DashScope image endpoint)

You can also set `apiKey` and `baseUrl` in plugin config. Plugin config takes precedence over env vars.

## Tool contract

- Tool name: `txt2img_aly`
- Input fields: `model`, `input_`, optional `parameters`
- `parameters` can be an object or a JSON string that parses to an object
- `model` only supports `qwen-image-max`
- `input_.messages` supports single-round user message only

## Development

```bash
pnpm test extensions/erlock/txt2img-aly-1/index.test.ts
```
