---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Voice Call plugin: outbound + inbound calls via Twilio/Telnyx/Plivo (plugin install + config + CLI)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to place an outbound voice call from OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are configuring or developing the voice-call plugin（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Voice Call Plugin"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Voice Call (plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Voice calls for OpenClaw via a plugin. Supports outbound notifications and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
multi-turn conversations with inbound policies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Current providers:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `twilio` (Programmable Voice + Media Streams)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `telnyx` (Call Control v2)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `plivo` (Voice API + XML transfer + GetInput speech)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `mock` (dev/no network)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick mental model:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install plugin（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Restart Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Configure under `plugins.entries.voice-call.config`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `openclaw voicecall ...` or the `voice_call` tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Where it runs (local vs remote)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Voice Call plugin runs **inside the Gateway process**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you use a remote Gateway, install/configure the plugin on the **machine running the Gateway**, then restart the Gateway to load it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Option A: install from npm (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install @openclaw/voice-call（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Restart the Gateway afterwards.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Option B: install from a local folder (dev, no copying)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install ./extensions/voice-call（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd ./extensions/voice-call && pnpm install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Restart the Gateway afterwards.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set config under `plugins.entries.voice-call.config`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  plugins: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    entries: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "voice-call": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        config: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          provider: "twilio", // or "telnyx" | "plivo" | "mock"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          fromNumber: "+15550001234",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          toNumber: "+15550005678",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          twilio: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            accountSid: "ACxxxxxxxx",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            authToken: "...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          plivo: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            authId: "MAxxxxxxxxxxxxxxxxxxxx",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            authToken: "...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // Webhook server（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          serve: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            port: 3334,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            path: "/voice/webhook",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // Webhook security (recommended for tunnels/proxies)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          webhookSecurity: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            allowedHosts: ["voice.example.com"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            trustedProxyIPs: ["100.64.0.1"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // Public exposure (pick one)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // publicUrl: "https://example.ngrok.app/voice/webhook",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // tunnel: { provider: "ngrok" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // tailscale: { mode: "funnel", path: "/voice/webhook" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          outbound: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            defaultMode: "notify", // notify | conversation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          streaming: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            streamPath: "/voice/stream",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Twilio/Telnyx require a **publicly reachable** webhook URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plivo requires a **publicly reachable** webhook URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `mock` is a local dev provider (no network calls).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `skipSignatureVerification` is for local testing only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you use ngrok free tier, set `publicUrl` to the exact ngrok URL; signature verification is always enforced.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` allows Twilio webhooks with invalid signatures **only** when `tunnel.provider="ngrok"` and `serve.bind` is loopback (ngrok local agent). Use for local dev only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ngrok free tier URLs can change or add interstitial behavior; if `publicUrl` drifts, Twilio signatures will fail. For production, prefer a stable domain or Tailscale funnel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Webhook Security（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a proxy or tunnel sits in front of the Gateway, the plugin reconstructs the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
public URL for signature verification. These options control which forwarded（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
headers are trusted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`webhookSecurity.allowedHosts` allowlists hosts from forwarding headers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`webhookSecurity.trustForwardingHeaders` trusts forwarded headers without an allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`webhookSecurity.trustedProxyIPs` only trusts forwarded headers when the request（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
remote IP matches the list.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example with a stable public host:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  plugins: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    entries: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "voice-call": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        config: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          publicUrl: "https://voice.example.com/voice/webhook",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          webhookSecurity: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            allowedHosts: ["voice.example.com"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## TTS for calls（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Voice Call uses the core `messages.tts` configuration (OpenAI or ElevenLabs) for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
streaming speech on calls. You can override it under the plugin config with the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**same shape** — it deep‑merges with `messages.tts`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    provider: "elevenlabs",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    elevenlabs: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      voiceId: "pMsXgVXv3BLzUgSXRplE",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      modelId: "eleven_multilingual_v2",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Edge TTS is ignored for voice calls** (telephony audio needs PCM; Edge output is unreliable).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Core TTS is used when Twilio media streaming is enabled; otherwise calls fall back to provider native voices.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### More examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use core TTS only (no override):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  messages: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      provider: "openai",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      openai: { voice: "alloy" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Override to ElevenLabs just for calls (keep core default elsewhere):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  plugins: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    entries: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "voice-call": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        config: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          tts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            provider: "elevenlabs",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            elevenlabs: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              apiKey: "elevenlabs_key",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              voiceId: "pMsXgVXv3BLzUgSXRplE",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              modelId: "eleven_multilingual_v2",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Override only the OpenAI model for calls (deep‑merge example):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  plugins: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    entries: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "voice-call": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        config: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          tts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            openai: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              model: "gpt-4o-mini-tts",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              voice: "marin",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Inbound calls（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inbound policy defaults to `disabled`. To enable inbound calls, set:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  inboundPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  allowFrom: ["+15550001234"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  inboundGreeting: "Hello! How can I help?",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Auto-responses use the agent system. Tune with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `responseModel`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `responseSystemPrompt`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `responseTimeoutMs`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall continue --call-id <id> --message "Any questions?"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall speak --call-id <id> --message "One moment"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall end --call-id <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall status --call-id <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall tail（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall expose --mode funnel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Agent tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tool name: `voice_call`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Actions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `initiate_call` (message, to?, mode?)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `continue_call` (callId, message)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `speak_to_user` (callId, message)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `end_call` (callId)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `get_status` (callId)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This repo ships a matching skill doc at `skills/voice-call/SKILL.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway RPC（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `voicecall.initiate` (`to?`, `message`, `mode?`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `voicecall.continue` (`callId`, `message`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `voicecall.speak` (`callId`, `message`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `voicecall.end` (`callId`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `voicecall.status` (`callId`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
