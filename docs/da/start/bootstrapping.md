---
summary: "Agentens bootstrapping-ritual, der sår arbejdsområdet og identitetsfilerne"
read_when:
  - Forstå hvad der sker ved agentens første kørsel
  - Forklare hvor bootstrapping-filerne ligger
  - Fejlsøgning af introduktionens identitetsopsætning
title: "Agent-bootstrapping"
sidebarTitle: "Bootstrapping"
---

# Agent-bootstrapping

Bootstrapping er det **første-runde-** ritual, der forbereder et agent-arbejdsrum, og
indsamler identitetsoplysninger. Det sker efter onboarding, når agenten starter
for første gang.

## Hvad bootstrapping gør

Ved agentens første kørsel bootstrapper OpenClaw arbejdsområdet (standard
`~/.openclaw/workspace`):

- Sår `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- Kører et kort Q&A‑ritual (ét spørgsmål ad gangen).
- Skriver identitet + præferencer til `IDENTITY.md`, `USER.md`, `SOUL.md`.
- Fjerner `BOOTSTRAP.md`, når det er færdigt, så det kun kører én gang.

## Hvor det kører

Bootstrapping kører altid på **gateway vært**. Hvis macOS appen forbinder til
en ekstern Gateway, lever arbejdsrummet og bootstrapping filer på den eksterne
-maskine.

<Note>
Når Gateway kører på en anden maskine, redigér arbejdsområdefiler på gateway-værten
(for eksempel `user@gateway-host:~/.openclaw/workspace`).
</Note>

## Relaterede dokumenter

- macOS‑app introduktion: [Onboarding](/start/onboarding)
- Arbejdsområdelayout: [Agent workspace](/concepts/agent-workspace)
