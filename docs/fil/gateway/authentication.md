---
summary: "Authentication ng modelo: OAuth, mga API key, at setup-token"
read_when:
  - Pag-debug ng model auth o pag-expire ng OAuth
  - Pagdodokumento ng authentication o pag-iimbak ng credential
title: "Authentication"
x-i18n:
  source_path: gateway/authentication.md
  source_hash: 66fa2c64ff374c9c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:32Z
---

# Authentication

Sinusuportahan ng OpenClaw ang OAuth at mga API key para sa mga provider ng modelo. Para sa mga Anthropic
account, inirerekomenda naming gumamit ng **API key**. Para sa access sa Claude subscription,
gamitin ang long‑lived token na nilikha ng `claude setup-token`.

Tingnan ang [/concepts/oauth](/concepts/oauth) para sa kumpletong OAuth flow at layout ng storage.

## Inirerekomendang Anthropic setup (API key)

Kung direktang gumagamit ka ng Anthropic, gumamit ng API key.

1. Gumawa ng API key sa Anthropic Console.
2. Ilagay ito sa **gateway host** (ang machine na nagpapatakbo ng `openclaw gateway`).

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. Kung ang Gateway ay tumatakbo sa ilalim ng systemd/launchd, mas mainam na ilagay ang key sa
   `~/.openclaw/.env` upang mabasa ito ng daemon:

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

Pagkatapos, i-restart ang daemon (o i-restart ang iyong Gateway process) at muling i-check:

```bash
openclaw models status
openclaw doctor
```

Kung ayaw mong ikaw mismo ang mag-manage ng env vars, maaaring mag-imbak ang onboarding wizard
ng mga API key para sa paggamit ng daemon: `openclaw onboard`.

Tingnan ang [Help](/help) para sa mga detalye tungkol sa env inheritance (`env.shellEnv`,
`~/.openclaw/.env`, systemd/launchd).

## Anthropic: setup-token (subscription auth)

Para sa Anthropic, ang inirerekomendang ruta ay **API key**. Kung gumagamit ka ng Claude
subscription, sinusuportahan din ang setup-token flow. Patakbuhin ito sa **gateway host**:

```bash
claude setup-token
```

Pagkatapos, i-paste ito sa OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

Kung ang token ay nilikha sa ibang machine, i-paste ito nang manu-mano:

```bash
openclaw models auth paste-token --provider anthropic
```

Kung makakita ka ng Anthropic error tulad ng:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…gumamit na lang ng Anthropic API key.

Manu-manong pagpasok ng token (anumang provider; nagsusulat ng `auth-profiles.json` + nag-a-update ng config):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

Automation-friendly na check (exit `1` kapag expired/nawawala, `2` kapag malapit nang mag-expire):

```bash
openclaw models status --check
```

Ang mga opsyonal na ops scripts (systemd/Termux) ay nakadokumento dito:
[/automation/auth-monitoring](/automation/auth-monitoring)

> Nangangailangan ang `claude setup-token` ng interactive TTY.

## Pag-check ng model auth status

```bash
openclaw models status
openclaw doctor
```

## Pagkontrol kung aling credential ang gagamitin

### Per-session (chat command)

Gamitin ang `/model <alias-or-id>@<profileId>` upang i-pin ang isang partikular na provider credential para sa kasalukuyang session (mga halimbawang profile id: `anthropic:default`, `anthropic:work`).

Gamitin ang `/model` (o `/model list`) para sa compact picker; gamitin ang `/model status` para sa full view (mga kandidato + susunod na auth profile, kasama ang mga detalye ng provider endpoint kapag naka-configure).

### Per-agent (CLI override)

Mag-set ng explicit auth profile order override para sa isang agent (naka-store sa `auth-profiles.json` ng agent na iyon):

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

Gamitin ang `--agent <id>` upang i-target ang isang partikular na agent; i-omit ito upang gamitin ang naka-configure na default agent.

## Pag-troubleshoot

### “No credentials found”

Kung nawawala ang Anthropic token profile, patakbuhin ang `claude setup-token` sa
**gateway host**, pagkatapos ay muling i-check:

```bash
openclaw models status
```

### Token expiring/expired

Patakbuhin ang `openclaw models status` upang kumpirmahin kung aling profile ang mag-e-expire. Kung nawawala ang profile,
patakbuhin muli ang `claude setup-token` at i-paste muli ang token.

## Mga kinakailangan

- Claude Max o Pro subscription (para sa `claude setup-token`)
- Naka-install ang Claude Code CLI (available ang `claude` command)
