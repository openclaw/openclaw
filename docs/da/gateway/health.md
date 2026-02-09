---
summary: "Sundhedstjektrin for kanalforbindelse"
read_when:
  - Diagnosticering af WhatsApp-kanalens sundhed
title: "Sundhedstjek"
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
- Session butik: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (path can be overridden in config). Tæller og seneste modtagere er dukket op via `status`.
- Relink flow: `openclaw channels logout && openclaw channels login --verbose` when status codes 409–515 or `loggedOut` appear in logs. (Bemærk: QR login flow auto-genstarter en gang for status 515 efter parring.)

## Når noget fejler

- `logged out` eller status 409–515 → genforbind med `openclaw channels logout` og derefter `openclaw channels login`.
- Gateway utilgængelig → start den: `openclaw gateway --port 18789` (brug `--force` hvis porten er optaget).
- Ingen indgående beskeder → bekræft, at den tilknyttede telefon er online, og at afsenderen er tilladt (`channels.whatsapp.allowFrom`); for gruppechats skal du sikre, at tilladelsesliste + nævneregler matcher (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## Dedikeret "health"-kommando

`openclaw sundhed --json` spørger den løbende Gateway for sin sundhed snapshot (ingen direkte kanal stikkontakter fra CLI). Det rapporterer linket creds/auth alder når tilgængelig, per-kanal probe resuméer, session-store resumé, og en sonde varighed. Den afslutter ikke nul, hvis porten ikke kan nås eller sonden svigter/timeouts. Brug `--timeout <ms>` for at tilsidesætte 10s standard.
