# Komatachi Distillation Progress

> **START HERE** — This file is the source of truth for project state.

## Quick Status

| Aspect | State |
|--------|-------|
| **Phase** | Compaction validated; ready for next component |
| **Last completed** | Compaction tests (44 tests passing) |
| **Next action** | Distill Long-term Memory & Search |
| **Blockers** | None |

### What Exists Now
- [x] Scouting reports for 4 core areas (~20k LOC analyzed)
- [x] Distillation principles documented (8 principles)
- [x] Trial distillation: `src/compaction/` code complete
- [x] Compaction tests (44 tests passing)
- [x] Key architectural decisions (TypeScript+Rust, minimal viable agent, no gateway)

### Current Focus: Next Component Selection
Compaction is validated with 44 passing tests. The distillation process works. Next: apply it to Long-term Memory & Search (most isolated, different domain).

---

This file tracks our progress distilling OpenClaw into Komatachi. Maintaining this file is essential—it provides continuity across sessions, documents what we've learned, and prevents re-discovering the same insights.

**Update this file as work progresses.**

---

## Completed Work

### 1. Scouting (Complete)

Analyzed four core functional areas of OpenClaw:

| Component | LOC | Files | Complexity | Report |
|-----------|-----|-------|------------|--------|
| Context Management | 2,630 | 15 | HIGH | `scouting/context-management.md` |
| Long-term Memory & Search | 5,713 | 25 | HIGH | `scouting/long-term-memory-search.md` |
| Agent Alignment | 4,261 | 18 | HIGH | `scouting/agent-alignment.md` |
| Session Management | 7,319 | 35+ | HIGH | `scouting/session-management.md` |

**Total**: ~20,000 lines of high-complexity code

### 2. Distillation Principles (Complete)

Established 8 core principles in `DISTILLATION.md`:

1. Preserve the Essential, Remove the Accidental
2. Make State Explicit and Localized
3. Prefer Depth over Breadth
4. Design for Auditability
5. Embrace Constraints
6. Interfaces Over Implementations
7. Fail Clearly, Not Gracefully
8. Respect Layer Boundaries

Also documented:
- The Distillation Test (when to distill, what success looks like)
- Four-phase process (Study → Design → Build → Validate)
- What distillation is NOT (refactoring, porting, optimization)
- Preserving the distilled state (cognitive scaffolding, guards against drift)

### 3. Trial Distillation: Compaction (Complete)

Successfully distilled compaction as a proof of concept:

| Metric | Original | Distilled |
|--------|----------|-----------|
| Lines of code | 666 | 275 |
| Hidden state | WeakMap registries | None |
| Chunking | Built-in, adaptive | Caller's responsibility |
| Oversized input | Silent pruning | Throws error |
| Extension hooks | Yes | No |
| Tests needed (est.) | ~50 | ~15-20 |

**Key insight discovered**: The summarizer was handling chunking that wasn't its responsibility (layer boundary violation). Modern 128k+ context models can summarize ~107k tokens in one call—the 40% chunk ratio was a holdover from smaller context windows.

Files created:
- `src/compaction/index.ts` - The distilled implementation
- `src/compaction/DECISIONS.md` - Architectural decision record

### 4. Project Documentation (Complete)

- `CLAUDE.md` - Project context for AI assistants
- `DISTILLATION.md` - Principles and process
- `PROGRESS.md` - This file

### 5. Compaction Validation (Complete)

Added test infrastructure and comprehensive tests for the compaction module:

| Aspect | Result |
|--------|--------|
| Test framework | Vitest (aligned with OpenClaw) |
| Tests written | 44 |
| Tests passing | 44 |
| Coverage areas | Token estimation, tool failure extraction, file ops, error handling, edge cases |

Key validations:
- Token estimation accuracy with safety margin
- InputTooLargeError thrown at correct thresholds
- Tool failure extraction from various message formats
- File operations computation (read vs modified)
- Summarizer fallback when API fails
- Edge cases: empty messages, no failures, content block arrays

This validates both the distilled code and the distillation process itself.

### 6. Rust Portability Validation (Complete, Cleaned Up)

Built an experimental Rust implementation of compaction to validate decision #5 ("TypeScript with Rust portability"). The experiment confirmed:

- Type mapping works cleanly between TypeScript and Rust
- Pure functions port 1:1
- Hybrid architecture (Rust computation, TypeScript async) is viable

**Outcome**: Validation successful. Experimental code removed; lessons documented in [docs/rust-porting.md](./docs/rust-porting.md) for future reference.

### 7. Documentation Reorganization (Complete)

Restructured documentation for discoverability:

- Created `docs/` directory for supplementary documentation
- Added `docs/INDEX.md` as central navigation hub
- Updated `CLAUDE.md` with document map
- Preserved lessons from Rust experiment in `docs/rust-porting.md`

---

## Key Decisions Made

1. **Single embedding provider** - One provider behind a clean interface
2. **No plugin hooks for core behavior** - Static, predictable behavior
3. **Vector-only search** - Modern embeddings are sufficient
4. **Cross-agent session access** - Deferred. Essential for power users, but not needed for minimal viable agent. Will add when requirements demand it.
5. **TypeScript with Rust portability** - Distill into TypeScript, but write code that converts easily to Rust. Avoid TypeScript-only tricks; verify heavy dependencies have Rust ecosystem equivalents.
6. **CLI + Backend architecture** - The CLI is a thin client handling user interaction and display. The backend handles agent logic, LLM calls, compaction, memory, etc. This separation keeps the core framework interface-agnostic—it could serve a CLI, web client, or be embedded as a library.
7. **Backend-first, gateway-deferred** - Start with a single-process backend. Design session storage and tool execution so they *could* support multi-agent later, but don't build it until needed. If/when we need multi-agent communication, prefer local-first IPC (ZeroMQ, Unix sockets) over web-oriented tech (WebSocket, HTTP). Note: ZeroMQ supports broker-less patterns (direct peer-to-peer)—a central broker may not be required at all.
8. **Validate before advancing** - Write tests for each distilled component before moving to the next. Unvalidated foundations are risky; tests often reveal design issues early. This implements "Phase 4: Validate" from DISTILLATION.md.

---

## Insights Discovered

### From Compaction Analysis

1. **Chunking was over-engineered** - 40% chunk ratio was for 8k-16k context era; modern models don't need it
2. **Token estimation needs margins** - 20% safety buffer is essential (estimation is imprecise)
3. **Metadata survives compaction** - Tool failures and file operations are high-signal information
4. **Layer boundaries matter** - Summarizer shouldn't chunk; that's caller's responsibility

### From OpenClaw AGENTS.md Analysis

The original codebase had **no architectural principles documented**—only operational procedures. This absence likely contributed to complexity accumulation. The distilled system must embed principles alongside code.

### From Gateway Analysis

Traced cross-agent communication in OpenClaw. The gateway is a WebSocket-based JSON-RPC broker that:
- Routes messages between agents via session key prefixes (`agent:<agentId>:...`)
- Maintains combined view of all agent session stores
- Handles multi-client streaming (web, mobile, CLI)
- Enforces auth and access control

**Key insight**: The gateway solves problems that emerge from multi-client and multi-agent requirements. A single-process CLI has none of these problems. The lesson isn't "always use a gateway"—it's "when you need multi-client or multi-agent, you need a broker."

**Design implication**: Keep session storage and tool execution decoupled enough that a broker could be added later without rewriting core logic.

---

## Next Steps

1. ~~**Write compaction tests**~~ - Done (44 tests passing)

2. **Distill Long-term Memory & Search** (next)
   - Most isolated component
   - Different domain than compaction (tests process generalization)
   - Clear success criteria: can embed and retrieve text
   - Follow same process: scout -> design -> build -> validate

3. **Integration checkpoint** - After two components, verify they can compose toward minimal viable agent

---

## Open Questions

None currently. Cross-agent session access question resolved—deferred until requirements demand it (see decisions #4 and #7).

---

## File Manifest

```
komatachi/
├── CLAUDE.md           # Project context (includes document map)
├── PROGRESS.md         # This file - update as work progresses
├── DISTILLATION.md     # Principles and process
├── package.json        # Dependencies (vitest, typescript)
├── tsconfig.json       # TypeScript config
├── vitest.config.ts    # Test runner config
├── docs/               # Supplementary documentation
│   ├── INDEX.md        # Central navigation hub
│   └── rust-porting.md # Rust migration guide (from validation)
├── scouting/           # Analysis of OpenClaw components
│   ├── context-management.md
│   ├── long-term-memory-search.md
│   ├── agent-alignment.md
│   └── session-management.md
└── src/
    └── compaction/     # First distilled module (validated)
        ├── index.ts
        ├── index.test.ts   # 44 tests
        └── DECISIONS.md
```

---

## Maintaining This File

**This progress file is essential infrastructure.** Without it:
- New sessions start from zero, re-discovering what we already know
- Decisions get revisited unnecessarily
- Context is lost between work sessions

**Update discipline**:
- Add completed work immediately after finishing
- Record insights as they're discovered
- Update open questions as they're resolved
- Keep the "Current Status" line accurate

The goal is that anyone (human or AI) can read this file and understand exactly where we are and what to do next.
