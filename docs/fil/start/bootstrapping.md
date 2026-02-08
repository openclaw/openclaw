---
summary: "Ritwal ng bootstrapping ng agent na naglalagay ng paunang laman sa workspace at mga identity file"
read_when:
  - Pag-unawa kung ano ang nangyayari sa unang takbo ng agent
  - Pagpapaliwanag kung saan nakaimbak ang mga bootstrapping file
  - Pag-debug ng setup ng identity sa onboarding
title: "Bootstrapping ng Agent"
sidebarTitle: "Bootstrapping"
x-i18n:
  source_path: start/bootstrapping.md
  source_hash: 4a08b5102f25c6c4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:57Z
---

# Bootstrapping ng Agent

Ang bootstrapping ay ang ritwal ng **unang takbo** na naghahanda ng agent workspace at
nangongolekta ng mga detalye ng identity. Nangyayari ito pagkatapos ng onboarding, kapag
unang beses na nagsisimula ang agent.

## Ano ang ginagawa ng bootstrapping

Sa unang takbo ng agent, bina-bootstrap ng OpenClaw ang workspace (default
`~/.openclaw/workspace`):

- Naglalagay ng paunang laman sa `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- Nagpapatakbo ng maikling ritwal ng Q&A (isang tanong sa bawat pagkakataon).
- Nagsusulat ng identity + mga preference sa `IDENTITY.md`, `USER.md`, `SOUL.md`.
- Inaalis ang `BOOTSTRAP.md` kapag tapos na upang isang beses lang itong tumakbo.

## Saan ito tumatakbo

Palaging tumatakbo ang bootstrapping sa **gateway host**. Kung kumokonekta ang macOS app sa
isang remote Gateway, ang workspace at mga bootstrapping file ay nasa remote
na makinang iyon.

<Note>
Kapag tumatakbo ang Gateway sa ibang makina, i-edit ang mga workspace file sa host ng Gateway
(halimbawa, `user@gateway-host:~/.openclaw/workspace`).
</Note>

## Kaugnay na docs

- Onboarding ng macOS app: [Onboarding](/start/onboarding)
- Layout ng workspace: [Agent workspace](/concepts/agent-workspace)
