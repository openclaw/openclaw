---
summary: "Mag-sign in sa GitHub Copilot mula sa OpenClaw gamit ang device flow"
read_when:
  - Gusto mong gamitin ang GitHub Copilot bilang model provider
  - Kailangan mo ang `openclaw models auth login-github-copilot` flow
title: "GitHub Copilot"
x-i18n:
  source_path: providers/github-copilot.md
  source_hash: 503e0496d92c921e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:44Z
---

# GitHub Copilot

## Ano ang GitHub Copilot?

Ang GitHub Copilot ay AI coding assistant ng GitHub. Nagbibigay ito ng access sa mga model ng Copilot para sa iyong GitHub account at plano. Maaaring gamitin ng OpenClaw ang Copilot bilang model provider sa dalawang magkaibang paraan.

## Dalawang paraan para gamitin ang Copilot sa OpenClaw

### 1) Built-in na GitHub Copilot provider (`github-copilot`)

Gamitin ang native device-login flow para kumuha ng GitHub token, pagkatapos ay i-exchange ito para sa mga Copilot API token kapag tumatakbo ang OpenClaw. Ito ang **default** at pinakasimpleng ruta dahil hindi nito kailangan ang VS Code.

### 2) Copilot Proxy plugin (`copilot-proxy`)

Gamitin ang **Copilot Proxy** VS Code extension bilang lokal na bridge. Nakikipag-usap ang OpenClaw sa `/v1` endpoint ng proxy at ginagamit ang listahan ng model na kino-configure mo roon. Piliin ito kapag nagpapatakbo ka na ng Copilot Proxy sa VS Code o kailangan mong mag-route dito. Kailangan mong i-enable ang plugin at panatilihing tumatakbo ang VS Code extension.

Gamitin ang GitHub Copilot bilang model provider (`github-copilot`). Pinapatakbo ng login command ang GitHub device flow, sine-save ang isang auth profile, at ina-update ang iyong config para gamitin ang profile na iyon.

## CLI setup

```bash
openclaw models auth login-github-copilot
```

Ipo-prompt kang bumisita sa isang URL at maglagay ng one-time code. Panatilihing bukas ang terminal hanggang sa makumpleto ito.

### Mga opsyonal na flag

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## Magtakda ng default na model

```bash
openclaw models set github-copilot/gpt-4o
```

### Snippet ng config

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## Mga tala

- Nangangailangan ng interactive TTY; patakbuhin ito nang direkta sa isang terminal.
- Ang availability ng Copilot model ay depende sa iyong plano; kung may model na ma-reject, subukan ang ibang ID (halimbawa `github-copilot/gpt-4.1`).
- Ang login ay nag-iimbak ng GitHub token sa auth profile store at ine-exchange ito para sa isang Copilot API token kapag tumatakbo ang OpenClaw.
