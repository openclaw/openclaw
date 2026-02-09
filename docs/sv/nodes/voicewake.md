---
summary: "Globala röstväckningsord (Gateway-ägda) och hur de synkroniseras mellan noder"
read_when:
  - Ändring av beteende eller standardvärden för röstväckningsord
  - Tillägg av nya nodplattformar som behöver synk av väckningsord
title: "Röstväckning"
---

# Röstväckning (Globala väckningsord)

OpenClaw behandlar **väckningsord som en enda global lista** som ägs av **Gateway**.

- Det finns **inga nodspecifika anpassade väckningsord**.
- **Valfri nod/app‑UI kan redigera** listan; ändringar sparas av Gateway och sänds till alla.
- Varje enhet behåller fortfarande sin egen växel för **Röstväckning aktiverad/inaktiverad** (lokal UX + behörigheter skiljer sig).

## Lagring (Gateway-värd)

Väckningsord lagras på gateway‑maskinen på:

- `~/.openclaw/settings/voicewake.json`

Struktur:

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## Protokoll

### Metoder

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set` med parametrar `{ triggers: string[] }` → `{ triggers: string[] }`

Noteringar:

- Utlösare är normaliserade (trimmade tommar tappade). Tomma listor faller tillbaka till standardinställningar.
- Gränser tillämpas av säkerhetsskäl (tak för antal/längd).

### Händelser

- `voicewake.changed` payload `{ triggers: string[] }`

Vem tar emot den:

- Alla WebSocket‑klienter (macOS‑appen, WebChat osv.)
- Alla anslutna noder (iOS/Android), samt även vid nodanslutning som en initial push av ”aktuellt tillstånd”.

## Klientbeteende

### macOS‑app

- Använder den globala listan för att styra `VoiceWakeRuntime`‑triggers.
- Redigering av ”Trigger words” i inställningarna för Röstväckning anropar `voicewake.set` och förlitar sig därefter på sändningen för att hålla andra klienter synkroniserade.

### iOS‑nod

- Använder den globala listan för `VoiceWakeManager`‑detektering av triggers.
- Redigering av Wake Words i Inställningar anropar `voicewake.set` (via Gateway WS) och håller samtidigt lokal väckningsordsdetektering responsiv.

### Android‑nod

- Exponerar en redigerare för Wake Words i Inställningar.
- Anropar `voicewake.set` via Gateway WS så att ändringar synkroniseras överallt.
