---
summary: "Globale voice wake words (eigendom van de Gateway) en hoe ze synchroniseren tussen nodes"
read_when:
  - Wijzigen van het gedrag of de standaardwaarden van voice wake words
  - Toevoegen van nieuwe nodeplatforms die wake word-synchronisatie nodig hebben
title: "Voice Wake"
---

# Voice Wake (Globale wake words)

OpenClaw behandelt **wake words als één enkele globale lijst** die eigendom is van de **Gateway**.

- Er zijn **geen per-node aangepaste wake words**.
- **Elke node/app-UI kan** de lijst bewerken; wijzigingen worden door de Gateway opgeslagen en naar iedereen uitgezonden.
- Elk apparaat behoudt wel zijn eigen **Voice Wake ingeschakeld/uitgeschakeld**-schakelaar (lokale UX + rechten verschillen).

## Opslag (Gateway-host)

Wake words worden opgeslagen op de gatewaymachine op:

- `~/.openclaw/settings/voicewake.json`

Vorm:

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## Protocol

### Methoden

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set` met parameters `{ triggers: string[] }` → `{ triggers: string[] }`

Notities:

- Triggers worden genormaliseerd (getrimd, lege waarden verwijderd). Lege lijsten vallen terug op standaardwaarden.
- Limieten worden afgedwongen voor veiligheid (maxima voor aantal/lengte).

### Events

- `voicewake.changed` payload `{ triggers: string[] }`

Wie ontvangt het:

- Alle WebSocket-clients (macOS-app, WebChat, enz.)
- Alle verbonden nodes (iOS/Android), en ook bij het verbinden van een node als initiële push van de “huidige status”.

## Clientgedrag

### macOS-app

- Gebruikt de globale lijst om `VoiceWakeRuntime`-triggers te begrenzen.
- Het bewerken van “Trigger words” in de Voice Wake-instellingen roept `voicewake.set` aan en vertrouwt vervolgens op de broadcast om andere clients gesynchroniseerd te houden.

### iOS-node

- Gebruikt de globale lijst voor `VoiceWakeManager`-triggerdetectie.
- Het bewerken van Wake Words in Instellingen roept `voicewake.set` aan (via de Gateway WS) en houdt ook lokale wake-word-detectie responsief.

### Android-node

- Biedt een Wake Words-editor in Instellingen.
- Roept `voicewake.set` aan via de Gateway WS zodat bewerkingen overal synchroniseren.
