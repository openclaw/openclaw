# @openclaw/anvil-voice-plugin

Bundled Anvil Voice realtime provider for OpenClaw Talk and Voice Call.

Provider id: `anvil`
Transport: `gateway-relay`
Audio: browser relay PCM16 24 kHz or Voice Call G.711 mu-law 8 kHz, adapted to Anvil Voice PCM16 16 kHz

Docs: `https://docs.openclaw.ai/providers/anvil-voice`
Plugin system: `https://docs.openclaw.ai/tools/plugin`

## Config

Same-host Anvil Voice:

```json5
{
  talk: {
    realtime: {
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "anvil",
      providers: {
        anvil: {
          realtimeUrl: "ws://127.0.0.1:8765/v1/realtime",
          model: "fast-local",
        },
      },
    },
  },
}
```

Remote Anvil Voice:

```json5
{
  talk: {
    realtime: {
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "anvil",
      providers: {
        anvil: {
          baseUrl: "https://anvil-voice.example.com",
          apiKey: { source: "env", provider: "default", id: "ANVIL_ROUTER_TOKEN" },
          model: "fast-local",
        },
      },
    },
  },
}
```

## Notes

- Local examples use `127.0.0.1`.
- Plain `ws://` is allowed only for loopback, private, `.local`, or `.ts.net` endpoints.
- Public endpoints should use `wss://`.
- API keys can be plaintext strings or SecretRef objects; prefer SecretRefs for non-loopback deployments.
