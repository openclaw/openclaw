---
summary: "Rich output protocol for structured media, embeds, audio hints, and replies"
read_when:
  - Changing assistant output rendering in the Control UI
  - Debugging `[embed ...]`, structured media, reply, or audio presentation directives
title: "Rich output protocol"
---

Assistant output carries delivery/render directives through a few dedicated channels:

- Structured `mediaUrl` / `mediaUrls` fields for attachment delivery.
- `[[audio_as_voice]]` for audio presentation hints.
- `[[reply_to_current]]` / `[[reply_to:<id>]]` for reply metadata.
- `[embed ...]` for Control UI rich rendering.

Structured media fields and `[[...]]` tags are delivery metadata. `[embed ...]` is the separate web-only rich-render path; it is not a media alias.

## Media attachments

Remote attachments must be public `https:` URLs. `http:`, loopback, link-local, private, and internal hostnames are rejected as attachment directives; server-side media fetchers apply their own network guards on top.

Local attachments accept absolute paths, workspace-relative paths, or home-relative `~/` paths. They still pass the agent file-read policy and media type checks before delivery.

In Control UI chat, relative local references resolve against the session's working directory, including a selected project or worktree. They use the same authenticated media route as absolute paths; a missing file shows an attachment error instead of a literal `MEDIA:` line. Files on another execution host must first be delivered as managed attachments.

<Warning>
Tools, plugins, browser output, message actions, and streaming block payloads must use structured attachment fields, not text commands. Reply payloads use `mediaUrl` / `mediaUrls`:

```json
{ "text": "Here is your image.", "mediaUrl": "/workspace/image.png" }
```

For `message(action=send)`, use `media` for one attachment or `attachments: [{media: ...}]` for several. The automatic-mode model-authored text compatibility below is not a general tool, plugin, or block-streaming protocol.
</Warning>

## Legacy `MEDIA:` lines

In automatic visible-reply mode, final assistant replies can still attach media
with a plain standalone `MEDIA:` line. WebChat also supports the committed
commentary compatibility path described below. The parser only recognizes lines
whose trimmed text starts with `MEDIA:` outside Markdown wrappers and fenced or
indented code blocks. Up to three leading spaces are accepted; four-space or tab
indentation follows CommonMark code-block rules.

Valid automatic-mode assistant output:

```text
Here is the generated image.

MEDIA:/workspace/image.png
```

These remain ordinary text and do not attach media:

```text
**MEDIA:/workspace/image.png**
`MEDIA:/workspace/image.png`
Here is your image: MEDIA:/workspace/image.png
```

Double-quote a legacy reference when punctuation belongs to its path or URL,
such as `MEDIA:"https://example.com/video.mp4?token=ends,"`. The punctuation
stays part of the reference; attachment validation still applies.

### WebChat commentary compatibility

In automatic mode, WebChat can also attach media from model-authored commentary
(progress messages) once the assistant message is committed to the transcript,
while the task continues. This is not parsing of arbitrary streaming deltas or
streamed block payloads.

The runtime captures the model-authored references before `before_message_write`
hooks run. Only references from that captured set that remain in the committed
commentary are eligible for attachment preparation; references newly inserted by
a hook remain ordinary text. Preparation is bound to the exact committed message
and current admitted run. Captured references establish delivery intent, not file
access authority: file-read policy, media validation, authenticated serving, and
live run/session ownership checks still apply.

This compatibility does not replace message-tool-only delivery. When the resolved
source reply mode is `message_tool_only` (configured with
`messages.visibleReplies: "message_tool"`), visible output must use
`message(action=send)` and its structured attachment fields, not legacy `MEDIA:`
lines in commentary or final text. See [visible reply configuration](/gateway/config-agents/messages-and-talk#other-message-keys).

### Structured payloads and block streaming

Tools, plugins, browser output, message actions, and streamed block payloads still
require structured attachment fields as described above. Committed WebChat
commentary is a separate compatibility path, not an exception for text returned
by those producers.

Plain Markdown image syntax stays text by default. Channels that intentionally
map Markdown image replies to media attachments opt in at their outbound
adapter; Telegram does this so `![alt](url)` can still become a media reply.

When block streaming is enabled, media in streamed blocks must ride on structured `mediaUrl` / `mediaUrls` fields. If the same media URL appears in a streamed block and again in the final assistant payload, OpenClaw delivers it once and strips the duplicate from the final payload.

## `[embed ...]`

`[embed ...]` is the only agent-facing rich-render syntax for the Control UI. Self-closing example:

```text
[embed ref="cv_123" title="Status" /]
```

Rules:

- `[view ...]` is not valid for new output. `[embed ...]` replaced it in 2026.4.11 ([#64104](https://github.com/openclaw/openclaw/pull/64104)).
- Embed shortcodes render only in the assistant message surface.
- Only URL-backed embeds render; use `ref="..."` or `url="..."`.
- Block-form inline HTML embed shortcodes do not render.
- The web UI strips the shortcode from visible text and renders the embed inline.

## Stored rendering shape

The normalized/stored assistant content block is a structured `canvas` item:

```json
{
  "type": "canvas",
  "preview": {
    "kind": "canvas",
    "surface": "assistant_message",
    "render": "url",
    "viewId": "cv_123",
    "url": "/__openclaw__/canvas/documents/cv_123/index.html",
    "title": "Status",
    "preferredHeight": 320
  }
}
```

`present_view` is not recognized; stored/rendered rich blocks always use this `canvas` shape.

## Related

- [Hosted embeds](/web/control-ui/chat#hosted-embeds) - how the Control UI renders `[embed ...]` and its iframe sandbox policy
- [Typebox](/concepts/typebox)
