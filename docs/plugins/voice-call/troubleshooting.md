---
summary: "Fixes for voice-call setup, webhooks, signatures, Meet dial-in, and silent calls"
read_when:
  - A voice call fails to place or webhooks never arrive
  - Webhook signature verification fails
  - A realtime call connects but nobody speaks
title: "Voice call troubleshooting"
sidebarTitle: "Troubleshooting"
---

Fixes for setup, webhook exposure, credentials, signature verification, Google Meet dial-in, and silent realtime calls. Part of the [Voice call plugin](/plugins/voice-call) guide.

## Troubleshooting

### Call placement fails to save its initial record

Voice Call saves the initial record before reserving a concurrency slot or
contacting the carrier. If that write fails, the placement reports the storage
error without dialing. Restore access to the state directory, then retry; the
failed placement does not consume `maxConcurrentCalls` capacity.

### Setup fails webhook exposure

Run setup from the same environment that runs the Gateway:

```bash
openclaw voicecall setup
openclaw voicecall setup --json
```

For `twilio`, `telnyx`, and `plivo`, `webhook-exposure` must be green. A
configured `publicUrl` still fails when it points at local or private
network space, because the carrier cannot call back into those addresses.
Do not use `localhost`, `127.0.0.1`, `0.0.0.0`, `10.x`, `172.16.x`-`172.31.x`,
`192.168.x`, `169.254.x`, `fc00::/7`, `fd00::/8`, or other carrier-grade-NAT
ranges as `publicUrl`.

Twilio notify-mode outbound calls send their initial `<Say>` TwiML directly
in the create-call request, so the first spoken message does not depend on
Twilio fetching webhook TwiML. A public webhook is still required for status
callbacks, conversation calls, pre-connect DTMF, realtime streams, and
post-connect call control.

Use one public exposure path:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          publicUrl: "https://voice.example.com/voice/webhook",
          // or
          tunnel: { provider: "ngrok" },
          // or
          tailscale: { mode: "funnel", port: 8443, path: "/voice/webhook" },
        },
      },
    },
  },
}
```

After changing config, restart or reload the Gateway, then run:

```bash
openclaw voicecall setup
openclaw voicecall smoke
```

`voicecall smoke` is a dry run unless you pass `--yes`.

### Provider credentials fail

Check the selected provider and the required credential fields:

- Twilio: `twilio.accountSid`, `twilio.authToken`, and `fromNumber`, or
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`.
- Telnyx: `telnyx.apiKey`, `telnyx.connectionId`, `telnyx.publicKey`, and
  `fromNumber`, or `TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`, and
  `TELNYX_PUBLIC_KEY`.
- Plivo: `plivo.authId`, `plivo.authToken`, and `fromNumber`, or
  `PLIVO_AUTH_ID` and `PLIVO_AUTH_TOKEN`.

Credentials must exist on the Gateway host. Editing a local shell profile
does not affect an already running Gateway until it restarts or reloads its
environment.

### Calls start but provider webhooks do not arrive

Confirm the provider console points at the exact public webhook URL:

```text
https://voice.example.com/voice/webhook
```

For a Twilio inbound number, configure both number-level callbacks in the
Twilio Console:

- **Voice webhook:** `https://voice.example.com/voice/webhook` using `POST`.
- **Status Callback:** `https://voice.example.com/voice/webhook?type=status` using `POST`.

Media Streams `stop`/WebSocket close handling is the primary auto-end path and
does not depend on the HTTP status callback. Twilio's optional `<Stream
statusCallback>` is a separate stream-diagnostic signal and is not required for
teardown. `openclaw voicecall setup` validates local configuration and webhook
exposure; it cannot inspect or change Twilio Console settings.

Then inspect runtime state:

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw logs --follow
```

Common causes:

- `publicUrl` does not match the public webhook URL configured with the provider. A reverse proxy may map that public path to a different `serve.path`, but `publicUrl` must remain the provider-facing URL.
- The tunnel URL changed after the Gateway started.
- A proxy forwards the request but strips or rewrites host/proto headers.
- Firewall or DNS routes the public hostname somewhere other than the Gateway.
- The Gateway was restarted without the Voice Call plugin enabled.

When a reverse proxy or tunnel is in front of the Gateway, set
`webhookSecurity.allowedHosts` to the public hostname, or use
`webhookSecurity.trustedProxyIPs` for a known proxy address. Use
`webhookSecurity.trustForwardingHeaders` only when the proxy boundary is
under your control.

### Signature verification fails

Twilio and Plivo URL signatures use `publicUrl` when it is configured: its
scheme, host, and path are preserved, while the request query is applied.
Without `publicUrl`, OpenClaw reconstructs the URL from the request. Telnyx
signatures do not include the request URL. If signatures fail:

- Confirm the provider webhook URL exactly matches `publicUrl`, including scheme, host, and path.
- For ngrok free-tier URLs, update `publicUrl` when the tunnel hostname changes.
- Ensure the proxy preserves the original host and proto headers, or configure `webhookSecurity.allowedHosts`.
- Do not enable `skipSignatureVerification` outside local testing.

### Google Meet Twilio joins fail

Google Meet uses this plugin for Twilio dial-in joins. First verify Voice
Call:

```bash
openclaw voicecall setup
openclaw voicecall smoke --to "+15555550123"
```

Then verify the Google Meet transport explicitly:

```bash
openclaw googlemeet setup --transport twilio
```

If Voice Call is green but the Meet participant never joins, check the Meet
dial-in number, PIN, and `--dtmf-sequence`. The phone call can be healthy
while the meeting rejects or ignores an incorrect DTMF sequence.

Google Meet starts the Twilio phone leg through `voicecall.start` with a
pre-connect DTMF sequence. PIN-derived sequences include the Google Meet
plugin's `voiceCall.dtmfDelayMs` (default **12000 ms**) as leading Twilio
wait digits, because Meet dial-in prompts can arrive late. Voice Call then
redirects back to realtime handling before the intro greeting is requested.

Use `openclaw logs --follow` for the live phase trace. A healthy Twilio Meet
join logs this order:

- Google Meet delegates the Twilio join to Voice Call.
- Voice Call stores pre-connect DTMF TwiML.
- Twilio initial TwiML is consumed and served before realtime handling.
- Voice Call serves realtime TwiML for the Twilio call.
- Google Meet requests intro speech with `voicecall.speak` after the post-DTMF delay.

`openclaw voicecall tail` still shows persisted call records; useful for
call state and transcripts, but not every webhook/realtime transition
appears there.

### Realtime call has no speech

Confirm only one audio mode is enabled: `realtime.enabled` and
`streaming.enabled` cannot both be true.

For realtime Twilio/Telnyx calls, also verify:

- A realtime provider plugin is loaded and registered.
- `realtime.provider` is unset or names a registered provider.
- The provider API key is available to the Gateway process.
- `openclaw logs --follow` shows realtime TwiML served, the realtime bridge started, and the initial greeting queued.
