---
name: line-sticker
description: Use the LINE sticker directive to send a native LINE sticker (in addition to or instead of text) when replying on a LINE conversation.
---

When replying on a LINE chat, you can send a native LINE sticker by emitting a
`STICKER:packageId:stickerId` directive on its own line in your reply text. The
LINE plugin parses the directive, removes that line from the user-visible text,
and sends the sticker through the LINE Messaging API.

## Format

```
STICKER:<packageId>:<stickerId>
```

- The directive must occupy its **own line** (no surrounding text on the same line).
- `packageId` and `stickerId` must both be **numeric strings**.
- The directive can be combined with regular text. Other lines are sent as a normal text message.
- Directives **inside fenced code blocks** are preserved as plain text and **not** parsed.

## Choosing IDs

Use only stickers from LINE's allowlist for Messaging API bots:
[https://developers.line.biz/en/docs/messaging-api/sticker-list/](https://developers.line.biz/en/docs/messaging-api/sticker-list/).

Pick a small, fixed set (typically 5-20) of `packageId`/`stickerId` pairs that
fit the deployment's tone, and reference them by purpose (e.g., greeting, OK,
sorry). Keep the catalog inside the deployment's prompt rather than hardcoding it
in this skill.

## Invalid ID handling

If `packageId` or `stickerId` is not a numeric string, the LINE plugin **drops
the sticker** (verbose log emitted) and still delivers the rest of the message.
If LINE's API rejects the IDs (unknown sticker, sticker not in the bot allowlist),
the request fails with an HTTP 400 from the LINE API.

## Example

```
Thanks for letting me know!
STICKER:446:1988
```

This delivers a text message ("Thanks for letting me know!") followed by a
sticker from package 446. The directive line itself is removed from the text.
