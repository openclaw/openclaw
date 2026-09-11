---
summary: "Streaming previews, voice-note transcription, and reactions"
read_when:
  - Turning on live reply previews in Matrix
  - Configuring Matrix ack reactions and custom emotes
title: "Matrix message behavior"
sidebarTitle: "Messaging"
---

How OpenClaw delivers replies into Matrix rooms: streaming previews, inbound voice notes, and reactions.

## Streaming previews

Matrix reply streaming is opt-in. `streaming.mode` controls how OpenClaw delivers the in-flight assistant reply; `streaming.block.enabled` controls whether each completed block is kept as its own Matrix message.

```json5
{
  channels: {
    matrix: {
      streaming: { mode: "partial" },
    },
  },
}
```

To keep live answer previews but hide interim tool/progress lines:

```json5
{
  channels: {
    matrix: {
      streaming: {
        mode: "partial",
        preview: {
          toolProgress: false,
        },
      },
    },
  },
}
```

The full config accepts `{ mode, chunkMode, block, preview, progress }`:

```json5
{
  channels: {
    matrix: {
      streaming: {
        mode: "progress",
        progress: {
          label: "auto", // pick from configured or built-in labels (false to hide)
          labels: ["Thinking", "Writing", "Searching"], // candidates for label: "auto"
          maxLines: 8, // max rolling progress lines (default: 8)
          maxLineChars: 120, // max chars per line before truncation (default: 120)
          toolProgress: true, // rolling tool log in the progress draft (default: false)
        },
      },
    },
  },
}
```

- `progress.label`: custom label, `"auto"`/unset to pick a configured or built-in label, or `false` to hide it.
- `progress.labels`: candidates used only when `label` is `"auto"` or unset.
- `progress.maxLines`: max rolling progress lines kept in the draft; older lines are trimmed past this.
- `progress.maxLineChars`: max characters per compact progress line before truncation.
- `progress.toolProgress`: when `true`, live tool/progress activity appears in the draft. The default `false` keeps the draft to its headline, commentary, plan milestones, and approval or failure lines.

| `streaming.mode`  | Behavior                                                                                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"off"` (default) | Wait for the full reply, send once.                                                                                                                                                                                                                                                          |
| `"partial"`       | Edit one normal text message in place as the model writes the current block. Stock clients may notify on the first preview, not the final edit.                                                                                                                                              |
| `"quiet"`         | Same as `"partial"` but the message is a non-notifying notice. Recipients are notified once a per-user push rule matches the finalized edit (see [Self-hosted push rules for quiet finalized previews](/channels/matrix/rich-messages#self-hosted-push-rules-for-quiet-finalized-previews)). |
| `"progress"`      | Sends individual compact progress lines using a progress draft.                                                                                                                                                                                                                              |

`streaming.block.enabled` (default `false`) is independent of `streaming.mode`:

| `streaming.mode`        | `block.enabled: true`                                               | `block.enabled: false` (default)                     |
| ----------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| `"partial"` / `"quiet"` | Live draft for the current block, completed blocks kept as messages | Live draft for the current block, finalized in place |
| `"off"`                 | One notifying Matrix message per finished block                     | One notifying Matrix message for the full reply      |

Notes:

- If a preview grows past Matrix's per-event size limit, OpenClaw stops preview streaming and falls back to final-only delivery.
- Media replies always send attachments normally. If a visible preview cannot be reused safely, OpenClaw keeps it until the complete replacement is confirmed and then redacts it. If replacement delivery fails, is partial, or produces no visible event, the preview remains visible.
- Tool-progress preview updates are on by default when preview streaming is active. Set `streaming.preview.toolProgress: false` to keep preview edits for answer text but leave tool progress on the normal delivery path.
- Preview edits cost extra Matrix API calls. Leave `streaming.mode: "off"` for the most conservative rate-limit profile.
- Legacy scalar/boolean `streaming` values and the flat `blockStreaming` / `chunkMode` keys are rewritten to this nested shape by `openclaw doctor --fix`.

## Voice messages

Inbound Matrix voice notes are transcribed before the room mention gate, so a voice note saying the bot name can trigger the agent in a `requireMention: true` room, and the agent gets the transcript instead of only an audio attachment placeholder.

Matrix uses the shared audio media provider under `tools.media.audio`, such as OpenAI `gpt-4o-mini-transcribe`. See [Media tools overview](/tools/media-overview) for provider setup and limits.

- `m.audio` events and `m.file` events with an `audio/*` MIME type are eligible.
- In encrypted rooms, OpenClaw decrypts the attachment through the existing Matrix media path before transcription.
- The transcript is marked machine-generated and untrusted in the agent prompt.
- The attachment is marked as already transcribed so downstream media tools do not transcribe it again.
- Set `tools.media.audio.enabled: false` to disable audio transcription globally.

## Reactions

Matrix supports outbound reactions, inbound reaction notifications, and ack reactions.

Outbound reaction tooling is gated by `channels.matrix.actions.reactions`:

- `react` adds a reaction to a Matrix event.
- `reactions` lists the current reaction summary for a Matrix event.
- `emoji-list` discovers custom emoji from the current conversation's room packs and your personal pack.
- `emoji=""` removes the bot's own reactions on that event.
- `remove: true` removes only the specified emoji reaction from the bot.

`emoji-list` reads MSC2545 `im.ponies.room_emotes` packs from the authorized current room and `im.ponies.user_emotes` account data. It returns up to 100 sorted entries such as `{ "name": "party", "identifier": "party", "url": "mxc://example.org/party" }`; sticker-only entries are excluded. Pass `identifier` to `react`: it is the plain shortcode stored directly as the Matrix reaction's `m.relates_to.key`, not the `mxc://` media URL. Custom-reaction rendering depends on the Matrix client, so `url` is included separately for clients or agents that need the image.

**Resolution order** (first defined value wins):

| Setting                 | Order                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `ackReaction`           | per-account -> channel -> `messages.ackReaction` -> agent identity emoji fallback   |
| `ackReactionScope`      | per-account -> channel -> `messages.ackReactionScope` -> default `"group-mentions"` |
| `reactionNotifications` | per-account -> channel -> default `"own"`                                           |

`reactionNotifications: "own"` forwards added `m.reaction` events when they target bot-authored Matrix messages; `"off"` disables reaction system events. Reaction removals are not synthesized into system events - Matrix surfaces those as redactions, not as standalone `m.reaction` removals.
