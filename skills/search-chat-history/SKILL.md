---
name: search-chat-history
description: Search chat history from Telegram/Slack conversations using grep. Find who said what and when with exact timestamps.
metadata: { "openclaw": { "emoji": "🔍", "requires": { "bins": ["grep"] } } }
---

# search-chat-history

Search real-time ingested chat history from Telegram or Slack. Use this when users ask about past conversations, who said something, or when something was discussed.

## Trigger

Use this skill when:

- User asks "ai nói gì về X?" / "who said X?"
- User asks "lúc nào bàn về Y?" / "when did we discuss Y?"
- User wants to recall exact quotes or timestamps
- User references past group conversations

## Location

Chat history lives in workspace under `knowledge/chat-history/`:

```
workspace/
└── knowledge/
    └── chat-history/
        ├── telegram/
        │   └── 2026-03.md    # Monthly files
        └── slack/
            └── #channel-name.md
```

## File Format

Each file is markdown with lines like:

```
**Username** (Mar 25, 10:30): message text here
**Username** (Mar 25, 10:31): [reply] this is a reply
**Username** (Mar 25, 10:32): message with [file: document.pdf]
```

## Search Commands

### Basic keyword search

```bash
grep -rni "keyword" workspace/knowledge/chat-history/ --include="*.md"
```

### Search by username

```bash
grep -rni "\*\*Son\*\*" workspace/knowledge/chat-history/ --include="*.md"
```

### Search specific month (Telegram)

```bash
grep -ni "keyword" workspace/knowledge/chat-history/telegram/2026-03.md
```

### Search with context (2 lines before/after)

```bash
grep -rni -B2 -A2 "keyword" workspace/knowledge/chat-history/ --include="*.md"
```

### Count mentions

```bash
grep -rnic "keyword" workspace/knowledge/chat-history/ --include="*.md"
```

## Output Format

When reporting results, format as:

```
Found X result(s) for "query":

[2026-03.md:15] **Son** (Mar 18, 16:05): the matching message...
[2026-03.md:23] **Giang** (Mar 19, 07:21): another match...
```

Include file name and line number for traceability.

## Tips

1. **Case-insensitive** — Always use `-i` flag for grep
2. **Escape special chars** — If query has `*`, `?`, `[`, escape them
3. **Vietnamese search** — grep handles UTF-8 fine, search Vietnamese directly
4. **Limit results** — Use `| head -20` to avoid flooding output
5. **No chat history?** — If folder is empty, chat ingest may not be enabled for this workspace

## Example Usage

User: "Giang hỏi gì về n8n?"

```bash
grep -rni "Giang.*n8n\|n8n.*Giang" workspace/knowledge/chat-history/ --include="*.md" | head -10
```

User: "Lúc nào bàn về affiliate?"

```bash
grep -rni "affiliate" workspace/knowledge/chat-history/ --include="*.md" | head -20
```
