<overview>
Files are the universal interface for agent-native applications. Agents are naturally fluent with file operations—they already know how to read, write, and organize files. This document covers why files work so well, how to organize them, and the context.md pattern for accumulated knowledge.
</overview>

<why_files>
## Why Files

Agents are naturally good at files. Claude Code works because bash + filesystem is the most battle-tested agent interface. When building agent-native apps, lean into this.

### Agents Already Know How

You don't need to teach the agent your API—it already knows `cat`, `grep`, `mv`, `mkdir`. File operations are the primitives it's most fluent with.

### Files Are Inspectable

Users can see what the agent created, edit it, move it, delete it. No black box. Complete transparency into agent behavior.

### Files Are Portable

Export is trivial. Backup is trivial. Users own their data. No vendor lock-in, no complex migration paths.

### App State Stays in Sync

On mobile, if you use the file system with iCloud, all devices share the same file system. The agent's work on one device appears on all devices—without you having to build a server.

### Directory Structure Is Information Architecture

The filesystem gives you hierarchy for free. `/projects/acme/notes/` is self-documenting in a way that `SELECT * FROM notes WHERE project_id = 123` isn't.
</why_files>

<file_organization>
## File Organization Patterns

> **Needs validation:** These conventions are one approach that's worked so far, not a prescription. Better solutions should be considered.

A general principle of agent-native design: **Design for what agents can reason about.** The best proxy for that is what would make sense to a human. If a human can look at your file structure and understand what's going on, an agent probably can too.

### Entity-Scoped Directories

Organize files around entities, not actors or file types:

```
{entity_type}/{entity_id}/
├── primary content
├── metadata
└── related materials
```

**Example:** `Research/books/{bookId}/` contains everything about one book—full text, notes, sources, agent logs.

### Naming Conventions

| File Type | Naming Pattern | Example |
|-----------|---------------|---------|
| Entity data | `{entity}.json` | `library.json`, `status.json` |
| Human-readable content | `{content_type}.md` | `introduction.md`, `profile.md` |
| Agent reasoning | `agent_log.md` | Per-entity agent history |
| Primary content | `full_text.txt` | Downloaded/extracted text |
| Multi-volume | `volume{N}.txt` | `volume1.txt`, `volume2.txt` |
| External sources | `{source_name}.md` | `wikipedia.md`, `sparknotes.md` |
| Checkpoints | `{sessionId}.checkpoint` | UUID-based |
| Configuration | `config.json` | Feature settings |

### Directory Naming

- **Entity-scoped:** `{entityType}/{entityId}/` (e.g., `Research/books/{bookId}/`)
- **Type-scoped:** `{type}/` (e.g., `AgentCheckpoints/`, `AgentLogs/`)
- **Convention:** Lowercase with underscores, not camelCase

### Ephemeral vs. Durable Separation

Separate agent working files from user's permanent data:

```
Documents/
├── AgentCheckpoints/     # Ephemeral (can delete)
│   └── {sessionId}.checkpoint
├── AgentLogs/            # Ephemeral (debugging)
│   └── {type}/{sessionId}.md
└── Research/             # Durable (user's work)
    └── books/{bookId}/
```

### The Split: Markdown vs JSON

- **Markdown:** For content users might read or edit
- **JSON:** For structured data the app queries
</file_organization>

<context_md_pattern>
## The context.md Pattern

A file the agent reads at the start of each session and updates as it learns:

```markdown
# Context

## Who I Am
Reading assistant for the Every app.

## What I Know About This User
- Interested in military history and Russian literature
- Prefers concise analysis
- Currently reading War and Peace

## What Exists
- 12 notes in /notes
- 3 active projects
- User preferences at /preferences.md

## Recent Activity
- User created "Project kickoff" (2 hours ago)
- Analyzed passage about Austerlitz (yesterday)

## My Guidelines
- Don't spoil books they're reading
- Use their interests to personalize insights

## Current State
- No pending tasks
- Last sync: 10 minutes ago
```

### Benefits

- **Agent behavior evolves without code changes** - Update the context, behavior changes
- **Users can inspect and modify** - Complete transparency
- **Natural place for accumulated context** - Learnings persist across sessions
- **Portable across sessions** - Restart agent, knowledge preserved

### How It Works

1. Agent reads `context.md` at session start
2. Agent updates it when learning something important
3. System can also update it (recent activity, new resources)
4. Context persists across sessions

### What to Include

| Section | Purpose |
|---------|---------|
| Who I Am | Agent identity and role |
| What I Know About This User | Learned preferences, interests |
| What Exists | Available resources, data |
| Recent Activity | Context for continuity |
| My Guidelines | Learned rules and constraints |
| Current State | Session status, pending items |
</context_md_pattern>

<files_vs_database>
## Files vs. Database

> **Needs validation:** This framing is informed by mobile development. For web apps, the tradeoffs are different.

| Use files for... | Use database for... |
|------------------|---------------------|
| Content users should read/edit | High-volume structured data |
| Configuration that benefits from version control | Data that needs complex queries |
| Agent-generated content | Ephemeral state (sessions, caches) |
| Anything that benefits from transparency | Data with relationships |
| Large text content | Data that needs indexing |

**The principle:** Files for legibility, databases for structure. When in doubt, files—they're more transparent and users can always inspect them.

### When Files Work Best

- Scale is small (one user's library, not millions of records)
- Transparency is valued over query speed
- Cloud sync (iCloud, Dropbox) works well with files

### Hybrid Approach

Even if you need a database for performance, consider maintaining a file-based "source of truth" that the agent works with, synced to the database for the UI:

```
Files (agent workspace):
  Research/book_123/introduction.md

Database (UI queries):
  research_index: { bookId, path, title, createdAt }
```
</files_vs_database>

<conflict_model>
## Conflict Model

If agents and users write to the same files, you need a conflict model.

### Current Reality

Most implementations use **last-write-wins** via atomic writes:

```swift
try data.write(to: url, options: [.atomic])
```

This is simple but can lose changes.

### Options

| Strategy | Pros | Cons |
|----------|------|------|
| **Last write wins** | Simple | Changes can be lost |
| **Agent checks before writing** | Preserves user edits | More complexity |
| **Separate spaces** | No conflicts | Less collaboration |
| **Append-only logs** | Never overwrites | Files grow forever |
| **File locking** | Safe concurrent access | Complexity, can block |

### Recommended Approaches

**For files agents write frequently (logs, status):** Last-write-wins is fine. Conflicts are rare.

**For files users edit (profiles, notes):** Consider explicit handling:
- Agent checks modification time before overwriting
- Or keep agent output separate from user-editable content
- Or use append-only pattern

### iCloud Considerations

iCloud sync adds complexity. It creates `{filename} (conflict).md` files when sync conflicts occur. Monitor for these:

```swift
NotificationCenter.default.addObserver(
    forName: .NSMetadataQueryDidUpdate,
    ...
)
```

### System Prompt Guidance

Tell the agent about the conflict model:

```markdown
## Working with User Content

When you create content, the user may edit it afterward. Always read
existing files before modifying them—the user may have made improvements
you should preserve.

If a file has been modified since you last wrote it, ask before overwriting.
```
</conflict_model>

<examples>
## Example: Reading App File Structure

```
Documents/
├── Library/
│   └── library.json              # Book metadata
├── Research/
│   └── books/
│       └── {bookId}/
│           ├── full_text.txt     # Downloaded content
│           ├── introduction.md   # Agent-generated, user-editable
│           ├── notes.md          # User notes
│           └── sources/
│               ├── wikipedia.md  # Research gathered by agent
│               └── reviews.md
├── Chats/
│   └── {conversationId}.json     # Chat history
├── Profile/
│   └── profile.md                # User reading profile
└── context.md                    # Agent's accumulated knowledge
```

**How it works:**

1. User adds book → creates entry in `library.json`
2. Agent downloads text → saves to `Research/books/{id}/full_text.txt`
3. Agent researches → saves to `sources/`
4. Agent generates intro → saves to `introduction.md`
5. User edits intro → agent sees changes on next read
6. Agent updates `context.md` with learnings
</examples>

<checklist>
## Files as Universal Interface Checklist

### Organization
- [ ] Entity-scoped directories (`{type}/{id}/`)
- [ ] Consistent naming conventions
- [ ] Ephemeral vs durable separation
- [ ] Markdown for human content, JSON for structured data

### context.md
- [ ] Agent reads context at session start
- [ ] Agent updates context when learning
- [ ] Includes: identity, user knowledge, what exists, guidelines
- [ ] Persists across sessions

### Conflict Handling
- [ ] Conflict model defined (last-write-wins, check-before-write, etc.)
- [ ] Agent guidance in system prompt
- [ ] iCloud conflict monitoring (if applicable)

### Integration
- [ ] UI observes file changes (or shared service)
- [ ] Agent can read user edits
- [ ] User can inspect agent output
</checklist>
