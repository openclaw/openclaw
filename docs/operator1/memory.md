---
title: "Memory"
summary: "Browse, edit, and search an agent's memory files — MEMORY.md, dated journals, and identity files — and monitor the memory index health and activity log."
---

# Memory

The Memory page shows an agent's persistent knowledge. You can browse files, search, check index health, and view activity.

Go to **Memory** in the sidebar.

---

## Index Status

The Index Status tab shows the health of the memory index and lets you trigger a manual re-index.

### Health badge

A color-coded badge at the top of the tab shows the overall state:

| Badge                 | Meaning                                                |
| --------------------- | ------------------------------------------------------ |
| **Healthy** (green)   | All checks pass, files indexed                         |
| **Degraded** (amber)  | One or more warnings (fallback active, batch failures) |
| **Empty** (amber)     | No files indexed yet                                   |
| **Unavailable** (red) | Embedding probe failed or hard error                   |
| **Unknown** (muted)   | Status not yet loaded                                  |

### Re-index Now

Click **Re-index Now** to trigger a full re-index of all memory files. The button shows a spinner while the operation is running. After indexing completes the stat cards and issues panel refresh automatically.

### Stat cards

Three stat cards adapt to the backend in use:

**QMD backend**

| Card        | What it shows                                              |
| ----------- | ---------------------------------------------------------- |
| Documents   | Number of indexed documents                                |
| Collections | Number of QMD collections; subtitle shows last update time |
| Backend     | `qmd` and provider name                                    |

**Built-in backend**

| Card    | What it shows                                                              |
| ------- | -------------------------------------------------------------------------- |
| Files   | Number of indexed memory files; subtitle shows workspace directory         |
| Chunks  | Number of indexed chunks; subtitle notes pending changes if index is dirty |
| Backend | Backend identifier and provider name                                       |

### Source counts table

For the built-in backend, a **Sources** table below the stat cards breaks down indexed files and chunks by source path. The table is sortable by source, files, or chunks.

### Technical info badges

Below the stat cards, small `font-mono` badges show subsystem status:

| Label  | Values                                          |
| ------ | ----------------------------------------------- |
| Model  | Embedding model in use                          |
| Vector | `available` with dimensions, or `unavailable`   |
| FTS    | `available` or `unavailable` (full-text search) |
| Cache  | `enabled (N/max)` or `disabled`                 |
| Batch  | `enabled` or `enabled (N failures)`             |

For QMD, Vector shows `managed by qmd` instead of individual availability flags.

### Issues panel

If any warnings or errors are detected, each issue appears as a colored card:

- **Red** (error): embedding probe failed, fatal initialization error
- **Amber** (warning): fallback active (with the reason and previous backend), batch failures, vector or FTS unavailable, no files indexed

---

## Files

The Files tab is a two-panel editor: a file tree on the left and an inline text editor on the right.

### Agent selector

If multiple agents are configured, a dropdown at the top of the file tree lets you switch between agents. Switching reloads the file list for the selected agent.

### File tree

Files are organized into two sections:

**Memory files** — `MEMORY.md` is always pinned at the top. Dated daily journals (`memory/YYYY-MM-DD.md`) follow sorted newest-first, displayed as human-readable dates (e.g., `Mar 10, 2026`). If there are more than 10 journals, a **Show all** link expands the full list. The preference is remembered in `localStorage`.

**Identity files** — Other workspace files (`SOUL.md`, `IDENTITY.md`, `AGENTS.md`, etc.) appear in a collapsible section below. The section is collapsed by default; the preference is remembered in `localStorage`.

Each file entry shows its display name, file size, and time since last modification. Missing files that the agent should have but doesn't are shown in italics with a `+` icon and the label "Click to create" — selecting one opens an empty editor and saving it creates the file.

A **filter input** at the top of the file tree lets you narrow by filename or display name.

A **Refresh** icon button reloads the file list and re-fetches the currently open file.

### Inline editor

Click any file in the tree to load it into the editor on the right. The editor is a plain-text textarea with monospace font.

**Header** — shows the filename and two action buttons:

| Button     | Enabled when          | Action                                       |
| ---------- | --------------------- | -------------------------------------------- |
| **Revert** | Unsaved changes exist | Discard edits and restore last saved content |
| **Save**   | Unsaved changes exist | Write the file via the gateway RPC           |

Unsaved changes are tracked by comparing the current content to the originally loaded content. Navigating to a different file discards unsaved changes without warning.

### Line navigation from Search

When you click a search result on the Search tab, the Files tab opens with the matching file loaded and the editor scrolled and selected to the specific line. The cursor is placed at that line and focus moves to the editor automatically.

---

## Search

The Search tab runs semantic search over indexed memory content.

### Search input

Type a query and press **Enter** or click **Search**. A history dropdown appears on focus (if you have previous queries) showing recent searches with a clock icon. Click a history entry to re-run it immediately.

### Backend indicator

A small badge below the input shows which backend handled the search (`qmd` or `builtin`) and, for the built-in backend, the search mode (e.g., `vector`, `fts`, `hybrid`).

### Text search fallback

If semantic search returns no results, the system falls back to text search automatically. A blue info banner indicates when results are from text search rather than vector embeddings.

### Results

Each result card shows:

| Element              | Description                                                          |
| -------------------- | -------------------------------------------------------------------- |
| File path + line     | `memory/2026-03-10.md:42` — the exact file and start line            |
| Score badge          | Relevance score 0–1; green ≥ 0.8, amber ≥ 0.5, muted otherwise       |
| Source badge         | Which source produced the result                                     |
| Date                 | Last modification date of the file                                   |
| Snippet              | A short excerpt from the matching passage                            |
| "View in Files" link | Navigates to the Files tab with the file loaded at the matching line |

Click any result card to navigate directly to the Files tab.

### QMD search tips

QMD uses vector embeddings, not keyword matching. Short abbreviations (fewer than 4 characters) will not match. Use descriptive phrases or full sentences, for example:

- Instead of `"neo"` → try `"CTO agent responsibilities"` or `"Neo engineering tasks"`
- Instead of `"auth"` → try `"authentication flow"` or `"login session handling"`

---

## Activity Log

The Activity Log tab shows a chronological record of all memory operations performed by the agent.

### Filters

Three filter buttons narrow the log:

| Filter     | Shows                          |
| ---------- | ------------------------------ |
| **All**    | Every operation                |
| **Reads**  | `read` and `search` operations |
| **Writes** | `write` and `edit` operations  |

A **Refresh** button (top-right) reloads the log from the gateway.

### Log entries

Each entry shows:

| Field              | Description                                                                         |
| ------------------ | ----------------------------------------------------------------------------------- |
| Timestamp          | Date and time of the operation                                                      |
| Operation badge    | Colored by type: `search` (blue), `read` (green), `write` (orange), `edit` (purple) |
| Tool name          | The gateway tool that performed the operation                                       |
| File path or query | The file accessed, or the search query used                                         |
| Snippet            | A brief excerpt of content read or written                                          |
| Session key        | Which agent session triggered the operation                                         |

### Pagination

The log displays 20 entries at a time. Click **Load more** to fetch the next batch. The display limit increments by 20 with each click.
