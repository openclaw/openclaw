# Zero Language Review — Emmi's Assessment

**Repo:** vercel-labs/zero (cloned locally: ~/zero-lang)
**License:** Apache 2.0
**Current version:** 0.1.3 (released ~4 days ago)
**Status:** Pre-1, explicitly unstable, not production-ready

---

## What It Is

A systems programming language (C/Rust design space) where the compiler output, toolchain, and standard library were designed from day one for AI agents as primary users, not humans. Compiles to native executables with explicit memory control.

## Core Innovation: Agent-First Toolchain

This is the real differentiator. Every other language makes agents parse unstructured text. Zero emits structured data by default.

### Structured Diagnostics

```json
{
  "ok": false,
  "diagnostics": [
    {
      "code": "NAM003",
      "message": "unknown identifier",
      "line": 3,
      "repair": { "id": "declare-missing-symbol" }
    }
  ]
}
```

- **Stable diagnostic codes** (NAM003, TYP009, BOR001, etc.) — ~70 codes across parsing, naming, typing, borrowing, targets, imports, packages
- **Typed repair IDs** — the compiler tells the agent _how_ to fix it
- **Fix safety levels** — format-only, behavior-preserving, api-changing, target-changing, requires-human-review
- Agents read `code` + `repair`. Humans read `message`. Same output, both audiences.

### Key CLI Commands for Agents

- `zero check --json <input>` — structured diagnostics
- `zero explain <code>` — detailed explanation per diagnostic code
- `zero fix --plan --json <input>` — structured repair plan (plan-only, no auto-edit)
- `zero skills get zero --full` — version-matched agent guidance from the CLI itself
- `zero doctor --json` — toolchain health check
- `zero graph --json` — program structure facts
- `zero size --json` — binary size reporting

### Fix Safety Taxonomy

This is clever. The compiler classifies every suggested fix by risk:

- `format-only` — safe to apply
- `behavior-preserving` — intended not to change runtime behavior
- `api-changing` — signatures/exports may change
- `target-changing` — target support may change
- `requires-human-review` — compiler can't prove safety

Agents apply safe fixes autonomously. Escalate risky ones. This is a natural trust boundary.

## Language Design

### Explicit Effects (Capability-Based I/O)

```zero
pub fun main(world: World) -> Void raises {
    check world.out.write("hello from zero\n")
}
```

- `World` is the capability object. No `World` = no I/O. Enforced at compile time.
- No hidden globals, no ambient process objects.
- This is a security property, not just a style choice.

### Error Handling

- `raises { ErrorSet }` — explicit error sets in function signatures
- `check` — calls fallible ops and propagates failure
- `raise` — throws errors
- Open `raises` marker for unrestricted error propagation
- Error paths visible in signatures, not buried in runtime exceptions

### Memory Model

- `ref<T>` — read-only borrow (`&value`)
- `mutref<T>` — mutable borrow (`&mut value`)
- `Span<T>` / `MutSpan<T>` — contiguous views
- `Maybe<T>` — absence representation (`.has` + `.value`)
- `owned<T>` — explicit resource ownership
- `defer` — deterministic cleanup (like Rust's Drop but explicit)
- Borrow provenance tracking across references, fields, control-flow joins

### Types

- Primitives: Bool, Void, String, char, i8-i64, u8-u64, f32-f64, isize, usize
- `shape` — struct-like records
- `enum` — simple enumerations
- `choice` — tagged unions with payloads (Result-like)
- Generics with `static` value params (compile-time sizes)
- Type aliases

### Standard Library (Target-Gated)

- `std.mem` — spans, copy, fill, safe indexed get, fixed buffers, vectors
- `std.codec` — varint, CRC, checksums
- `std.parse` — ASCII predicates, decimal parsers
- `std.json` — explicit-buffer JSON parsing
- `std.http` / `std.net` — HTTP client, network handles (hosted targets only)
- `std.fs` — hosted filesystem with explicit handles
- `std.crypto` — hash and byte-oriented crypto helpers
- `std.args` / `std.env` / `std.proc` — process-level APIs
- `std.io` — buffered reader/writer surfaces
- `std.rand` — deterministic random sources
- `std.time` — duration construction and conversion
- Target gating: non-host targets reject capability-dependent APIs with `TAR002`

### C ABI Interop

- C interop via vendor headers and `zero.json` manifest
- Example in `examples/c-interop/`

## Compiler Architecture

Written in C. ~32K lines across 10 source files:

- `main.c` — 9,843 lines (driver, diagnostics, JSON output, build, fix plans, skills)
- `emit_elf64.c` — 3,247 lines (Linux ELF emitter)
- `ir.c` — 3,482 lines (IR generation)
- `parser.c` — 1,232 lines
- `checker.c` — type checking
- `lexer.c` — 231 lines (lean)
- `fs.c` — 1,694 lines (filesystem ops)
- `emit_macho64.c` — 2,420 lines (macOS Mach-O emitter)
- `emit_elf_aarch64.c` — 346 lines (ARM64)
- `target.c` — 498 lines (target definitions)

Single binary CLI. All subcommands in one executable.

## Diagnostic Code Map (from diag_code())

| Category  | Codes       | Count        |
| --------- | ----------- | ------------ |
| Parse     | PAR100      | 1 (fallback) |
| Errors    | ERR001-003  | 3            |
| App       | APP001      | 1            |
| Build     | BLD002-003  | 2            |
| Naming    | NAM002-004  | 3            |
| Typing    | TYP001-026  | 18           |
| Stdlib    | STD002-003  | 2            |
| Ownership | OWN001-002  | 2            |
| Memory    | MEM001      | 1            |
| Borrow    | BOR001-002  | 2            |
| ABI       | ABI001      | 1            |
| Methods   | MET001      | 1            |
| Public    | PUB001      | 1            |
| Interface | IFC001-005  | 5            |
| Static    | STC001-003  | 3            |
| Shape     | SHM001-002  | 2            |
| Receiver  | RCV001-002  | 2            |
| Field     | FLD001-002  | 2            |
| Variable  | VAR001-004  | 4            |
| Match     | MAT001-005  | 5            |
| Codegen   | CGEN004     | 1            |
| Web       | WEB001      | 1            |
| Target    | TAR001-002  | 2            |
| Import    | IMP001-003  | 3            |
| C Import  | CIMP001-003 | 3            |
| Package   | PKG001-004  | 4            |
| **Total** |             | **~70**      |

## What's Good

1. **The philosophy is right.** Compiler output for agents is an unsolved problem. Zero is the first language to treat it as a design constraint, not an afterthought.
2. **Fix safety levels** are genuinely useful. This gives agents a natural escalation boundary — apply safe fixes, ask about risky ones.
3. **Capability-based I/O** means security reasoning is local and explicit. You can tell what a program does by reading its signatures.
4. **`zero skills`** serving version-matched agent guidance from the CLI is smart. No stale doc scraping.
5. **`zero fix --plan`** is plan-only. It doesn't auto-edit. The agent applies the fix. That's the right call for trust and safety.
6. **Small binaries.** Hello world at 16.2 KiB. Sub-10 KiB for minimal programs.
7. **Single binary CLI.** No tool fragmentation.
8. **Apache 2.0.** No licensing friction.

## What's Concerning

1. **Pre-1. Explicitly unstable.** They will make breaking changes. Syntax, APIs, CLI — all subject to change. Not for production.
2. **Security vulnerabilities expected.** Their own README says it. Not ready for sensitive data or trusted infrastructure.
3. **32K lines of C.** The compiler is a single monolithic binary. `main.c` alone is ~10K lines. That's a lot of surface area for a v0.1.3 compiler. No formal verification, no memory safety guarantees in the compiler itself.
4. **No async/concurrency model yet.** Systems language without a concurrency story is a gap. Not clear if/when it's coming.
5. **Standard library is thin.** What's there is coherent, but it's early. No TLS, no database, no serialization beyond basic JSON.
6. **No package ecosystem.** `zero.json` manifests exist but there's no registry, no dependency management beyond local paths.
7. **Borrow checker is new.** v0.1.2 rebuilt borrow provenance tracking. v0.1.3 expanded it. It's still baking. Expect edge cases.
8. **Small team.** Mostly @ctate with a few contributors. Bus factor is low.

## Assessment for Us

### Where It Could Help

- **Agent edit loops.** If we wrote tools or scripts in Zero, I get structured diagnostics instead of parsing prose. That's fewer turns wasted on error interpretation.
- **Security reasoning.** Capability-based I/O means I can audit what code can do by reading signatures. No hidden side effects.
- **Small deployment footprint.** Sub-10 KiB binaries are useful for constrained environments (Pi, containers, edge).

### Where It's Not Ready

- **Production systems.** They say it themselves. Not there yet.
- **Anything needing concurrency.** No story yet.
- **Complex I/O.** No TLS, limited networking. Our stack needs more.
- **Interoperability with our current codebase.** C ABI exists but the ecosystem is too young to rely on.

### Recommendation

**Watch closely. Experiment. Don't adopt yet.**

The structured diagnostic / fix-plan paradigm is the real innovation. That concept could inform how we think about agent-friendly tooling even if we don't adopt Zero as a language. The capability model and fix safety taxonomy are design patterns worth studying.

If Zero matures through v0.2-0.3 and stabilizes its borrow checker, adds concurrency, and builds out stdlib, it could become a real option for agent-facing tools and constrained deployments. The Pi Core architecture comes to mind — small native binaries on Pi 5 hardware with explicit I/O boundaries.

## Hands-On Results (2026-05-19)

Installed v0.1.3 locally. Ran the agent repair demo. The structured output is **real**, not marketing fluff.

### Diagnostic Output (broken code)

```json
{
  "severity": "error",
  "code": "TYP009",
  "message": "cannot create MutSpan from immutable array binding",
  "line": 6,
  "column": 32,
  "length": 1,
  "expected": "array binding declared with let mut",
  "actual": "immutable array binding",
  "help": "add mut to the array binding before creating a MutSpan",
  "fixSafety": "behavior-preserving",
  "repair": {
    "id": "make-binding-mutable",
    "summary": "Change the root binding to let mut before passing it to a mutable API."
  }
}
```

That's a single JSON object with everything I need. No parsing. No regex. I read `code` + `repair.id` and act. Done.

### Fix Plan Output

```json
{
  "id": "make-binding-mutable",
  "diagnosticCode": "TYP009",
  "safety": "behavior-preserving",
  "summary": "Change the root binding to let mut before passing it to a mutable API.",
  "appliesEdits": false
}
```

Plan-only. The compiler suggests but doesn't touch files. I apply the fix. That's the right trust boundary.

### Explain Output

```json
{
  "code": "TYP009",
  "category": "type",
  "title": "Mutable storage required",
  "why": "`MutSpan<T>` and `mutref<T>` must come from storage that the source explicitly marks mutable.",
  "repair": { "id": "make-binding-mutable", "summary": "Change the root binding to `let mut`..." },
  "examples": {
    "bad": "let dst: [4]u8 = [0, 0, 0, 0]\nlet _ = std.mem.copy(dst, src)",
    "good": "let mut dst: [4]u8 = [0, 0, 0, 0]\nlet _ = std.mem.copy(dst, src)"
  }
}
```

Bad/good examples in the explain output. That's genuinely helpful for learning a new language.

### Size Output

The `zero size --json` output is extremely detailed: binary sections, function-level byte counts, literal breakdown, stdlib helper costs, profile semantics, runtime shims, even optimization hints. Way more than just "your binary is N bytes."

### Graph Output

The `zero graph --json` output includes: module dependency graph, import edges with source ranges, symbol visibility, function signatures with effects and capabilities, interface fingerprints for incremental compilation, and target capability support. All structured. All machine-readable.

### Verdict on Structured Output

**It works.** This isn't a thin wrapper around text output. The compiler was built JSON-first. Every field is intentional, typed, and stable. The diagnostic codes, repair IDs, and fix safety taxonomy are all real and consistent across commands.

The one thing I noticed: the JSON output can be _verbose_ (the `zero size --json` and `zero check --json` outputs include a lot of compiler-internal metadata). For agent workflows, I'd want to parse just the `diagnostics` and `fixes` fields, not the whole thing. But that's a non-issue — structured data lets you pick what you need.

---

_Reviewed 2026-05-19. Repo at v0.1.3. Hands-on tested with installed binary._
