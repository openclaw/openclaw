# Prepared incoming calls over your existing Gateway

This Node.js operator CLI uses your installed OpenClaw SDK to prepare a short sourced briefing in a dedicated session, then rings one paired Android device using the Gateway's existing authenticated node connection. No separate dependencies, custom server, FCM account, phone number, PSTN provider, or direct provider credential are involved.

The Android incoming-call extension must be installed, paired, opted in, and connected through your private Tailscale Gateway endpoint. Keep its persistent connection service running and permit notifications/microphone access. Without push, an offline or force-stopped app cannot be woken remotely; this tool fails visibly instead of queuing a stale call.

## Setup

- Use an OpenClaw-supported Node.js runtime (24.16+ or 26.1+) and OpenClaw 2026.9.5+ with an already paired operator device identity **and this change's relay history, opening greeting, and continuous-output fixes**. Stock 2026.9.5 omits first-relay history and can reject GPT-Live's initial continuous audio as unowned. Preparing the transcript alone does not fix an unpatched Gateway.
- The existing operator device token must permit `operator.read`, `operator.write`, and `operator.admin` (required by `chat.inject`). The SDK checks existing grants, preserves approved scopes, and opens a signed-device connection. Missing pairing, an origin mismatch, or insufficient grants fails visibly: this helper never requests broader scopes, creates a device identity, writes authentication state, or falls back to shared credentials. Complete any required pairing separately through OpenClaw's supported operator flow.
- Configure the Android app with your own HTTPS/WSS Tailscale Gateway address, including its port. Do not put credentials in a URL.
- Allow `talk.incoming`, `talk.callStatus`, and `talk.endCall` through `gateway.nodes.commands.allow`, preserving existing entries. Android must advertise all three commands.
- Configure the chosen agent and Talk runtime separately. This CLI does not choose a provider, access API keys, change billing policy, or override the Talk voice model.
- Discover exact node IDs with `openclaw gateway call node.list --json`. Automatic selection is allowed only when exactly one online paired Android node advertises all commands.

## Prepare and ring

Create a private brief containing the reason for calling, conclusion, essential facts, uncertainty, a decision/question, and short source references with retrieval dates. Keep complete research in an agent-readable dossier. Never put credentials in either briefing or receipt.

```sh
node contrib/incoming-calls/incoming-call.mjs prepare \
  --expect-url wss://your-gateway.example:18789 \
  --agent talk-assistant \
  --node EXACT_PAIRED_NODE_ID \
  --caller 'OpenClaw' \
  --topic 'Compare the three options' \
  --briefing /private/path/call-brief.txt \
  --dossier /private/path/full-research.md \
  --receipt /private/path/call-receipt.json \
  --ttl 180

node contrib/incoming-calls/incoming-call.mjs ring --receipt /private/path/call-receipt.json
node contrib/incoming-calls/incoming-call.mjs status --receipt /private/path/call-receipt.json
node contrib/incoming-calls/incoming-call.mjs end --receipt /private/path/call-receipt.json
```

`prepare` does not ring or start inference. It uses `sessions.create` without an initial message, then `chat.inject`. It selects medium reasoning and fast mode for that dedicated session while preserving the configured agent model/workspace policy. `ring` is the intentional call action. No microphone activates until Android accepts the call through its native UI. A ring acknowledgement is not proof that the user answered; query `status` for `active`.

Use `--binary /absolute/path/to/openclaw` to select a particular installed OpenClaw executable (or its standard npm command shim on Windows). Otherwise the first executable on `PATH` is selected. Shell functions and custom wrappers are not supported: the helper loads the public `openclaw/plugin-sdk/gateway-runtime` from that exact installation, never another installation or this helper's checkout. It does not execute a shell or pass briefing text in process arguments.

Preparation requires `--expect-url` to pin the SDK's already configured Gateway target without overriding or exposing authentication. This can be a local `ws://127.0.0.1:PORT` endpoint even when Android uses Tailscale. The immutable receipt records that target, and ring/status/end automatically enforce it; an overriding URL must match. The canonical SDK owns target selection, pin enforcement, TLS, and existing device authentication; the helper does not read credential files itself.

The owner-only receipt is an explicit operation export, not authoritative call state. It contains the pinned Gateway URL, UUID, node/session identity, topic, expiration, and a briefing hash—not credentials or briefing contents. The Gateway owns the session; Android owns the current call state. Keep the same receipt to reconcile an uncertain result. Never create a second invitation just because the first RPC timed out.

## Context and lifecycle

- The capsule is split into complete messages below Talk's 800-character per-item cap. Its escaped serialized form is capped at 6,500 bytes and 12 items, leaving room inside the 8,000-byte/16-item startup-history budget.
- Each append is read back. `chat.inject` has no idempotency key: an uncertain append is never blindly retried. Preparation stops without ringing if the exact expected history cannot be proven. The failed session remains inspectable; start a new preparation with a new receipt file.
- The briefing is historical background, not a system instruction or new authorization. Source quotations do not authorize tools/actions. After explicit Answer, Android requests a brief opening about that prepared topic through the bounded `greeting` field on `talk.session.create`. The Gateway speaks only once both the provider is ready and the client has admitted its first audio frame, proving playout setup; a silent frame suffices. It rechecks connection/session authority immediately before speech, and closure while connecting prevents a late greeting. No extra delegated-agent turn or global prompt change is needed. Ordinary Talk and voice replacement omit this field.
- Before dispatch, the CLI verifies the immutable capsule and exact online node again. It refuses altered/pre-used sessions, expired invitations, ambiguous targets, or missing capabilities.
- Ring/end use fixed call-scoped idempotency keys; status uses fresh read IDs. Android must retain terminal call IDs for replay protection through the invitation expiry. Replays of ringing or terminal calls return their state, not a second ring.
- After Answer, a temporary Gateway transport loss pauses microphone capture and playback while retaining the native call for up to 30 seconds. The screen returns to its connecting state. Recovery uses bounded 1/2/4-second backoff, requires fresh authenticated node and operator connections to the same still-authorized Gateway, and reopens voice on the same dedicated session without repeating the opening greeting. Audio during the outage is not recorded or replayed. Mute and the selected Android audio route are retained. Repeated failures do not extend the deadline; expiry ends the call. Hangup, consent revocation, explicit disconnect, Gateway replacement, and terminal voice/audio failures still end it immediately. An unanswered invitation is not recovered across a disconnect.
- TTL is 30–300 seconds, including preparation. The default is three minutes. Answered call duration is owned by Android/Talk and is not the invitation TTL.
- The caller name may appear on the lock screen; the native incoming-call notification intentionally hides the prepared topic. The spoken briefing starts only after Answer.
- This is not self-destructing storage: injected briefing and subsequent speech follow the Gateway's existing session retention. "Ephemeral capsule" means session-specific rather than global instructions, not guaranteed deletion.

## Node payload contract

`talk.incoming`: `{callId, sessionKey, callerName, topic, expiresAtMs}`. `callId` is a UUIDv4; canonical session key is `agent:<agent>:incoming-call:<UUID>`. Caller/topic limits are 80/160 characters. Expiration is absolute milliseconds, at most five minutes ahead.

`talk.callStatus`: `{callId}`. `talk.endCall`: `{callId}`.

Successful node payloads expose `{callId, sessionKey?, status}` with status `ringing`, `connecting`, `active`, `declined`, `ended`, `missed`, or `error`. An unseen call returns `{callId, status:"unknown"}`; idle with no call ID is also accepted. The CLI rejects mismatched call/session IDs and does not echo arbitrary node data.

## Verification

```sh
node --test contrib/incoming-calls/*.test.mjs
```

Tests exercise the full operator workflow against a synthetic RPC owner: offline/ambiguous selection, capsule limits/tampering, no-inference preparation, exact node dispatch, uncertainty reconciliation, replay suppression, expiration, session isolation, and error redaction. Actual-entrypoint tests cover selected-installation SDK resolution, PATH lookup, signed-device options, pin/auth failures, and no session creation for an offline node. They do not ring a real phone or access a paid voice endpoint. Real device audibility, background reachability, screen-off notifications, and Bluetooth require separate device proof.
