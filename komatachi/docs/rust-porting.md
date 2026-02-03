# Rust Porting Guide

> **Context**: Decision #5 established "TypeScript with Rust portability"

This document captures lessons from validating that our TypeScript design ports cleanly to Rust. We built a Rust implementation of the compaction module and ran it against the existing TypeScript test suite via napi-rs bindings. The experiment confirmed the approach works; this document preserves what we learned.

---

## The Core Insight

**Pure computation ports trivially. Keep I/O at the boundaries.**

The compaction module is essentially pure: it takes data in, does computation, and returns data out. The one I/O operation (calling the summarizer) is injected as a dependency. This separation means:

- The computation logic translates 1:1 to Rust
- The I/O strategy is decided separately, at the boundary
- Testing is straightforward (inject a mock)

This isn't a Rust-specific pattern—it's good software design that happens to make porting easy.

---

## Type Mapping

TypeScript types map predictably to Rust types.

### Optional Fields

```typescript
// TypeScript
interface Message {
  role: string;
  toolCallId?: string;
  exitCode?: number;
}
```

```rust
// Rust
pub struct Message {
    pub role: String,
    pub tool_call_id: Option<String>,
    pub exit_code: Option<i32>,
}
```

### Discriminated Unions → Rust Enums or Structs

```typescript
// TypeScript
type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; inputTokens: number };
```

```rust
// Rust - as enum
pub enum ValidationResult {
    Ok,
    Err { reason: String, input_tokens: u32 },
}

// Rust - as struct (when serialization matters)
pub struct ValidationResult {
    pub ok: bool,
    pub reason: Option<String>,
    pub input_tokens: Option<u32>,
}
```

### Collections

```typescript
// TypeScript
const filesRead: Set<string>;
const messages: Message[];
```

```rust
// Rust
let files_read: HashSet<String>;
let messages: Vec<Message>;
```

Note: When crossing FFI boundaries (napi-rs), `Set<T>` converts to `Vec<T>` since JavaScript Sets don't map directly.

### Dynamic Content

```typescript
// TypeScript
interface Message {
  content: unknown;
}
```

```rust
// Rust
pub struct Message {
    pub content: serde_json::Value,
}
```

---

## Pure Functions Port 1:1

Functions without side effects translate directly:

```typescript
// TypeScript
export function estimateTokens(message: Message): number {
  const text = extractText(message.content);
  return Math.ceil(text.length / 4);
}
```

```rust
// Rust
pub fn estimate_tokens(message: &Message) -> u32 {
    let text = extract_text(&message.content);
    (text.len() as f64 / 4.0).ceil() as u32
}
```

The logic is identical. The differences are mechanical: `&` for borrows, explicit numeric casts, snake_case.

---

## Dependency Injection for I/O

When a module needs external capabilities (like calling an LLM), inject them:

```typescript
// TypeScript - function injection
interface CompactionConfig {
  summarize: (messages: Message[]) => Promise<string>;
}
```

```rust
// Rust - trait-based injection
pub trait Summarizer {
    fn summarize(&self, messages: &[Message]) -> Result<String, Error>;
}

pub fn compact(
    messages: &[Message],
    summarizer: &impl Summarizer,
) -> Result<CompactionResult, Error> {
    // Module doesn't know or care how summarization happens
    let summary = summarizer.summarize(messages)?;
    // ...
}
```

The module stays pure and testable. The caller decides how I/O actually works.

---

## Validation Approach

We used napi-rs to create Node.js bindings for the Rust implementation. This let us:

1. Run the existing 44 TypeScript tests against Rust code
2. Verify identical behavior without writing duplicate tests
3. Catch type mapping issues at the boundary

This was validation scaffolding, not target architecture. The bindings confirmed the port works; they aren't part of the design going forward.

---

## What We Validated

1. **Type mapping works**: All TypeScript types mapped cleanly to Rust equivalents
2. **Behavior is identical**: Same tests, same results
3. **Pure functions port directly**: No structural changes needed

The experiment confirmed decision #5: writing Rust-portable TypeScript is achievable. The actual port can happen when requirements demand it.

---

## References

- [napi-rs documentation](https://napi.rs/) (for validation bindings)
- [serde_json](https://docs.rs/serde_json/) (for dynamic JSON)
- Decision #5 in [PROGRESS.md](../PROGRESS.md)
