# Validation — SIP phone channel

## Automated tests

- `src/phone/sip-bridge.test.ts` — registration handshake, reconnect on disconnect, event emission for ring/accept/end.
- `src/phone/session.test.ts` — session key derivation, allowlist gate, pairing fallthrough for unknown callers.
- `src/phone/pairing.test.ts` — DTMF approval flow; voice approval transcribed to a code; pairing-store integration with cross-channel approval.
- `src/phone/transcripts.test.ts` — JSONL persistence, optional audio recording, consent-prompt sequencing.
- `src/channels/phone-routing.test.ts` — `phone:` session keys route to the configured agent.
- Live test (gated on `OPENCLAW_PHONE_LIVE_TEST=1`): place a real call against a sandbox SIP trunk and assert ring → answer → tool call → hangup.

## Smoke checks

- `openclaw phone status` shows trunk registration + last-call timestamp.
- From an allowlisted number, call the trunk; greeting plays; ask the agent to "search for the weather in Lima"; reply lands within ~1.5s.
- From an unknown number, call the trunk; pairing code is read aloud; `openclaw pairing approve phone <code>` succeeds; subsequent calls bypass pairing.
- `openclaw doctor` flags an open `dmPolicy` on `phone` with an empty allowlist.

## Manual criteria

- Greeting voice sounds natural, not robotic; reasoning-effort `low` doesn't introduce conversational gaps the caller notices.
- Recording consent prompt is the first sentence on the call when recording is on.
- Hangup detection is reliable — sessions don't dangle (verifiable via `~/.openclaw/agents/<agentId>/sessions/phone-*.jsonl` having a clean end event).

## AI eval plan

- Success criteria: 90% tool-call accuracy on a 20-prompt phone-eval set (voice WAVs + expected tool selection + expected final reply intent); ≤ 1s 95p time-to-first-audio after end-of-utterance.
- Eval dataset: `tests/evals/phone-call-eval/` — voice samples + expected outcomes.
- Regression set: pairing flow (unknown caller), allowlist accept, allowlist reject, mid-call tool call, hangup-during-tool-call.
- Cadence: nightly on the phone live matrix when `OPENCLAW_PHONE_LIVE_TEST=1` is set; per-PR on the offline fixtures.

## Risks & rollback

- **Risks:**
  - SIP/RTP traversal varies by trunk provider. *Detect via* a documented test matrix in `docs/channels/phone.mdx`.
  - Caller-ID spoofing — bad actor calls in claiming to be an allowlisted number. *Mitigate* by requiring STIR/SHAKEN verification on the trunk and falling back to pairing when verification is absent.
  - Long calls rack up Realtime audio costs invisibly. *Mitigate* by surfacing audio-second cost in `/usage` and an optional per-call cap (`phone.maxDurationSec`).
  - Recording without consent — legal risk. *Mitigate* by hard-defaulting `phone.recording=off` and gating recording start on a consent prompt heard by the caller.
- **Rollback:** unregister the SIP trunk; revert the PR; the new `phone` channel is additive.

## Open questions

- Which SIP provider do we showcase in docs? Suggested: pick the cheapest provider with documented OpenAI Realtime compatibility before merge.
- Should we charge a per-call PIN check on top of allowlist? Probably no for v1 (it doubles the friction).
