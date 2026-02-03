# Komatachi

> **First action**: Read [PROGRESS.md](./PROGRESS.md) for current state, completed work, and next steps.

---

## Document Map

```
PROGRESS.md          <- Start here (current state, next actions)
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

Komatachi is a new codebase built from the ground up. It captures OpenClaw's essential functionality while shedding accumulated complexity, bloat, and historical baggage.

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
