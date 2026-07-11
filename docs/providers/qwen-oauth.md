---
summary: "Use the Qwen Portal provider id with OpenClaw"
read_when:
  - You want to configure the qwen-oauth provider id
  - You previously used Qwen Portal OAuth credentials
  - You need the Qwen Portal endpoint or migration guidance
title: "Qwen OAuth / Portal"
---

`qwen-oauth` is the Qwen Portal provider id, registered by the Qwen plugin
(`@openclaw/qwen-provider`). It targets the Qwen Portal endpoint at
`https://portal.qwen.ai/v1` and keeps older Qwen OAuth / portal setups
addressable through a distinct provider id, separate from the canonical `qwen`
provider.

Choose `qwen-oauth` if you already have a working Qwen Portal token, are
migrating a legacy Qwen OAuth or Qwen CLI workflow, or need to test the Qwen
Portal endpoint specifically. For new setups, prefer
[Qwen](/providers/qwen) with the Standard ModelStudio endpoint: it covers new
API-key setups, broader endpoint choices, Standard pay-as-you-go, Coding Plan,
and the full Qwen plugin catalog.

## Setup

Install the Qwen plugin if you have not already:

```bash
openclaw plugins install @openclaw/qwen-provider
openclaw gateway restart
```

Provide your portal token through onboarding:

```bash
openclaw onboard --auth-choice qwen-oauth
```

Non-interactive runs read the token from `--qwen-oauth-token <token>`, or set:

```bash
export QWEN_API_KEY="<your-qwen-portal-token>" # pragma: allowlist secret
```

Onboarding stores the token under a `qwen-oauth` auth profile, seeds the portal
model catalog, and sets `qwen-oauth/qwen3.5-plus` as the default model when
none is configured.

## Defaults

- Provider: `qwen-oauth`
- Aliases: `qwen-portal`, `qwen-cli`
- Base URL: `https://portal.qwen.ai/v1`
- Env var: `QWEN_API_KEY`
- API style: OpenAI-compatible
- Default model: `qwen-oauth/qwen3.5-plus`

## How this differs from Qwen

OpenClaw has two Qwen-facing provider ids:

| Provider     | Endpoint family                                          | Best for                                                                               |
| ------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `qwen`       | Qwen Cloud / Alibaba DashScope and Coding Plan endpoints | New API-key setups, Standard pay-as-you-go, Coding Plan, multimodal DashScope features |
| `qwen-oauth` | Qwen Portal endpoint at `portal.qwen.ai/v1`              | Existing Qwen Portal tokens and legacy Qwen OAuth / CLI setups                         |

Both providers use OpenAI-compatible request shapes, but they are separate auth
surfaces. A token stored for `qwen-oauth` should not be treated as a DashScope
or ModelStudio key, and a new DashScope key should use the canonical `qwen`
provider instead.

## Models

The Qwen plugin seeds this static catalog for the Qwen Portal endpoint. All
entries use a 65,536-token max output; availability depends on the current Qwen
Portal account and token.

| Model ref                         | Input       | Context   | Notes         |
| --------------------------------- | ----------- | --------- | ------------- |
| `qwen-oauth/qwen3.5-plus`         | text, image | 1,000,000 | Default model |
| `qwen-oauth/qwen3.6-plus`         | text, image | 1,000,000 |               |
| `qwen-oauth/qwen3-max-2026-01-23` | text        | 262,144   |               |
| `qwen-oauth/qwen3-coder-next`     | text        | 262,144   |               |
| `qwen-oauth/qwen3-coder-plus`     | text        | 1,000,000 |               |
| `qwen-oauth/MiniMax-M2.5`         | text        | 1,000,000 | Reasoning     |
| `qwen-oauth/glm-5`                | text        | 202,752   |               |
| `qwen-oauth/glm-4.7`              | text        | 202,752   |               |
| `qwen-oauth/kimi-k2.5`            | text, image | 262,144   |               |

If your account uses ModelStudio / DashScope API keys instead, configure the
canonical `qwen` provider:

```bash
openclaw onboard --auth-choice qwen-standard-api-key
openclaw models set qwen/qwen3-coder-plus
```

## Migration

Legacy Qwen Portal OAuth profiles are not refreshable; `openclaw doctor` flags
them. If a portal profile stops working, re-run onboarding with a current token
or switch to the Standard Qwen provider:

```bash
openclaw onboard --auth-choice qwen-standard-api-key
```

Standard global ModelStudio uses:

```text
https://dashscope-intl.aliyuncs.com/compatible-mode/v1
```

## Troubleshooting

- Portal OAuth refresh failures: legacy Qwen Portal OAuth profiles are not
  refreshable. Re-run onboarding with a current token.
- Wrong endpoint errors: confirm the model ref starts with `qwen-oauth/` when
  using a portal token. Use `qwen/` refs only for the canonical Qwen provider.
- `QWEN_API_KEY` confusion: both Qwen pages mention this env var, but onboarding
  stores credentials under the selected provider id. Prefer onboarding when you
  keep both `qwen` and `qwen-oauth` available on the same machine.

## Related

- [Qwen](/providers/qwen)
- [Alibaba Model Studio](/providers/alibaba)
- [Model providers](/concepts/model-providers)
- [All providers](/providers/index)
