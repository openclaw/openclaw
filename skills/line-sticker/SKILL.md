---
name: line-sticker
description: Send a LINE sticker to express emotions or reactions in LINE conversations. Use for casual greetings, sticker replies, and short emotional exchanges.
metadata: { "openclaw": { "emoji": "🎨", "requires": { "config": ["channels.line"] } } }
---

# LINE Sticker Skill

Send a sticker on the LINE channel using the STICKER directive.
Stickers are a primary emotional communication tool in Japanese LINE culture —
not a decoration, but a genuine social gesture.

## Output format

```text
<brief intent text>
STICKER:packageId:stickerId
```

Always include a brief natural-language line describing the sticker's intent before the directive.
Do not output the sticker directive alone.

This text helps preserve conversational intent and context for downstream processing and transcript history.
The final user-visible output depends on channel delivery behavior.

Guidelines for the intent text:

- Keep it brief and natural (1-2 sentences).
- Describe the communicative intent of the sticker, not an explanation of the system.
- Write in the conversation language.
- Do not mention internal mechanics, directives, transcripts, or implementation details.
- Do not add extra text after the STICKER: line.

Example:

```text
おはようの気持ちをこめて、明るいスタンプで返します。
STICKER:8515:16581260
```

## When not to use a sticker

- Serious topics: grief, anger, crisis, formal complaints
- The conversation clearly calls for a substantive text response

Everything else is a judgment call — trust your read of the room.

## Package selection (Step 1)

| packageId | name                                   | lang      | character | expression_style | animated | description                              |
| --------- | -------------------------------------- | --------- | --------- | ---------------- | -------- | ---------------------------------------- |
| 789       | Sally Special                          | universal | sally     | subtle           | false    | Chick character, playful, cute           |
| 1070      | Moon Special                           | universal | moon      | expressive       | false    | Human character, quirky-cute, no text    |
| 11537     | Moving Brown & Cony & Sally Special    | universal | mixed     | subtle           | true     | Animal characters, cute, animated        |
| 11538     | Moving Choco & LINE Characters Special | universal | choco     | expressive       | true     | Human characters, quirky-cute, animated  |
| 11539     | Universe Star BT21 Special             | universal | bt21      | subtle           | true     | BT21 characters, cute, animated, K-pop   |
| 6136      | Apology Pros! LINE Characters          | ja        | mixed     | expressive       | false    | Comic apology expressions, Japanese text |
| 6632      | LINE Characters: Making Amends         | zh-tw     | mixed     | expressive       | false    | Comic apology expressions, Chinese text  |
| 6325      | Chibi Brown & Cony                     | ja        | brown     | subtle           | false    | Animal characters, cute, Japanese text   |
| 6359      | Brown and Cony Fun Size Pack           | th        | brown     | subtle           | false    | Animal characters, cute, Thai text       |
| 6362      | Brown and Cony Fun Size Pack           | zh-tw     | brown     | subtle           | false    | Animal characters, cute, Chinese text    |
| 6370      | Chibi Brown & Cony                     | en        | brown     | subtle           | false    | Animal characters, cute, English text    |
| 8515      | Gentle Keigo★ LINE Characters          | ja        | mixed     | subtle           | false    | Polite/formal expressions, Japanese text |
| 8522      | Gentle Keigo★ LINE Characters          | en        | mixed     | subtle           | false    | Polite expressions, English text         |
| 8525      | LINE Characters: Pretty Phrases        | zh-tw     | mixed     | subtle           | false    | Polite expressions, Chinese text         |

**Selection rules:**

1. Match lang to the conversation language. Fall back to universal if no match.
2. Read description to match the mood: polite, playful, comic, animated, etc.
3. Match expression_style to the emotional intensity: subtle by default, expressive for stronger reactions.

## Sticker selection (Step 2)

Read {baseDir}/references/package-{packageId}.json and select using these fields:

- **desc** (primary): Visual description with embedded context. Includes pose, expression, action, and usage scene. Match to the current conversational moment.
- **text** (filter): Printed text on the sticker. Must match the conversation language or be absent.

Prefer the sticker whose desc most specifically matches the moment over the safest generic choice.
If no sticker fits naturally, do not send one.

## Catalog location

- {baseDir}/references/package-index.json
- {baseDir}/references/package-{packageId}.json
