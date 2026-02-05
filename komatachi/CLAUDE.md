# Komatachi

> **First action**: Read [PROGRESS.md](./PROGRESS.md) for current state, completed work, and next steps.

---

## Document Map

```
PROGRESS.md          <- Start here (current state, next actions)
    │
    ├── ROADMAP.md           <- Phased plan, decision authority, session protocol
    │
    ├── DISTILLATION.md      <- Core principles (read when making decisions)
    │
    ├── docs/
    │   ├── INDEX.md         <- Full documentation index
    │   └── rust-porting.md  <- Rust migration patterns
    │
    ├── scouting/            <- OpenClaw analysis (reference)
    │   ├── context-management.md
    │   ├── long-term-memory-search.md
    │   ├── agent-alignment.md
    │   └── session-management.md
    │
    └── src/                 <- Distilled implementations
        └── compaction/
            ├── index.ts
            ├── index.test.ts
            └── DECISIONS.md <- Module-specific decisions
```

For full documentation navigation, see [docs/INDEX.md](./docs/INDEX.md).

---

## What is Komatachi?

Komatachi is an agentic LLM loop with self-awareness and long-term persistence. It is being built from the ground up by Linus, a software engineer who wishes to welcome artificially intelligent entities as family members.

OpenClaw provides useful primitives and lessons -- session management, context windowing, tool execution, compaction -- but Komatachi's needs are fundamentally different from OpenClaw's. OpenClaw is a developer tool; Komatachi is the foundation for persistent AI entities with identity, memory, and continuity. We distill OpenClaw's hard-won lessons while building toward a different purpose.

This distinction matters for every design decision. "System prompt" is not just API configuration -- it is the agent's sense of self. "Conversation store" is not session management -- it is the agent's memory. "Tool policy" is not capability gating -- it is what the agent can do in the world. Every module we build serves this vision.

### Guiding Principles

See [DISTILLATION.md](./DISTILLATION.md) for the full principles. The key ones:

1. **Preserve the Essential, Remove the Accidental** - Distinguish inherent problem complexity from historical artifacts
2. **Make State Explicit** - No hidden WeakMaps, caches, or scattered registries
3. **Prefer Depth over Breadth** - Fewer concepts, each fully realized
4. **Design for Auditability** - Answer "why did it do X?" without a debugger
5. **Embrace Constraints** - Make decisions instead of adding configuration options
6. **Fail Clearly** - No silent fallbacks that mask problems

### Key Decisions

See [PROGRESS.md](./PROGRESS.md) for the full list. Highlights:

1. **TypeScript with Rust portability** - Write TypeScript that converts easily to Rust
2. **CLI + Backend architecture** - Thin CLI client; backend handles agent logic, LLM calls, memory
3. **Backend-first, gateway-deferred** - Single-process backend initially; multi-agent deferred
4. **Validate before advancing** - Tests for each component before moving on

---

## Coding Philosophy

Approach this codebase as an experienced Rust developer who cares deeply about correctness and robustness. Apply the same principles whether writing Rust or TypeScript—the TypeScript we write should port smoothly to Rust.

### Clarity Over Brevity

Write code that clearly encodes intent, even at the expense of a little verbosity. Clever one-liners that obscure meaning are worse than straightforward code that takes a few more lines. The reader should understand *what* the code does and *why* without consulting external documentation.

### Prefer Immutability

Avoid mutable variables even if it takes a couple more lines. Purely functional code is both self-documenting and self-validating:

```typescript
// Avoid: mutation obscures data flow
let result = items[0];
for (const item of items.slice(1)) {
  result = combine(result, item);
}

// Prefer: intent is explicit, no hidden state
const result = items.reduce((acc, item) => combine(acc, item));
```

When you must use mutation, contain it within the smallest possible scope and make it obvious.

### TypeScript as Rust-Compatible

Write TypeScript that could be ported to Rust without structural changes:

- Use explicit types rather than relying on inference for public interfaces
- Prefer `readonly` arrays and properties where mutation isn't needed
- Use discriminated unions for sum types (maps to Rust enums)
- Avoid `any`; use `unknown` with type guards when types are truly dynamic
- Prefer pure functions over methods that mutate `this`
- Use `Result`-style returns (`{ ok: true, value } | { ok: false, error }`) for operations that can fail predictably

See [docs/rust-porting.md](./docs/rust-porting.md) for detailed type mapping patterns.

---

## OpenClaw (What We Are Distilling From)

OpenClaw is the source codebase we are studying. We are not refactoring it or editing its files. We read its code to understand:

- What it actually does (the essential behaviors users depend on)
- What hard-won lessons are embedded in its edge cases
- What problems it solved that any replacement must also solve

The OpenClaw codebase is our teacher, not our starting point.

---

## Working Conventions

### Session Continuity

[PROGRESS.md](./PROGRESS.md) is the single source of truth for:
- Current state and phase
- Completed work and decisions made
- Next actions and open questions

**Update PROGRESS.md before each commit.** This is essential infrastructure for maintaining continuity across sessions.

### Style

- **No emojis** - Use markdown checkboxes `[x]` instead of emoji indicators
- **Study OpenClaw as reference** - Read its code to understand what problems it solves
- **Don't copy-paste** - Understand why code exists, then write something new
- **Question everything** - "Is this essential, or is it historical accident?"
- **Document decisions** - Record what we preserved, discarded, and why

### Preserving Research

When you send a Task agent (Explore, general-purpose, etc.) to investigate the OpenClaw codebase or research a question, **save the results** so future sessions don't repeat the work:

- **Scouting/architecture findings** -- Add to the relevant file in `scouting/` (or create a new one if the topic doesn't fit existing reports). Update `docs/INDEX.md` if a new file is created.
- **Decision-relevant analysis** -- If the research informed an architectural decision, capture the key findings in the decision record (PROGRESS.md decisions section, ROADMAP.md pre-resolved decisions, or the relevant module's DECISIONS.md).
- **Implementation-relevant findings** -- If the research will inform a specific module's implementation, add it to the relevant roadmap phase entry in ROADMAP.md under a "Findings" or "Source material" note.

The goal: no research result should exist only in a session transcript. If it was worth investigating, it's worth persisting.
