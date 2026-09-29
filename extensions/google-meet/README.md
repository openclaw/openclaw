# @openclaw/google-meet

Official Google Meet participant plugin for OpenClaw.

This plugin registers the `google_meet` tool so agents can join Google Meet calls through supported Chrome or Twilio transports.

Managed Chrome sessions also read and send native Meet chat. Agent and bidi modes answer fresh requests in writing by default; transcribe mode remains observe-only. Manual sends use `google_meet` with `action: "send_chat"`, or `openclaw googlemeet send-chat <session-id> <text> --request-id <id>`. Stable request IDs prevent repeated sends, and existing drafts are preserved. See the [native chat documentation](https://docs.openclaw.ai/plugins/google-meet#native-meeting-chat) for source-bound voice replies and result guarantees.

## Install

```bash
openclaw plugins install @openclaw/google-meet
```

Restart the Gateway after installing or updating the plugin.

## Configure

Enable the plugin and follow the Google Meet docs for browser profile, transport, and call-join setup:

- https://docs.openclaw.ai/plugins/google-meet

## Package

- Plugin id: `google-meet`
- Tool: `google_meet`
- Package: `@openclaw/google-meet`
- Minimum OpenClaw host: `2026.4.20`
