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

    Topic IDs must be positive integers. OpenClaw rejects topic `0` in delivery targets and explicit thread options before making Telegram requests.

    General topic (`threadId=1`) is a special case: message sends omit `message_thread_id` (Telegram rejects `sendMessage(...thread_id=1)` with "thread not found"), but typing actions still include `message_thread_id` (empirically required for the typing indicator to appear).

    Topic entries inherit group settings unless overridden (`requireMention`, `requireMentionInBotThreads`, `allowFrom`, `skills`, `systemPrompt`, `enabled`, `groupPolicy`). `agentId` is topic-only and does not inherit from group defaults. `topics."*"` sets defaults for every topic in that group; exact topic IDs still win over `"*"`.

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

    Startup waits for stored thread bindings before accepting updates. Shutdown drains accepted binding changes before a replacement bot reloads them. Bundled Telegram handlers persist bindings through the shared SQLite worker so storage does not block message handling. Deprecated synchronous Plugin SDK touch and lifecycle setters keep their immediate behavior on the same binding owner until the next SDK major.

    Disabling `threadBindings.enabled` globally, for Telegram, or for one account leaves ordinary Telegram messages working.

    Template context exposes `MessageThreadId` and `IsForum`. DM chats with `message_thread_id` use thread-aware session keys when Telegram reports topics enabled. Native private-topic messages and title updates also establish topic scope when startup `getMe` data is stale.
    The retired `dm.threadReplies` and `direct.*.threadReplies` overrides are gone; BotFather threaded mode is the single source of truth. Run `openclaw doctor --fix` to remove stale config keys.

    Observed private-topic creation and rename events update the existing session's name in the connected Control UI without starting an agent turn. A manually chosen session label keeps priority over the native topic name. Renaming an unmessaged topic does not create a session.

  </Accordion>
</AccordionGroup>

## Bot-created forum topics

Set `requireMentionInBotThreads` on a group or topic to override mention gating only in forum topics created by the receiving bot. `false` allows unmentioned messages to start turns there; `true` requires a mention, including for replies to the bot. Omission preserves existing behavior. A topic setting wins over the selected group setting. The same paths are available under `channels.telegram.accounts.<accountId>.groups`.

OpenClaw records the creator from an observed `forum_topic_created` service message or from a successful topic creation by the bot. Ownership is specific to that bot: another bot's topic or a human-created topic keeps its ordinary mention policy. Replying in a topic does not make the bot its creator.

Topic ownership persists alongside topic names in the existing cache, which retains up to 2,048 recently used topics. Topics created before OpenClaw observed them and evicted entries keep the ordinary mention policy. Telegram does not provide a topic-owner lookup to recover those facts. This setting does not change DM topics, authorization, group silence policy, or visible-reply policy. See [Mention behavior](/channels/telegram/access-control#access-control-and-activation) for configuration and Telegram visibility requirements.

## Automatic DM topic names

In DM forum topics, OpenClaw can name the topic automatically after the first message using the configured LLM. This is on by default and can be disabled per DM or per account: set `channels.telegram.autoTopicLabel: false` (default account), `channels.telegram.accounts.<accountId>.autoTopicLabel: false` (account default), or a per-DM `channels.telegram.accounts.<accountId>.direct.<chatId>.autoTopicLabel: false` (root `channels.telegram.direct.<chatId>.autoTopicLabel` for the default account). An object form customizes the LLM prompt:

```json5
{
  channels: {
    telegram: {
      autoTopicLabel: {
        enabled: true,
        // prompt: "custom naming instruction",
        // Optional, off by default: one bounded refinement of the automatic
        // name after several later messages. Never renames a topic that was
        // renamed manually after the automatic name was set, and runs at most
        // once per topic.
        refine: true,
        refineAfterMessages: 6, // user messages before refinement (1-100, default 6)
      },
    },
  },
}
```

Manual renames always win: if the topic name changes after the automatic label was applied, the optional refinement skips that topic. Disabling `autoTopicLabel` also disables its refinement.

### Reset-aware automatic names

Control-only turns, including `/reset` and `/model`, do not supply topic-title
text. After `/reset` or `/new`, the current name remains visible until a
substantive task arrives. For names owned by the automatic writer, a reset
prefers the existing name when it still fits; a new conversation may receive
a new subject name. Manual names and topics without established automatic
provenance are not adopted. Missing ownership or failed inference preserves
the current title. This reassessment shares the refinement owner; it is not
another recurring renaming loop. The optional later-message refinement still
defaults to six task messages, with configurable bounds of 1–100.

Automatic Telegram topic names are limited to **three words by code after
inference**, including custom prompts, first naming, refinement, and reset/new
reassessment. Word boundaries use Unicode word segmentation; punctuation does
not bypass the limit. An already suitable short automatic name is kept without
an API rename. Manual names are never shortened by this rule. Legacy automatic
names longer than three words are bounded on the next substantive reassessment,
not on a control-only turn. Empty or punctuation-only output leaves the name alone.
