---
title: "OpenViking Context and Memory"
summary: "Recommended architecture for using OpenViking as the unified retrieval plane across OpenClaw memory files and an external knowledge base"
read_when:
  - You are adopting OpenViking as the active context engine
  - You want one retrieval plane across native OpenClaw memory and an external vault such as Obsidian
  - You need writeback and diagnostics rules for OpenViking
---

# OpenViking Context and Memory

OpenViking works best when you treat it as the **single retrieval plane** for
OpenClaw, while still keeping Markdown files as the source of truth.

That means:

- OpenClaw native memory files stay authoritative for agent memory.
- An external knowledge tree such as an Obsidian vault stays authoritative for
  broader notes and reference material.
- OpenViking indexes both and becomes the only retrieval layer used during
  context assembly.

## Recommended target architecture

Use **two knowledge sources** and **one retrieval plane**:

- **Native OpenClaw memory**
  - `MEMORY.md`
  - `memory/YYYY-MM-DD.md`
  - optional agent-scoped workspace notes
- **External knowledge base**
  - a vault such as Obsidian
  - project notes, docs, research, and longer-lived references
- **Unified retrieval**
  - OpenViking context-engine plugin
  - `plugins.slots.contextEngine = "openviking"`
  - `plugins.slots.memory = "none"` when you want to avoid a second retrieval
    surface

This keeps retrieval, ranking, and context assembly in one place instead of
splitting them between `qmd`, `memory-core`, and a separate external knowledge
retriever.

## Recommended config

```json5
{
  plugins: {
    slots: {
      contextEngine: "openviking",
      memory: "none",
    },
    entries: {
      openviking: {
        enabled: true,
        baseUrl: "http://127.0.0.1:1933",
        targetUri: "viking://resources",
        writebackEnabled: true,
        writebackMode: "hybrid",
        writebackDirectory: "memory/openviking",
        writebackIndexFile: "memory/openviking/_writeback-index.json",
        diagnosticEnabled: true,
        diagnosticFile: "memory/openviking/_status.json",
      },
    },
  },
  memory: {
    backend: "builtin",
  },
}
```

If you intentionally keep a memory plugin enabled, do it as a compatibility
choice. Otherwise, disable the memory slot so OpenViking is the only recall
path.

## Source boundaries

Keep the two sources separate on purpose:

- Put durable agent memory and session-derived notes into native OpenClaw
  memory files.
- Put broader knowledge, documents, and curated notes into the external vault.
- Do not let OpenClaw write directly into the vault root as part of routine
  writeback.

The current OpenViking integration enforces this by constraining its workspace
writeback paths under `memory/...`. It will reject paths that escape the
workspace memory tree or try to target `.obsidian`.

## Writeback model

OpenViking supports three writeback modes:

- `session-api`
  - writes directly to OpenViking-managed memory
- `workspace-memory`
  - mirrors writeback into OpenClaw Markdown files
- `hybrid`
  - does both

For OpenClaw workspaces, `hybrid` is the safest default because it keeps:

- OpenViking memory updated for retrieval
- a Markdown mirror in `memory/openviking/YYYY-MM-DD.md`

The integration also maintains a persisted digest index at
`memory/openviking/_writeback-index.json` so duplicate writebacks can be
suppressed across gateway restarts and plugin reloads.

## Diagnostics

OpenViking runtime state is exposed in three places:

- [`openclaw status`](/cli/status)
  - includes the latest runtime summary when OpenViking is active
- [`openclaw doctor`](/cli/doctor)
  - reports whether OpenViking is active, whether a snapshot exists, and whether
    retrieval or writeback is failing
- [`openclaw plugins inspect openviking`](/cli/plugins)
  - shows the latest detailed runtime snapshot and plugin-specific notices

The latest runtime snapshot is stored in:

- `memory/openviking/_status.json`

This snapshot records retrieval success, result count, target URI, writeback
mode, writeback outputs, and any recent writeback failure or duplicate-skip
reason.

## Why this architecture

This design keeps a clean separation:

- Markdown files stay human-editable and auditable.
- OpenViking owns retrieval and context assembly.
- The external vault remains an external source of truth, not an OpenClaw
  scratchpad.

That gives you one retrieval plane without collapsing everything into one file
tree.
