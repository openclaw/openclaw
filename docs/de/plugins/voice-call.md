---
summary: "„Voice-Call-Plugin: ausgehende + eingehende Anrufe über Twilio/Telnyx/Plivo (Plugin-Installation + Konfiguration + CLI)“"
read_when:
  - Sie möchten einen ausgehenden Sprachanruf aus OpenClaw tätigen
  - Sie konfigurieren oder entwickeln das Voice-Call-Plugin
title: "„Voice-Call-Plugin“"
---

# Voice Call (Plugin)

Sprachanrufe für OpenClaw über ein Plugin. Unterstützt ausgehende Benachrichtigungen und
mehrturnige Konversationen mit eingehenden Richtlinien.

Aktuelle Anbieter:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML-Transfer + GetInput-Spracherkennung)
- `mock` (dev/kein Netzwerk)

Kurzes mentales Modell:

- Plugin installieren
- Gateway neu starten
- Unter `plugins.entries.voice-call.config` konfigurieren
- `openclaw voicecall ...` oder das Werkzeug `voice_call` verwenden

## Wo es läuft (lokal vs. remote)

Das Voice-Call-Plugin läuft **innerhalb des Gateway-Prozesses**.

Wenn Sie ein entferntes Gateway verwenden, installieren/konfigurieren Sie das Plugin auf der **Maschine, auf der das Gateway läuft**, und starten Sie anschließend das Gateway neu, um es zu laden.

## Installation

### Option A: Installation von npm (empfohlen)

```bash
openclaw plugins install @openclaw/voice-call
```

Starten Sie das Gateway anschließend neu.

### Option B: Installation aus einem lokalen Ordner (Entwicklung, kein Kopieren)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

Starten Sie das Gateway anschließend neu.

## Konfiguration

Setzen Sie die Konfiguration unter `plugins.entries.voice-call.config`:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio", // or "telnyx" | "plivo" | "mock"
          fromNumber: "+15550001234",
          toNumber: "+15550005678",

          twilio: {
            accountSid: "ACxxxxxxxx",
            authToken: "...",
          },

          plivo: {
            authId: "MAxxxxxxxxxxxxxxxxxxxx",
            authToken: "...",
          },

          // Webhook server
          serve: {
            port: 3334,
            path: "/voice/webhook",
          },

          // Webhook security (recommended for tunnels/proxies)
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
            trustedProxyIPs: ["100.64.0.1"],
          },

          // Public exposure (pick one)
          // publicUrl: "https://example.ngrok.app/voice/webhook",
          // tunnel: { provider: "ngrok" },
          // tailscale: { mode: "funnel", path: "/voice/webhook" }

          outbound: {
            defaultMode: "notify", // notify | conversation
          },

          streaming: {
            enabled: true,
            streamPath: "/voice/stream",
          },
        },
      },
    },
  },
}
```

Hinweise:

- Twilio/Telnyx erfordern eine **öffentlich erreichbare** Webhook-URL.
- Plivo erfordert eine **öffentlich erreichbare** Webhook-URL.
- `mock` ist ein lokaler Entwicklungsanbieter (keine Netzwerkanfragen).
- `skipSignatureVerification` ist nur für lokale Tests.
- Wenn Sie die kostenlose ngrok-Stufe verwenden, setzen Sie `publicUrl` auf die exakte ngrok-URL; die Signaturprüfung wird immer erzwungen.
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` erlaubt Twilio-Webhooks mit ungültigen Signaturen **nur**, wenn `tunnel.provider="ngrok"` und `serve.bind` Loopback ist (lokaler ngrok-Agent). Nur für lokale Entwicklung verwenden.
- URLs der kostenlosen ngrok-Stufe können sich ändern oder Zwischenseiten hinzufügen; wenn `publicUrl` abweicht, schlagen Twilio-Signaturen fehl. Für Produktion bevorzugen Sie eine stabile Domain oder einen Tailscale-Funnel.

## Webhook-Sicherheit

Wenn ein Proxy oder Tunnel vor dem Gateway sitzt, rekonstruiert das Plugin die
öffentliche URL zur Signaturprüfung. Diese Optionen steuern, welchen weitergeleiteten
Headern vertraut wird.

`webhookSecurity.allowedHosts` allowlistet Hosts aus Weiterleitungs-Headern.

`webhookSecurity.trustForwardingHeaders` vertraut weitergeleiteten Headern ohne Allowlist.

`webhookSecurity.trustedProxyIPs` vertraut weitergeleiteten Headern nur, wenn die Anfrage-
Remote-IP mit der Liste übereinstimmt.

Beispiel mit einem stabilen öffentlichen Host:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          publicUrl: "https://voice.example.com/voice/webhook",
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
          },
        },
      },
    },
  },
}
```

## TTS für Anrufe

Voice Call verwendet die Kernkonfiguration `messages.tts` (OpenAI oder ElevenLabs) für
Streaming-Sprachausgabe bei Anrufen. Sie können diese unter der Plugin-Konfiguration mit der
**gleichen Struktur** überschreiben — sie wird per Deep-Merge mit `messages.tts` zusammengeführt.

```json5
{
  tts: {
    provider: "elevenlabs",
    elevenlabs: {
      voiceId: "pMsXgVXv3BLzUgSXRplE",
      modelId: "eleven_multilingual_v2",
    },
  },
}
```

Hinweise:

- **Edge TTS wird für Sprachanrufe ignoriert** (Telefonaudio benötigt PCM; Edge-Ausgabe ist unzuverlässig).
- Core-TTS wird verwendet, wenn Twilio-Medienstreaming aktiviert ist; andernfalls greifen Anrufe auf native Stimmen des Anbieters zurück.

### Weitere Beispiele

Nur Core-TTS verwenden (keine Überschreibung):

```json5
{
  messages: {
    tts: {
      provider: "openai",
      openai: { voice: "alloy" },
    },
  },
}
```

Nur für Anrufe auf ElevenLabs überschreiben (Core-Standard beibehalten):

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            provider: "elevenlabs",
            elevenlabs: {
              apiKey: "elevenlabs_key",
              voiceId: "pMsXgVXv3BLzUgSXRplE",
              modelId: "eleven_multilingual_v2",
            },
          },
        },
      },
    },
  },
}
```

Nur das OpenAI-Modell für Anrufe überschreiben (Deep-Merge-Beispiel):

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            openai: {
              model: "gpt-4o-mini-tts",
              voice: "marin",
            },
          },
        },
      },
    },
  },
}
```

## Eingehende Anrufe

Die Richtlinie für eingehende Anrufe ist standardmäßig `disabled`. Um eingehende Anrufe zu aktivieren, setzen Sie:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

Automatische Antworten verwenden das Agent-System. Feinabstimmung mit:

- `responseModel`
- `responseSystemPrompt`
- `responseTimeoutMs`

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall speak --call-id <id> --message "One moment"
openclaw voicecall end --call-id <id>
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw voicecall expose --mode funnel
```

## Agent-Werkzeug

Werkzeugname: `voice_call`

Aktionen:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

Dieses Repository liefert eine passende Skill-Dokumentation unter `skills/voice-call/SKILL.md`.

## Gateway-RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
