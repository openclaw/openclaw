---
summary: "Agentens bootstrapping-ritual, der sår arbejdsområdet og identitetsfilerne"
read_when:
  - Forstå hvad der sker ved agentens første kørsel
  - Forklare hvor bootstrapping-filerne ligger
  - Fejlsøgning af introduktionens identitetsopsætning
title: "Agent-bootstrapping"
sidebarTitle: "Bootstrapping"
x-i18n:
  source_path: start/bootstrapping.md
  source_hash: 4a08b5102f25c6c4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:37Z
---

# Agent-bootstrapping

Bootstrapping er **første‑kørsel**‑ritualet, der forbereder et agent‑arbejdsområde og
indsamler identitetsoplysninger. Det sker efter introduktion, når agenten starter
for første gang.

## Hvad bootstrapping gør

Ved agentens første kørsel bootstrapper OpenClaw arbejdsområdet (standard
`~/.openclaw/workspace`):

- Sår `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- Kører et kort Q&A‑ritual (ét spørgsmål ad gangen).
- Skriver identitet + præferencer til `IDENTITY.md`, `USER.md`, `SOUL.md`.
- Fjerner `BOOTSTRAP.md`, når det er færdigt, så det kun kører én gang.

## Hvor det kører

Bootstrapping kører altid på **gateway-værten**. Hvis macOS‑appen forbinder til en
fjern Gateway, ligger arbejdsområdet og bootstrapping‑filerne på den fjernmaskine.

<Note>
Når Gateway kører på en anden maskine, redigér arbejdsområdefiler på gateway-værten
(for eksempel `user@gateway-host:~/.openclaw/workspace`).
</Note>

## Relaterede dokumenter

- macOS‑app introduktion: [Onboarding](/start/onboarding)
- Arbejdsområdelayout: [Agent workspace](/concepts/agent-workspace)
