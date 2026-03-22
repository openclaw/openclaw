# Jitsi Realtime Bridge

Dieser Prototyp setzt das Zielbild in einer ersten lauffaehigen Form um:

1. OpenClaw oder ein Telegram-Workflow kann einen Raum per HTTP anlegen.
2. Der Dienst erzeugt eine Jitsi-URL und merkt sich Briefings pro Raum.
3. Ein Joiner-Prozess tritt mit konfigurierbarer Bot-Identitaet einem Jitsi-Raum bei.
4. Eine Azure-Realtime-Bridge kann pro Raum Antworten mit Persona + Briefing erzeugen.
5. Der Joiner schleust Remote-Audio aus Jitsi in Azure Realtime und spielt Antwort-Audio in die lokale Meeting-Mikrofonspur zurück.

## Was der MVP bereits kann

- Jitsi-Raeume erzeugen und persistent speichern
- Briefings pro Raum speichern und spaeter erweitern
- Einen Joiner-Prozess fuer Jitsi mit konfigurierbarer Bot-Identitaet starten
- Azure Realtime direkt ueber `/realtime` statt `/responses` ansprechen
- Textantworten mit Persona- und Briefing-Kontext generieren
- Remote-Audio aus Jitsi in eine Azure-Realtime-Audio-Session senden
- Ruecklaufendes PCM-Audio aus Azure in den synthetischen Mikrofon-Track des Bot-Browsers einspeisen

## Was noch nicht fertig ist

- Native Telegram-Bot-Automation in diesem Modul
- Produktionsreifes Monitoring, Rekonnektion und Audioqualitaets-Tuning fuer lange Meetings

Der Dienst ist damit die richtige Basis fuer:

- Telegram/OpenClaw als Control Plane
- Jitsi als Meeting-Oberflaeche
- Azure Realtime als Konversationskern

## Umgebungsvariablen

```bash
export AZURE_OPENAI_REALTIME_BASE_URL="https://<resource>.openai.azure.com/openai/v1"
export AZURE_OPENAI_API_KEY="<key>"
export AZURE_OPENAI_REALTIME_MODEL="gpt-realtime-mini"

export JITSI_BASE_URL="https://meet.jit.si"
export JITSI_BOT_DISPLAY_NAME="Meeting Assistant"
export JITSI_INVITE_EMAIL="assistant@example.com"
export JITSI_BRIDGE_PORT="4318"
export JITSI_BRIDGE_PUBLIC_BASE_URL="http://192.168.179.3:4318"
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="/usr/bin/chromium"
```

Optional: zentrales Downstream-JSON (fuer Persona/Prompts/UI-Texte):

```bash
export OPENCLAW_JITSI_CONFIG_PATH="/etc/openclaw/jitsi-downstream-config.json"
```

Beispiel:

```json
{
  "identity": {
    "displayName": "Meeting Assistant",
    "inviteEmail": "assistant@example.com",
    "roomTopicFallback": "meeting-briefing"
  },
  "prompt": {
    "baseInstructions": [
      "Du bist ein technischer Meeting-Assistent in einem Business-Meeting.",
      "Sprich knapp, sachlich und in modernem Deutsch."
    ],
    "briefingTemplate": "Aktuelles Briefing fuer Raum {{roomId}}:\n{{briefing}}",
    "noBriefingTemplate": "Kein separates Briefing hinterlegt fuer Raum {{roomId}}."
  },
  "delegation": {
    "toolName": "delegate_to_openclaw_agent"
  },
  "telegramUi": {
    "createButton": "Neues Meeting",
    "emptyPanelHint": "Nutze den Button unten, um ein neues Meeting zu starten."
  }
}
```

## Start

```bash
pnpm jitsi-bridge:start
```

Healthcheck:

```bash
curl http://127.0.0.1:4318/health
```

## Raum anlegen

```bash
curl -X POST http://127.0.0.1:4318/rooms \
  -H 'content-type: application/json' \
  -d '{"topic":"Investor Briefing"}'
```

## Briefing setzen

```bash
curl -X POST http://127.0.0.1:4318/rooms/<room-id>/briefing \
  -H 'content-type: application/json' \
  -d '{"briefing":"Du vertrittst die Fugger-Perspektive und fragst nach Finanzierung, Risiko und Handelsnetz."}'
```

## Realtime-Antwort abrufen

```bash
curl -X POST http://127.0.0.1:4318/rooms/<room-id>/respond \
  -H 'content-type: application/json' \
  -d '{"prompt":"Wie sollten wir heute mit steigenden Zinsen umgehen?"}'
```

## Jitsi-Joiner starten

```bash
curl -X POST http://127.0.0.1:4318/rooms/<room-id>/join \
  -H 'content-type: application/json' \
  -d '{"headless":true}'
```

Der Joiner startet als separater Prozess und bleibt im Raum. Screenshots landen unter
`.artifacts/jitsi-realtime-bridge`.

## Host-Join mit Auto-Bot-Join

Wenn `JITSI_BRIDGE_PUBLIC_BASE_URL` gesetzt ist, liefert jeder Raum einen `startUrl`.
Der Ablauf ist dann:

1. Host oeffnet `startUrl`
2. Host klickt dort auf `Join`
3. Bridge startet den Bot-Joiner
4. Host wird direkt auf die echte Jitsi-URL weitergeleitet

Verfuegbare Endpunkte:

- `GET /meeting/<room-id>/start?token=<token>` zeigt die Join-Seite
- `GET /meeting/<room-id>/enter?token=<token>` startet Bot-Join + redirect auf Jitsi

## Direktprobe fuer Azure Realtime

```bash
pnpm jitsi-bridge:probe -- "Sag nur OK."
```

## Audio-Probe

Der implementierte Audio-Pfad wurde lokal mit synthetischer Sprache getestet:

- Eingang: PCM-Audio mit einer generierten Sprachfrage
- Verarbeitung: Azure Realtime `gpt-realtime-mini`
- Ausgang: echte Audio-Deltas und Audio-Transkript zurück

Die Jitsi-Seite nutzt dazu einen synthetischen Mikrofon-Track im Browser und zapft
Remote-Audioelemente auf der Meeting-Seite an.

## Naechster Ausbauschritt

Wenn der MVP stabil laeuft, folgt Phase 2:

- Telegram/OpenClaw-Werkzeug, das `POST /rooms`, `POST /briefing` und `POST /join` ausloest
- Zustandsüberwachung für aktive Joiner und Healthchecks pro Meeting
