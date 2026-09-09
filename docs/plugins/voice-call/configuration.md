---
summary: "Plugin config keys, the call owner, the config reference table, and session scope"
read_when:
  - You are setting up voice-call plugin config keys
  - You need the default for a voice-call config key
  - You are choosing how call sessions are scoped
title: "Voice call configuration"
sidebarTitle: "Configuration"
---

Plugin config keys, the call owner, the full config reference table, and session scope. Part of the [Voice call plugin](/plugins/voice-call) guide.

## Configuration

If `enabled: true` but the selected provider is missing credentials, Gateway
startup logs a setup-incomplete warning with the missing keys and skips
starting the runtime. Commands, RPC calls, and agent tools still return the
exact missing configuration when used.

<Note>
Voice-call credentials accept SecretRefs. `plugins.entries.voice-call.config.twilio.authToken`, `plugins.entries.voice-call.config.realtime.providers.*.apiKey`, `plugins.entries.voice-call.config.streaming.providers.*.apiKey`, and `plugins.entries.voice-call.config.tts.providers.*.apiKey` resolve through the standard SecretRef surface; see [SecretRef credential surface](/reference/secretref-credential-surface).
</Note>

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio", // or "telnyx" | "plivo" | "mock"
          fromNumber: "+15550001234", // or TWILIO_FROM_NUMBER for Twilio
          toNumber: "+15550005678",
          sessionScope: "per-phone", // per-phone | per-call | main
          numbers: {
            "+15550009999": {
              inboundGreeting: "Silver Fox Cards, how can I help?",
              responseSystemPrompt: "You are a concise baseball card specialist.",
              tts: {
                providers: {
                  openai: { speakerVoice: "alloy" },
                },
              },
            },
          },

          twilio: {
            accountSid: "ACxxxxxxxx",
            authToken: "...",
            // region: "ie1", // optional: us1 | ie1 | au1; defaults to us1
          },
          telnyx: {
            apiKey: "...",
            connectionId: "...",
            // Telnyx webhook public key from the Mission Control Portal
            // (Base64; can also be set via TELNYX_PUBLIC_KEY).
            publicKey: "...",
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
          // tailscale: { mode: "funnel", port: 8443, path: "/voice/webhook" },

          outbound: {
            defaultMode: "notify", // notify | conversation
          },

          streaming: { enabled: true /* Twilio only; see Streaming transcription */ },
          realtime: { enabled: false /* see Realtime voice conversations */ },
        },
      },
    },
  },
}
```

### Choose the call owner

With one configured agent, Voice Call uses that agent automatically. With
multiple agents, set `plugins.entries.voice-call.config.agentId` to the intended
response and session owner. `main` is an ordinary agent ID, not a fallback for
a multi-agent fleet. Per-number routes may choose different agents for inbound
calls, but do not replace the plugin's startup owner.

If startup reports that Voice Call has no explicit owner, list your agents with
`openclaw agents list`, set the existing `agentId` field, and rerun
`openclaw voicecall setup`. Restart the Gateway after updating its configuration.
Existing legacy default-agent selection is preserved; new multi-agent setups
should use an explicit owner. See [Agent configuration](/gateway/config-agents).

### Config reference

Top-level keys under `plugins.entries.voice-call.config` not shown above:

| Key                             | Default      | Notes                                                                                                                           |
| ------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                       | `false`      | Master on/off switch.                                                                                                           |
| `inboundPolicy`                 | `"disabled"` | `disabled` \| `allowlist` \| `pairing` \| `open`. See [Inbound calls](/plugins/voice-call/tts-and-inbound-calls#inbound-calls). |
| `allowFrom`                     | `[]`         | E.164 allowlist for `inboundPolicy: "allowlist"`.                                                                               |
| `maxDurationSeconds`            | `300`        | Hard per-call duration cap, enforced regardless of answered state.                                                              |
| `staleCallReaperSeconds`        | `120`        | See [Stale call reaper](/plugins/voice-call/tts-and-inbound-calls#stale-call-reaper). `0` disables it.                          |
| `silenceTimeoutMs`              | `800`        | End-of-speech silence detection for the classic (non-realtime) flow.                                                            |
| `transcriptTimeoutMs`           | `180000`     | Max wait for a caller transcript before giving up on a turn.                                                                    |
| `ringTimeoutMs`                 | `30000`      | Ring timeout for outbound calls.                                                                                                |
| `maxConcurrentCalls`            | `1`          | Outbound calls beyond this limit are rejected.                                                                                  |
| `outbound.notifyHangupDelaySec` | `3`          | Seconds to wait after TTS before auto-hangup in notify mode.                                                                    |
| `skipSignatureVerification`     | `false`      | Local testing only; never enable in production.                                                                                 |
| `store`                         | unset        | Overrides the default `$OPENCLAW_STATE_DIR/voice-calls` path (normally `~/.openclaw/voice-calls`).                              |
| `agentId`                       | sole agent   | Agent used for response generation and session storage. Set explicitly with multiple agents.                                    |
| `responseModel`                 | unset        | Overrides the default model for classic (non-realtime) responses.                                                               |
| `responseSystemPrompt`          | generated    | Custom system prompt for classic responses.                                                                                     |
| `responseTimeoutMs`             | `30000`      | Timeout for classic response generation (ms).                                                                                   |

Twilio defaults to its US1 REST endpoint. To process calls in a supported
non-US Region, set `twilio.region` to `ie1` or `au1` and use credentials from
that Region. See
[Twilio's non-US REST API guide](https://www.twilio.com/docs/global-infrastructure/using-the-twilio-rest-api-in-a-non-us-region).

<AccordionGroup>
  <Accordion title="Provider exposure and security notes">
    - Twilio, Telnyx, and Plivo all require a **publicly reachable** webhook URL.
    - `mock` is a local dev provider (no network calls).
    - Telnyx requires `telnyx.publicKey` (or `TELNYX_PUBLIC_KEY`) unless `skipSignatureVerification` is true.
    - `skipSignatureVerification` is for local testing only.
    - On ngrok free tier, set `publicUrl` to the exact ngrok URL; signature verification is always enforced.
    - `tunnel.allowNgrokFreeTierLoopbackBypass: true` allows Twilio webhooks with invalid signatures **only** when `tunnel.provider="ngrok"` and `serve.bind` is loopback (ngrok local agent). Local dev only.
    - Ngrok free-tier URLs can change or add interstitial behavior; if `publicUrl` drifts, Twilio signatures fail. Production: prefer a stable domain or a Tailscale funnel.
    - Tailscale Serve and Funnel automatically expose the realtime or streaming WebSocket path when that audio mode is enabled.
    - `tailscale.port` selects the external HTTPS port for both `tailscale.mode` and unified `tunnel.provider: "tailscale-serve" | "tailscale-funnel"`. It defaults to `443`; use `8443` when another HTTPS server owns port 443. Funnel accepts only `443`, `8443`, or `10000`, while Serve accepts any valid TCP port. Non-default ports appear in the webhook and realtime stream URLs.

  </Accordion>
  <Accordion title="Streaming connection caps">
    - `streaming.preStartTimeoutMs` (default `5000`) closes sockets that never send a valid `start` frame.
    - `streaming.maxPendingConnections` (default `32`) caps total unauthenticated pre-start sockets.
    - `streaming.maxPendingConnectionsPerIp` (default `4`) caps unauthenticated pre-start sockets per source IP.
    - `streaming.maxConnections` (default `128`) caps all open media stream sockets (pending + active).

  </Accordion>
  <Accordion title="Legacy config migrations">
    Run `openclaw doctor --fix` to rewrite these legacy keys to the canonical
    shape. The Voice Call plugin owns the migration; runtime config parsing
    accepts only the current keys. When both old and current settings exist,
    Doctor keeps the current setting, removes the legacy key, and reports which
    destination it retained. Legacy values fill only missing current fields:

    - `provider: "log"` → `provider: "mock"`
    - `twilio.from` → `fromNumber`
    - `streaming.sttProvider` → `streaming.provider`
    - `streaming.openaiApiKey` → `streaming.providers.openai.apiKey`
    - `streaming.sttModel` → `streaming.providers.openai.model`
    - `streaming.silenceDurationMs` → `streaming.providers.openai.silenceDurationMs`
    - `streaming.vadThreshold` → `streaming.providers.openai.vadThreshold`
    - `realtime.agentContext.includeSystemPrompt` is removed (realtime context now uses the generated agent prompt)

  </Accordion>
</AccordionGroup>

## Session scope

By default, Voice Call uses `sessionScope: "per-phone"` so repeat calls from
the same caller keep conversation memory. Set `sessionScope: "per-call"` when
each carrier call should start with fresh context, for example reception,
booking, IVR, or Google Meet bridge flows where the same phone number may
represent different meetings.

Set `sessionScope: "main"` to route every call into the configured agent's main
session, `agent:<agentId>:main`, or `global` when core `session.scope` is
`"global"`. Custom core `session.mainKey` values are ignored. Raw call turns
then share history with the agent's primary session, so use this only when
that shared context is intentional.

For `per-phone` and `per-call`, Voice Call stores generated session keys under
the configured agent namespace (`agent:<agentId>:voice:*`). Raw explicit
integration keys resolve into the same namespace: a canonical
`agent:<configuredAgentId>:*` key keeps that owner and honors core
main-session/global-scope aliasing; foreign or malformed `agent:*` input
is scoped as an opaque key under the configured agent; `global` and `unknown`
remain global sentinels.
