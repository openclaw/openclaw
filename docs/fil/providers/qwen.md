---
summary: "Gamitin ang Qwen OAuth (free tier) sa OpenClaw"
read_when:
  - Gusto mong gumamit ng Qwen sa OpenClaw
  - Gusto mo ng free-tier OAuth access sa Qwen Coder
title: "Qwen"
x-i18n:
  source_path: providers/qwen.md
  source_hash: 88b88e224e2fecbb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:46Z
---

# Qwen

Nagbibigay ang Qwen ng free-tier OAuth flow para sa mga modelong Qwen Coder at Qwen Vision
(2,000 request/araw, nakabatay sa mga rate limit ng Qwen).

## I-enable ang plugin

```bash
openclaw plugins enable qwen-portal-auth
```

I-restart ang Gateway pagkatapos i-enable.

## Mag-authenticate

```bash
openclaw models auth login --provider qwen-portal --set-default
```

Pinapatakbo nito ang Qwen device-code OAuth flow at nagsusulat ng provider entry sa iyong
`models.json` (kasama ang isang `qwen` alias para sa mabilis na paglipat).

## Mga Model ID

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Magpalit ng mga model gamit ang:

```bash
openclaw models set qwen-portal/coder-model
```

## Muling gamitin ang Qwen Code CLI login

Kung naka-login ka na gamit ang Qwen Code CLI, isi-sync ng OpenClaw ang mga credential
mula sa `~/.qwen/oauth_creds.json` kapag nilo-load nito ang auth store. Kailangan mo pa rin ng
isang `models.providers.qwen-portal` entry (gamitin ang login command sa itaas para gumawa nito).

## Mga tala

- Auto-refresh ang mga token; patakbuhin muli ang login command kung pumalya ang refresh o nabawi ang access.
- Default na base URL: `https://portal.qwen.ai/v1` (i-override gamit ang
  `models.providers.qwen-portal.baseUrl` kung may ibang endpoint na ibinigay ang Qwen).
- Tingnan ang [Model providers](/concepts/model-providers) para sa mga patakarang saklaw ng provider.
