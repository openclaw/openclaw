---
doc-schema-version: 1
summary: "The WhatsApp QA lane and the shared Convex credential pool used by the real-transport lanes."
read_when:
  - You are running the WhatsApp QA lane
  - You are leasing QA credentials from the Convex pool
title: "WhatsApp QA and credentials"
---

## WhatsApp QA

```bash
pnpm openclaw qa whatsapp
```

Targets two dedicated WhatsApp Web accounts: a driver account controlled by
the harness and a SUT account started by the child OpenClaw gateway through
the bundled WhatsApp plugin.

Required env when `--credential-source env`:

- `OPENCLAW_QA_WHATSAPP_DRIVER_PHONE_E164`
- `OPENCLAW_QA_WHATSAPP_SUT_PHONE_E164`
- `OPENCLAW_QA_WHATSAPP_DRIVER_AUTH_ARCHIVE_BASE64`
- `OPENCLAW_QA_WHATSAPP_SUT_AUTH_ARCHIVE_BASE64`

Optional:

- `OPENCLAW_QA_WHATSAPP_GROUP_JID` enables group scenarios such as
  `whatsapp-mention-gating`, `whatsapp-group-pending-history-context`,
  `whatsapp-broadcast-group-fanout`, `whatsapp-group-activation-always`,
  `whatsapp-group-reply-to-bot-triggers`, group action/media/poll scenarios,
  and `whatsapp-group-allowlist-block`.

WhatsApp YAML scenarios (`qa/scenarios/channels/whatsapp-*.yaml`):

- Baseline and group gating: `whatsapp-canary`, `whatsapp-pairing-block`,
  `whatsapp-mention-gating`, `whatsapp-group-pending-history-context`,
  `whatsapp-group-activation-always`, `whatsapp-group-reply-to-bot-triggers`,
  `whatsapp-top-level-reply-shape`, `whatsapp-restart-resume`,
  `whatsapp-group-allowlist-block`.
- Native commands: `whatsapp-help-command`, `whatsapp-status-command`,
  `whatsapp-commands-command`, `whatsapp-tools-compact-command`,
  `whatsapp-whoami-command`, `whatsapp-context-command`,
  `whatsapp-native-new-command`.
- Reply and final-output behavior: `whatsapp-tool-only-usage-footer`,
  `whatsapp-reply-to-message`, `whatsapp-group-reply-to-message`,
  `whatsapp-reply-to-mode-batched`, `whatsapp-reply-context-isolation`,
  `whatsapp-reply-delivery-shape`, `whatsapp-stream-final-message-accounting`.
- User-path message actions: `whatsapp-agent-message-action-react` starts
  from a real driver DM, lets the model call the `message` tool, and
  observes the native WhatsApp reaction. `whatsapp-agent-message-action-upload-file`
  uses the same posture for `message(action=upload-file)` and observes
  native WhatsApp media. `whatsapp-group-agent-message-action-react` and
  `whatsapp-group-agent-message-action-upload-file` prove the same
  user-visible actions in a real WhatsApp group.
- Group fanout: `whatsapp-broadcast-group-fanout` starts from one mentioned
  WhatsApp group message and verifies distinct visible replies from `main`
  and `qa-second`.
- Group activation: `whatsapp-group-activation-always` changes a real group
  session to `/activation always`, proves an unmentioned group message wakes
  the agent, then restores `/activation mention`.
  `whatsapp-group-reply-to-bot-triggers` seeds a bot reply, sends a native
  quoted reply to it without an explicit mention, and verifies the agent
  wakes from that reply context.
- Inbound media and structured messages: `whatsapp-inbound-image-caption`,
  `whatsapp-audio-preflight`, `whatsapp-inbound-structured-messages`,
  `whatsapp-group-audio-gating`, `whatsapp-inbound-reaction-no-trigger`.
  These send real WhatsApp image, audio, document, location, contact,
  sticker, and reaction events through the driver.
- Direct Gateway contract probes: `whatsapp-outbound-media-matrix`,
  `whatsapp-outbound-document-preserves-filename`, `whatsapp-outbound-poll`,
  `whatsapp-outbound-send-serialization`,
  `whatsapp-group-outbound-media`, `whatsapp-group-outbound-poll`,
  `whatsapp-message-actions`, `whatsapp-reply-context-isolation`,
  `whatsapp-reply-delivery-shape`. These bypass model prompting on purpose
  and prove deterministic Gateway/channel `send`, `poll`, and
  `message.action` contracts.
- Access-control coverage: `whatsapp-access-control-dm-open`,
  `whatsapp-access-control-dm-disabled`, `whatsapp-access-control-group-open`,
  `whatsapp-access-control-group-disabled`, `whatsapp-group-allowlist-block`.
- Native approvals: `whatsapp-approval-exec-deny-native`,
  `whatsapp-approval-exec-native`, `whatsapp-approval-exec-reaction-native`,
  `whatsapp-approval-exec-group-reaction-native`,
  `whatsapp-approval-plugin-native`.
- Status reactions: `whatsapp-status-reactions`,
  `whatsapp-status-reaction-lifecycle`.

WhatsApp defaults are derived from the selected taxonomy profile and lane
constraints. `mock-openai` runs eligible scenarios deterministically through
the real WhatsApp transport while mocking only model output; `live-frontier`
excludes scenarios whose provider or model contract requires the mock lane.

The WhatsApp QA driver observes structured live events (`text`, `media`,
`location`, `reaction`, and `poll`) and can actively send media, polls,
contacts, locations, and stickers. QA Lab imports that driver through the
`@openclaw/whatsapp/api.js` package surface instead of reaching into private
WhatsApp runtime files. For group observations, `fromJid` is the group JID
while `participantJid` and `fromPhoneE164` identify the participant sender.
Message content is redacted by default. Direct Gateway poll, upload-file,
media, group poll, group media, and reply-shape probes are transport/API
contract checks; they are not treated as proof that a user prompt made the
agent choose the same action. User-path action proof comes from scenarios
such as `whatsapp-agent-message-action-react` and
`whatsapp-group-agent-message-action-react`, where the driver sends a normal
WhatsApp message and QA Lab observes the resulting native WhatsApp artifact.
WhatsApp scenario details include each scenario's posture (`user-path`,
`direct-gateway`, or `native-approval`) so evidence cannot be mistaken for a
stronger contract than it actually proves.

Output artifacts:

- `qa-suite-report.md`
- `qa-suite-summary.json`
- `qa-evidence.json` - evidence entries for the live transport checks.

## Convex credential pool

Buzz, Discord, Slack, Telegram, and WhatsApp lanes can lease credentials from a
shared Convex pool instead of reading the per-lane env vars documented in
[Channel QA reference](/concepts/qa-e2e-automation/channel-qa-reference),
[Slack QA](/concepts/qa-e2e-automation/slack-qa), and [WhatsApp QA](#whatsapp-qa). Pass
`--credential-source convex` (or set `OPENCLAW_QA_CREDENTIAL_SOURCE=convex`);
QA Lab acquires an exclusive lease, heartbeats it for the duration of the
run, and releases it on shutdown. Pool kinds are `"buzz"`, `"discord"`,
`"slack"`, `"telegram"`, and `"whatsapp"`.

The suite owns its Gateway lifecycle before startup begins, including packaged
auth and plugin-repair commands, startup retries, replacement processes, and
commands run against the active Gateway. Each CLI command has a two-minute
execution limit. Stop closes admission immediately and settles all owned process
groups; leader exit does not bypass shutdown or the bounded wait for inherited
stdio to close. On POSIX, CLI commands use their own process groups, so concurrent
commands do not replace the active Gateway's identity. CLI failures, including
timeouts, cancellations, and stream faults, retain bounded, redacted stderr and
stdout captured through shutdown. Packaged plugin setup errors distinguish
`update repair --help` from `update repair`.

Gateway RPC calls wait for reconnection only while the request is unsent. Once
sent, a lost connection is reported to the scenario without replaying the
request: the Gateway may already have committed it. Scenario code must inspect
the resulting state before deciding whether an interrupted action is safe to retry.

Transport adapters drain their driver work in
`cleanup()` and release Gateway-backed credentials in
`cleanupAfterGatewayStop()`. The suite runs that second phase only when no
subprocess was spawned or all owned process groups were confirmed stopped. A
readiness failure or an exited group leader is not shutdown proof.

Failed startup or replacement settles the process without finalizing its logs
or staging directory. The caller retains the lifecycle owner and always calls
`stop()`, including after startup rejects. That explicit stop applies the
caller's artifact policy, so failure reports can preserve sanitized Gateway logs
before temporary runtime state is removed.

After confirmed shutdown, a successful export (or choosing no export) finalizes
the artifact policy before temporary state removal. Cleanup retries retain that
export without rewriting it or using a later destination, while RPC and staging
cleanup still retry. Failed exports remain retryable. Unconfirmed stops refresh
requested snapshots, and the final confirmed snapshot includes later output.
Keeping temporary state leaves its logs available for a later cleanup retry.

If termination cannot be confirmed, the suite reports a cleanup failure, keeps
the runtime directory, and leaves the adapter's lease and heartbeat owned.
Inspect the reported process group and retained runtime before reusing those
credentials. Log, RPC, or artifact errors are still reported, but do not prevent
after-stop cleanup when the process group is confirmed stopped. This ordering
requires adapters to use the two cleanup phases; it does not change broker TTLs
or provide a durable guarantee after the QA parent or host is lost.

Temporary runtime and staged-plugin directories are removed independently, and
cleanup failures are reported with redacted diagnostics. Before removing the
runtime, the QA parent closes that root's auth readers and agent databases,
releases their leases while shared state is still open, then closes the shared
database. Other QA roots remain untouched. A close failure retains the runtime
for retry while staged-plugin removal is still attempted. A cleanup error can
therefore leave isolated runtime or auth state on disk even when process
termination is confirmed. Correct the reported problem and retry `stop()` on the
retained lifecycle owner; confirmed termination still permits after-stop
credential cleanup.

Payload shapes the broker validates on `admin/add`:

- Buzz (`kind: "buzz"`): `{ relayUrl: string, roomId: string,
driverPrivateKey: string, sutPrivateKey: string, driverAuthTag?: string,
sutAuthTag?: string }` - `relayUrl` must use `wss://`, with `ws://` allowed only
  for loopback relays; `roomId` must be a channel UUID, and the identities must
  be distinct.
- Discord (`kind: "discord"`): `{ guildId: string, channelId: string,
driverBotToken: string, sutBotToken: string, sutApplicationId: string,
voiceChannelId?: string }`.
- Telegram (`kind: "telegram"`): `{ groupId: string, driverToken: string,
sutToken: string }` - `groupId` must be a numeric chat-id string.
- WhatsApp (`kind: "whatsapp"`): `{ driverPhoneE164: string, sutPhoneE164:
string, driverAuthArchiveBase64: string, sutAuthArchiveBase64: string,
groupJid?: string }` - phone numbers must be distinct E.164 strings.

Slack lanes can also use the pool. Slack payload shape checks currently live
in the Slack QA runner rather than the broker; use `{ channelId: string,
driverBotToken: string, sutBotToken: string, sutAppToken: string }`, with a
Slack channel id like `Cxxxxxxxxxx`. See
[Setting up the Slack workspace](/concepts/qa-e2e-automation/slack-qa#setting-up-the-slack-workspace) for app
and scope provisioning.

Operational env vars and the Convex broker endpoint contract live in
[Testing → Shared Telegram credentials via Convex](/help/testing/qa-runners#shared-telegram-credentials-via-convex-v1)
(the section name predates the multi-channel pool; the lease semantics are
shared across kinds).
