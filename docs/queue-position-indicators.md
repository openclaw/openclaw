---
summary: "Number-emoji reactions that show a Slack message's position in the followup queue"
read_when:
  - You want to understand how queue position reactions work in Slack
  - You are debugging missing or stale number-emoji reactions on messages
title: "Queue Position Indicators"
---

# Queue Position Indicators

When multiple Slack messages arrive while the agent is busy, OpenClaw adds
number-emoji reactions (1️⃣ 2️⃣ 3️⃣ …) to each queued message so users can see
their position in the queue at a glance.

## How it works

1. **Enqueue** — when a new message is added to a followup queue, all queued
   messages receive updated number reactions reflecting their current position.

2. **Processing** — when the agent starts handling a message, the number
   reaction is replaced with ⏳ (`hourglass_flowing_sand`) to signal active
   processing.

3. **Complete** — once the agent finishes, the ⏳ reaction is removed. The
   remaining queued messages keep their updated position numbers.

4. **Queue cleared** — when a queue is explicitly cleared (e.g., session ends),
   all position reactions for that queue's messages are removed.

## Limits

- Positions 1–10 receive number reactions (1️⃣ through 🔟).

- Messages beyond position 10 receive no reaction.

- Only Slack messages are tracked. Other channels (Telegram, WhatsApp, etc.)
  are unaffected.

## Multi-account support

Each tracked reaction stores the `accountId` it was added with. Removal calls
always use the same account so multi-workspace setups work correctly.

## Per-queue scoping

Clearing one queue removes reactions only for that queue's messages. Reactions
tracked for other concurrent queues are preserved.

## Implementation

The feature lives in `src/auto-reply/reply/queue/position-tracker.ts`.

Key classes and exports:

- `QueuePositionTracker` — the tracker class
- `globalQueuePositionTracker` — singleton shared across all queues
- `MAX_TRACKED_POSITION` — maximum position that receives a number reaction (10)

Integration points:

- `enqueue.ts` — calls `updateQueuePositions` after every successful enqueue
- `drain.ts` — calls `markAsProcessing` before processing, then `removeProcessingIndicator` after
- `state.ts` — calls `clearQueuePositions` in `clearFollowupQueue` (scoped to that queue)
