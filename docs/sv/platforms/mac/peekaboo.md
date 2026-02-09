---
summary: "”PeekabooBridge‑integration för macOS‑UI‑automatisering”"
read_when:
  - ”Värd för PeekabooBridge i OpenClaw.app”
  - ”Integrera Peekaboo via Swift Package Manager”
  - ”Ändra PeekabooBridge‑protokoll/sökvägar”
title: "”Peekaboo Bridge”"
---

# Peekaboo Bridge (macOS‑UI‑automatisering)

OpenClaw kan vara värd för **PeekabooBridge** som en lokal, behörighetsmedveten UI-automatisering
mäklare. Detta låter `peekaboo` CLI-enhet UI automation när du återanvänder
macOS appens TCC behörigheter.

## Vad detta är (och inte är)

- **Värd**: OpenClaw.app kan fungera som värd för PeekabooBridge.
- **Klient**: använd `peekaboo`‑CLI:t (ingen separat `openclaw ui ...`‑yta).
- **UI**: visuella överlägg ligger kvar i Peekaboo.app; OpenClaw är en tunn
  mäklarvärd.

## Aktivera bryggan

I macOS‑appen:

- Inställningar → **Aktivera Peekaboo Bridge**

När den är aktiverad startar OpenClaw en lokal UNIX-uttagsserver. Om inaktiverad stoppas värden
och `peekaboo` kommer att falla tillbaka till andra tillgängliga värdar.

## Klienternas upptäcktsordning

Peekaboo‑klienter provar vanligtvis värdar i denna ordning:

1. Peekaboo.app (full UX)
2. Claude.app (om installerad)
3. OpenClaw.app (tunn mäklare)

Använd `peekaboo bridge status --verbose` för att se vilken värd som är aktiv och vilken
socket-sökväg som används. Du kan åsidosätta med:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## Säkerhet och behörigheter

- Bryggan validerar **anroparens kodsignaturer**; en tillåtelselista med TeamID:n
  tillämpas (Peekaboo‑värdens TeamID + OpenClaw‑appens TeamID).
- Förfrågningar får timeout efter ~10 sekunder.
- Om nödvändiga behörigheter saknas returnerar bryggan ett tydligt felmeddelande
  i stället för att starta Systeminställningar.

## Snapshot‑beteende (automatisering)

Ögonblicksbilder lagras i minnet och upphör automatiskt efter ett kort fönster.
Om du behöver längre retention, återfånga från klienten.

## Felsökning

- Om `peekaboo` rapporterar ”bridge client is not authorized”, säkerställ att
  klienten är korrekt signerad eller kör värden med `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`
  i **debug**‑läge endast.
- Om inga värdar hittas, öppna en av värdapparna (Peekaboo.app eller OpenClaw.app)
  och bekräfta att behörigheter är beviljade.
