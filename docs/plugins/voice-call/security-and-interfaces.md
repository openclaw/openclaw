---
summary: "Webhook security options and the CLI, agent tool, and Gateway RPC surfaces"
read_when:
  - You are putting a proxy or tunnel in front of the voice webhook
  - You are looking up a voicecall CLI command
  - You are calling voice-call over Gateway RPC or the agent tool
title: "Voice call security and interfaces"
sidebarTitle: "Security and interfaces"
---

Webhook signature and forwarding-header security, plus the CLI, agent tool, and Gateway RPC surfaces. Part of the [Voice call plugin](/plugins/voice-call) guide.

## Webhook security

When a proxy or tunnel sits in front of the Gateway, the plugin reconstructs
the public URL for signature verification. These options control which
forwarded headers are trusted:

<ParamField path="webhookSecurity.allowedHosts" type="string[]">
  Allowlist hosts from forwarding headers.
</ParamField>
<ParamField path="webhookSecurity.trustForwardingHeaders" type="boolean">
  Trust forwarded headers without an allowlist.
</ParamField>
<ParamField path="webhookSecurity.trustedProxyIPs" type="string[]">
  Only trust forwarded headers when the request remote IP matches the list.
</ParamField>

Additional protections:

- Webhook **replay protection** is enabled for Twilio, Telnyx, and Plivo. Replayed valid webhook requests are acknowledged but skipped for side effects.
- Twilio conversation turns include a per-turn token in `<Gather>` callbacks, so stale/replayed speech callbacks cannot satisfy a newer pending transcript turn.
- Unauthenticated webhook requests are rejected before body reads when the provider's required signature headers are missing.
- The voice-call webhook uses the shared pre-auth body-read profile (64 KB max body, 5-second read timeout) plus a per-key in-flight cap (8 concurrent requests per key by default) before signature verification.

Example with a stable public host:

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

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall start --to "+15555550123"   # alias for call
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall speak --call-id <id> --message "One moment"
openclaw voicecall dtmf --call-id <id> --digits "ww123456#"
openclaw voicecall end --call-id <id>
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw voicecall latency                      # summarize turn latency from logs
openclaw voicecall expose --mode funnel
```

When the Gateway is already running, operational `voicecall` commands
delegate to the Gateway-owned voice-call runtime so the CLI does not bind a
second webhook server. If no Gateway is reachable, the commands fall back to
a standalone CLI runtime.

`latency` reads persisted call records from SQLite by default. Use
`--file <path>` to read an existing custom JSONL log (with a basename other than
`calls.jsonl`) and `--last <n>` to limit
analysis to the last N records (default 200). Output includes min/max/avg,
p50, and p95 for turn latency and listen-wait times.

## Agent tool

Tool name: `voice_call`.

| Action          | Args                                       |
| --------------- | ------------------------------------------ |
| `initiate_call` | `message`, `to?`, `mode?`, `dtmfSequence?` |
| `continue_call` | `callId`, `message`                        |
| `speak_to_user` | `callId`, `message`                        |
| `send_dtmf`     | `callId`, `digits`                         |
| `end_call`      | `callId`                                   |
| `get_status`    | `callId`                                   |

The voice-call plugin ships a matching agent skill.

## Gateway RPC

| Method                      | Args                                                             | Notes                                                                     |
| --------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `voicecall.initiate`        | `to?`, `message`, `mode?`, `sessionKey?`, `requesterSessionKey?` | Falls back to `toNumber` config when `to` is omitted.                     |
| `voicecall.start`           | `to`, `message?`, `mode?`, `dtmfSequence?`, `sessionKey?`        | Same as `initiate` but also accepts pre-connect `dtmfSequence`.           |
| `voicecall.continue`        | `callId`, `message`                                              | Blocks until the turn resolves; returns the transcript.                   |
| `voicecall.continue.start`  | `callId`, `message`                                              | Async variant: returns an `operationId` immediately.                      |
| `voicecall.continue.result` | `operationId`                                                    | Polls a pending `voicecall.continue.start` operation for its result.      |
| `voicecall.speak`           | `callId`, `message`                                              | Speaks without waiting; uses the realtime bridge when `realtime.enabled`. |
| `voicecall.dtmf`            | `callId`, `digits`                                               |                                                                           |
| `voicecall.end`             | `callId`                                                         |                                                                           |
| `voicecall.status`          | `callId?`                                                        | Omit `callId` to list all active calls.                                   |

`dtmfSequence` is only valid with `mode: "conversation"`; notify-mode calls
should use `voicecall.dtmf` after the call exists if they need post-connect
digits.
