---
summary: "Sundhedstjektrin for kanalforbindelse"
read_when:
  - Diagnosticering af WhatsApp-kanalens sundhed
title: "Sundhedstjek"
x-i18n:
  source_path: gateway/health.md
  source_hash: 74f242e98244c135
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:17Z
---

# Sundhedstjek (CLI)

Kort guide til at verificere kanalforbindelse uden at gætte.

## Hurtige tjek

- `openclaw status` — lokal oversigt: gateway-rækkevidde/tilstand, opdateringshint, alder på tilknyttet kanalautentificering, sessioner + nylig aktivitet.
- `openclaw status --all` — fuld lokal diagnosticering (skrivebeskyttet, farver, sikker at indsætte til fejlsøgning).
- `openclaw status --deep` — sonderer også den kørende Gateway (per-kanal-sondering hvor understøttet).
- `openclaw health --json` — beder den kørende Gateway om et fuldt sundhedsbillede (kun WS; ingen direkte Baileys-socket).
- Send `/status` som en selvstændig besked i WhatsApp/WebChat for at få et status-svar uden at aktivere agenten.
- Logs: følg `/tmp/openclaw/openclaw-*.log` og filtrér efter `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`.

## Dybdegående diagnosticering

- Legitimationsoplysninger på disk: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime bør være nylig).
- Sessionslager: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (stien kan tilsidesættes i konfigurationen). Antal og seneste modtagere vises via `status`.
- Genforbindelsesflow: `openclaw channels logout && openclaw channels login --verbose` når statuskoder 409–515 eller `loggedOut` vises i logs. (Bemærk: QR-loginflowet genstarter automatisk én gang for status 515 efter parring.)

## Når noget fejler

- `logged out` eller status 409–515 → genforbind med `openclaw channels logout` og derefter `openclaw channels login`.
- Gateway utilgængelig → start den: `openclaw gateway --port 18789` (brug `--force` hvis porten er optaget).
- Ingen indgående beskeder → bekræft, at den tilknyttede telefon er online, og at afsenderen er tilladt (`channels.whatsapp.allowFrom`); for gruppechats skal du sikre, at tilladelsesliste + nævneregler matcher (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## Dedikeret "health"-kommando

`openclaw health --json` beder den kørende Gateway om dens sundhedsbillede (ingen direkte kanalsockets fra CLI’en). Den rapporterer tilknyttede legitimationsoplysninger/autentalder, per-kanal-sondeoversigter, sessionslager-oversigt og en sonderingsvarighed. Den afslutter med ikke-nul, hvis Gateway er utilgængelig, eller hvis sonden fejler/timeout’er. Brug `--timeout <ms>` til at tilsidesætte standarden på 10 s.
