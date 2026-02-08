---
summary: "Steg för hälsokontroll av kanalanslutning"
read_when:
  - Diagnostiserar WhatsApp-kanalens hälsa
title: "Hälsokontroller"
x-i18n:
  source_path: gateway/health.md
  source_hash: 74f242e98244c135
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:17Z
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
- Sessionslagring: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (sökvägen kan åsidosättas i konfig). Antal och senaste mottagare exponeras via `status`.
- Omlänkningsflöde: `openclaw channels logout && openclaw channels login --verbose` när statuskoderna 409–515 eller `loggedOut` visas i loggar. (Obs: QR-inloggningsflödet startar automatiskt om en gång för status 515 efter parkoppling.)

## När något misslyckas

- `logged out` eller status 409–515 → länka om med `openclaw channels logout` och sedan `openclaw channels login`.
- Gateway inte nåbar → starta den: `openclaw gateway --port 18789` (använd `--force` om porten är upptagen).
- Inga inkommande meddelanden → bekräfta att den länkade telefonen är online och att avsändaren är tillåten (`channels.whatsapp.allowFrom`); för gruppchattar, säkerställ att tillåtelselista + omnämnanderegler matchar (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## Dedikerat ”health”-kommando

`openclaw health --json` frågar den körande Gateway efter dess hälsobild (inga direkta kanalsockets från CLI). Det rapporterar länkade inloggningsuppgifter/auth-ålder när tillgängligt, sammanfattningar av per-kanal-prober, sammanfattning av sessionslagring samt en probduration. Det avslutas med icke-noll om Gateway inte kan nås eller om proben misslyckas/tidsgränsar. Använd `--timeout <ms>` för att åsidosätta standarden på 10 s.
