---
title: "Memory Deep Dive"
summary: "How to structure, search, and maintain OpenClaw memory files over time"
read_when:
  - You want a practical workflow for MEMORY.md and daily logs
  - memory_search is not finding the context you expect
  - You want to keep memory useful as your workspace grows
---

# Memory Deep Dive

This guide focuses on the part after "memory exists": how to write it well, how
to search it well, and how to keep it useful after weeks or months of use.

For the high-level overview, see [Memory Overview](/concepts/memory). For the
retrieval pipeline and provider setup, see [Memory Search](/concepts/memory-search).

## Memory Architecture

OpenClaw memory works best as a two-layer system:

- `MEMORY.md` is the curated layer.
- `memory/YYYY-MM-DD.md` files are the working layer.

### `MEMORY.md`: long-term memory

Use `MEMORY.md` for durable facts that should survive across many sessions:

- stable preferences
- recurring people, projects, and environments
- decisions that are still in force
- lessons that future sessions should reuse

`MEMORY.md` is injected into workspace bootstrap context when present, so it
costs tokens on every turn. Keep it concise and curated.

### `memory/YYYY-MM-DD.md`: daily logs

Use daily files for short-horizon context:

- what happened today
- recent experiments
- temporary blockers
- raw observations that are not yet worth promoting

Daily logs are not injected automatically. They are indexed and surfaced on
demand through `memory_search`, and `memory_get` can read the exact file or line
range you need.

### How the layers work together

The default search scope indexes `MEMORY.md` plus `memory/**/*.md`. OpenClaw
chunks those Markdown files into overlapping sections, searches them, and
returns results with:

- the file path
- start and end line numbers
- a relevance score
- a snippet

That flow matters:

1. Search broadly with `memory_search`.
2. Open the returned file and lines with `memory_get`.
3. Promote only durable conclusions into `MEMORY.md`.

<Tip>
Think of daily files as the journal and `MEMORY.md` as the distilled mental
model.
</Tip>

## Writing Effective Memory

The main failure mode is writing everything into both layers. That makes memory
noisy, repetitive, and expensive to search.

### Put this in `MEMORY.md`

Good candidates:

- "User prefers short answers unless they ask for depth."
- "Project Atlas deploys from `main` and uses Fly for staging."
- "The office printer is flaky on 5 GHz Wi-Fi; Ethernet is the reliable path."
- "Current stance: use Bun for TypeScript scripts in this repo."

Patterns that help:

- write the current truth, not the whole story
- keep entries short and explicit
- use stable names, headings, and exact terms people will search for later
- date changes when the timeline matters

Example:

```md
## Project Atlas

- Deploy branch: `main`
- Staging host: Fly
- Preferred local runner: Bun
- 2026-04-01: Moved smoke tests from manual scripts to CI
```

### Put this in daily logs

Good candidates:

- today's debugging notes
- meeting takeaways that may or may not matter later
- half-formed hypotheses
- temporary plans, reminders, and blockers

Example:

```md
# 2026-04-03

- Investigated Atlas deploy failures.
- The failing step was the asset upload, not the migration.
- Suspect bad cache headers on the staging CDN.
- Need to confirm whether the April 2 rollback changed bucket settings.
```

### Promote instead of duplicating

A useful pattern is:

1. Write the raw event into today's file.
2. Wait until it proves durable.
3. Distill the lasting part into `MEMORY.md`.

Example:

- Daily log: "Tried three deploy fixes; only disabling CDN caching worked."
- Long-term memory: "Atlas staging deploys can fail when CDN cache headers are stale; check cache settings first."

### Write for retrieval, not just for humans

Because `memory_search` uses semantic plus keyword retrieval, memory works
better when notes contain both:

- natural-language descriptions
- exact anchors like config keys, service names, IDs, filenames, or error text

Bad:

```md
- That weird thing happened again.
```

Better:

```md
- `openclaw memory index --force` fixed stale memory results after watcher lag.
```

## Search Optimization

`memory_search` combines semantic search with keyword matching. The best queries
usually include both meaning and anchors.

### Start with the concept, then add the handle

If you only remember the idea, search with the idea:

- "why does the staging deploy fail"
- "user preference for answer length"
- "notes about printer reliability"

If you remember an exact term, include it:

- "`memorySearch.experimental.sessionMemory`"
- "`openclaw memory index --force`"
- "`Project Atlas` Fly staging"

This helps both retrieval paths:

- semantic search matches paraphrases and related wording
- BM25 matches exact tokens such as IDs, config keys, filenames, and error text

### Use stable nouns

Search quality improves when your notes and your queries reuse the same names:

- person names
- project names
- repo names
- service names
- config keys

If a project has three nicknames, pick one canonical label in `MEMORY.md` and
include aliases only when needed.

### Add time when you want recent context

Recent work often lives in daily files, so add a date, timeframe, or event:

- "April staging rollback"
- "today's notes about onboarding"
- "last week webhook debugging"

If your memory history gets large, enabling temporal decay can also help recent
daily notes outrank older ones. See [Memory Search](/concepts/memory-search) and
[Memory configuration reference](/reference/memory-config).

### Search, then read

`memory_search` is for discovery. `memory_get` is for inspection.

A reliable pattern:

1. Run `memory_search` with a broad query.
2. Pick the result with the right file and line range.
3. Use `memory_get` on that path, optionally with `from` and `lines`.

This keeps context small and avoids loading full files when a single section is
enough.

### Common query upgrades

- Replace vague words like "that issue" with the system, person, or file name.
- Add exact error text, command names, or config keys when available.
- If results are too broad, add a date, environment, or entity name.
- If results are too narrow, remove one exact token and search semantically.

<Info>
If transcript recall is important, remember that prior session history only
appears in `memory_search` when session memory is enabled and `"sessions"` is
included in `memorySearch.sources`.
</Info>

## Memory Maintenance

Good memory needs periodic cleanup. The goal is not to delete history
aggressively. The goal is to keep `MEMORY.md` current and keep daily logs from
becoming the only source of truth.

### Review loop

Every few days or every week:

1. Read recent `memory/YYYY-MM-DD.md` files.
2. Identify facts that are now durable.
3. Promote those facts into `MEMORY.md`.
4. Remove or rewrite stale statements in `MEMORY.md`.

Signs that `MEMORY.md` needs maintenance:

- entries contradict newer behavior
- preferences changed but old wording still remains
- the file became a raw dump instead of a summary
- the same fact appears in many places

### Cleanup strategy

Prefer these cleanup moves:

- merge repeated bullets into one canonical entry
- replace superseded guidance instead of stacking conflicting rules
- keep dated notes when historical context matters
- move long narratives out of `MEMORY.md` and keep the distilled conclusion

Be careful with destructive cleanup in daily logs. Those files are often useful
as a timeline even after the key lesson has been promoted.

### Heartbeat-based maintenance

Heartbeats are a practical way to keep memory healthy without requiring a manual
cleanup ritual every time. A lightweight pattern is:

- add a short review reminder to `HEARTBEAT.md`
- track the last review in `memory/heartbeat-state.json`
- on a maintenance heartbeat, review recent daily logs and update `MEMORY.md`

Example state file:

```json
{
  "lastChecks": {
    "memoryReview": 1775174400
  }
}
```

This is a workspace convention, not a special built-in file. It works well
because it gives the agent a place to record when memory maintenance last ran.

## Advanced Patterns

### Entity tracking

For people, projects, machines, or services that come up repeatedly, keep a
stable heading in `MEMORY.md`:

```md
## Jamie

- Role: product lead for Atlas
- Prefers concise async updates
- Usually asks for screenshots when reporting UI regressions
```

This makes search easier because the entity name becomes a durable anchor.

### Opinion evolution

Preferences and decisions change. When they do, capture both the current state
and the transition:

```md
## Tooling Preferences

- Current preference: Bun for TypeScript scripts
- 2026-03-10: Stopped defaulting to ts-node because startup time was slower
```

That pattern avoids a common failure mode where memory contains only the latest
preference with no clue why old behavior changed.

### Cross-session recall

If a topic spans many days:

- keep day-by-day details in daily logs
- keep the durable summary in `MEMORY.md`
- use the same entity names across both layers

That gives you both:

- fast recall of the current state
- a searchable trail of how you got there

If you need recall from outside the default workspace memory roots, use
`memorySearch.extraPaths` to index additional Markdown files. Keep those notes
structured and named consistently so they behave like first-class memory.

## Troubleshooting

### `memory_search` returns nothing

Check the index:

```bash
openclaw memory status
openclaw memory index --force
```

If the index is empty, the relevant files may not exist yet, may be outside the
default roots, or may require `memorySearch.extraPaths`.

### Results are stale or miss recent edits

The watcher usually reindexes changes automatically, but rebuild manually if
needed:

```bash
openclaw memory index --force
```

If recent notes still rank too low, consider enabling temporal decay so older
daily logs lose weight over time.

### Results only match exact keywords

Your embedding provider may not be configured. Check:

```bash
openclaw memory status --deep
```

Without embeddings, search falls back to keyword-only retrieval.

### `memory_get` cannot read a file you expected

`memory_get` reads Markdown memory files only:

- `MEMORY.md`
- `memory/**/*.md`
- Markdown files under configured `memorySearch.extraPaths`

It does not read arbitrary non-memory files through the memory tool.

### `MEMORY.md` keeps getting too large

That usually means raw daily detail is being promoted without distillation.
Trim it back to durable facts, decisions, and current preferences. Keep the
timeline in daily logs.

### Search does not find past chats

Session transcripts are not searched by default. Enable
`memorySearch.experimental.sessionMemory` and include `"sessions"` in
`memorySearch.sources` if you want transcript recall through `memory_search`.

## Further Reading

- [Memory Overview](/concepts/memory)
- [Memory Search](/concepts/memory-search)
- [Builtin Memory Engine](/concepts/memory-builtin)
- [Agent Workspace](/concepts/agent-workspace)
- [Memory configuration reference](/reference/memory-config)
