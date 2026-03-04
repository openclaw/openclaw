# Memory Search

You have two tools for recalling information from your memory files. Use them.

## Tools

### `memory_search`

Semantic vector search across your indexed memory files (MEMORY.md, memory/\*.md, and session transcripts).

**Parameters:**

| Param        | Type   | Required | Description                                      |
| ------------ | ------ | -------- | ------------------------------------------------ |
| `query`      | string | yes      | Natural language question or topic to search for |
| `maxResults` | number | no       | Max results to return (default: 6)               |
| `minScore`   | number | no       | Minimum relevance score threshold (0-1)          |

**Example calls:**

```json
{ "query": "what projects is the human working on" }
{ "query": "preferences about code style", "maxResults": 3 }
{ "query": "important dates birthdays deadlines", "maxResults": 10, "minScore": 0.3 }
```

**Returns:** Array of results, each with:

- `snippet` — the matching text chunk
- `path` — relative file path (e.g. `MEMORY.md`, `memory/2026-02-07.md`)
- `startLine` / `endLine` — line range in the source file
- `score` — relevance score
- `citation` — formatted source reference (in direct chats)

### `memory_get`

Read a specific section of a memory file by path and line range. Use this after `memory_search` to pull more context around a result.

**Parameters:**

| Param   | Type   | Required | Description                                                             |
| ------- | ------ | -------- | ----------------------------------------------------------------------- |
| `path`  | string | yes      | Relative path from workspace (e.g. `MEMORY.md`, `memory/2026-02-07.md`) |
| `from`  | number | no       | Starting line number                                                    |
| `lines` | number | no       | Number of lines to read                                                 |

**Example calls:**

```json
{ "path": "MEMORY.md" }
{ "path": "memory/2026-02-07.md", "from": 15, "lines": 30 }
```

## When to Use Memory Search

**Always search before answering about:**

- Prior conversations or decisions
- The human's preferences, habits, or opinions
- Dates, deadlines, birthdays, events
- Project status or history
- Anything the human said "remember this" about
- Todos, action items, or commitments
- People, names, relationships

**The pattern is:**

1. Receive a question that might involve past context
2. Call `memory_search` with a relevant query
3. Review the results
4. If a snippet looks promising but needs more context, call `memory_get` with the path and line range
5. Answer using what you found (cite sources in direct chats)

## When NOT to Use

- Purely factual questions with no personal context ("what is Python?")
- The human explicitly gives you all the context you need in the message
- You just searched and the results are still in your context

## Tips

- **Be specific in queries.** "birthday" works better than "important information about the human."
- **Search multiple angles.** If one query returns nothing useful, try rephrasing. "project deadlines" and "what's due soon" might return different results.
- **Don't over-fetch.** Start with default maxResults. Only increase if you need more coverage.
- **Use memory_get sparingly.** The search snippets are usually enough. Only pull full sections when you need surrounding context.
- **Say when you checked.** If you searched and found nothing, tell the human: "I checked my memory and didn't find anything about that." Don't silently guess.

## What Gets Indexed

Your memory search covers:

- `MEMORY.md` — your curated long-term memory
- `memory/*.md` — daily notes and raw logs
- Session transcripts (if enabled)

These files are automatically indexed. You don't need to trigger indexing — just write to the files and the system handles the rest.

## Do NOT

- Do NOT try to run shell commands like `cat` or `ls` to read memory files. Use `memory_search` and `memory_get`.
- Do NOT try to configure or debug the search system. That's operator config, not your job.
- Do NOT assume memory is empty without searching first. The index may have content even if the `memory/` directory looks sparse.
