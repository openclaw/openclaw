---
summary: "Ritwal ng bootstrapping ng agent na naglalagay ng paunang laman sa workspace at mga identity file"
read_when:
  - Pag-unawa kung ano ang nangyayari sa unang takbo ng agent
  - Pagpapaliwanag kung saan nakaimbak ang mga bootstrapping file
  - Pag-debug ng setup ng identity sa onboarding
title: "Bootstrapping ng Agent"
sidebarTitle: "Bootstrapping"
---

# Bootstrapping ng Agent

Bootstrapping is the **first‑run** ritual that prepares an agent workspace and
collects identity details. It happens after onboarding, when the agent starts
for the first time.

## Ano ang ginagawa ng bootstrapping

Sa unang takbo ng agent, bina-bootstrap ng OpenClaw ang workspace (default
`~/.openclaw/workspace`):

- Naglalagay ng paunang laman sa `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- Nagpapatakbo ng maikling ritwal ng Q&A (isang tanong sa bawat pagkakataon).
- Nagsusulat ng identity + mga preference sa `IDENTITY.md`, `USER.md`, `SOUL.md`.
- Inaalis ang `BOOTSTRAP.md` kapag tapos na upang isang beses lang itong tumakbo.

## Saan ito tumatakbo

Bootstrapping always runs on the **gateway host**. If the macOS app connects to
a remote Gateway, the workspace and bootstrapping files live on that remote
machine.

<Note>
Kapag tumatakbo ang Gateway sa ibang makina, i-edit ang mga workspace file sa host ng Gateway
(halimbawa, `user@gateway-host:~/.openclaw/workspace`).
</Note>

## Kaugnay na docs

- Onboarding ng macOS app: [Onboarding](/start/onboarding)
- Layout ng workspace: [Agent workspace](/concepts/agent-workspace)
