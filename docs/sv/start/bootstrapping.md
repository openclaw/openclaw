---
summary: "”Agentens bootstrap‑ritual som sår arbetsytan och identitetsfilerna”"
read_when:
  - Förstå vad som händer vid agentens första körning
  - Förklara var bootstrap‑filerna finns
  - Felsöka introduktionens identitetskonfiguration
title: "”Agent‑bootstrap”"
sidebarTitle: "Bootstrapping"
---

# Agent‑bootstrap

Bootstrapping är den \*\*första-run-ritualen \*\* som förbereder en agent arbetsyta och
samlar identitetsdetaljer. Det händer efter ombordstigning, när agenten startar
för första gången.

## Vad bootstrap gör

Vid agentens första körning bootstrappar OpenClaw arbetsytan (standard
`~/.openclaw/workspace`):

- Sår `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- Kör en kort Q&A‑ritual (en fråga i taget).
- Skriver identitet + preferenser till `IDENTITY.md`, `USER.md`, `SOUL.md`.
- Tar bort `BOOTSTRAP.md` när den är klar så att den bara körs en gång.

## Var den körs

Bootstrapping körs alltid på **gateway host**. Om macOS appen ansluter till
en fjärr-Gateway, arbetsytan och bootstrapping filer live på den fjärr-
-maskinen.

<Note>
När Gateway (nätverksgateway) körs på en annan maskin ska du redigera
arbetsytefiler på gateway‑värden (till exempel `user@gateway-host:~/.openclaw/workspace`).
</Note>

## Relaterad dokumentation

- Introduktion för macOS‑appen: [Onboarding](/start/onboarding)
- Arbetsytans layout: [Agent workspace](/concepts/agent-workspace)
