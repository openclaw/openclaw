---
summary: "Voice Call-plugin: uitgaande + inkomende gesprekken via Twilio/Telnyx/Plivo (plugin-installatie + configuratie + CLI)"
read_when:
  - Je wilt een uitgaand spraakgesprek plaatsen vanuit OpenClaw
  - Je bent de voice-call plugin aan het configureren of ontwikkelen
title: "Voice Call-plugin"
---

# Voice Call (plugin)

Spraakgesprekken voor OpenClaw via een plugin. Ondersteunt uitgaande notificaties en
meerturn-gesprekken met inkomend beleid.

Huidige providers:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML transfer + GetInput-spraak)
- `mock` (dev/geen netwerk)

Snel mentaal model:

- Plugin installeren
- Gateway herstarten
- Configureren onder `plugins.entries.voice-call.config`
- Gebruik `openclaw voicecall ...` of de `voice_call` tool

## Waar het draait (lokaal vs. op afstand)

De Voice Call-plugin draait **binnen het Gateway-proces**.

Als je een Gateway op afstand gebruikt, installeer/configureer de plugin op de **machine waarop de Gateway draait**, en herstart daarna de Gateway om deze te laden.

## Installeren

### Optie A: installeren vanaf npm (aanbevolen)

```bash
openclaw plugins install @openclaw/voice-call
```

Herstart daarna de Gateway.

### Optie B: installeren vanuit een lokale map (dev, geen kopiëren)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

Herstart daarna de Gateway.

## Configuratie

Stel de config in onder `plugins.entries.voice-call.config`:

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

Notities:

- Twilio/Telnyx vereisen een **publiek bereikbaar** webhook-URL.
- Plivo vereist een **publiek bereikbaar** webhook-URL.
- `mock` is een lokale dev-provider (geen netwerkcalls).
- `skipSignatureVerification` is alleen voor lokaal testen.
- Als je ngrok free tier gebruikt, stel `publicUrl` in op de exacte ngrok-URL; handtekeningverificatie wordt altijd afgedwongen.
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` staat Twilio-webhooks met ongeldige handtekeningen **alleen** toe wanneer `tunnel.provider="ngrok"` en `serve.bind` loopback is (ngrok local agent). Gebruik dit alleen voor lokale ontwikkeling.
- Ngrok free tier-URL’s kunnen wijzigen of interstitiële stappen toevoegen; als `publicUrl` afwijkt, zullen Twilio-handtekeningen falen. Geef voor productie de voorkeur aan een stabiel domein of een Tailscale-funnel.

## Webhook-beveiliging

Wanneer een proxy of tunnel vóór de Gateway staat, reconstrueert de plugin de
publieke URL voor handtekeningverificatie. Deze opties bepalen welke doorgestuurde
headers worden vertrouwd.

`webhookSecurity.allowedHosts` stelt een toegestane lijst in van hosts uit forwarding-headers.

`webhookSecurity.trustForwardingHeaders` vertrouwt forwarding-headers zonder toegestane lijst.

`webhookSecurity.trustedProxyIPs` vertrouwt forwarding-headers alleen wanneer het
remote IP van het verzoek overeenkomt met de lijst.

Voorbeeld met een stabiele publieke host:

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

## TTS voor gesprekken

Voice Call gebruikt de kernconfiguratie `messages.tts` (OpenAI of ElevenLabs) voor
streaming spraak tijdens gesprekken. Je kunt dit overschrijven onder de pluginconfig
met **dezelfde vorm** — het wordt diep samengevoegd met `messages.tts`.

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

Notities:

- **Edge TTS wordt genegeerd voor spraakgesprekken** (telefonie-audio vereist PCM; Edge-uitvoer is onbetrouwbaar).
- Kern-TTS wordt gebruikt wanneer Twilio media streaming is ingeschakeld; anders vallen gesprekken terug op de native stemmen van de provider.

### Meer voorbeelden

Alleen kern-TTS gebruiken (geen override):

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

Alleen voor gesprekken overschakelen naar ElevenLabs (kern-standaard elders behouden):

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

Alleen het OpenAI-model voor gesprekken overschrijven (deep‑merge-voorbeeld):

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

## Inkomende oproepen

Het inkomende beleid staat standaard op `disabled`. Om inkomende gesprekken in te schakelen, stel in:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

Automatische antwoorden gebruiken het agentsysteem. Afstellen met:

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

## Agent tool

Toolnaam: `voice_call`

Acties:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

Deze repo levert een bijbehorend skill-document op `skills/voice-call/SKILL.md`.

## Gateway RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
