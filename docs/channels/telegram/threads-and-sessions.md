---
summary: "Forum topic session keys, topic config inheritance, per-topic agents, and ACP bindings"
read_when:
  - Routing a forum topic to its own agent
  - Working out a Telegram session key for a topic
  - Binding an ACP harness session to a topic
title: "Telegram threads and sessions"
sidebarTitle: "Threads and sessions"
---

How forum topics map to sessions, agents, and ACP bindings.

## Forum topics and sessions

<AccordionGroup>
  <Accordion title="Forum topics and thread behavior">
    Forum supergroups: topic session keys append `:topic:<threadId>`; replies and typing target the topic thread; topic config path is `channels.telegram.groups.<chatId>.topics.<threadId>`.

    General topic (`threadId=1`) is a special case: message sends omit `message_thread_id` (Telegram rejects `sendMessage(...thread_id=1)` with "thread not found"), but typing actions still include `message_thread_id` (empirically required for the typing indicator to appear).

    Topic entries inherit group settings unless overridden (`requireMention`, `allowFrom`, `skills`, `systemPrompt`, `enabled`, `groupPolicy`). `agentId` is topic-only and does not inherit from group defaults. `topics."*"` sets defaults for every topic in that group; exact topic IDs still win over `"*"`.

    **Per-topic agent routing**: each topic can route to a different agent via `agentId` in the topic config, giving it its own workspace, memory, and session:

    ```json5
    {
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              topics: {
                "1": { agentId: "main" },      // General topic -> main agent
                "3": { agentId: "zu" },        // Dev topic -> zu agent
                "5": { agentId: "coder" }      // Code review -> coder agent
              }
            }
          }
        }
      }
    }
    ```

    Each topic then has its own session key, for example `agent:zu:telegram:group:-1001234567890:topic:3`.

    **Persistent ACP topic binding**: forum topics can pin ACP harness sessions through top-level typed bindings (`bindings[]` with `type: "acp"`, `match.channel: "telegram"`, `peer.kind: "group"`, and a topic-qualified id like `-1001234567890:topic:42`). Currently scoped to forum topics in groups/supergroups. See [ACP Agents](/tools/acp-agents).

    **Thread-bound ACP spawn from chat**: `/acp spawn <agent> --thread here|auto` binds the current topic to a new ACP session; follow-ups route there directly, and OpenClaw pins the spawn confirmation in-topic. Controlled by `session.threadBindings.spawnSessions` (default: `true`).

    Template context exposes `MessageThreadId` and `IsForum`. DM chats with `message_thread_id` keep reply metadata but only use thread-aware session keys when Telegram `getMe` reports `has_topics_enabled: true`.
    The retired `dm.threadReplies` and `direct.*.threadReplies` overrides are gone; BotFather threaded mode is the single source of truth. Run `openclaw doctor --fix` to remove stale config keys.

  </Accordion>
</AccordionGroup>
