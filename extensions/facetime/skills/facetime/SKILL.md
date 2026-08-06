---
name: facetime
description: "Check FaceTime readiness, place explicit allowlisted outbound audio or video calls, inspect active calls, and hang up through the facetime_call tool. Use for FaceTime call requests and FaceTime call-status questions on the signed-in OpenClaw Mac."
metadata:
  { "openclaw": { "emoji": "📞", "requires": { "config": ["plugins.entries.facetime.enabled"] } } }
allowed-tools: facetime_call
---

# FaceTime

Use `facetime_call` for FaceTime operations. Do not use shell commands or the
generic `voice_call` tool for FaceTime.

## Outbound calls

1. Call `get_status`.
2. Refuse to start a second call while another call or dial is active.
3. Resolve the exact allowlisted email address or phone number. Ask when the
   target is ambiguous.
4. Use `initiate_call`. OpenClaw will ask the user for trusted, one-shot
   approval before the call runs.
5. Default to `audio`; use `video` only when the user explicitly requests it.
6. Report the returned state as pending or ringing. Do not claim the caller
   answered until a later `get_status` result shows an active call with
   `audioReady: true` and `realtimeActive: true`.

```json
{
  "action": "initiate_call",
  "handle": "owner@example.com",
  "mode": "audio"
}
```

## Inbound calls

Allowlisted inbound calls are answered automatically by the plugin. Do not try
to answer them manually. Use `get_status` to inspect the active call. Tell the
operator when an unexpected caller was ignored rather than changing the
allowlist.

## Readiness and failures

Use `check_readiness` when status shows disconnected helpers, routing errors, or
the user asks whether FaceTime is ready. Report failed checks and ask the
operator to run the guided `facetime.setup` workflow.

Never install or update the audio driver, alter SIP, change TCC permissions,
sign in to FaceTime, edit the allowlist, or modify System Settings. Those are
operator-only actions.

## Hang up

Use `end_call`. Pass `callUUID` when status returned one; omit it to end the
only active or pending call.

```json
{ "action": "end_call", "callUUID": "CALL-UUID" }
```
