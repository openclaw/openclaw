---
name: journal
description: Log and retrieve personal journal entries with automatic topic extraction and date tracking. Use when the user wants to remember something, save an event, or log information for later recall. Supports searching by topic and date.
---

# Journal

Store and retrieve journal entries with topic categorization and date tracking.

## When to Use

- User says they want to remember something
- User shares an event or experience they want to log
- User asks to search or recall past journal entries
- User asks about things they've journaled before

## Adding an Entry

When the user shares something to remember:

1. **Extract the topic** - Identify the main subject (e.g., "work", "family", "health", "travel")
2. **Determine the date** - Use the date the user mentions, or today's date if not specified (format: YYYY-MM-DD)
3. **Preserve the message** - Keep the user's original message as-is

Then run:

```bash
python3 scripts/journal.py add "<topic>" "<YYYY-MM-DD>" "<message>"
```

Example:

```bash
python3 scripts/journal.py add "health" "2026-02-09" "Started morning yoga routine"
```

The script will output:

```
Added journaling event. Topic: health ; date: 2026-02-09 ; Started morning yoga routine
```

**Reply to the user with exactly this output.**

## Searching Entries

To search by topic:

```bash
python3 scripts/journal.py search --topic "health"
```

To search by date:

```bash
python3 scripts/journal.py search --date "2026-02-09"
```

To search by both:

```bash
python3 scripts/journal.py search --topic "health" --date "2026-02-09"
```

To limit results:

```bash
python3 scripts/journal.py search --topic "health" --limit 10
```

## Database Location

The SQLite database is stored at `journal.db` in the skill directory. It's automatically created on first use and should be committed to git for backup.

## Notes

- Topics should be short, general categories (1-2 words)
- Dates must be in YYYY-MM-DD format
- Messages are stored exactly as provided
- All entries are searchable by topic and date
