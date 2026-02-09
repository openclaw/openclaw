---
summary: "Hvordan macOS-appen rapporterer gateway/Baileys-sundhedstilstande"
read_when:
  - Fejlfinding af mac-appens sundhedsindikatorer
title: "Sundhedstjek"
---

# Sundhedstjek på macOS

Sådan kan du se, om den tilknyttede kanal er sund fra menulinje-appen.

## Menulinje

- Statusprikken afspejler nu Baileys-sundhed:
  - Grøn: tilknyttet + socket åbnet for nylig.
  - Orange: forbinder/genprøver.
  - Rød: logget ud eller probe mislykkedes.
- Sekundær linje viser "tilknyttet · auth 12m" eller viser fejlen.
- Menupunktet "Kør sundhedstjek" udløser en probe efter behov.

## Indstillinger

- Fanen Generelt får et Sundhed-kort, der viser: alder på tilknyttet auth, session-store sti/antal, tidspunkt for sidste tjek, seneste fejl/statuskode samt knapper til Kør sundhedstjek / Vis logs.
- Bruger et cachet snapshot, så UI indlæses øjeblikkeligt og falder elegant tilbage, når der er offline.
- **Fanen Kanaler** viser kanalstatus + kontroller for WhatsApp/Telegram (login-QR, log ud, probe, seneste afbrydelse/fejl).

## Sådan virker proben

- App kører `openclaw sundhed --json` via `ShellExecutor` hver ~ 60s og efter behov. Sonden indlæser creds og rapporter status uden at sende beskeder.
- Cache det seneste gode snapshot og den seneste fejl separat for at undgå flimmer; vis tidsstemplet for hver.

## Når du er i tvivl

- Du kan stadig bruge CLI-flowet i [Gateway health](/gateway/health) (`openclaw status`, `openclaw status --deep`, `openclaw health --json`) og følge `/tmp/openclaw/openclaw-*.log` for `web-heartbeat` / `web-reconnect`.
