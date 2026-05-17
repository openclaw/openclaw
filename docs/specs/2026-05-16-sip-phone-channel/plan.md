# Plan — SIP phone channel

## Approach

Add `src/phone/` as a new built-in channel that registers a SIP trunk against OpenAI Realtime's SIP endpoint and surfaces inbound calls to the Gateway as `phone:<E.164>` session keys. The channel reuses the existing `src/agents/realtime/` runtime (from `2026-05-16-openai-realtime-talk-mode`) so the Realtime session, tool dispatch, and transcript persistence are shared. Allowlist + pairing flows go through `src/channels/` + `src/pairing/` exactly like Telegram/Discord/Slack today.

## Steps

1. Add `src/phone/sip-bridge.ts` — registers the operator's SIP credentials with OpenAI's Realtime SIP endpoint; emits `phone.callRing` / `phone.callAccepted` / `phone.callEnded` events into the Gateway event bus.
2. Add `src/phone/session.ts` — when a call rings, derive `sessionKey="phone:<E.164>"`, check allowlist, run pairing flow for unknown callers (TTS the pairing code, capture DTMF or spoken approval code back), then hand off to the Realtime runtime.
3. Add `src/phone/pairing.ts` — DTMF + voice approval flow; reuses `src/pairing/pairing-store.ts` so approvals carry to other channels.
4. Add `src/phone/transcripts.ts` — persist call audio + transcript under `~/.openclaw/agents/<agentId>/sessions/phone-<timestamp>.jsonl` and (optional) `.opus`. Honor the recording opt-in flag.
5. Channel registration: add `phone` to `src/channels/channel-config.ts` so allowlists, command gating, and conversation labels work consistently.
6. Routing: extend `src/routing/resolve-route.ts` to map `phone:<E.164>` to the right agent under the operator's `routing` config.
7. CLI: `openclaw phone status`, `openclaw phone pairing approve <code>`, `openclaw phone test --to <number>` (dry-run, no actual call).
8. Doctor: warn on missing SIP creds; warn when allowlist is empty AND `dmPolicy="open"`; warn when the SIP trunk's domain doesn't match its TLS cert.
9. Docs: `docs/channels/phone.mdx` + a deployment guide for at least one SIP provider as an example (no preference, but a worked example helps adoption).

## Dependencies / order

- Whole feature depends on `2026-05-16-openai-realtime-talk-mode` shipping `src/agents/realtime/`.
- Steps 1–2 (SIP bridge + session) block everything.
- Step 3 (pairing) blocks first-call usability.
- Steps 7–9 land after the core path works end-to-end.
