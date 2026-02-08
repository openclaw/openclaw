---
summary: "Zalo Personal plugin: QR login + pagmemensahe sa pamamagitan ng zca-cli (pag-install ng plugin + config ng channel + CLI + tool)"
read_when:
  - Gusto mo ng Zalo Personal (unofficial) na suporta sa OpenClaw
  - Kinokonpigure o dine-develop mo ang zalouser plugin
title: "Zalo Personal Plugin"
x-i18n:
  source_path: plugins/zalouser.md
  source_hash: b29b788b023cd507
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:41Z
---

# Zalo Personal (plugin)

Suporta ng Zalo Personal para sa OpenClaw sa pamamagitan ng isang plugin, gamit ang `zca-cli` para i-automate ang isang normal na Zalo user account.

> **Babala:** Ang hindi opisyal na automation ay maaaring humantong sa suspension o ban ng account. Gamitin sa sarili mong panganib.

## Naming

Ang channel id ay `zalouser` para malinaw na ipakita na ito ay nag-a-automate ng isang **personal Zalo user account** (unofficial). Inilalaan namin ang `zalo` para sa posibleng opisyal na Zalo API integration sa hinaharap.

## Saan ito tumatakbo

Tumatakbo ang plugin na ito **sa loob ng Gateway process**.

Kung gumagamit ka ng remote Gateway, i-install at i-configure ito sa **machine na nagpapatakbo ng Gateway**, pagkatapos ay i-restart ang Gateway.

## Install

### Opsyon A: i-install mula sa npm

```bash
openclaw plugins install @openclaw/zalouser
```

I-restart ang Gateway pagkatapos.

### Opsyon B: i-install mula sa lokal na folder (dev)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

I-restart ang Gateway pagkatapos.

## Paunang kinakailangan: zca-cli

Ang Gateway machine ay dapat may `zca` sa `PATH`:

```bash
zca --version
```

## Config

Ang channel config ay nasa ilalim ng `channels.zalouser` (hindi `plugins.entries.*`):

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

## CLI

```bash
openclaw channels login --channel zalouser
openclaw channels logout --channel zalouser
openclaw channels status --probe
openclaw message send --channel zalouser --target <threadId> --message "Hello from OpenClaw"
openclaw directory peers list --channel zalouser --query "name"
```

## Agent tool

Pangalan ng tool: `zalouser`

Mga aksyon: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
