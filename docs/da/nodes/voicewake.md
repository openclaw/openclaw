---
summary: "Globale vækkeord for stemmeaktivering (Gateway-ejet) og hvordan de synkroniseres på tværs af noder"
read_when:
  - Ændring af adfærd eller standarder for vækkeord for stemmeaktivering
  - Tilføjelse af nye nodeplatforme, der har brug for synkronisering af vækkeord
title: "Stemmeaktivering"
---

# Stemmeaktivering (Globale vækkeord)

OpenClaw behandler **vækkeord som én samlet global liste**, der ejes af **Gateway**.

- Der er **ingen brugerdefinerede vækkeord pr. node**.
- **Enhver node/app-UI kan redigere** listen; ændringer gemmes af Gateway og udsendes til alle.
- Hver enhed har stadig sin egen **Stemmeaktivering til/fra**-kontakt (lokal UX + tilladelser varierer).

## Lagring (gateway-vært)

Vækkeord gemmes på gateway-maskinen på:

- `~/.openclaw/settings/voicewake.json`

Struktur:

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## Protokol

### Metoder

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set` med parametre `{ triggers: string[] }` → `{ triggers: string[] }`

Noter:

- Udløsere er normaliserede (trimmet, tomme droppet). Tomme lister falder tilbage til standardværdier.
- Grænser håndhæves af hensyn til sikkerhed (maks. antal/længde).

### Hændelser

- `voicewake.changed` payload `{ triggers: string[] }`

Hvem modtager den:

- Alle WebSocket-klienter (macOS-app, WebChat osv.)
- Alle tilsluttede noder (iOS/Android), samt ved nodeforbindelse som et indledende “aktuel tilstand”-push.

## Klientadfærd

### macOS-app

- Bruger den globale liste til at gate `VoiceWakeRuntime`-triggere.
- Redigering af “Trigger words” i indstillinger for Stemmeaktivering kalder `voicewake.set` og er derefter afhængig af udsendelsen for at holde andre klienter synkroniseret.

### iOS-node

- Bruger den globale liste til `VoiceWakeManager`-triggerdetektion.
- Redigering af Vækkeord i Indstillinger kalder `voicewake.set` (over Gateway WS) og holder også lokal detektion af vækkeord responsiv.

### Android-node

- Viser en editor til Vækkeord i Indstillinger.
- Kalder `voicewake.set` over Gateway WS, så ændringer synkroniseres overalt.
