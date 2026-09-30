# Incoming data calls

This opt-in feature receives private, assistant-initiated calls through the existing
authenticated Gateway node connection. It does not need a phone number, FCM, a
third-party signaling server, or OpenAI credentials on the phone. A reachable
Tailscale Gateway endpoint works like any other configured Gateway endpoint.

## Setup

1. Pair the app with the Gateway as both operator and node.
2. Configure a working realtime Talk provider on the Gateway.
   Prepared calls require a compatible Gateway build that accepts the
   `talk.session.create` greeting parameter and loads the prepared session's
   history on initial creation. Updating only the Android app cannot add these
   server capabilities; incompatible Gateways produce a call error.
3. Open **Settings → Voice → Incoming data calls** and enable calls. Grant microphone
   and notification access. On Android 14+, allow full-screen call alerts if desired.
   Consent applies only to the selected Gateway; enable it separately for another
   Gateway. Forgetting a Gateway removes its consent. Unscoped opt-ins from preview
   builds must be enabled again.
4. Keep the app's Gateway background connection and Tailscale running. Consider
   unrestricted battery use for this app on devices that suspend background services.
5. Allow `talk.incoming`, `talk.callStatus`, and `talk.endCall` in the Gateway's
   node-command policy. Ordinary device pairing is still required.

Calls cannot arrive if the phone is offline, the Gateway connection is stopped,
or Android has force-stopped the app. There is deliberately no independent push
service that could bypass these boundaries. No microphone starts while ringing.
Accepting the call activates the existing Talk Gateway relay, audio focus and
device routing; it never silently falls back to speech recognition plus TTS.

## Gateway node commands

`talk.incoming` accepts:

```json
{
  "callId": "f0a65f14-24e1-43f1-b3e0-fd415af7e59b",
  "sessionKey": "agent:assistant:call-123",
  "callerName": "Assistant",
  "topic": "Prepared briefing",
  "expiresAtMs": 1800000000000
}
```

The expiration must be in the next five minutes. IDs must be canonical UUIDs;
session keys must explicitly name an agent. Caller names are bounded to 80
printable characters and topics to 160. Prepare the briefing in the chosen
session through normal Gateway APIs before sending the invitation; do not place
private briefing text in notifications or globally change Talk instructions.

`talk.callStatus` optionally takes `callId`; `talk.endCall` requires it. Successful
responses contain `callId`, `sessionKey`, `status` and `expiresAtMs`. Lifecycle
statuses are `ringing`, `connecting`, `active`, `declined`, `ended`, `missed`,
and `error`. Unknown requested IDs return `unknown`; absent current state returns
`idle`. Duplicate identical invitations reconcile their existing state; differing
payloads with a reused ID fail. IDs are remembered across process death until
their expiration, so retries cannot reopen already-handled invitations.

Only one call is allowed at a time. Other audio capture blocks acceptance. A
transport drop during an answered call pauses audio and gives the same Gateway
up to 30 seconds to reconnect. Recovery retains the call's session, mute, and
audio route without repeating its opening greeting or replaying outage audio.
A disconnection while ringing, a Gateway switch, revoked consent or permission,
user decline/hangup, or remote end closes the call. Protocol, authorization, and
microphone errors are terminal and report the voice failure; they are not
reported as generic Gateway disconnections or retried as network loss.
The internal call activity is not exported; Android's Telecom binding requires
its signature-level permission. PhoneAccount is self-managed and cannot place
PSTN calls. Topic/session content is not persisted in the replay ledger.

## Verification

Focused JVM tests: `:app:testThirdPartyDebugUnitTest --tests '*IncomingCall*'` (use the
variant available on the build host). A real-device test remains necessary for
locked-screen ringing, Answer consent, Bluetooth, carrier-call arbitration,
screen-off/Tailscale persistence, expiry, reconnect, and two-way provider audio.
Emulator tests do not establish Samsung background behavior or acoustic quality.
