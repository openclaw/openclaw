---
summary: "Group mention gating, visible reply modes, DM history limits, and self-chat mode"
read_when:
  - Deciding when the agent replies in a group or channel
  - Debugging a group @mention that types then goes silent
  - Limiting how much DM history the agent sees
title: "Configuration — group mention gating and history"
---

How group messages reach the agent: mention gating, visible reply modes, DM history limits, and self-chat mode.

## Group chat mention gating

Group messages default to **require mention** (metadata mention or safe regex patterns). Applies to WhatsApp, Telegram, Discord, Google Chat, and iMessage group chats.

Visible replies are controlled separately. Normal group, channel, and internal WebChat direct requests default to automatic final delivery: final assistant text posts through the legacy visible reply path. Opt into `messages.visibleReplies: "message_tool"` or `messages.groupChat.visibleReplies: "message_tool"` when model-authored source replies should only post after the agent calls `message(action=send)`. If the model returns a substantive final answer without calling the message tool in an opted-in tool-only mode, that final text stays private, the gateway verbose log records suppressed payload metadata, and OpenClaw enqueues one recovery retry asking the model to deliver the same reply via `message(action=send)`.

The tool-only policy governs assistant source replies and generic tool media. It does not suppress runtime-owned terminal output such as authorized command responses, durable completion notices, or provider-native artifacts that the owning harness explicitly classifies as host-owned. Host-owned artifacts are delivered through the normal channel dispatch path and still respect outbound `sendPolicy` denial. Ambient `room_event` turns remain quiet unless they are explicit commands, even when runtime output is marked host-owned.

Tool-only visible replies require a model/runtime that reliably calls tools, and are recommended for shared ambient rooms on latest-generation models such as GPT-5.6 Sol. Some weaker models can answer final text but fail to understand that source-visible output must be sent with `message(action=send)`. OpenClaw recovers the common stranded-final case by default only when the final is substantive, the source turn was not a room event, send policy did not deny delivery, and no source reply was already sent. Recovery is bounded to one retry; it suppresses persistence for the synthetic retry prompt and keeps that retry out of collect batching so it cannot merge with unrelated queued prompts. If the retry also strands or cannot be enqueued, OpenClaw delivers only a sanitized diagnostic such as "I generated a reply but could not deliver it to this chat. Please try again." The original private final text is never marked for automatic source delivery. For models that repeatedly strand replies, use `"automatic"` so the final assistant turn is the visible reply path, switch to a stronger tool-calling model, inspect the gateway verbose log for the suppressed payload summary, or set `messages.groupChat.visibleReplies: "automatic"` to use visible final replies for every group/channel request.

If the message tool is unavailable under the active tool policy, OpenClaw falls back to automatic visible replies instead of silently suppressing the response. `openclaw doctor` warns about this mismatch.

This rule applies to normal agent final text. Plugin-owned conversation bindings use the owning plugin's returned reply as the visible response for claimed bound-thread turns; the plugin does not need to call `message(action=send)` for those binding replies.

**Troubleshooting: group @mention triggers typing then silence (no error)**

Symptom: a group/channel @mention shows the typing indicator and the gateway log reports `dispatch complete (queuedFinal=false, replies=0)`, but no message lands in the room. DMs to the same agent reply normally.

Cause: the group/channel visible-reply mode resolves to `"message_tool"`, so OpenClaw runs the turn but suppresses final assistant text unless the agent calls `message(action=send)`. There is no `NO_REPLY` contract in this mode; no message-tool call means the original final text is private. For substantive source turns OpenClaw now attempts one guarded recovery retry; short notes, explicit silence, room events, send-policy-denied turns, and already delivered turns are not retried. Normal group and channel turns default to `"automatic"`, so this symptom only appears when `messages.groupChat.visibleReplies` (or global `messages.visibleReplies`) is explicitly set to `"message_tool"`. Harness `defaultVisibleReplies` does not apply here — the group/channel resolver ignores it; it only affects direct/source chats (the Codex harness suppresses direct-chat finals that way).

Fix: either pick a stronger tool-calling model, remove the explicit `"message_tool"` override to fall back to the `"automatic"` default, or set `messages.groupChat.visibleReplies: "automatic"` to force visible replies for every group/channel request. A substantive stranded final should no longer end as silent success; it should either recover through one `message(action=send)` retry or show the sanitized delivery-failure diagnostic. The gateway hot-reloads `messages` config after the file is saved; only restart the gateway when file watching or config reload is disabled in the deployment.

**Mention types:**

- **Metadata mentions**: Native platform @-mentions. Ignored in WhatsApp self-chat mode.
- **Text patterns**: Safe regex patterns in `agents.entries.*.groupChat.mentionPatterns`. Invalid patterns and unsafe nested repetition are ignored.
- Mention gating is enforced only when detection is possible (native mentions or at least one pattern).

```json5
{
  messages: {
    visibleReplies: "automatic", // force old automatic final replies for direct/source chats
    groupChat: {
      historyLimit: 50,
      unmentionedInbound: "room_event", // always-on unmentioned room chatter becomes quiet context
      visibleReplies: "message_tool", // opt-in; require message(action=send) for visible room replies
    },
  },
  agents: {
    entries: {
      main: {
        default: true,
        groupChat: { mentionPatterns: ["@openclaw", "openclaw"] },
      },
    },
  },
}
```

`messages.groupChat.historyLimit` sets the global default. Channels can override with `channels.<channel>.historyLimit` (or per-account). Set `0` to disable.

`messages.groupChat.unmentionedInbound: "room_event"` submits unmentioned always-on group/channel messages as quiet room context on supported channels. Mentioned messages, commands, and direct messages remain user requests. See [Ambient room events](/channels/ambient-room-events) for complete Discord, Slack, and Telegram examples.

`messages.visibleReplies` is the global source-event default; `messages.groupChat.visibleReplies` overrides it for group/channel source events. When `messages.visibleReplies` is unset, direct/source chats use the selected runtime or harness default, but internal WebChat direct turns use automatic final delivery for Pi/Codex prompt parity. Set `messages.visibleReplies: "message_tool"` to intentionally require `message(action=send)` for visible output. Channel allowlists and mention gating still decide whether an event is processed.

### DM history limits

```json5
{
  channels: {
    telegram: {
      dmHistoryLimit: 30,
      dms: {
        "123456789": { historyLimit: 50 },
      },
    },
  },
}
```

Resolution: per-DM override → provider default → no limit (all retained). On a multi-account channel, the account for the current message is checked before the channel root, so `channels.<provider>.accounts.<id>.dmHistoryLimit` overrides `channels.<provider>.dmHistoryLimit` for that account only.

The `dms` map is the exception: an account that defines `accounts.<id>.dms` replaces the root `dms` map for that account rather than merging entry by entry. A peer listed only at the root therefore falls through to that account's `dmHistoryLimit`, not to the root per-DM value. Repeat any root entries you still want inside the account map.

The embedded OpenClaw runtime applies these limits to recent turns during prompt preparation for channel-scoped DM sessions, including `per-account-channel-peer`. Shared main sessions remain unwindowed by these channel limits. Client-side compaction still summarizes older durable history; the resulting summary is preserved alongside the windowed recent turns. These limits do not delete stored messages. Native runtimes manage their own transcript history.

Provider-side compaction uses the prepared transcript window. Gateway-triggered compaction resolves a linked peer from the current session's recorded primary conversation; missing or stale route facts do not select another peer's override.

Channel-supplied recent-message context is a separate window. For example, Telegram looks up `dms` by native user ID and counts individual messages, while the embedded transcript window looks up the session peer and counts user turns. With `session.identityLinks`, that session peer is the linked ID. Configure both keys when you want both windows limited for a linked identity:

```json5
{
  session: {
    dmScope: "per-channel-peer",
    identityLinks: { alice: ["telegram:123456789"] },
  },
  channels: {
    telegram: {
      accounts: {
        work: {
          dms: {
            "123456789": { historyLimit: 2 }, // Telegram supplemental context
            alice: { historyLimit: 2 }, // Embedded session transcript
          },
        },
      },
    },
  },
}
```

These existing windows are not one strict whole-prompt cap: supplemental reply context, saved compaction summaries, and the transcript window's batching cushion can add context beyond the configured count.

Session keys alone can be ambiguous when account names or linked peer IDs contain tokens such as `direct`. OpenClaw uses the observed route peer to select the correct per-DM override. When an ambiguous session has no observed peer, or its identity link has changed, the known account/channel DM default applies instead of another peer's override. Unambiguous session keys retain their existing per-DM lookup.

### Self-chat mode

Include your own number in `allowFrom` to enable self-chat mode (ignores native @-mentions, only responds to text patterns):

```json5
{
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
  agents: {
    entries: {
      main: {
        default: true,
        groupChat: { mentionPatterns: ["reisponde", "@openclaw"] },
      },
    },
  },
}
```
