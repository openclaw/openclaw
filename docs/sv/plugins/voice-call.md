---
summary: "Röst­samtalsplugin: utgående + inkommande samtal via Twilio/Telnyx/Plivo (plugininstallation + konfiguration + CLI)"
read_when:
  - Du vill ringa ett utgående röstsamtal från OpenClaw
  - Du konfigurerar eller utvecklar voice-call‑pluginet
title: "Röstsamtalsplugin"
x-i18n:
  source_path: plugins/voice-call.md
  source_hash: 46d05a5912b785d7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:11Z
---

# Voice Call (plugin)

Röstsamtal för OpenClaw via ett plugin. Stöder utgående notifieringar och
flerstegs­konversationer med inkommande policyer.

Nuvarande leverantörer:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML-överföring + GetInput-tal)
- `mock` (dev/ingen nätverksåtkomst)

Snabb mental modell:

- Installera plugin
- Starta om Gateway
- Konfigurera under `plugins.entries.voice-call.config`
- Använd `openclaw voicecall ...` eller verktyget `voice_call`

## Var den körs (lokalt vs fjärr)

Röstsamtalspluginet körs **inuti Gateway-processen**.

Om du använder en fjärr-Gateway, installera/konfigurera pluginet på **maskinen som kör Gateway**, och starta sedan om Gateway för att läsa in det.

## Installera

### Alternativ A: installera från npm (rekommenderas)

```bash
openclaw plugins install @openclaw/voice-call
```

Starta om Gateway efteråt.

### Alternativ B: installera från en lokal mapp (dev, ingen kopiering)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

Starta om Gateway efteråt.

## Konfiguration

Ställ in konfiguration under `plugins.entries.voice-call.config`:

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

Noteringar:

- Twilio/Telnyx kräver en **offentligt nåbar** webhook-URL.
- Plivo kräver en **offentligt nåbar** webhook-URL.
- `mock` är en lokal dev‑leverantör (inga nätverksanrop).
- `skipSignatureVerification` är endast för lokal testning.
- Om du använder ngrok free tier, sätt `publicUrl` till den exakta ngrok‑URL:en; signaturverifiering tillämpas alltid.
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` tillåter Twilio‑webhooks med ogiltiga signaturer **endast** när `tunnel.provider="ngrok"` och `serve.bind` är loopback (ngrok lokal agent). Använd endast för lokal utveckling.
- URL:er i ngrok free tier kan ändras eller lägga till mellanliggande beteende; om `publicUrl` förändras kommer Twilio‑signaturer att misslyckas. För produktion, föredra en stabil domän eller Tailscale funnel.

## Webhook-säkerhet

När en proxy eller tunnel ligger framför Gateway återskapar pluginet den
offentliga URL:en för signaturverifiering. Dessa alternativ styr vilka vidarebefordrade
headers som betros.

`webhookSecurity.allowedHosts` tillåter värdar från vidarebefordrade headers via tillåtelselista.

`webhookSecurity.trustForwardingHeaders` litar på vidarebefordrade headers utan tillåtelselista.

`webhookSecurity.trustedProxyIPs` litar endast på vidarebefordrade headers när begärans
fjärr-IP matchar listan.

Exempel med en stabil publik värd:

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

## TTS för samtal

Voice Call använder kärnkonfigurationen `messages.tts` (OpenAI eller ElevenLabs) för
strömmande tal i samtal. Du kan åsidosätta den under pluginets konfiguration med
**samma struktur** — den djupsammanfogas med `messages.tts`.

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

Noteringar:

- **Edge TTS ignoreras för röstsamtal** (telefoni‑ljud kräver PCM; Edge‑utdata är opålitligt).
- Kärn‑TTS används när Twilio media streaming är aktiverat; annars faller samtal tillbaka till leverantörens inbyggda röster.

### Fler exempel

Använd endast kärn‑TTS (ingen åsidosättning):

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

Åsidosätt till ElevenLabs endast för samtal (behåll kärnstandard i övrigt):

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

Åsidosätt endast OpenAI‑modellen för samtal (exempel på djup‑sammanfogning):

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

## Inkommande samtal

Inkommande policy är som standard `disabled`. För att aktivera inkommande samtal, sätt:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

Autosvar använder agentsystemet. Finjustera med:

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

## Agentverktyg

Verktygsnamn: `voice_call`

Åtgärder:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

Detta repo levererar ett matchande Skills‑dokument på `skills/voice-call/SKILL.md`.

## Gateway-RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
