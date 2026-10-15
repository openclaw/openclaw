---
summary: "When OpenClaw shows typing indicators and how to tune them"
read_when:
  - Changing typing indicator behavior or defaults
title: "Typing indicators"
---

Typing indicators are sent to the chat channel while a run is active. Use `agents.defaults.typingMode` to control **when** typing starts and `typingIntervalSeconds` to control **how often** it refreshes (keepalive cadence, default 6 seconds).

## Defaults

When `agents.defaults.typingMode` is **unset**:

- **Direct chats**: typing starts immediately once the model loop begins.
- **Group chats with a mention**: typing starts immediately.
- **Group chats without a mention**: typing starts when the admitted run has user-visible activity, such as harness execution activity or message text.
- **Message-tool-only replies**: typing starts immediately, even in a group chat without a mention, so members can see the agent working when no automatic final reply is posted. This takes precedence over the group rules above; an explicit `typingMode` still wins over it.
- **Noninteractive automation and system-event turns**: no typing indicator.

## Modes

Set `agents.defaults.typingMode` to one of:

- `never` - no typing indicator, ever.
- `instant` - start typing **as soon as the model loop begins**, even if the run later returns only the silent reply token.
- `thinking` - start typing on the **first reasoning delta**, or on active harness execution after the turn is accepted.
- `message` - start typing on the **first user-visible reply activity**, such as active harness execution or a non-silent text delta. Silent reply tokens such as `NO_REPLY` do not count as text activity.

Order of "how early it fires": `never` -> `message`/`thinking` -> `instant`.

## Configuration

Set the agent-level default:

```json5
{
  agents: {
    defaults: {
      typingMode: "thinking",
      typingIntervalSeconds: 6,
    },
  },
}
```

Override the policy for one agent:

```json5
{
  agents: {
    entries: {
      support: {
        typingMode: "message",
      },
    },
  },
}
```

## Notes

- `message` mode does not start from silent reply tokens, but active execution can still show typing before any assistant text is available.
- `thinking` still reacts to streamed reasoning (`reasoningLevel: "stream"`), and can also start from active execution before reasoning deltas arrive.
- Restart recovery can renew typing through a guarded channel hook while an interrupted conversation resumes. It respects `typingMode: "never"`; see [Restart recovery](/gateway/restart-recovery).
- `agents.defaults.typingIntervalSeconds` controls the **refresh cadence** for every agent, not the start time. Default: 6 seconds.

## Related

<CardGroup cols={2}>
  <Card title="Presence" href="/concepts/presence" icon="signal">
    How the Gateway tracks connected clients for the Control UI Devices page and macOS Instances tab.
  </Card>
  <Card title="Streaming and chunking" href="/concepts/streaming" icon="bars-staggered">
    Outbound streaming behavior, chunk boundaries, and channel-specific delivery.
  </Card>
  <Card title="Automations" href="/automation/cron-jobs" icon="clock">
    Scheduled agent turns, per-job execution policies, and delivery settings.
  </Card>
  <Card title="Groups" href="/channels/groups" icon="users">
    Group chat behavior and mention gating across group-capable channels.
  </Card>
</CardGroup>
