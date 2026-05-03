---
summary: "Progress drafts: one visible work-in-progress message that updates while an agent runs"
read_when:
  - Configuring visible progress updates for long-running chat turns
  - Choosing between partial, block, and progress streaming modes
  - Explaining how OpenClaw updates one channel message while work is in progress
  - Troubleshooting progress drafts, standalone progress messages, or finalization fallback
title: "Progress drafts"
---

Progress drafts make long-running agent turns feel alive in chat without turning
the conversation into a stack of temporary status replies.

When progress drafts are enabled, OpenClaw creates one visible work-in-progress
message, updates it while the agent reads, plans, calls tools, or waits for
approval, and then turns that draft into the final answer when the channel can
do that safely.

```text
Shelling
- reading recent channel context
- checking matching issues
- preparing reply
```

Use progress drafts when you want one tidy status message during tool-heavy work
and the final answer when the turn is done.

## Quick Start

Enable progress drafts per channel with `streaming.mode: "progress"`:

```json5
{
  channels: {
    discord: {
      streaming: {
        mode: "progress",
      },
    },
  },
}
```

That is usually enough. OpenClaw will pick an automatic one-word label, add
compact progress lines while useful work happens, and suppress duplicate
standalone progress chatter for that turn.

## What Users See

A progress draft has two parts:

| Part           | Purpose                                                           |
| -------------- | ----------------------------------------------------------------- |
| Label          | A short title such as `Thinking` or `Shelling`.                   |
| Progress lines | Compact run updates such as tool calls, task steps, or approvals. |

The label appears immediately when the agent starts replying. Progress lines are
added only when the agent emits useful work updates. The final answer replaces
the draft when possible; otherwise OpenClaw sends the final answer normally and
cleans up or stops updating the draft according to the channel's transport.

## Choose A Mode

`channels.<channel>.streaming.mode` controls the visible in-progress behavior:

| Mode       | Best for                         | What appears in chat                              |
| ---------- | -------------------------------- | ------------------------------------------------- |
| `off`      | Quiet channels                   | Only the final answer.                            |
| `partial`  | Watching answer text appear      | One draft edited with the latest answer text.     |
| `block`    | Larger answer-preview chunks     | One preview updated or appended in bigger chunks. |
| `progress` | Tool-heavy or long-running turns | One status draft, then the final answer.          |

Choose `progress` when users care more about "what is happening" than watching
the answer text stream token by token.

Choose `partial` when the answer itself is the progress signal.

Choose `block` when you want draft preview updates in larger text chunks. On
Discord and Telegram, `streaming.mode: "block"` is still preview streaming, not
normal block delivery. Use `streaming.block.enabled` or legacy
`blockStreaming` when you want normal block replies.

## Configure Labels

Progress labels live under `channels.<channel>.streaming.progress`.

The default label is `auto`, which chooses from OpenClaw's built-in single-word
label pool:

```text
Thinking
Shelling
Scuttling
Clawing
Pinching
Molting
Bubbling
Tiding
Reefing
Cracking
Sifting
Brining
Nautiling
Krilling
Barnacling
Lobstering
Tidepooling
Pearling
Snapping
Surfacing
```

Use a fixed label:

```json5
{
  channels: {
    discord: {
      streaming: {
        mode: "progress",
        progress: {
          label: "Investigating",
        },
      },
    },
  },
}
```

Use your own automatic label pool:

```json5
{
  channels: {
    discord: {
      streaming: {
        mode: "progress",
        progress: {
          label: "auto",
          labels: ["Checking", "Reading", "Testing", "Finishing"],
        },
      },
    },
  },
}
```

Hide the label and show only progress lines:

```json5
{
  channels: {
    discord: {
      streaming: {
        mode: "progress",
        progress: {
          label: false,
        },
      },
    },
  },
}
```

## Control Progress Lines

Progress lines are enabled by default in progress mode. They come from real run
events: tool starts, item updates, task plans, approvals, command output, patch
summaries, and similar agent activity.

Limit how many lines stay visible:

```json5
{
  channels: {
    discord: {
      streaming: {
        mode: "progress",
        progress: {
          maxLines: 4,
        },
      },
    },
  },
}
```

Keep the single progress draft but hide tool and task lines:

```json5
{
  channels: {
    discord: {
      streaming: {
        mode: "progress",
        progress: {
          toolProgress: false,
        },
      },
    },
  },
}
```

With `toolProgress: false`, OpenClaw still suppresses the older standalone
tool-progress messages for that turn. The channel stays visually quiet until the
final answer, except for the label if one is configured.

## Channel Behavior

Each channel uses the cleanest transport it supports:

| Channel         | Progress transport                     | Notes                                                                 |
| --------------- | -------------------------------------- | --------------------------------------------------------------------- |
| Discord         | Send one message, then edit it.        | Final text edits in place when it fits one safe preview message.      |
| Matrix          | Send one event, then edit it.          | Account-level streaming config controls account-level drafts.         |
| Microsoft Teams | Native Teams stream in personal chats. | `streaming.mode: "block"` maps to Teams block delivery.               |
| Slack           | Native stream or editable draft post.  | Thread availability affects whether native streaming can be used.     |
| Telegram        | Send one message, then edit it.        | Older visible drafts may be replaced so final timestamps stay useful. |
| Mattermost      | Editable draft post.                   | Tool activity is folded into the same draft-style post.               |

Channels without safe edit support usually fall back to typing indicators or
final-only delivery.

## Finalization

When the final answer is ready, OpenClaw tries to keep the chat clean:

- If the draft can safely become the final answer, OpenClaw edits it in place.
- If the channel uses native progress streaming, OpenClaw finalizes that stream
  when the native transport accepts the final text.
- If the final answer has media, an approval prompt, an explicit reply target,
  too many chunks, or a failed edit/send, OpenClaw sends the final answer through
  the normal channel delivery path.

The fallback path is intentional. It is better to send a fresh final answer than
to lose text, mis-thread a reply, or overwrite a draft with a payload the channel
cannot represent safely.

## Troubleshooting

**I only see the final answer.**

Check that `channels.<channel>.streaming.mode` is set to `progress` for the
account or channel that handled the message. Some group or quote-reply paths may
disable draft previews for a turn when the channel cannot safely edit the right
message.

**I see the label but no tool lines.**

Check `streaming.progress.toolProgress`. If it is `false`, OpenClaw keeps the
single draft behavior but hides tool and task progress lines.

**I see a fresh final message instead of an edited draft.**

That is a safety fallback. It can happen for media replies, long answers,
explicit reply targets, old Telegram drafts, missing Slack thread targets,
deleted preview messages, or failed native stream finalization.

**I still see standalone progress messages.**

Progress mode suppresses default standalone tool-progress messages when a draft
is active. If standalone messages still appear, verify that the turn is actually
using progress mode and not `streaming.mode: "off"` or a channel path that
cannot create a draft for that message.

**Teams behaves differently from Discord or Telegram.**

Microsoft Teams uses a native stream in personal chats instead of the generic
send-and-edit preview transport. Teams also treats `streaming.mode: "block"` as
Teams block delivery because it does not have the same draft-preview block mode
used by Discord and Telegram.

## Related

- [Streaming and chunking](/concepts/streaming)
- [Messages](/concepts/messages)
- [Channel configuration](/gateway/config-channels)
- [Discord](/channels/discord)
- [Matrix](/channels/matrix)
- [Microsoft Teams](/channels/msteams)
- [Slack](/channels/slack)
- [Telegram](/channels/telegram)
