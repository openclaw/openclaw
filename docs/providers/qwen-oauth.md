---
summary: "Use the Qwen Portal provider id with OpenClaw"
read_when:
  - You want to configure the qwen-oauth provider id
  - You previously used Qwen Portal OAuth credentials
  - You need the Qwen Portal endpoint or migration guidance
title: "Qwen OAuth / Portal"
---

`qwen-oauth` is the Qwen Portal provider id. It targets the Qwen Portal endpoint
and keeps older Qwen OAuth / portal setups addressable through a distinct
provider id.

For new Qwen Cloud setups, prefer [Qwen](/providers/qwen) with the Standard
ModelStudio endpoint unless you specifically have a current Qwen Portal token.

## Setup

Provide your portal token through onboarding:

```bash
openclaw onboard --auth-choice qwen-oauth
```

Or set:

```bash
export QWEN_API_KEY="<your-qwen-portal-token>" # pragma: allowlist secret
```

## Defaults

- Provider: `qwen-oauth`
- Aliases: `qwen-portal`, `qwen-cli`
- Base URL: `https://portal.qwen.ai/v1`
- Env var: `QWEN_API_KEY`
- API style: OpenAI-compatible
- Default model: `qwen-oauth/qwen3.5-plus`

## Models

The bundled catalog seeds the Qwen Portal default:

- `qwen-oauth/qwen3.5-plus`

Availability depends on the current Qwen Portal account and token. If your
account uses ModelStudio / DashScope API keys instead, configure the canonical
`qwen` provider:

```bash
openclaw onboard --auth-choice qwen-standard-api-key
openclaw models set qwen/qwen3-coder-plus
```

## Migration

Legacy Qwen Portal OAuth profiles may not be refreshable. If a portal profile
stops working, re-authenticate with a current token or switch to the Standard
Qwen provider:

```bash
openclaw onboard --auth-choice qwen-standard-api-key
```

Standard global ModelStudio uses:

```text
https://dashscope-intl.aliyuncs.com/compatible-mode/v1
```

## Related

- [Qwen](/providers/qwen)
- [Alibaba Model Studio](/providers/alibaba)
- [Model providers](/concepts/model-providers)
- [All providers](/providers/index)
