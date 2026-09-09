---
summary: "Durable inbound ingress for channel plugins: the ingress resolver, replay dedupe, transport retention classes, at-least-once side effects, and the reload and restart contract"
read_when:
  - You are moving a channel onto the durable ingress queue
  - You need transport retention, replay dedupe, or at-least-once rules
  - You are opting a multi-account channel into account-scoped restarts
title: "Durable channel ingress"
sidebarTitle: "Durable ingress"
---

Make inbound delivery durable, and keep replay, retention, and restart
behavior provable. Part of the [Building channel
plugins](/plugins/sdk-channel-plugins) guide.

## Inbound ingress (experimental)

Channels migrating inbound authorization can use the experimental
`openclaw/plugin-sdk/channel-ingress-runtime` subpath from runtime receive
paths. It accepts platform facts, raw allowlists, route descriptors, command
facts, and access group config, then returns sender/route/command/activation
projections plus the ordered ingress graph, while platform lookup and side
effects stay in the plugin. Keep plugin identity normalization in the
descriptor you pass to the resolver; do not serialize raw match values from
the resolved state or decision. See
[Channel ingress API](/plugins/sdk-channel-ingress) for the API design,
ownership boundary, and test expectations.

Pass the exact resolver result to the host-injected registered context builder
as `channelIngress`. Results used for execution must include the final
agent/session/message/event `contextBinding`; decision-only resolver calls may
omit it. This preserves the native plugin's record-, epoch-, and scope-bound participant evidence through one-shot queued run admission without
exposing it in message context fields. The standalone public builder is not an
authoritative substitute. Never reconstruct evidence from sender, route, room,
account, thread, message, transport, or session values. Legacy adapters can explicitly pass
`channelIngress: "unsupported"` only when the path is source-proven to lack an
authoritative Phase 0 integration. Supported paths must pass the exact result;
omission is invalid production wiring. Missing, fake, stale, reused, or mixed
supported evidence projects as unknown, never as an allow signal.

## Durable ingress and replay dedupe

Channels adopting durable ingress should use `createChannelIngressMonitor`
from `openclaw/plugin-sdk/channel-outbound` unless they need a materially
different admission or pump contract. Enqueue the raw transport envelope at a
single receive chokepoint (no normalization at receive time), gate the
transport ack on the durable append for webhook transports, derive one
serialized lane per conversation, and mark the event complete at dispatch
adoption. The queue's primary key is `(queue_name, event_id)` and completion
tombstones the row instead of deleting it, so a late platform redelivery of
the same `event_id` is rejected durably for the tombstone retention window.
See [Channel outbound API](/plugins/sdk-channel-outbound#durable-ingress-monitors)
for the monitor API and shutdown contract.

That tombstone is the layering rule for replay guards
(`openclaw/plugin-sdk/persistent-dedupe`): a drained channel keeps a separate
replay guard only when the guard's identity or retention exceeds the queue's
— a logical message key that differs from the transport delivery id (Telegram
dedupes `chat_id:message_id` because debounce merges can re-surface a message
under a fresh `update_id`), or a longer window than the channel's tombstone
retention. If your guard key would equal the drain `event_id`, delete the
guard when adopting the drain and size `completedTtlMs`/`completedMaxEntries`
to cover the old guard window instead. Non-dedupe protections such as age
fences are unrelated to this rule. Stable outbound message IDs use the shared
outbound-echo registry from `openclaw/plugin-sdk/channel-outbound` instead of a
channel-local TTL cache.

### Transport classes and retention

Classify a transport by the recovery guarantee at its receive boundary:

- **Ack-gated webhook or event delivery:** acknowledge or return success only
  after the durable append. An append failure must leave the delivery eligible
  for retry or fail the receive boundary. This class includes Slack, SMS, Zalo,
  Microsoft Teams, Google Chat, LINE, and Synology Chat.
- **Awaited polling or stream delivery:** advance the remote cursor or send the
  transport ack only after the append. When no explicit cursor exists, keep the
  receive callback serialized and awaited so an append failure cannot let the
  receive loop run ahead. Telegram polling, Signal, and Tlon use this class;
  Telegram webhook delivery follows the ack-gated rule above.
- **Non-replay sockets:** IRC, Mattermost, Twitch, and Zalo Personal cannot ask
  the platform to redeliver an accepted event. Their durable queue protects the
  process crash window and supports local restart recovery; completion
  tombstones are near-inert against platform replay.

Use 30 days as the fleet tombstone-TTL convention, not as an SDK default. A
high-volume redelivery window normally uses a 20,000-entry completed cap;
lower-volume awaited and non-replay transports normally use 1,000-2,000.
Current exceptions include LINE's 4,096-entry caps, SMS's 24-hour completed
TTL, and Tlon's cap-only completed retention. Failed-row caps may also be lower
than completed caps. TTL and cap both prune rows, so effective retention ends
when the first bound is reached. Deviate only for a documented platform retry
horizon, preserved shipped replay-guard window, expected volume or disk budget,
or non-replay transport, and cover the retention contract with tests.

### At-least-once side effects

Drain dispatch runs command side effects before the ingress row reaches its
completion tombstone. A process crash between those steps replays the row and
can execute the side effect again. This at-least-once crash window is the
default contract. For non-idempotent work such as config writes, storage
clears, or visible acknowledgements outside the reply lane, use
`createIngressEffectOnce(...)` from
`openclaw/plugin-sdk/ingress-effect-once`. Give each call the stable ingress
`eventId` plus an effect name. Create one helper per ingress queue/account and
use a stable, unique `namespacePrefix` for that scope because transport event
IDs may be queue-local. The helper commits its durable claim only after the
effect succeeds; a thrown effect releases the claim so a drain retry can
execute it again, while concurrent callers wait for the active claim. Durable
state errors call `onDiskError` when provided and reject instead of falling
back to process memory.

Set the helper's `ttlMs` to at least the channel's ingress tombstone retention
plus the maximum delay between effect commit and row completion, including
bounded downtime and drain retries. The effect record's TTL starts at commit,
while tombstone retention starts later at completion; if pending-row lifetime
is unbounded, no finite TTL covers arbitrary downtime. After the tombstone can
no longer replay the row, older effect records are dead weight. Size
`stateMaxEntries` for every distinct event/effect key that can exist in that
retention window, accounting for the queue's completed-entry bound and the
maximum effects per event. A lower cap evicts the oldest record before its TTL
and allows that effect to execute again. Residual at-least-once windows remain
if the process dies or persistence fails after the effect succeeds but before
the claim commits, or if the record expires while its ingress row is still
pending.

### Dynamic policy publication

Use `reload.noopPrefixes` only for fields whose consumers read the committed
runtime config without replacing a channel resource. These writes still publish
the validated runtime snapshot; “noop” means no component restart. A `*` path
segment matches one nonempty config key, for example
`channels.example.accounts.*.allowFrom`. Deeper boundaries take precedence;
at the same depth, an exact path takes precedence over a wildcard.

Bind `createRuntimeConfigReader` when the account starts, and derive a coherent
policy snapshot at each new admission. Keep resolved-name caches with that
account owner and recheck the current revision after asynchronous resolution.
Do not retain startup-only allowlists in another message or interaction path.

Keep credentials, transport settings, and account lifecycle changes on the
restart path. Do not declare an entire `accounts` subtree dynamic merely to cover
its policy fields. Writes containing both dynamic policy and restart-required
settings retain the existing atomic reload and drain behavior.

### Account-scoped restart contract

Channel config changes restart the whole channel by default. A multi-account
channel may set `reload.accountScopedRestart: true` only when configuration
resolution reads channel-wide shared fields plus the selected account, never a
sibling account, and the Gateway can stop and start one `(channel, accountId)`
runtime without replacing sibling runtimes.

The scoped path applies only to changes under
`channels.<channel>.accounts.<non-default-id>.*`. Changes to shared channel
fields, `accounts.default`, removed or unresolvable accounts, and mixed changes
that can affect inheritance are promoted to a whole-channel restart. Plugins
that do not opt in always use the whole-channel path.

The Gateway retains the admitted account's `cfg`, resolved `account`, and owning
`stopAccount` hook through teardown, including failed-stop retries. Cleanup must
use that context even when the published config removes the account or a new
plugin registration replaces it.

Finish status updates inside `stopAccount` before its promise settles. The Gateway ignores
writes through a retained stop callback after that attempt finishes or times out.
Terminal startup status retires previous webhook handoffs even when the account
promise stays pending until abort; it does not revoke the current task's ability
to register ingress and explicitly report ready after recovery.

Account-count-dependent policy needs whole-channel reloads. For example, Telegram
changes how an empty account `groups` map inherits defaults between single- and
multi-account configurations. Synology Chat also validates inherited and duplicate
webhook paths across accounts. These plugins do not opt into account-only reloads.

For channels using the durable ingress drain, the account monitor's stop path
must first settle all accepted transport admissions, then dispose and await its
drain. Starting the account opens the same account-keyed queue, whose initial
drain recovers undispatched durable rows. Do not add a second reload-specific
replay pass; queue recovery is the canonical restart path.

Treat this flag as a capability claim, not a performance preference. Contract
tests should prove that adding and editing one named account leaves a sibling's
resolved config unchanged, stopping one account settles only that account's
monitor and drain, and a fresh monitor recovers that account's rows exactly
once. If any guarantee cannot be proved, omit the flag.
