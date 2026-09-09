---
summary: "Place outbound and accept inbound voice calls via Twilio, Telnyx, or Plivo, with optional realtime voice and streaming transcription"
read_when:
  - You want to place an outbound voice call from OpenClaw
  - You are configuring or developing the voice-call plugin
  - You need realtime voice or streaming transcription on telephony
title: "Voice call plugin"
sidebarTitle: "Voice call"
---

Voice calls for OpenClaw via a plugin: outbound notifications, multi-turn
conversations, full-duplex realtime voice, streaming transcription, and
inbound calls with allowlist policies.

**Providers:** `mock` (dev, no network), `plivo` (Voice API + XML transfer +
GetInput speech), `telnyx` (Call Control v2), `twilio` (Programmable Voice +
Media Streams).

<Note>
The Voice Call plugin runs **inside the Gateway process**. If you use a
remote Gateway, install and configure the plugin on the machine running the
Gateway, then restart the Gateway to load it.
</Note>

## Quick start

<Steps>
  <Step title="Install the plugin">
    <Tabs>
      <Tab title="From npm">
        ```bash
        openclaw plugins install @openclaw/voice-call
        ```
      </Tab>
      <Tab title="From a local folder (dev)">
        ```bash
        PLUGIN_SRC=./path/to/local/voice-call-plugin
        openclaw plugins install "$PLUGIN_SRC"
        cd "$PLUGIN_SRC" && pnpm install
        ```
      </Tab>
    </Tabs>

    Use the bare package to follow the current release tag. Pin an exact
    version only when you need a reproducible install. Restart the Gateway
    afterwards so the plugin loads.

  </Step>
  <Step title="Configure provider and webhook">
    Set config under `plugins.entries.voice-call.config` (see
    [Configuration](/plugins/voice-call/configuration)). At minimum: `provider`, provider
    credentials, `fromNumber`, and a publicly reachable webhook URL. With
    multiple agents, also set `agentId` to the agent that should own calls.

    For an inbound Twilio number, set its **Voice webhook** to the public Voice
    Call webhook URL with method `POST`. Set the number-level **Status
    Callback** to the same URL with `?type=status`, also using `POST`, so
    terminal inbound call statuses reach the plugin.

  </Step>
  <Step title="Verify setup">
    ```bash
    openclaw voicecall setup
    openclaw voicecall setup --json
    ```

    Checks plugin enablement, provider credentials, webhook exposure, agent
    ownership, and that only one audio mode (`streaming` or `realtime`) is active.

  </Step>
  <Step title="Smoke test">
    ```bash
    openclaw voicecall smoke
    openclaw voicecall smoke --to "+15555550123"
    ```

    Both are dry runs by default. Add `--yes` to place a short outbound
    notify call:

    ```bash
    openclaw voicecall smoke --to "+15555550123" --yes
    ```

  </Step>
</Steps>

<Warning>
For Twilio, Telnyx, and Plivo, setup must resolve to a **public webhook URL**.
If `publicUrl`, the tunnel URL, the Tailscale URL, or the serve fallback
resolves to loopback or private network space, setup fails instead of
starting a provider that cannot receive carrier webhooks.
</Warning>

## Where each section moved

Every section of the single-page version now lives on this page or on one of
the five child pages below. The anchors from the single-page version still
resolve here.

### Voice call configuration

[Voice call configuration](/plugins/voice-call/configuration) — plugin config keys, the call owner, the full config reference table, and session scope.

- <a id="configuration"></a>[Configuration](/plugins/voice-call/configuration#configuration)
- <a id="choose-the-call-owner"></a>[Choose the call owner](/plugins/voice-call/configuration#choose-the-call-owner)
- <a id="config-reference"></a>[Config reference](/plugins/voice-call/configuration#config-reference)
- <a id="provider-exposure-and-security-notes"></a>[Provider exposure and security notes](/plugins/voice-call/configuration#provider-exposure-and-security-notes)
- <a id="streaming-connection-caps"></a>[Streaming connection caps](/plugins/voice-call/configuration#streaming-connection-caps)
- <a id="legacy-config-migrations"></a>[Legacy config migrations](/plugins/voice-call/configuration#legacy-config-migrations)
- <a id="session-scope"></a>[Session scope](/plugins/voice-call/configuration#session-scope)

### Voice call realtime and streaming

[Voice call realtime and streaming](/plugins/voice-call/realtime-and-streaming) — full-duplex realtime voice, hangup detection, tool and consult policy, agent voice context, and Twilio Media Streams transcription.

- <a id="realtime-voice-conversations"></a>[Realtime voice conversations](/plugins/voice-call/realtime-and-streaming#realtime-voice-conversations)
- <a id="hangup-detection"></a>[Hangup detection](/plugins/voice-call/realtime-and-streaming#hangup-detection)
- <a id="tool-policy"></a>[Tool policy](/plugins/voice-call/realtime-and-streaming#tool-policy)
- <a id="agent-voice-context"></a>[Agent voice context](/plugins/voice-call/realtime-and-streaming#agent-voice-context)
- <a id="realtime-provider-examples"></a>[Realtime provider examples](/plugins/voice-call/realtime-and-streaming#realtime-provider-examples)
- <a id="google-gemini-live"></a>[Google Gemini Live](/plugins/voice-call/realtime-and-streaming#google-gemini-live)
- <a id="openai"></a>[OpenAI realtime example](/plugins/voice-call/realtime-and-streaming#openai)
- <a id="streaming-transcription"></a>[Streaming transcription](/plugins/voice-call/realtime-and-streaming#streaming-transcription)
- <a id="streaming-provider-examples"></a>[Streaming provider examples](/plugins/voice-call/realtime-and-streaming#streaming-provider-examples)
- <a id="openai-2"></a>[OpenAI streaming example](/plugins/voice-call/realtime-and-streaming#openai-2)
- <a id="xai"></a>[xAI](/plugins/voice-call/realtime-and-streaming#xai)

### Voice call TTS and inbound calls

[Voice call TTS and inbound calls](/plugins/voice-call/tts-and-inbound-calls) — telephony text-to-speech, inbound policy and per-number routing, the spoken output contract, conversation startup, and the stale call reaper.

- <a id="tts-for-calls"></a>[TTS for calls](/plugins/voice-call/tts-and-inbound-calls#tts-for-calls)
- <a id="tts-examples"></a>[TTS examples](/plugins/voice-call/tts-and-inbound-calls#tts-examples)
- <a id="core-tts-only"></a>[Core TTS only](/plugins/voice-call/tts-and-inbound-calls#core-tts-only)
- <a id="override-to-elevenlabs-calls-only"></a>[Override to ElevenLabs (calls only)](/plugins/voice-call/tts-and-inbound-calls#override-to-elevenlabs-calls-only)
- <a id="openai-model-override-deep-merge"></a>[OpenAI model override (deep-merge)](/plugins/voice-call/tts-and-inbound-calls#openai-model-override-deep-merge)
- <a id="inbound-calls"></a>[Inbound calls](/plugins/voice-call/tts-and-inbound-calls#inbound-calls)
- <a id="per-number-routing"></a>[Per-number routing](/plugins/voice-call/tts-and-inbound-calls#per-number-routing)
- <a id="spoken-output-contract"></a>[Spoken output contract](/plugins/voice-call/tts-and-inbound-calls#spoken-output-contract)
- <a id="conversation-startup-behavior"></a>[Conversation startup behavior](/plugins/voice-call/tts-and-inbound-calls#conversation-startup-behavior)
- <a id="twilio-stream-disconnect-grace"></a>[Twilio stream disconnect grace](/plugins/voice-call/tts-and-inbound-calls#twilio-stream-disconnect-grace)
- <a id="stale-call-reaper"></a>[Stale call reaper](/plugins/voice-call/tts-and-inbound-calls#stale-call-reaper)

### Voice call security and interfaces

[Voice call security and interfaces](/plugins/voice-call/security-and-interfaces) — webhook signature and forwarding-header security, plus the CLI, agent tool, and Gateway RPC surfaces.

- <a id="webhook-security"></a>[Webhook security](/plugins/voice-call/security-and-interfaces#webhook-security)
- <a id="param-webhook-security-allowed-hosts"></a>[webhookSecurity.allowedHosts](/plugins/voice-call/security-and-interfaces#param-webhook-security-allowed-hosts)
- <a id="param-webhook-security-trust-forwarding-headers"></a>[webhookSecurity.trustForwardingHeaders](/plugins/voice-call/security-and-interfaces#param-webhook-security-trust-forwarding-headers)
- <a id="param-webhook-security-trusted-proxy-ips"></a>[webhookSecurity.trustedProxyIPs](/plugins/voice-call/security-and-interfaces#param-webhook-security-trusted-proxy-ips)
- <a id="cli"></a>[CLI](/plugins/voice-call/security-and-interfaces#cli)
- <a id="agent-tool"></a>[Agent tool](/plugins/voice-call/security-and-interfaces#agent-tool)
- <a id="gateway-rpc"></a>[Gateway RPC](/plugins/voice-call/security-and-interfaces#gateway-rpc)

### Voice call troubleshooting

[Voice call troubleshooting](/plugins/voice-call/troubleshooting) — fixes for setup, webhook exposure, credentials, signature verification, Google Meet dial-in, and silent realtime calls.

- <a id="troubleshooting"></a>[Troubleshooting](/plugins/voice-call/troubleshooting#troubleshooting)
- <a id="call-placement-fails-to-save-its-initial-record"></a>[Call placement fails to save its initial record](/plugins/voice-call/troubleshooting#call-placement-fails-to-save-its-initial-record)
- <a id="setup-fails-webhook-exposure"></a>[Setup fails webhook exposure](/plugins/voice-call/troubleshooting#setup-fails-webhook-exposure)
- <a id="provider-credentials-fail"></a>[Provider credentials fail](/plugins/voice-call/troubleshooting#provider-credentials-fail)
- <a id="calls-start-but-provider-webhooks-do-not-arrive"></a>[Calls start but provider webhooks do not arrive](/plugins/voice-call/troubleshooting#calls-start-but-provider-webhooks-do-not-arrive)
- <a id="signature-verification-fails"></a>[Signature verification fails](/plugins/voice-call/troubleshooting#signature-verification-fails)
- <a id="google-meet-twilio-joins-fail"></a>[Google Meet Twilio joins fail](/plugins/voice-call/troubleshooting#google-meet-twilio-joins-fail)
- <a id="realtime-call-has-no-speech"></a>[Realtime call has no speech](/plugins/voice-call/troubleshooting#realtime-call-has-no-speech)

## Related

- [Talk mode](/nodes/talk)
- [Text-to-speech](/tools/tts)
- [Voice wake](/nodes/voicewake)
- [Google Meet plugin](/plugins/google-meet) - Meet calls, including Twilio sessions delegated through Voice Call
