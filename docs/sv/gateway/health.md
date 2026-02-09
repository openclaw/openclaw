---
summary: "Steg för hälsokontroll av kanalanslutning"
read_when:
  - Diagnostiserar WhatsApp-kanalens hälsa
title: "Hälsokontroller"
---

# Hälsokontroller (CLI)

Kort guide för att verifiera kanalanslutning utan gissningar.

## Snabbkontroller

- `openclaw status` — lokal sammanfattning: Gateway-åtkomlighet/läge, uppdateringstips, ålder på länkad kanalauth, sessioner + nylig aktivitet.
- `openclaw status --all` — fullständig lokal diagnos (skrivskyddad, färg, säker att klistra in för felsökning).
- `openclaw status --deep` — sonderar även den körande Gateway (per-kanal-prober när det stöds).
- `openclaw health --json` — frågar den körande Gateway efter en fullständig hälsobild (endast WS; ingen direkt Baileys-socket).
- Skicka `/status` som ett fristående meddelande i WhatsApp/WebChat för att få ett statusvar utan att anropa agenten.
- Loggar: tail `/tmp/openclaw/openclaw-*.log` och filtrera efter `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`.

## Djupdiagnostik

- Inloggningsuppgifter på disk: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime bör vara nylig).
- Sessionsbutik: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (sökvägen kan åsidosättas i config). Räkna och de senaste mottagarna dyker upp via `status`.
- Relink flow: `openclaw channels logout && openclaw channels login --verbose` when status codes 409–515 or `loggedOut` appear in logs. (Observera: QR-inloggningsflödet startar automatiskt om en gång för status 515 efter parning.)

## När något misslyckas

- `logged out` eller status 409–515 → länka om med `openclaw channels logout` och sedan `openclaw channels login`.
- Gateway inte nåbar → starta den: `openclaw gateway --port 18789` (använd `--force` om porten är upptagen).
- Inga inkommande meddelanden → bekräfta att den länkade telefonen är online och att avsändaren är tillåten (`channels.whatsapp.allowFrom`); för gruppchattar, säkerställ att tillåtelselista + omnämnanderegler matchar (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## Dedikerat ”health”-kommando

`openclaw hälsa --json` frågar den körande Gateway för dess hälsa ögonblicksbild (inga direkta kanaluttag från CLI). Den rapporterar länkade krediter/auth ålder när tillgänglig, per kanal sond sammanfattningar, session-store sammanfattning och en sond varaktighet. Den avslutas utan noll om Gateway inte kan nås eller sonden misslyckas/timeouts. Använd `--timeout <ms>` för att åsidosätta 10s standard.
