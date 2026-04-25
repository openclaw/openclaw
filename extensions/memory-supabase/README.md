# memory-supabase

Long-term memory plugin for OpenClaw, backed by Supabase (Postgres + `pgvector`).

This is a drop-in alternative to the bundled `memory-lancedb` plugin for setups
where the gateway runs on a remote host (e.g. a VPS) and you want memory to
live in managed Postgres rather than a local LanceDB directory.

## What it adds

- Two tools the agent can call:
  - `memory_remember(content, tags?, metadata?)` — explicit save
  - `memory_search(query, k?)` — semantic recall via cosine similarity
- Optional **auto-indexing** of every inbound message from any channel that
  broadcasts the `message_received` plugin hook (WhatsApp does so out of the
  box; the sibling `inbox-triage` extension wires up Gmail).
- Optional **auto-recall** that prepends relevant memories to the model
  context before each turn.
- A daily journal table (`daily_journal`) used by the `inbox-triage` evening
  job to write a one-paragraph summary plus indexed highlights.

## SQL setup

Run once against your Supabase project:

```bash
psql "$SUPABASE_DB_URL" -f extensions/memory-supabase/sql/0001_init.sql
psql "$SUPABASE_DB_URL" -f extensions/memory-supabase/sql/0002_journal.sql
```

Or paste both files into the Supabase SQL editor.

## Configuration

```json
{
  "memory-supabase": {
    "embedding": {
      "apiKey": "${OPENAI_API_KEY}",
      "model": "text-embedding-3-small",
      "dimensions": 1536
    },
    "supabase": {
      "url": "${SUPABASE_URL}",
      "serviceRoleKey": "${SUPABASE_SERVICE_ROLE_KEY}",
      "userId": "arhan"
    },
    "autoIndex": true,
    "autoRecall": true,
    "consentDefault": true,
    "captureMaxChars": 2000
  }
}
```

All `${ENV_VAR}` placeholders are interpolated from `process.env` at startup;
secrets never need to live in the JSON file.

## Required env vars

| Var                          | Purpose                                       |
| ---------------------------- | --------------------------------------------- |
| `OPENAI_API_KEY`             | Embedding model                               |
| `SUPABASE_URL`               | Project URL                                   |
| `SUPABASE_SERVICE_ROLE_KEY`  | Backend-only key (never ship to clients)      |
| `SUPABASE_DB_URL` (optional) | Used only for running the SQL migration files |
