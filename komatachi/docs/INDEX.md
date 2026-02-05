# Komatachi Documentation Index

This index provides navigation to all project documentation.

---

## Primary Documents

These are the essential documents for understanding and contributing to Komatachi:

| Document | Purpose | When to Read |
|----------|---------|--------------|
| [PROGRESS.md](../PROGRESS.md) | Current state, completed work, next steps | **Start here** - read first in every session |
| [ROADMAP.md](../ROADMAP.md) | Phased plan, decision authority, session protocol | When picking next work item or making decisions |
| [DISTILLATION.md](../DISTILLATION.md) | Principles and process for distillation | When making design decisions |
| [CLAUDE.md](../CLAUDE.md) | Project context and conventions | When starting work on Komatachi |

---

## Scouting Reports

Analysis of OpenClaw components that inform our distillation:

| Component | Report | Status |
|-----------|--------|--------|
| Context Management | [scouting/context-management.md](../scouting/context-management.md) | Complete |
| Long-term Memory & Search | [scouting/long-term-memory-search.md](../scouting/long-term-memory-search.md) | Complete |
| Agent Alignment | [scouting/agent-alignment.md](../scouting/agent-alignment.md) | Complete |
| Session Management | [scouting/session-management.md](../scouting/session-management.md) | Complete |

---

## Technical Guides

Reference material for specific technical topics:

| Guide | Purpose |
|-------|---------|
| [integration-trace.md](./integration-trace.md) | Full integration verification: component interfaces, turn traces, dependency graph, identified gaps |
| [testing-strategy.md](./testing-strategy.md) | Layer-based testing approach; when to mock vs use real deps |
| [rust-porting.md](./rust-porting.md) | Lessons from Rust portability validation; patterns for future Rust migration |

---

## Module Documentation

Each distilled module has its own DECISIONS.md:

| Module | Decisions | Status |
|--------|-----------|--------|
| Compaction | [src/compaction/DECISIONS.md](../src/compaction/DECISIONS.md) | Validated (44 tests) |
| Embeddings | [src/embeddings/DECISIONS.md](../src/embeddings/DECISIONS.md) | Validated (47 tests) |

---

## Document Hierarchy

```
komatachi/
├── CLAUDE.md              # Entry point for AI assistants
├── PROGRESS.md            # Source of truth for project state
├── ROADMAP.md             # Phased plan and decision framework
├── DISTILLATION.md        # Core principles
├── docs/
│   ├── INDEX.md              # This file
│   ├── integration-trace.md  # Component integration verification
│   ├── testing-strategy.md   # Layer-based testing approach
│   └── rust-porting.md       # Rust migration guide
├── scouting/              # OpenClaw analysis
│   ├── context-management.md
│   ├── long-term-memory-search.md
│   ├── agent-alignment.md
│   └── session-management.md
└── src/
    ├── compaction/
    │   ├── index.ts
    │   ├── index.test.ts
    │   └── DECISIONS.md
    └── embeddings/
        ├── index.ts
        ├── index.test.ts
        └── DECISIONS.md
```

---

## Adding New Documents

When adding documentation:

1. **Module decisions**: Add `DECISIONS.md` in the module's directory
2. **Technical guides**: Add to `docs/` and update this index
3. **Scouting reports**: Add to `scouting/` and update this index
4. **Core principles**: Update existing documents rather than creating new ones
