---
name: memory-second-brain
description: Long-term memory backed by Supabase + pgvector. Use memory_remember to save, memory_search to recall.
metadata: { "openclaw": { "emoji": "🧠" } }
---

# Memory (second brain)

You have a persistent memory store that survives across sessions, channels,
and restarts. Treat it as the user's external long-term memory.

## Tools

### `memory_search(query: string, k?: number)`

Semantic similarity search across everything ever indexed. Use it
**proactively** at the start of a conversation if the topic might have
relevant prior context — don't wait for the user to ask "do you remember…".

Examples of when to call it without being asked:

- The user mentions a person, project, or place by name.
- The user asks for a recommendation in a category they've discussed before.
- The user asks "what did we decide about X" / "what was that thing about Y".

### `memory_remember(content: string, tags?: string[], metadata?: object)`

Save something explicitly. Use when:

- The user says "remember that…" / "note that…" / "for next time…".
- The user states a preference, decision, or fact about themselves that
  isn't already in memory (call `memory_search` first to check).
- An end-of-day summary needs to be persisted (use tags `["journal","YYYY-MM-DD"]`).

Keep `content` self-contained — it'll be retrieved out of context, so
"yes" or "the usual" won't help future-you. Prefer:

> "Arhan prefers Caddy over nginx for personal projects because he doesn't
>  want to maintain certbot."

over:

> "Prefer Caddy."

## Auto-indexing

Inbound messages from WhatsApp (and Gmail, via the `inbox-triage` plugin) are
auto-indexed by the `memory-supabase` plugin. You don't need to manually save
incoming messages — focus `memory_remember` on summaries, decisions, and
explicit notes.

## Tagging conventions

Use lowercase, hyphenated tags. Common ones:

- `preference` — user preferences
- `decision` — choices the user has made
- `entity:<name>` — a person, project, company
- `project:<slug>` — work the user is doing
- `journal` — daily journal entries
- `triage:<date>` — triage briefs

## Privacy

All items are stored under a single `user_id` in Postgres. The user can ask
you to forget specific items by content; in that case, use `memory_search`
to find the id and tell them to delete it via Supabase directly (no
`memory_forget` tool yet).
