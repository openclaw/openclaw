---
summary: "Voice Call-plugin: udgående + indgående opkald via Twilio/Telnyx/Plivo (plugin-installation + konfiguration + CLI)"
read_when:
  - Du vil foretage et udgående taleopkald fra OpenClaw
  - Du konfigurerer eller udvikler voice-call-pluginet
title: "Voice Call-plugin"
x-i18n:
  source_path: plugins/voice-call.md
  source_hash: 46d05a5912b785d7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:36Z
---

# Voice Call (plugin)

Taleopkald til OpenClaw via et plugin. Understøtter udgående notifikationer og
samtaler i flere omgange med indgående politikker.

Nuværende udbydere:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML-overførsel + GetInput-tale)
- `mock` (dev/ingen netværk)

Hurtig mental model:

- Installér plugin
- Genstart Gateway
- Konfigurer under `plugins.entries.voice-call.config`
- Brug `openclaw voicecall ...` eller værktøjet `voice_call`

## Hvor det kører (lokalt vs. remote)

Voice Call-pluginet kører **inde i Gateway-processen**.

Hvis du bruger en remote Gateway, skal du installere/konfigurere pluginet på
**maskinen, der kører Gateway**, og derefter genstarte Gateway for at indlæse det.

## Installér

### Mulighed A: installér fra npm (anbefalet)

```bash
openclaw plugins install @openclaw/voice-call
```

Genstart Gateway bagefter.

### Mulighed B: installér fra en lokal mappe (dev, ingen kopiering)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

Genstart Gateway bagefter.

## Konfiguration

Sæt konfiguration under `plugins.entries.voice-call.config`:

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

Noter:

- Twilio/Telnyx kræver en **offentligt tilgængelig** webhook-URL.
- Plivo kræver en **offentligt tilgængelig** webhook-URL.
- `mock` er en lokal dev-udbyder (ingen netværkskald).
- `skipSignatureVerification` er kun til lokal test.
- Hvis du bruger ngrok free tier, skal du sætte `publicUrl` til den præcise ngrok-URL; signaturverifikation håndhæves altid.
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` tillader Twilio-webhooks med ugyldige signaturer **kun** når `tunnel.provider="ngrok"` og `serve.bind` er loopback (ngrok lokal agent). Brug kun til lokal udvikling.
- Ngrok free tier-URL’er kan ændre sig eller tilføje interstitiel adfærd; hvis `publicUrl` afviger, vil Twilio-signaturer fejle. Til produktion bør du foretrække et stabilt domæne eller Tailscale funnel.

## Webhook-sikkerhed

Når en proxy eller tunnel står foran Gateway, rekonstruerer pluginet den
offentlige URL til signaturverifikation. Disse indstillinger styrer, hvilke
videresendte headers der er tillid til.

`webhookSecurity.allowedHosts` tilladelseslister værter fra videresendte headers.

`webhookSecurity.trustForwardingHeaders` stoler på videresendte headers uden en tilladelsesliste.

`webhookSecurity.trustedProxyIPs` stoler kun på videresendte headers, når anmodningens
remote IP matcher listen.

Eksempel med en stabil offentlig vært:

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

## TTS til opkald

Voice Call bruger kerne-`messages.tts`-konfigurationen (OpenAI eller ElevenLabs)
til streamet tale på opkald. Du kan tilsidesætte den under plugin-konfigurationen
med **samme struktur** — den deep-merger med `messages.tts`.

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

Noter:

- **Edge TTS ignoreres for taleopkald** (telefoni-lyd kræver PCM; Edge-output er upålideligt).
- Kerne-TTS bruges, når Twilio media streaming er aktiveret; ellers falder opkald tilbage til udbyderens native stemmer.

### Flere eksempler

Brug kun kerne-TTS (ingen tilsidesættelse):

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

Tilsidesæt til ElevenLabs kun for opkald (bevar kernestandard andre steder):

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

Tilsidesæt kun OpenAI-modellen for opkald (deep-merge-eksempel):

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

## Indgående opkald

Indgående politik er som standard `disabled`. For at aktivere indgående opkald skal du sætte:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

Auto-svar bruger agent-systemet. Justér med:

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

## Agent-værktøj

Værktøjsnavn: `voice_call`

Handlinger:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

Dette repo leverer en matchende Skills-dokumentation på `skills/voice-call/SKILL.md`.

## Gateway RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
