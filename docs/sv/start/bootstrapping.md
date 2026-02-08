---
summary: ”Agentens bootstrap‑ritual som sår arbetsytan och identitetsfilerna”
read_when:
  - Förstå vad som händer vid agentens första körning
  - Förklara var bootstrap‑filerna finns
  - Felsöka introduktionens identitetskonfiguration
title: ”Agent‑bootstrap”
sidebarTitle: "Bootstrapping"
x-i18n:
  source_path: start/bootstrapping.md
  source_hash: 4a08b5102f25c6c4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:28Z
---

# Agent‑bootstrap

Bootstrap är **första‑körningen**‑ritualen som förbereder en agents arbetsyta och
samlar in identitetsuppgifter. Den sker efter introduktionen, när agenten startar
för första gången.

## Vad bootstrap gör

Vid agentens första körning bootstrappar OpenClaw arbetsytan (standard
`~/.openclaw/workspace`):

- Sår `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- Kör en kort Q&A‑ritual (en fråga i taget).
- Skriver identitet + preferenser till `IDENTITY.md`, `USER.md`, `SOUL.md`.
- Tar bort `BOOTSTRAP.md` när den är klar så att den bara körs en gång.

## Var den körs

Bootstrap körs alltid på **gateway‑värden**. Om macOS‑appen ansluter till en
fjärr‑Gateway (nätverksgateway) finns arbetsytan och bootstrap‑filerna på den
fjärrmaskinen.

<Note>
När Gateway (nätverksgateway) körs på en annan maskin ska du redigera
arbetsytefiler på gateway‑värden (till exempel `user@gateway-host:~/.openclaw/workspace`).
</Note>

## Relaterad dokumentation

- Introduktion för macOS‑appen: [Onboarding](/start/onboarding)
- Arbetsytans layout: [Agent workspace](/concepts/agent-workspace)
