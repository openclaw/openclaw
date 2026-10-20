---
summary: "iMessage attachment ingestion, outbound staging, text chunking, and delivery target formats"
read_when:
  - Enabling inbound attachments
  - Tuning outbound text chunking
  - Choosing an addressing format for a send
title: "iMessage media and attachments"
sidebarTitle: "Media and attachments"
---

How attachments move in and out, how outbound text is chunked, and which delivery targets iMessage accepts.

## Media, chunking, and delivery targets

<AccordionGroup>
  <Accordion title="Attachments and media">
    - inbound attachment ingestion is **off by default** — set `channels.imessage.includeAttachments: true` to forward photos, voice memos, video, and other attachments to the agent. With it disabled, attachment-only iMessages are dropped before reaching the agent and may produce no `Inbound message` log line at all.
    - remote inbound attachment paths can be fetched via SCP when `remoteHost` is set
    - outbound files are staged into an owner-only temporary path on the configured or auto-detected Messages Mac, passed to `imsg` by that remote path, and cleaned up best-effort after success, failure, or timeout; cleanup failure emits a warning and can leave owner-only residue
    - attachment paths must match allowed roots:
      - `channels.imessage.attachmentRoots` (local)
      - `channels.imessage.remoteAttachmentRoots` (remote SCP mode)
      - configured roots extend the default root pattern `/Users/*/Library/Messages/Attachments` (merged, not replaced)
    - SCP uses strict host-key checking (`StrictHostKeyChecking=yes`)
    - outbound media size uses `channels.imessage.mediaMaxMb` (default 16 MB)

  </Accordion>

  <Accordion title="Outbound text and chunking">
    - text chunk limit: `channels.imessage.textChunkLimit` (default 4000)
    - chunk mode: `channels.imessage.streaming.chunkMode`
      - `length` (default)
      - `newline` (paragraph-first splitting)
    - outbound markdown bold/italic/underline/strikethrough is converted to native styled text (macOS 15+ recipients render the styling; older recipients see plain text without the markers); markdown tables are converted per the channel markdown table mode
    - `channels.imessage.sendTransport` (`auto` default, `bridge`, `applescript`) selects how `imsg` delivers sends

  </Accordion>

  <Accordion title="Addressing formats">
    Preferred explicit targets:

    - `chat_id:123` (recommended for stable routing)
    - `chat_guid:...`
    - `chat_identifier:...`

    Direct handles are also supported:

    - `+1555...`
    - `tel:+1555...`
    - `imessage:+1555...`
    - `sms:+1555...`
    - `user@example.com`

    Use a service-qualified target for a contact name or mixed alphanumeric alias:

    - `auto:<contact>` lets Messages choose iMessage or SMS
    - `imessage:<contact>` requires iMessage
    - `sms:<contact>` requires SMS

    Bare contact names and mixed alphanumeric aliases are rejected instead of being converted to
    a phone number. If an existing automation uses one, add `auto:`, `imessage:`, or `sms:` to
    make the intended delivery service explicit.

    ```bash
    imsg chats --limit 20
    ```

  </Accordion>
</AccordionGroup>
