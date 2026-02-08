---
summary: "Ritueel voor het opstarten van de agent dat de werkruimte en identiteitsbestanden initialiseert"
read_when:
  - Begrijpen wat er gebeurt bij de eerste uitvoering van de agent
  - Uitleggen waar bootstrap-bestanden zich bevinden
  - Problemen oplossen bij het instellen van de onboarding-identiteit
title: "Agent Bootstrapping"
sidebarTitle: "Bootstrapping"
x-i18n:
  source_path: start/bootstrapping.md
  source_hash: 4a08b5102f25c6c4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:41Z
---

# Agent Bootstrapping

Bootstrapping is het **eerste‑run**‑ritueel dat een agentwerkruimte voorbereidt en
identiteitsgegevens verzamelt. Het vindt plaats na onboarding, wanneer de agent
voor het eerst start.

## Wat bootstrapping doet

Bij de eerste uitvoering van de agent initialiseert OpenClaw de werkruimte
(standaard `~/.openclaw/workspace`):

- Initialiseert `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- Voert een kort vraag‑en‑antwoordritueel uit (één vraag tegelijk).
- Schrijft identiteit + voorkeuren naar `IDENTITY.md`, `USER.md`, `SOUL.md`.
- Verwijdert `BOOTSTRAP.md` wanneer het is voltooid, zodat het slechts één keer wordt uitgevoerd.

## Waar het wordt uitgevoerd

Bootstrapping wordt altijd uitgevoerd op de **Gateway-host**. Als de macOS-app
verbinding maakt met een externe Gateway, bevinden de werkruimte en de
bootstrap-bestanden zich op die externe machine.

<Note>
Wanneer de Gateway op een andere machine draait, bewerk je werkruimtebestanden
op de Gateway-host (bijvoorbeeld `user@gateway-host:~/.openclaw/workspace`).
</Note>

## Gerelateerde documentatie

- macOS-app onboarding: [Onboarding](/start/onboarding)
- Indeling van de werkruimte: [Agent workspace](/concepts/agent-workspace)
