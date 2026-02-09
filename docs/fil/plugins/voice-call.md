---
summary: "Voice Call plugin: outbound + inbound na mga tawag sa pamamagitan ng Twilio/Telnyx/Plivo (install ng plugin + config + CLI)"
read_when:
  - Gusto mong maglagay ng outbound na voice call mula sa OpenClaw
  - Kino-configure o dine-develop mo ang voice-call plugin
title: "Voice Call Plugin"
---

# Voice Call (plugin)

Mga voice call para sa OpenClaw sa pamamagitan ng isang plugin. Sumusuporta sa outbound notifications at mga multi-turn na pag-uusap na may inbound policies.

Mga kasalukuyang provider:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML transfer + GetInput speech)
- `mock` (dev/no network)

Mabilis na mental model:

- I-install ang plugin
- I-restart ang Gateway
- I-configure sa ilalim ng `plugins.entries.voice-call.config`
- Gamitin ang `openclaw voicecall ...` o ang `voice_call` tool

## Saan ito tumatakbo (local vs remote)

Ang Voice Call plugin ay tumatakbo **sa loob ng proseso ng Gateway**.

Kung gumagamit ka ng remote na Gateway, i-install/i-configure ang plugin sa **machine na nagpapatakbo ng Gateway**, pagkatapos ay i-restart ang Gateway para ma-load ito.

## Install

### Option A: mag-install mula npm (inirerekomenda)

```bash
openclaw plugins install @openclaw/voice-call
```

I-restart ang Gateway pagkatapos.

### Option B: mag-install mula sa local folder (dev, walang pagkopya)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

I-restart ang Gateway pagkatapos.

## Config

I-set ang config sa ilalim ng `plugins.entries.voice-call.config`:

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

Mga tala:

- Ang Twilio/Telnyx ay nangangailangan ng **publicly reachable** na webhook URL.
- Ang Plivo ay nangangailangan ng **publicly reachable** na webhook URL.
- Ang `mock` ay isang local dev provider (walang network calls).
- Ang `skipSignatureVerification` ay para sa local testing lamang.
- Kung gumagamit ka ng ngrok free tier, i-set ang `publicUrl` sa eksaktong ngrok URL; palaging ipinapatupad ang signature verification.
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` ay nagpapahintulot sa mga Twilio webhook na may invalid na mga signature **lamang** kapag `tunnel.provider="ngrok"` at ang `serve.bind` ay loopback (ngrok local agent). Gamitin lamang para sa lokal na development.
- Maaaring magbago o magdagdag ng interstitial behavior ang mga URL ng Ngrok free tier; kung mag-drift ang `publicUrl`, mabibigo ang mga Twilio signature. Para sa production, mas mainam ang isang stable na domain o Tailscale funnel.

## Webhook Security

When a proxy or tunnel sits in front of the Gateway, the plugin reconstructs the
public URL for signature verification. Kinokontrol ng mga opsyong ito kung aling mga forwarded header ang pinagkakatiwalaan.

Ang `webhookSecurity.allowedHosts` ay nag-a-allowlist ng mga host mula sa forwarding headers.

Ang `webhookSecurity.trustForwardingHeaders` ay nagtitiwala sa forwarded headers nang walang allowlist.

Ang `webhookSecurity.trustedProxyIPs` ay nagtitiwala lamang sa forwarded headers kapag ang request
remote IP ay tumutugma sa listahan.

Halimbawa gamit ang isang stable na public host:

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

## TTS para sa mga tawag

Gumagamit ang Voice Call ng core na `messages.tts` configuration (OpenAI o ElevenLabs) para sa streaming na pananalita sa mga tawag. Maaari mo itong i-override sa ilalim ng plugin config na may **parehong hugis** — ito ay nagde-deep‑merge sa `messages.tts`.

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

Mga tala:

- **Binabalewala ang Edge TTS para sa mga voice call** (kailangan ng telephony audio ang PCM; hindi maaasahan ang Edge output).
- Ginagamit ang core TTS kapag naka-enable ang Twilio media streaming; kung hindi, babagsak ang mga tawag sa native voices ng provider.

### Higit pang mga halimbawa

Gamitin ang core TTS lamang (walang override):

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

Mag-override sa ElevenLabs para sa mga tawag lamang (panatilihin ang core default sa iba):

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

I-override lamang ang OpenAI model para sa mga tawag (halimbawa ng deep‑merge):

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

## Inbound calls

Ang inbound policy ay default na `disabled`. Upang paganahin ang inbound calls, itakda:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

Auto-responses use the agent system. Tune with:

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

Pangalan ng tool: `voice_call`

Mga aksyon:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

Ang repo na ito ay may kasamang katugmang skill doc sa `skills/voice-call/SKILL.md`.

## Gateway RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
