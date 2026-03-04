# Img2Txt Aly

Demo OpenClaw plugin that provides `img2txt_aly` tool for Aliyun multimodal understanding.

You must set `apiKey` and `baseUrl` in plugin config. Plugin config takes precedence over env vars.

## Tool contract

- Tool name: `img2txt_aly`
- Input fields: `model`, `input_`
- `model` only supports `qwen-vl-max-latest`
- `input_.prompt` is the analysis instruction
- `input_.image` supports public URL / OSS URL / Base64 `data:image/...`

## Development

```bash
pnpm test extensions/img2txt-aly/index.test.ts
```
