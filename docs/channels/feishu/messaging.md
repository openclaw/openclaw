---
summary: "Which Feishu message types OpenClaw receives and sends, including stickers and thread replies"
read_when:
  - Checking whether Feishu supports a message type
  - Enabling sticker replies or sticker keyword search
title: "Feishu message types"
sidebarTitle: "Message types"
---

The Feishu message types OpenClaw can receive and send, sticker support, and thread-aware replies.

## Supported message types

### Receive

- ✅ Text
- ✅ Rich text (post)
- ✅ Images
- ✅ Files
- ✅ Audio
- ✅ Video/media
- ✅ Stickers

Received stickers expose their reusable `file_key` to the agent as
`<sticker key="..."/>`. Feishu/Lark does not support downloading sticker
resources, so OpenClaw preserves the key without fetching an attachment.

Inbound Feishu/Lark audio messages are normalized as media placeholders instead
of raw `file_key` JSON. When `tools.media.audio` is configured, OpenClaw
downloads the voice-note resource and runs shared audio transcription before the
agent turn, so the agent receives the spoken transcript. If Feishu includes
transcript text directly in the audio payload, that text is used without another
ASR call. Without an audio transcription provider, the agent still receives a
`<media:audio>` placeholder plus the saved attachment, not the raw Feishu
resource payload.

### Send

- ✅ Text
- ✅ Images
- ✅ Files
- ✅ Audio
- ✅ Video/media
- ✅ Interactive cards (including streaming updates)
- ✅ Stickers previously received by the same bot (requires `actions.sticker`)
- ⚠️ Rich text (post-style formatting; doesn't support full Feishu/Lark authoring capabilities)

Native Feishu/Lark audio bubbles use the Feishu `audio` message type and require
Ogg/Opus upload media (`file_type: "opus"`). Existing `.opus` and `.ogg` media
is sent directly as native audio. MP3/WAV/M4A and other likely audio formats are
transcoded to 48kHz Ogg/Opus with `ffmpeg` only when the reply requests voice
delivery (`audioAsVoice` / message tool `asVoice`, including TTS voice-note
replies). Ordinary MP3 attachments stay regular files. If `ffmpeg` is missing or
conversion fails, OpenClaw falls back to a file attachment and logs the reason.

### Sticker replies

Enable the sticker action to let the agent resend stickers:

```json5
{
  channels: {
    feishu: {
      actions: { sticker: true },
    },
  },
}
```

For one account only, set `channels.feishu.accounts.<id>.actions.sticker: true`
instead. An account-level `actions` object **replaces**, rather than merges
with, the channel-level object. Repeat any action gates you want to preserve.
For example, keep reactions disabled while enabling stickers for `work`:

```json5
{
  channels: {
    feishu: {
      actions: { reactions: false },
      accounts: {
        work: {
          actions: { reactions: false, sticker: true },
        },
      },
    },
  },
}
```

Send a sticker to that bot first, then ask it to resend the sticker.
The shared `message` tool uses `action: "sticker"` with the received `file_key`
in `fileId` or the first entry of `stickerId`. In multi-account setups, use the
same `accountId` that received the sticker.

Only stickers previously received by that bot can be sent. Uploading new
stickers, downloading sticker resources, and searching the sticker store are
not supported.

### Sticker keyword search

Add a curated sticker set to let the agent find a received sticker by keyword.
First send each sticker to the bot and ask it for the received `file_key`.
Then add keys and your own labels to the existing Feishu configuration:

```json5
{
  channels: {
    feishu: {
      actions: { sticker: true },
      stickerSets: {
        cli_work: {
          file_received_key: ["thumbs up", "赞", "👍"],
        },
      },
    },
  },
}
```

Replace `cli_work` with the bot's actual app ID and `file_received_key` with
the key received by that bot. `stickerSets` belongs directly under
`channels.feishu`, not inside an account. The selected account can search only
the set matching its app ID; changing an account to a different bot does not
reuse the previous bot's set. Accounts using the same bot share its set.
Keep any existing account-level action gates as described above.

Ask the agent to “send a thumbs up sticker.” It can use the shared `message`
tool with `action: "sticker-search"`, `query: "thumbs up"`, and the intended
`accountId`, then send a returned `fileId` with `action: "sticker"` on that
same account. Search is available only when stickers are enabled and the bot
has a nonempty configured set.

Search matches a case-insensitive substring of an explicit keyword, including
Chinese labels and emoji, in sticker-key order. It does not infer a sticker's
meaning, search Feishu's store, or automatically collect received stickers.
Results include the matching `keyword` and reusable `fileId`. No matches
produce an empty list; `truncated: true` means matching entries were omitted
by the result limit or output budget. Narrow the query to find other matches.

Limits: 32 bot sets, 256 stickers per set, and 1–8 keywords per sticker.
Store keywords without leading or trailing whitespace; each must be nonempty
and at most 64 Unicode characters. File keys must be canonical received keys,
at most 512 Unicode characters. Each key appears only once in its bot's map.
Queries are nonempty and at most 128 Unicode characters. `limit` defaults to 5
and accepts integers from 1 through 10; search results are also capped at
3 KiB of JSON output. Removing a set removes it from search; no separate
sticker database or cache is created.

### Threads and replies

- ✅ Inline replies
- ✅ Thread replies
- ✅ Media replies stay thread-aware when replying to a thread message

Topic-group session routing is covered under
[Group session scope and topic threads](/channels/feishu/advanced-configuration#group-session-scope-and-topic-threads).
