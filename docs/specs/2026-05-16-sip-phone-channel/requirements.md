# Requirements — SIP phone channel

## Outcome

A new `phone` channel lets the openclaw assistant answer real phone calls via OpenAI Realtime API's GA SIP integration: inbound calls hit a SIP trunk, the Realtime API answers with `gpt-realtime-2`, the conversation is treated as a normal session (with tool calls, session keys, allowlists, channel routing) and ends with a transcript filed under `~/.openclaw/agents/<agentId>/sessions/`. The existing `extensions/voice-call` Twilio path coexists for outbound and SMS but is no longer the primary way to handle inbound voice.

## Users affected

- Operators who want a phone number their AI assistant can answer (personal hotline, "call my assistant").
- Channel routing — `src/channels/`, `src/routing/` — must learn about a `phone` channel kind.
- Pairing / DM allowlist — phone numbers feed into the same allowlist model as Telegram/WhatsApp/etc.
- `openclaw doctor` — surfaces SIP credential and number health.

## In scope

- New built-in channel `src/phone/` with SIP signaling proxy or, more practically, an OpenAI Realtime SIP endpoint configuration that registers the operator's SIP trunk credentials.
- Inbound: caller-ID → session key derivation; default `dmPolicy="pairing"` like other channels; pairing message played via TTS for unknown callers.
- Outbound: not in scope here (operator-initiated calling stays on `extensions/voice-call`).
- Per-session conversation routed through the same agent runtime as text channels (full tool-call support, transcripts saved, `/status` `/new` chat commands available via DTMF or by the agent reading them).
- Recording: opt-in per session (`phone.recording=on|off`), with consent prompt at call start when on.
- Number provisioning: docs only — operator brings their own SIP trunk (e.g., Twilio Programmable SIP, Telnyx, etc.).

## Out of scope

- Cold outbound dialing (a separate spec; the assistant placing a call on the operator's behalf needs a different consent + cost model).
- Replacing or removing `extensions/voice-call` — it remains for Twilio-specific SMS + ngrok-tunneled webhooks.
- SMS via SIP (some carriers bundle it; keep it on the existing Twilio path).
- IVR menus and complex call trees — keep the call surface as natural conversation only.

## Decisions

- Use OpenAI Realtime SIP integration rather than a custom SIP stack. Reason: it's GA, handles RTP/STUN/TURN, and ties to the same Realtime session shape used by Talk Mode.
- Reuse `dmPolicy="pairing"` semantics with phone numbers normalized to E.164. Reason: matches the inbound DM trust posture across all channels.
- Recording opt-in, not opt-out. Reason: legal exposure is asymmetric and consent rules vary by jurisdiction.
- Default reasoning effort `low` like Talk Mode. Reason: latency budget on a phone call is tight (~700ms human tolerance for response gaps).
