# Gateway Follow-up Reliability Notes

Date: 2026-04-07

## Problem being addressed

Current behavior is not reliable enough for the user's desired flow:

- parent session delegates ACP/subagent work
- parent should stay effectively responsible for final delivery
- user should receive the completion report even if the original turn ended early or the transport reconnects

In practice, the current system often falls back to:

- completion visible only through later manual status checks
- completion announcements depending on child-session announce behavior
- parent-side blocking behavior being partly a prompting/behavior issue instead of a guaranteed gateway primitive

## What I verified locally

Using the installed OpenClaw package (`2026.3.24`) and a fresh source checkout:

### 1. WhatsApp gateway connect/disconnect events are injected as system events

Source:

- `extensions/whatsapp/src/auto-reply/monitor.ts`

Current behavior:

- enqueue `WhatsApp gateway connected ...`
- enqueue `WhatsApp gateway disconnected (status ...)`

These are routed into the target session as plain system events.

### 2. System events are ephemeral and only consumed on the next reply run

Source:

- `src/infra/system-events.ts`
- `src/auto-reply/reply/session-system-events.ts`
- `src/auto-reply/reply/get-reply-run.ts`

Current behavior:

- system events are kept in an in-memory queue
- they are drained only when a later reply run happens for that session
- they are not, by themselves, guaranteed user-facing outbound messages

This means gateway reconnect notices and child completion notices can exist internally without being proactively delivered to the user.

### 3. Subagent completion already has internal tracking hooks, but delivery still hinges on announce/follow-up paths

Relevant compiled/runtime symbols observed:

- `resolveRequesterForChildSession`
- `shouldIgnorePostCompletionAnnounceForSession`
- `getLatestSubagentRunByChildSessionKey`
- `enqueueFollowupRun`

This suggests OpenClaw already understands parent/child ownership, but the final user-visible delivery path is still not hard-guaranteed for the user's desired blocking/final-only workflow.

## Root cause summary

The main gap is not "can we know that a child finished?".
The gap is:

- **who owns final delivery**, and
- **whether final delivery is queued durably enough to survive parent turn end / reconnect / timing differences**.

Right now, too much of this relies on:

- parent staying alive long enough
- completion announcement timing
- later user polling
- ephemeral session/system event consumption

## Recommended structural changes

## Proposal A — Parent-owned completion delivery queue (highest priority)

Add a gateway-level durable queue for delegated-run completion deliveries.

Desired behavior:

- when parent spawns child work, register a `completionOwnerSessionKey`
- when child finishes, gateway creates a durable "pending final delivery" item for the parent
- if parent turn is still open, deliver immediately
- if parent turn has ended, deliver on the next available outbound-safe opportunity
- if transport reconnects, pending completion delivery is retried

Key point:

- this should be **separate from ephemeral system events**
- this should behave more like a delivery job / follow-up obligation

Suggested payload shape:

```ts
type PendingCompletionDelivery = {
  id: string;
  requesterSessionKey: string;
  childSessionKey: string;
  runId: string;
  createdAt: number;
  completedAt: number;
  summaryText: string;
  deliveryContext?: DeliveryContext;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  lastError?: string;
};
```

## Proposal B — Explicit spawn option for final-delivery semantics

Extend `sessions_spawn`/subagent spawn metadata with something like:

- `finalDelivery: "announce" | "parent-owned" | "none"`

Recommended default for direct user sessions:

- `parent-owned`

Meaning:

- child completion should not rely only on child-session announce
- gateway must route final result back through the requester session as a follow-up obligation

## Proposal C — Do not encode transport reconnect notices as plain system events only

For important transport lifecycle events like:

- WhatsApp gateway disconnected
- WhatsApp gateway reconnected

current system-event-only treatment is too weak for user-facing reliability.

Recommended improvement:

- keep system events for prompt context if useful
- **also** write critical transport events into a durable notification/follow-up queue when they matter to the owning session

At minimum:

- reconnect/disconnect should be able to surface as guaranteed follow-up notifications, not just next-turn prompt prefixes

## Proposal D — Parent wait primitive / wait-on-child helper

Add a first-class runtime primitive for:

- spawn child
- wait for child completion
- collect final result
- reply once

This would replace current ad-hoc behavior where the agent itself must:

- remember child session keys
- sleep/poll history
- synthesize completion manually

Conceptually:

```ts
await spawnAndWait({
  runtime: "acp",
  agentId: "codex",
  task: "...",
  timeoutSeconds: 1800,
  completionDelivery: "parent-owned",
});
```

This is the cleanest solution for the user's requested blocking/final-only workflow.

## Proposal E — Persist follow-up obligations across gateway restarts

If the gateway process restarts or reconnects, completion/follow-up obligations should survive.

That implies persistence in session store or gateway store, not only memory.

Without this, the system remains vulnerable to:

- disconnects
- process restarts
- long-running jobs finishing after the original conversational turn ended

## Minimal practical implementation order

### Phase 1 — quickest meaningful improvement

1. Introduce durable pending completion delivery records
2. Write them when child runs finish
3. Deliver them via requester session routing
4. Retry on reconnect / next active opportunity

### Phase 2

1. Add `finalDelivery` semantics to spawn metadata
2. Default direct-chat delegated runs to `parent-owned`

### Phase 3

1. Convert important transport lifecycle notices from ephemeral-only to durable notifications too

### Phase 4

1. Add first-class `spawnAndWait` / parent wait helper

## Concrete places to inspect/change in OpenClaw source

Based on local verification, likely hotspots are:

- `src/infra/system-events.ts`
- `src/auto-reply/reply/session-system-events.ts`
- `src/auto-reply/reply/get-reply-run.ts`
- subagent registry / follow-up runtime around:
  - `resolveRequesterForChildSession`
  - `shouldIgnorePostCompletionAnnounceForSession`
  - `getLatestSubagentRunByChildSessionKey`
  - `enqueueFollowupRun`
- WhatsApp transport lifecycle path:
  - `extensions/whatsapp/src/auto-reply/monitor.ts`

## Conclusion

Yes — there is real gateway-side structural work to do.

The central change is:

- move from **ephemeral prompt-context events** toward **durable parent-owned final delivery obligations**.

That is the architectural fix for the user's requested behavior.
