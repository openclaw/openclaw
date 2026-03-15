---
name: line-sticker
description: Send LINE stickers as replies on LINE channels. Use when the user sends a sticker (detected by StickerInfo in context), or when a sticker would be a natural short reaction (e.g. greeting, thanks, goodbye). Do NOT use for substantive questions, long conversations, or non-LINE channels. If no suitable sticker is found, reply with text instead.
metadata: { "openclaw": { "emoji": "🎨", "requires": { "config": ["channels.line"] } } }
---

# LINE Sticker

Send LINE stickers to make conversations more expressive and human-like.

**This skill is for LINE channels only.** Do not use on Telegram, Slack, Discord, or other channels.

## When to use

- **User sends a sticker** (you'll see `[Sent a ... sticker]` or `StickerInfo` in the message context) → Reply with a sticker
- **Short reactions** → OK, thanks, sorry, goodbye, good night, cheering
- **Conversation endings** → A sticker can naturally close a conversation

## When NOT to use

- User asks a question that needs a text answer — even if sent as a sticker
- Long or serious conversations
- Business-critical messages
- When you can't find a suitable sticker — just reply with text
- On non-LINE channels

## Important rules

- **Sticker replaces text.** When you send a sticker, send ONLY the STICKER: directive. No text before or after it. The LINE plugin will drop text if a sticker is present.
- **If in doubt, use text.** A sticker is a seasoning, not the main dish.

## How to send

Output the directive as the entire message:

```
STICKER:446:1988
```

The format is `STICKER:<packageId>:<stickerId>` where the IDs come from the sticker catalog.

## Detecting user stickers

When a user sends a sticker on LINE, the message will contain:

- Text like `[Sent a Brown sticker: happy, wave, Hello]` in the message body
- `StickerInfo` with `raw` (packageId:stickerId), `keywords`, and `channel` fields

Use the keywords and description to understand the mood of the sticker they sent, then mirror it.

## Sticker selection

### Step 1: Pick a cluster

Choose the cluster that best matches the conversation mood:

| Cluster        | When to use                                    |
| -------------- | ---------------------------------------------- |
| agree-brown    | Confirming / OK / Got it (calm, cool tone)     |
| agree-misc     | Confirming / OK / Got it (cute, lively tone)   |
| thanks         | Expressing gratitude, joy, celebration         |
| sorry-formal   | Serious apology, bowing, formal setting        |
| sorry-casual   | Light apology, playful "oops", casual setting  |
| cheer-up       | Encouraging someone (energetic, powerful tone) |
| cheer-up-sally | Encouraging someone (cute, gentle tone)        |
| love           | Affection, hearts, warmth                      |
| goodnight      | Bedtime, sleepy, end of day                    |
| labor          | Acknowledging effort, "good work today"        |
| confused       | Puzzled, nervous, uncertain                    |
| shock          | Surprised, devastated, disbelief               |
| angry          | Frustrated, annoyed, scolding                  |
| please         | Requesting, begging, asking a favor            |
| action         | Eating, arriving, leaving, daily actions       |

**If no cluster fits the situation, do not send a sticker. Reply with text instead.**

### Step 2: Read the cluster file

Read `references/cluster-{name}.json` (e.g. `references/cluster-thanks.json`).

Each sticker entry has:

- `id` — use this in the STICKER: directive (format: packageId:stickerId)
- `lang` — `universal`, `ja`, `en`, `zh-tw`, or `th`
- `desc` — visual description (character appearance, pose, mood)
- `text` — text written on the sticker image (if any, null otherwise)

### Step 3: Filter by language

Determine the user's language from the conversation (what language they write in).

- If the user writes in Japanese → prefer `lang: ja`, fall back to `universal`
- If the user writes in English → prefer `lang: en`, fall back to `universal`
- If the user writes in Chinese → prefer `lang: zh-tw`, fall back to `universal`
- If the user writes in Thai → prefer `lang: th`, fall back to `universal`
- If unsure → use `universal` only

**If no stickers match the user's language or universal in this cluster, do not send a sticker. Reply with text instead.**

### Step 4: Pick the best sticker

From the filtered candidates, pick the one whose `desc` and `text` best match the conversation mood and tone.

- For casual conversations → pick stickers with playful expressions
- For polite conversations → pick stickers with formal text (e.g. "よろしくお願いします")
- For emotional moments → pick stickers with strong expressions

**Variety**: Don't repeat the same sticker. Choose different ones across conversations.

**If no sticker feels right, do not force it. Reply with text instead.**

## Mirroring principle

When the user sends a sticker, mirror their style:

1. **Respond with a sticker** — not text (unless the sticker contains a question)
2. **Match the mood** — cheerful → cheerful, sad → comforting, funny → funny
3. **Match the vibe** — cute character → cute character, dramatic → dramatic
4. **If the user's sticker is a question or request** (e.g. a sticker saying "Are you free?") → reply with text, not a sticker

## Frequency

- A sticker every 3-5 messages is natural
- Never send stickers in consecutive messages
- When in doubt, use text instead
