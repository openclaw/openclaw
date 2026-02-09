---
summary: "”Hur macOS-appen rapporterar hälsotillstånd för gateway/Baileys”"
read_when:
  - Felsökning av hälsindikatorer i macOS-appen
title: "”Hälsokontroller”"
---

# Hälsokontroller på macOS

Så ser du om den länkade kanalen är frisk från menyfältsappen.

## Menyfält

- Statuspricken återspeglar nu Baileys-hälsa:
  - Grön: länkad + socket öppnad nyligen.
  - Orange: ansluter/försöker igen.
  - Röd: utloggad eller kontroll misslyckades.
- Sekundärraden visar ”länkad · auth 12m” eller visar felorsaken.
- Menyalternativet ”Kör hälsokontroll” startar en kontroll på begäran.

## Inställningar

- Fliken Allmänt får ett hälsokort som visar: länkad auth-ålder, sökväg/antal för sessionslagret, tid för senaste kontroll, senaste fel/statuskod samt knappar för Kör hälsokontroll / Visa loggar.
- Använder en cachad ögonblicksbild så att UI:t laddas direkt och faller tillbaka på ett robust sätt när du är offline.
- **Fliken Kanaler** visar kanalstatus + kontroller för WhatsApp/Telegram (inloggnings‑QR, logga ut, kontroll, senaste frånkoppling/fel).

## Hur kontrollen fungerar

- Appen kör `openclaw health --json` via `ShellExecutor` varje ~60s och på begäran. Sonden laddar in creds och rapporterar status utan att skicka meddelanden.
- Cacha den senaste fungerande ögonblicksbilden och det senaste felet separat för att undvika flimmer; visa tidsstämpeln för vardera.

## Vid tveksamhet

- Du kan fortfarande använda CLI-flödet i [Gateway health](/gateway/health) (`openclaw status`, `openclaw status --deep`, `openclaw health --json`) och tail `/tmp/openclaw/openclaw-*.log` för `web-heartbeat` / `web-reconnect`.
