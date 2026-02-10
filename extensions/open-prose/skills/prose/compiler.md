---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
role: language-specification（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Complete syntax grammar, validation rules, and compilation semantics for OpenProse.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Read this file when compiling, validating, or resolving ambiguous syntax. Assumes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prose.md is already in context for execution semantics.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
see-also:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - SKILL.md: Activation triggers, onboarding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - prose.md: Execution semantics, how to run programs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - state/filesystem.md: File-system state management (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - state/in-context.md: In-context state management (on request)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenProse Language Reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenProse is a programming language for AI sessions. An AI session is a Turing-complete computer; this document provides complete documentation for the language syntax, semantics, and execution model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Document Purpose: Compiler + Validator（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This document serves a dual role:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### As Compiler（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When asked to "compile" a `.prose` file, use this specification to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Parse** the program according to the syntax grammar（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Validate** that the program is well-formed and semantically valid（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Transform** the program into "best practice" canonical form:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Expand syntax sugar where appropriate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Normalize formatting and structure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Apply optimizations (e.g., hoisting block definitions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### As Validator（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The validation criterion: **Would a blank agent with only `prose.md` understand this program as self-evident?**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When validating, check:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Syntax correctness (all constructs match grammar)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Semantic validity (references resolve, types match)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Self-evidence (program is clear without this full spec)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If a construct is ambiguous or non-obvious, it should be flagged or transformed into a clearer form.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### When to Read This Document（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Compilation requested**: Read fully to apply all rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Validation requested**: Read fully to check all constraints（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Ambiguous syntax encountered**: Reference specific sections（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Interpretation only**: Use `prose.md` instead (smaller, faster)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Table of Contents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. [Overview](#overview)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. [File Format](#file-format)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. [Comments](#comments)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. [String Literals](#string-literals)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. [Use Statements](#use-statements-program-composition)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. [Input Declarations](#input-declarations)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. [Output Bindings](#output-bindings)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
8. [Program Invocation](#program-invocation)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
9. [Agent Definitions](#agent-definitions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
10. [Session Statement](#session-statement)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
11. [Resume Statement](#resume-statement)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
12. [Variables & Context](#variables--context)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
13. [Composition Blocks](#composition-blocks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
14. [Parallel Blocks](#parallel-blocks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
15. [Fixed Loops](#fixed-loops)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
16. [Unbounded Loops](#unbounded-loops)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
17. [Pipeline Operations](#pipeline-operations)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
18. [Error Handling](#error-handling)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
19. [Choice Blocks](#choice-blocks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
20. [Conditional Statements](#conditional-statements)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
21. [Execution Model](#execution-model)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
22. [Validation Rules](#validation-rules)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
23. [Examples](#examples)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
24. [Future Features](#future-features)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenProse provides a declarative syntax for defining multi-agent workflows. Programs consist of statements that are executed sequentially, with each `session` statement spawning a subagent to complete a task.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Design Principles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Pattern over framework**: The simplest solution is barely anything at all—just structure for English（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Self-evident**: Programs should be understandable with minimal documentation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **The OpenProse VM is intelligent**: Design for understanding, not parsing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Framework-agnostic**: Works with Claude Code, OpenCode, and any future agent framework（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Files are artifacts**: `.prose` is the portable unit of work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Current Implementation Status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The following features are implemented:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Feature                | Status      | Description                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------- | ----------- | -------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Comments               | Implemented | `# comment` syntax                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Single-line strings    | Implemented | `"string"` with escapes                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Simple session         | Implemented | `session "prompt"`                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Agent definitions      | Implemented | `agent name:` with model/prompt properties   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Session with agent     | Implemented | `session: agent` with property overrides     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Use statements         | Implemented | `use "@handle/slug" as name`                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Agent skills           | Implemented | `skills: ["skill1", "skill2"]`               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Agent permissions      | Implemented | `permissions:` block with rules              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Let binding            | Implemented | `let name = session "..."`                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Const binding          | Implemented | `const name = session "..."`                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Variable reassignment  | Implemented | `name = session "..."` (for let only)        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Context property       | Implemented | `context: var` or `context: [a, b, c]`       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| do: blocks             | Implemented | Explicit sequential blocks                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Inline sequence        | Implemented | `session "A" -> session "B"`                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Named blocks           | Implemented | `block name:` with `do name` invocation      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Parallel blocks        | Implemented | `parallel:` for concurrent execution         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Named parallel results | Implemented | `x = session "..."` inside parallel          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Object context         | Implemented | `context: { a, b, c }` shorthand             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Join strategies        | Implemented | `parallel ("first"):` or `parallel ("any"):` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Failure policies       | Implemented | `parallel (on-fail: "continue"):`            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Repeat blocks          | Implemented | `repeat N:` fixed iterations                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Repeat with index      | Implemented | `repeat N as i:` with index variable         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| For-each blocks        | Implemented | `for item in items:` iteration               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| For-each with index    | Implemented | `for item, i in items:` with index           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Parallel for-each      | Implemented | `parallel for item in items:` fan-out        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Unbounded loop         | Implemented | `loop:` with optional max iterations         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Loop until             | Implemented | `loop until **condition**:` AI-evaluated     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Loop while             | Implemented | `loop while **condition**:` AI-evaluated     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Loop with index        | Implemented | `loop as i:` or `loop until ... as i:`       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Map pipeline           | Implemented | `items \| map:` transform each item          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Filter pipeline        | Implemented | `items \| filter:` keep matching items       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Reduce pipeline        | Implemented | `items \| reduce(acc, item):` accumulate     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Parallel map           | Implemented | `items \| pmap:` concurrent transform        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Pipeline chaining      | Implemented | `\| filter: ... \| map: ...`                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Try/catch blocks       | Implemented | `try:` with `catch:` for error handling      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Try/catch/finally      | Implemented | `finally:` for cleanup                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Error variable         | Implemented | `catch as err:` access error context         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Throw statement        | Implemented | `throw` or `throw "message"`                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Retry property         | Implemented | `retry: 3` automatic retry on failure        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Backoff strategy       | Implemented | `backoff: exponential` delay between retries |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Input declarations     | Implemented | `input name: "description"`                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Output bindings        | Implemented | `output name = expression`                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Program invocation     | Implemented | `name(input: value)` call imported programs  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Multi-line strings     | Implemented | `"""..."""` preserving whitespace            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| String interpolation   | Implemented | `"Hello {name}"` variable substitution       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Block parameters       | Implemented | `block name(param):` with parameters         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Block invocation args  | Implemented | `do name(arg)` passing arguments             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Choice blocks          | Implemented | `choice **criteria**: option "label":`       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| If/elif/else           | Implemented | `if **condition**:` conditional branching    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Persistent agents      | Implemented | `persist: true` or `persist: project`        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Resume statement       | Implemented | `resume: agent` to continue with memory      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## File Format（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Property         | Value                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------- | -------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Extension        | `.prose`             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Encoding         | UTF-8                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Case sensitivity | Case-sensitive       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Indentation      | Spaces (Python-like) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Line endings     | LF or CRLF           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Comments（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Comments provide documentation within programs and are ignored during execution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Syntax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# This is a standalone comment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Hello"  # This is an inline comment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Comments begin with `#` and extend to end of line（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Comments can appear on their own line or after a statement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Empty comments are valid: `#`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. The `#` character inside string literals is NOT a comment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Program header comment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Author: Example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Do something"  # Explain what this does（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# This comment is between statements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Do another thing"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Compilation Behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Comments are **stripped during compilation**. The OpenProse VM never sees them. They have no effect on execution and exist purely for human documentation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Important Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Comments inside strings are NOT comments**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Say hello # this is part of the string"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  The `#` inside the string literal is part of the prompt, not a comment.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Comments inside indented blocks are allowed**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agent researcher:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      # This comment is inside the block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  # This comment is outside the block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## String Literals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
String literals represent text values, primarily used for session prompts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Syntax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Strings are enclosed in double quotes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
"This is a string"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Escape Sequences（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The following escape sequences are supported:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Sequence | Meaning      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------- | ------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `\\`     | Backslash    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `\"`     | Double quote |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `\n`     | Newline      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `\t`     | Tab          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Hello world"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Line one\nLine two"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "She said \"hello\""（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Path: C:\\Users\\name"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Column1\tColumn2"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Single-line strings must be properly terminated with a closing `"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Unknown escape sequences are errors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Empty strings `""` are valid but generate a warning when used as prompts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Multi-line Strings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multi-line strings use triple double-quotes (`"""`) and preserve internal whitespace and newlines:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session """（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is a multi-line prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It preserves:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Indentation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Line breaks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - All internal whitespace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
"""（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Multi-line String Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Opening `"""` must be followed by a newline（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Content continues until closing `"""`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Escape sequences work the same as single-line strings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Leading/trailing whitespace inside the delimiters is preserved（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### String Interpolation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Strings can embed variable references using `{varname}` syntax:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let name = session "Get the user's name"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Hello {name}, welcome to the system!"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Interpolation Syntax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Variables are referenced by wrapping the variable name in curly braces: `{varname}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Works in both single-line and multi-line strings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Empty braces `{}` are treated as literal text, not interpolation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Nested braces are not supported（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let research = session "Research the topic"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let analysis = session "Analyze findings"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Single variable interpolation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Based on {research}, provide recommendations"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Multiple interpolations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Combining {research} with {analysis}, synthesize insights"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Multi-line with interpolation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session """（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Review Summary:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Research: {research}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Analysis: {analysis}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Please provide final recommendations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
"""（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Interpolation Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Variable names must be valid identifiers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Referenced variables must be in scope（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Empty braces `{}` are literal text（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Backslash can escape braces: `\{` produces literal `{`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Validation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Check                            | Result  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------------------------- | ------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Unterminated string              | Error   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Unknown escape sequence          | Error   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Empty string as prompt           | Warning |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Undefined interpolation variable | Error   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Use Statements (Program Composition)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use statements import other OpenProse programs from the registry at `p.prose.md`, enabling modular workflows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Syntax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use "@handle/slug"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use "@handle/slug" as alias（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Path Format（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Import paths follow the format `@handle/slug`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `@handle` identifies the program author/organization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `slug` is the program name（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
An optional alias (`as name`) allows referencing by a shorter name.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Import a program（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use "@alice/research"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Import with alias（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use "@bob/critique" as critic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Program URL Resolution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When the OpenProse VM encounters a `use` statement:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Fetch the program from `https://p.prose.md/@handle/slug`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Parse the program to extract its contract (inputs/outputs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Register the program in the Import Registry（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Validation Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Check                 | Severity | Message                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------------------- | -------- | -------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Empty path            | Error    | Use path cannot be empty               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Invalid path format   | Error    | Path must be @handle/slug format       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Duplicate import      | Error    | Program already imported               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Missing alias for dup | Error    | Alias required when importing multiple |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Execution Semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use statements are processed before any agent definitions or sessions. The OpenProse VM:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Fetches and validates all imported programs at the start of execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Extracts input/output contracts from each program（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Registers programs in the Import Registry for later invocation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Input Declarations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inputs declare what values a program expects from its caller.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Syntax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
input name: "description"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
input topic: "The subject to research"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
input depth: "How deep to go (shallow, medium, deep)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inputs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Are declared at the top of the program (before executable statements)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Have a name and a description (for documentation)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Become available as variables within the program body（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Must be provided by the caller when invoking the program（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Validation Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Check                  | Severity | Message                                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------- | -------- | ---------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Empty input name       | Error    | Input name cannot be empty                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Empty description      | Warning  | Consider adding a description                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Duplicate input name   | Error    | Input already declared                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Input after executable | Error    | Inputs must be declared before executable statements |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Output Bindings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Outputs declare what values a program produces for its caller.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Syntax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
output name = expression（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let raw = session "Research {topic}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
output findings = session "Synthesize research"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: raw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
output sources = session "Extract sources"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: raw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `output` keyword:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Marks a variable as an output (visible at assignment, not just at file top)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Works like `let` but also registers the value as a program output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Can appear anywhere in the program body（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multiple outputs are supported（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Validation Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Check                 | Severity | Message                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------------------- | -------- | ----------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Empty output name     | Error    | Output name cannot be empty         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Duplicate output name | Error    | Output already declared             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Output name conflicts | Error    | Output name conflicts with variable |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Program Invocation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Call imported programs by providing their inputs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Syntax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name(input1: value1, input2: value2)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use "@alice/research" as research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let result = research(topic: "quantum computing")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Accessing Outputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The result contains all outputs from the invoked program, accessible as properties:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Write summary"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: result.findings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Cite sources"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: result.sources（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Destructuring Outputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For convenience, outputs can be destructured:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let { findings, sources } = research(topic: "quantum computing")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Execution Semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a program invokes an imported program:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Bind inputs**: Map caller-provided values to the imported program's inputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Execute**: Run the imported program (spawns its own sessions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Collect outputs**: Gather all `output` bindings from the imported program（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Return**: Make outputs available to the caller as a result object（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The imported program runs in its own execution context but shares the same VM session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Validation Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Check                   | Severity | Message                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | -------- | ------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Unknown program         | Error    | Program not imported           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Missing required input  | Error    | Required input not provided    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Unknown input name      | Error    | Input not declared in program  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Unknown output property | Error    | Output not declared in program |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Agent Definitions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Agents are reusable templates that configure subagent behavior. Once defined, agents can be referenced in session statements.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Syntax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent name:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "System prompt for this agent"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  skills: ["skill1", "skill2"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  permissions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    read: ["*.md"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bash: deny（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Properties（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Property      | Type       | Values                       | Description                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------- | ---------- | ---------------------------- | ----------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `model`       | identifier | `sonnet`, `opus`, `haiku`    | The Claude model to use             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prompt`      | string     | Any string                   | System prompt/context for the agent |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `persist`     | value      | `true`, `project`, or STRING | Enable persistent memory for agent  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `skills`      | array      | String array                 | Skills assigned to this agent       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `permissions` | block      | Permission rules             | Access control for the agent        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Persist Property（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `persist` property enables agents to maintain memory across invocations:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Execution-scoped persistence (memory dies with run)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent captain:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  persist: true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You coordinate and review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Project-scoped persistence (memory survives across runs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent advisor:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  persist: project（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You provide architectural guidance"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Custom path persistence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent shared:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  persist: ".prose/custom/shared-agent/"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Shared across programs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Value     | Memory Location                   | Lifetime            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------- | --------------------------------- | ------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `true`    | `.prose/runs/{id}/agents/{name}/` | Dies with execution |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `project` | `.prose/agents/{name}/`           | Survives executions |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| STRING    | Specified path                    | User-controlled     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Skills Property（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `skills` property assigns imported skills to an agent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use "@anthropic/web-search"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use "@anthropic/summarizer" as summarizer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent researcher:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  skills: ["web-search", "summarizer"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Skills must be imported before they can be assigned. Referencing an unimported skill generates a warning.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Permissions Property（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `permissions` property controls agent access:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent secure-agent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  permissions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    read: ["*.md", "*.txt"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    write: ["output/"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bash: deny（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    network: allow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Permission Types（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Type      | Description                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------- | -------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `read`    | Files the agent can read (glob patterns)     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `write`   | Files the agent can write (glob patterns)    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `execute` | Files the agent can execute (glob patterns)  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `bash`    | Shell access: `allow`, `deny`, or `prompt`   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `network` | Network access: `allow`, `deny`, or `prompt` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Permission Values（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Value    | Description                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------- | ------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `allow`  | Permission granted                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `deny`   | Permission denied                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prompt` | Ask user for permission                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Array    | List of allowed patterns (for read/write/execute) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Define a research agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent researcher:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You are a research assistant skilled at finding and synthesizing information"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Define a writing agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent writer:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You are a technical writer who creates clear, concise documentation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Agent with only model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent quick:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: haiku（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Agent with only prompt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent expert:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You are a domain expert"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Agent with skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent web-researcher:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  skills: ["web-search", "summarizer"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Agent with permissions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent file-handler:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  permissions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    read: ["*.md", "*.txt"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    write: ["output/"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bash: deny（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Model Selection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Model    | Use Case                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------- | ------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `haiku`  | Fast, simple tasks; quick responses   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `sonnet` | Balanced performance; general purpose |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `opus`   | Complex reasoning; detailed analysis  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Execution Semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a session references an agent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. The agent's `model` property determines which Claude model is used（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. The agent's `prompt` property is included as system context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Session properties can override agent defaults（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Validation Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Check                 | Severity | Message                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------------------- | -------- | ------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Duplicate agent name  | Error    | Agent already defined          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Invalid model value   | Error    | Must be sonnet, opus, or haiku |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Empty prompt property | Warning  | Consider providing a prompt    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Duplicate property    | Error    | Property already specified     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Session Statement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The session statement is the primary executable construct in OpenProse. It spawns a subagent to complete a task.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Syntax Variants（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Simple Session (with inline prompt)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "prompt text"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Session with Agent Reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: agentName（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Named Session with Agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session sessionName: agentName（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Session with Properties（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: agentName（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Override the agent's default prompt"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus  # Override the agent's model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Property Overrides（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a session references an agent, it can override the agent's properties:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent researcher:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You are a research assistant"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Use researcher with different model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Use researcher with different prompt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Research this specific topic in depth"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Override both（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Specialized research task"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Execution Semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When the OpenProse VM encounters a `session` statement:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Resolve Configuration**: Merge agent defaults with session overrides（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Spawn a Subagent**: Create a new Claude subagent with the resolved configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Send the Prompt**: Pass the prompt string to the subagent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Wait for Completion**: Block until the subagent finishes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Continue**: Proceed to the next statement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Execution Flow Diagram（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenProse VM                    Subagent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    |                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    |  spawn session               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    |----------------------------->|（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    |                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    |  send prompt                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    |----------------------------->|（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    |                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    |  [processing...]             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    |                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    |  session complete            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    |<-----------------------------|（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    |                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    |  continue to next statement  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    v                              v（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Sequential Execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multiple sessions execute sequentially:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "First task"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Second task"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Third task"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each session waits for the previous one to complete before starting.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Using Claude Code's Task Tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To execute a session, use the Task tool:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// Simple session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Task({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  description: "OpenProse session",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "The prompt from the session statement",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  subagent_type: "general-purpose",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
});（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// Session with agent configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Task({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  description: "OpenProse session",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "The session prompt",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  subagent_type: "general-purpose",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: "opus", // From agent or override（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
});（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Validation Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Check                     | Severity | Message                                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------- | -------- | -------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Missing prompt and agent  | Error    | Session requires a prompt or agent reference |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Undefined agent reference | Error    | Agent not defined                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Empty prompt `""`         | Warning  | Session has empty prompt                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Whitespace-only prompt    | Warning  | Session prompt contains only whitespace      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Prompt > 10,000 chars     | Warning  | Consider breaking into smaller tasks         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Duplicate property        | Error    | Property already specified                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Simple session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Hello world"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Session with agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent researcher:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You research topics thoroughly"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Research quantum computing applications"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Named session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session analysis: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Analyze the competitive landscape"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Canonical Form（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The compiled output preserves the structure:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Input:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent researcher:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Do research"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Output:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent researcher:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Do research"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Resume Statement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `resume` statement continues a persistent agent with its accumulated memory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Syntax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
resume: agentName（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Continue from where we left off"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Keyword    | Behavior                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | ------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `session:` | Ignores existing memory, starts fresh |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `resume:`  | Loads memory, continues with context  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent captain:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  persist: true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You coordinate and review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# First invocation - creates memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: captain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Review the plan"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: plan（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Later invocation - loads memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
resume: captain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Review step 1 of the plan"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: step1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Output capture works with resume（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let review = resume: captain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Final review of all steps"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Validation Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Check                                      | Severity | Message                                                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------------------ | -------- | -------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `resume:` on non-persistent agent          | Error    | Agent must have `persist:` property to use `resume:`                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `resume:` with no existing memory          | Error    | No memory file exists for agent; use `session:` for first invocation |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `session:` on persistent agent with memory | Warning  | Will ignore existing memory; use `resume:` to continue               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Undefined agent reference                  | Error    | Agent not defined                                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Variables & Context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Variables allow you to capture the results of sessions and pass them as context to subsequent sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Let Binding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `let` keyword creates a mutable variable bound to a session result:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let research = session "Research the topic thoroughly"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# research now holds the output of that session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Variables can be reassigned:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let draft = session "Write initial draft"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Revise the draft（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
draft = session "Improve the draft"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: draft（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Const Binding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `const` keyword creates an immutable variable:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const config = session "Get configuration settings"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# This would be an error:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# config = session "Try to change"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Context Property（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `context` property passes previous session outputs to a new session:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Single Context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let research = session "Research quantum computing"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Write summary"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Multiple Contexts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let research = session "Research the topic"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let analysis = session "Analyze the findings"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Write final report"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: [research, analysis]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Empty Context (Fresh Start)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use an empty array to start a session without inherited context:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Independent task"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: []（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Object Context Shorthand（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For passing multiple named results (especially from parallel blocks), use object shorthand:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  a = session "Task A"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  b = session "Task B"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Combine results"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: { a, b }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is equivalent to passing an object where each property is a variable reference.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Complete Example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent researcher:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You are a research assistant"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent writer:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You are a technical writer"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Gather research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let research = session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Research quantum computing developments"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Analyze findings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let analysis = session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Analyze the key findings"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Write the final report using both contexts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const report = session: writer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Write a comprehensive report"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: [research, analysis]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Validation Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Check                           | Severity | Message                                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------- | -------- | -------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Duplicate variable name         | Error    | Variable already defined                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Const reassignment              | Error    | Cannot reassign const variable                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Undefined variable reference    | Error    | Undefined variable                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Variable conflicts with agent   | Error    | Variable name conflicts with agent name            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Undefined context variable      | Error    | Undefined variable in context                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Non-identifier in context array | Error    | Context array elements must be variable references |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Flat Namespace Requirement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All variable names must be **unique within a program**. No shadowing is allowed across scopes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**This is a compile error:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let result = session "Outer task"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for item in items:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  let result = session "Inner task"   # Error: 'result' already defined（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: item（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why this constraint:** Since bindings are stored as `bindings/{name}.md`, two variables with the same name would collide on the filesystem. Rather than introduce complex scoping rules, we enforce uniqueness.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Collision scenarios this prevents:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Variable inside loop shadows variable outside loop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Variables in different `if`/`elif`/`else` branches with same name（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Block parameters shadowing outer variables（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Parallel branches reusing outer variable names（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Exception:** Imported programs run in isolated namespaces. A variable `result` in the main program does not collide with `result` in an imported program (they write to different `imports/{handle}--{slug}/bindings/` directories).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Composition Blocks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Composition blocks allow you to structure programs into reusable, named units and express sequences of operations inline.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### do: Block (Anonymous Sequential Block)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `do:` keyword creates an explicit sequential block. All statements in the block execute in order.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Syntax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  statement1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  statement2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Explicit sequential block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Research the topic"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Analyze findings"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Write summary"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Assign result to a variable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let result = do:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Gather data"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Process data"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Block Definitions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Named blocks create reusable workflow components. Define once, invoke multiple times.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Syntax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
block name:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  statement1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  statement2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Invoking Blocks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `do` followed by the block name to invoke a defined block:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do blockname（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Define a review pipeline（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
block review-pipeline:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Security review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Performance review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Synthesize reviews"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Define another block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
block final-check:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Final verification"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Sign off"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Use the blocks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do review-pipeline（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Make fixes based on review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do final-check（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Block Parameters（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Blocks can accept parameters to make them more flexible and reusable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Syntax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
block name(param1, param2):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  # param1 and param2 are available here（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  statement1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  statement2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Invoking with Arguments（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pass arguments when invoking a parameterized block:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do name(arg1, arg2)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Define a parameterized block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
block review(topic):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Research {topic} thoroughly"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Analyze key findings about {topic}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Summarize {topic} analysis"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Invoke with different arguments（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do review("quantum computing")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do review("machine learning")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do review("blockchain")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Multiple Parameters（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
block process-item(item, mode):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Process {item} using {mode} mode"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Verify {item} processing"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do process-item("data.csv", "strict")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do process-item("config.json", "lenient")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Parameter Scope（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Parameters are scoped to the block body（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Parameters shadow outer variables of the same name (with warning)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Parameters are implicitly `const` within the block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Validation Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Check                   | Severity | Message                                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | -------- | ---------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Argument count mismatch | Warning  | Block expects N parameters but got M arguments |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Parameter shadows outer | Warning  | Parameter shadows outer variable               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Inline Sequence (Arrow Operator)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `->` operator chains sessions into a sequence on a single line. This is syntactic sugar for sequential execution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Syntax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "A" -> session "B" -> session "C"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is equivalent to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "A"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "B"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "C"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Quick pipeline（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Plan" -> session "Execute" -> session "Review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Assign result（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let workflow = session "Draft" -> session "Edit" -> session "Finalize"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Block Hoisting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Block definitions are hoisted - you can use a block before it's defined in the source:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Use before definition（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do validation-checks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Definition comes later（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
block validation-checks:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Check syntax"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Check semantics"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Nested Composition（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Blocks and do: blocks can be nested:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
block outer-workflow:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Start"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  do:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Sub-task 1"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Sub-task 2"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "End"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  do outer-workflow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Final step"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Context with Blocks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Blocks work with the context system:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Capture do block result（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let research = do:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Gather information"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Analyze patterns"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Use in subsequent session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Write report"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Validation Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Check                           | Severity | Message                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------- | -------- | ------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Undefined block reference       | Error    | Block not defined                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Duplicate block definition      | Error    | Block already defined                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Block name conflicts with agent | Error    | Block name conflicts with agent name |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Empty block name                | Error    | Block definition must have a name    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Parallel Blocks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Parallel blocks allow multiple sessions to run concurrently. All branches execute simultaneously, and the block waits for all to complete before continuing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Basic Syntax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Security review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Performance review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Style review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All three sessions start at the same time and run concurrently. The program waits for all of them to complete before proceeding.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Named Parallel Results（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Capture the results of parallel branches into variables:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  security = session "Security review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  perf = session "Performance review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  style = session "Style review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These variables can then be used in subsequent sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Object Context Shorthand（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pass multiple parallel results to a session using object shorthand:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  security = session "Security review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  perf = session "Performance review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  style = session "Style review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Synthesize all reviews"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: { security, perf, style }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The object shorthand `{ a, b, c }` is equivalent to passing an object with properties `a`, `b`, and `c` where each property's value is the corresponding variable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Mixed Composition（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Parallel Inside Sequential（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Setup"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Task A"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Task B"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Cleanup"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The setup runs first, then Task A and Task B run in parallel, and finally cleanup runs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Sequential Inside Parallel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  do:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Multi-step task 1a"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Multi-step task 1b"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  do:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Multi-step task 2a"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Multi-step task 2b"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each parallel branch contains a sequential workflow. The two workflows run concurrently.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Assigning Parallel Blocks to Variables（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let results = parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Task A"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Task B"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Complete Example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent reviewer:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Run parallel reviews（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  sec = session: reviewer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    prompt: "Review for security issues"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  perf = session: reviewer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    prompt: "Review for performance issues"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  style = session: reviewer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    prompt: "Review for style issues"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Combine all reviews（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Create unified review report"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: { sec, perf, style }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Join Strategies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, parallel blocks wait for all branches to complete. You can specify alternative join strategies:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### First (Race)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Return as soon as the first branch completes, cancel others:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel ("first"):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Try approach A"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Try approach B"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Try approach C"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The first successful result wins. Other branches are cancelled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Any (N of M)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Return when any N branches complete successfully:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Default: any 1 success（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel ("any"):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Attempt 1"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Attempt 2"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Specific count: wait for 2 successes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel ("any", count: 2):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Attempt 1"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Attempt 2"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Attempt 3"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### All (Default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Wait for all branches to complete:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Implicit - this is the default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Task A"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Task B"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Explicit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel ("all"):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Task A"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Task B"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Failure Policies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Control how the parallel block handles branch failures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Fail-Fast (Default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If any branch fails, fail immediately and cancel other branches:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:  # Implicit fail-fast（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Critical task 1"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Critical task 2"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Explicit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel (on-fail: "fail-fast"):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Critical task 1"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Critical task 2"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Continue（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Let all branches complete, then report all failures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel (on-fail: "continue"):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Task 1"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Task 2"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Task 3"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Continue regardless of which branches failed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Process results, including failures"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Ignore（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Ignore all failures, always succeed:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel (on-fail: "ignore"):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Optional enrichment 1"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Optional enrichment 2"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# This always runs, even if all branches failed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Continue regardless"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Combining Modifiers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Join strategies and failure policies can be combined:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Race with resilience（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel ("first", on-fail: "continue"):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Fast but unreliable"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Slow but reliable"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Get any 2 results, ignoring failures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel ("any", count: 2, on-fail: "ignore"):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Approach 1"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Approach 2"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Approach 3"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Approach 4"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Execution Semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When the OpenProse VM encounters a `parallel:` block:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Fork**: Start all branches concurrently（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Execute**: Each branch runs independently（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Join**: Wait according to join strategy:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `"all"` (default): Wait for all branches（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `"first"`: Return on first completion（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `"any"`: Return on first success (or N successes with `count`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Handle failures**: According to on-fail policy:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `"fail-fast"` (default): Cancel remaining and fail immediately（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `"continue"`: Wait for all, then report failures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `"ignore"`: Treat failures as successes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Continue**: Proceed to the next statement with available results（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Validation Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Check                                | Severity | Message                                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------------ | -------- | -------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Invalid join strategy                | Error    | Must be "all", "first", or "any"             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Invalid on-fail policy               | Error    | Must be "fail-fast", "continue", or "ignore" |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Count without "any"                  | Error    | Count is only valid with "any" strategy      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Count less than 1                    | Error    | Count must be at least 1                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Count exceeds branches               | Warning  | Count exceeds number of parallel branches    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Duplicate variable in parallel       | Error    | Variable already defined                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Variable conflicts with agent        | Error    | Variable name conflicts with agent name      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Undefined variable in object context | Error    | Undefined variable in context                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Fixed Loops（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fixed loops provide bounded iteration over a set number of times or over a collection.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Repeat Block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `repeat` block executes its body a fixed number of times.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Basic Syntax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
repeat 3:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Generate a creative idea"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### With Index Variable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Access the current iteration index using `as`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
repeat 5 as i:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Process item"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: i（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The index variable `i` is scoped to the loop body and starts at 0.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### For-Each Block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `for` block iterates over a collection.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Basic Syntax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let fruits = ["apple", "banana", "cherry"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for fruit in fruits:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Describe this fruit"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: fruit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### With Inline Array（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for topic in ["AI", "climate", "space"]:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Research this topic"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: topic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### With Index Variable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Access both the item and its index:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let items = ["a", "b", "c"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for item, i in items:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Process item with index"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: [item, i]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Parallel For-Each（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `parallel for` block runs all iterations concurrently (fan-out pattern):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let topics = ["AI", "climate", "space"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel for topic in topics:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Research this topic"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: topic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Combine all research"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is equivalent to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Research AI" context: "AI"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Research climate" context: "climate"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Research space" context: "space"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
But more concise and dynamic.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Variable Scoping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Loop variables are scoped to the loop body:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- They are implicitly `const` within each iteration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- They shadow outer variables of the same name (with a warning)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- They are not accessible outside the loop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let item = session "outer"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for item in ["a", "b"]:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  # 'item' here is the loop variable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "process loop item"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: item（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 'item' here refers to the outer variable again（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "use outer item"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: item（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Nesting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Loops can be nested:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
repeat 2:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  repeat 3:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Inner task"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Different loop types can be combined:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let items = ["a", "b"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
repeat 2:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  for item in items:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Process item"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      context: item（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Complete Example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Generate multiple variations of ideas（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
repeat 3:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Generate a creative startup idea"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Select the best idea from the options above"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Research the selected idea from multiple angles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let angles = ["market", "technology", "competition"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel for angle in angles:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Research this angle of the startup idea"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: angle（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Synthesize all research into a business plan"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Validation Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Check                         | Severity | Message                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------------- | -------- | ------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Repeat count must be positive | Error    | Repeat count must be positive        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Repeat count must be integer  | Error    | Repeat count must be an integer      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Undefined collection variable | Error    | Undefined collection variable        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Loop variable shadows outer   | Warning  | Loop variable shadows outer variable |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Unbounded Loops（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Unbounded loops provide iteration with AI-evaluated termination conditions. Unlike fixed loops, the iteration count is not known ahead of time - the OpenProse VM evaluates conditions at runtime using its intelligence to determine when to stop.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Discretion Markers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Unbounded loops use **discretion markers** (`**...**`) to wrap AI-evaluated conditions. These markers signal that the enclosed text should be interpreted intelligently by the OpenProse VM at runtime, not as a literal boolean expression.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# The text inside **...** is evaluated by the AI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **the poem has vivid imagery and flows smoothly**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Review and improve the poem"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For multi-line conditions, use triple-asterisks:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until ***（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  the document is complete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  all sections have been reviewed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  and formatting is consistent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
***:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Continue working on the document"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Basic Loop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The simplest unbounded loop runs indefinitely until explicitly limited:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Process next item"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Warning**: Loops without termination conditions or max iterations generate a warning. Always include a safety limit:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop (max: 50):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Process next item"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Loop Until（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `loop until` variant runs until a condition becomes true:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **the task is complete**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Continue working on the task"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The OpenProse VM evaluates the discretion condition after each iteration and exits when it determines the condition is satisfied.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Loop While（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `loop while` variant runs while a condition remains true:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop while **there are still items to process**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Process the next item"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Semantically, `loop while **X**` is equivalent to `loop until **not X**`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Iteration Variable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Track the current iteration number using `as`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **done** as attempt:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Try approach"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: attempt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The iteration variable:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Starts at 0（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Increments by 1 each iteration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Is scoped to the loop body（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Is implicitly `const` within each iteration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Safety Limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Specify maximum iterations with `(max: N)`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Stop after 10 iterations even if condition not met（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **all bugs fixed** (max: 10):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Find and fix a bug"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The loop exits when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. The condition is satisfied (for `until`/`while` variants), OR（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. The maximum iteration count is reached（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Complete Syntax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All options can be combined:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **condition** (max: N) as i:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  body...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Order matters: condition comes before modifiers, modifiers before `as`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Iterative Improvement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Write an initial draft"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **the draft is polished and ready for review** (max: 5):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Review the current draft and identify issues"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Revise the draft to address the issues"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Present the final draft"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Debugging Workflow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Run tests to identify failures"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **all tests pass** (max: 20) as attempt:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Identify the failing test"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Fix the bug causing the failure"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Run tests again"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Confirm all tests pass and summarize fixes"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Consensus Building（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  opinion1 = session "Get first expert opinion"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  opinion2 = session "Get second expert opinion"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **experts have reached consensus** (max: 5):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Identify points of disagreement"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: { opinion1, opinion2 }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Facilitate discussion to resolve differences"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Document the final consensus"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Quality Threshold（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let draft = session "Create initial document"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop while **quality score is below threshold** (max: 10):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  draft = session "Review and improve the document"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: draft（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Calculate new quality score"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Finalize the document"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: draft（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Execution Semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When the OpenProse VM encounters an unbounded loop:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Initialize**: Set iteration counter to 0（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Check Condition** (for `until`/`while`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - For `until`: Exit if condition is satisfied（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - For `while`: Exit if condition is NOT satisfied（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Check Limit**: Exit if iteration count >= max iterations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Execute Body**: Run all statements in the loop body（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Increment**: Increase iteration counter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **Repeat**: Go to step 2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For basic `loop:` without conditions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Only the max iteration limit can cause exit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Without max, the loop runs indefinitely (warning issued)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Condition Evaluation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The OpenProse VM uses its intelligence to evaluate discretion conditions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Context Awareness**: The condition is evaluated in the context of what has happened so far in the session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Semantic Understanding**: The condition text is interpreted semantically, not literally（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Uncertainty Handling**: When uncertain, the OpenProse VM may:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Continue iterating if progress is being made（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Exit early if diminishing returns are detected（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Use heuristics based on the condition's semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Nesting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Unbounded loops can be nested with other loop types:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Unbounded inside fixed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
repeat 3:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  loop until **sub-task complete** (max: 10):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Work on sub-task"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Fixed inside unbounded（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **all batches processed** (max: 5):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  repeat 3:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Process batch item"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Multiple unbounded（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **outer condition** (max: 5):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  loop until **inner condition** (max: 10):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Deep iteration"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Variable Scoping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Loop variables follow the same scoping rules as fixed loops:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let i = session "outer"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **done** as i:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  # 'i' here is the loop variable (shadows outer)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "use loop i"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: i（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 'i' here refers to the outer variable again（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "use outer i"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: i（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Validation Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Check                         | Severity | Message                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------------- | -------- | ------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Loop without max or condition | Warning  | Unbounded loop without max iterations |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Max iterations <= 0           | Error    | Max iterations must be positive       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Max iterations not integer    | Error    | Max iterations must be an integer     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Empty discretion condition    | Error    | Discretion condition cannot be empty  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Very short condition          | Warning  | Discretion condition may be ambiguous |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Loop variable shadows outer   | Warning  | Loop variable shadows outer variable  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pipeline Operations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pipeline operations provide functional-style collection transformations. They allow you to chain operations like map, filter, and reduce using the pipe operator (`|`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Pipe Operator（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The pipe operator (`|`) passes a collection to a transformation operation:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let items = ["a", "b", "c"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let results = items | map:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Process this item"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: item（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Map（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `map` operation transforms each element in a collection:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let articles = ["article1", "article2", "article3"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let summaries = articles | map:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Summarize this article in one sentence"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: item（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inside a map body, the implicit variable `item` refers to the current element being processed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Filter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `filter` operation keeps elements that match a condition:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let items = ["one", "two", "three", "four", "five"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let short = items | filter:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Does this word have 4 or fewer letters? Answer yes or no."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: item（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The session in a filter body should return something the OpenProse VM can interpret as truthy/falsy (like "yes"/"no").（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Reduce（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `reduce` operation accumulates elements into a single result:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let ideas = ["AI assistant", "smart home", "health tracker"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let combined = ideas | reduce(summary, idea):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Add this idea to the summary, creating a cohesive concept"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: [summary, idea]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The reduce operation requires explicit variable names:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- First variable (`summary`): the accumulator（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Second variable (`idea`): the current item（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The first item in the collection becomes the initial accumulator value.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Parallel Map (pmap)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `pmap` operation is like `map` but runs all transformations concurrently:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let tasks = ["task1", "task2", "task3"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let results = tasks | pmap:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Process this task in parallel"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: item（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Aggregate all results"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: results（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is similar to `parallel for`, but in pipeline syntax.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Chaining（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pipeline operations can be chained to compose complex transformations:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let topics = ["quantum computing", "blockchain", "machine learning", "IoT"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let result = topics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  | filter:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      session "Is this topic trending? Answer yes or no."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        context: item（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  | map:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      session "Write a one-line startup pitch for this topic"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        context: item（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Present the startup pitches"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: result（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Operations execute left-to-right: first filter, then map.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Complete Example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Define a collection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let articles = ["AI breakthroughs", "Climate solutions", "Space exploration"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Process with chained operations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let summaries = articles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  | filter:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      session "Is this topic relevant to technology? Answer yes or no."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        context: item（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  | map:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      session "Write a compelling one-paragraph summary"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        context: item（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  | reduce(combined, summary):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      session "Merge this summary into the combined document"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        context: [combined, summary]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Present the final result（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Format and present the combined summaries"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: summaries（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Implicit Variables（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Operation | Available Variables                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------- | -------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `map`     | `item` - current element                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `filter`  | `item` - current element                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `pmap`    | `item` - current element                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `reduce`  | Named explicitly: `reduce(accVar, itemVar):` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Execution Semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When the OpenProse VM encounters a pipeline:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Input**: Start with the input collection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **For each operation**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **map**: Transform each element, producing a new collection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **filter**: Keep elements where the session returns truthy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **reduce**: Accumulate elements into a single value（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **pmap**: Transform all elements concurrently（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Output**: Return the final transformed collection/value（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Variable Scoping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pipeline variables are scoped to their operation body:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let item = "outer"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let items = ["a", "b"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let results = items | map:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  # 'item' here is the pipeline variable (shadows outer)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "process"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: item（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 'item' here refers to the outer variable again（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "use outer"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: item（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Validation Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Check                           | Severity | Message                                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------- | -------- | -------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Undefined input collection      | Error    | Undefined collection variable                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Invalid pipe operator           | Error    | Expected pipe operator (map, filter, reduce, pmap) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Reduce without variables        | Error    | Expected accumulator and item variables            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Pipeline variable shadows outer | Warning  | Implicit/explicit variable shadows outer variable  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Error Handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenProse provides structured error handling with try/catch/finally blocks, throw statements, and retry mechanisms for resilient workflows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Try/Catch Blocks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `try:` block wraps operations that might fail. The `catch:` block handles errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Attempt risky operation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
catch:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Handle the error gracefully"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Error Variable Access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `catch as err:` to capture error context for the error handler:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Call external API"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
catch as err:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Log and handle the error"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: err（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The error variable (`err`) contains contextual information about what went wrong and is only accessible within the catch block.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Try/Catch/Finally（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `finally:` block always executes, whether the try block succeeds or fails:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Acquire and use resource"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
catch:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Handle any errors"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
finally:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Always clean up resource"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Execution Order（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Try succeeds**: try body → finally body（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Try fails**: try body (until failure) → catch body → finally body（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Try/Finally (No Catch)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For cleanup without error handling, use try/finally:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Open connection and do work"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
finally:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Close connection"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Throw Statement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `throw` statement raises or re-raises errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Rethrow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inside a catch block, `throw` without arguments re-raises the caught error to outer handlers:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Inner operation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  catch:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Partial handling"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    throw  # Re-raise to outer handler（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
catch:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Handle re-raised error"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Throw with Message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Throw a new error with a custom message:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Check preconditions"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
throw "Precondition not met"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Nested Error Handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Try blocks can be nested. Inner catch blocks don't trigger outer handlers unless they rethrow:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Outer operation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Inner risky operation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  catch:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Handle inner error"  # Outer catch won't run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Continue outer operation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
catch:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Handle outer error only"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Error Handling in Parallel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each parallel branch can have its own error handling:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Branch A might fail"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  catch:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Recover branch A"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Branch B might fail"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  catch:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Recover branch B"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Continue with recovered results"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This differs from the `on-fail:` policy which controls behavior when unhandled errors occur.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Retry Property（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `retry:` property makes a session automatically retry on failure:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Call flaky API"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  retry: 3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Retry with Backoff（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add `backoff:` to control delay between retries:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Rate-limited API"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  retry: 5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  backoff: exponential（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Backoff Strategies:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Strategy      | Behavior                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------- | ---------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `none`        | Immediate retry (default)          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `linear`      | Fixed delay between retries        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `exponential` | Doubling delay (1s, 2s, 4s, 8s...) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Retry with Context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Retry works with other session properties:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let data = session "Get input"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Process data"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: data（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  retry: 3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  backoff: linear（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Combining Patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Retry and try/catch work together for maximum resilience:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Call external service"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    retry: 3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    backoff: exponential（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
catch:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "All retries failed, use fallback"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Validation Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Check                        | Severity | Message                                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------------- | -------- | --------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Try without catch or finally | Error    | Try block must have at least "catch:" or "finally:" |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Error variable shadows outer | Warning  | Error variable shadows outer variable               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Empty throw message          | Warning  | Throw message is empty                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Non-positive retry count     | Error    | Retry count must be positive                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Non-integer retry count      | Error    | Retry count must be an integer                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| High retry count (>10)       | Warning  | Retry count is unusually high                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Invalid backoff strategy     | Error    | Must be none, linear, or exponential                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Retry on agent definition    | Warning  | Retry property is only valid in session statements  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Syntax Reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
try_block ::= "try" ":" NEWLINE INDENT statement+ DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              [catch_block]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              [finally_block]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
catch_block ::= "catch" ["as" identifier] ":" NEWLINE INDENT statement+ DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
finally_block ::= "finally" ":" NEWLINE INDENT statement+ DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
throw_statement ::= "throw" [string_literal]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
retry_property ::= "retry" ":" number_literal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backoff_property ::= "backoff" ":" ( "none" | "linear" | "exponential" )（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Choice Blocks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Choice blocks allow the OpenProse VM to select from multiple labeled options based on criteria. This is useful for branching workflows where the best path depends on runtime analysis.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Syntax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
choice **criteria**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Label A":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    statements...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Label B":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    statements...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Criteria（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The criteria is wrapped in discretion markers (`**...**`) and is evaluated by the OpenProse VM to select which option to execute:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
choice **the best approach for the current situation**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Quick fix":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Apply a quick temporary fix"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Full refactor":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Perform a complete code refactor"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Multi-line Criteria（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For complex criteria, use triple-asterisks:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
choice ***（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  which strategy is most appropriate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  given the current project constraints（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  and timeline requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
***:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "MVP approach":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Build minimum viable product"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Full feature set":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Build complete feature set"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Simple Choice（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let analysis = session "Analyze the code quality"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
choice **the severity of issues found in the analysis**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Critical":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Stop deployment and fix critical issues"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      context: analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Minor":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Log issues for later and proceed"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      context: analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "None":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Proceed with deployment"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Choice with Multiple Statements per Option（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
choice **the user's experience level**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Beginner":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Explain basic concepts first"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Provide step-by-step guidance"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Include helpful tips and warnings"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Expert":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Provide concise technical summary"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Include advanced configuration options"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Nested Choices（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
choice **the type of request**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Bug report":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    choice **the bug severity**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      option "Critical":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        session "Escalate immediately"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      option "Normal":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        session "Add to sprint backlog"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Feature request":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Add to feature backlog"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Execution Semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When the OpenProse VM encounters a `choice` block:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Evaluate Criteria**: Interpret the discretion criteria in current context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Select Option**: Choose the most appropriate labeled option（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Execute**: Run all statements in the selected option's body（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Continue**: Proceed to the next statement after the choice block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Only one option is executed per choice block.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Validation Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Check                   | Severity | Message                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | -------- | ------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Choice without options  | Error    | Choice block must have at least one option |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Empty criteria          | Error    | Choice criteria cannot be empty            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Duplicate option labels | Warning  | Duplicate option label                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Empty option body       | Warning  | Option has empty body                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Syntax Reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
choice_block ::= "choice" discretion ":" NEWLINE INDENT option+ DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
option ::= "option" string ":" NEWLINE INDENT statement+ DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
discretion ::= "**" text "**" | "***" text "***"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Conditional Statements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If/elif/else statements provide conditional branching based on AI-evaluated conditions using discretion markers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### If Statement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if **condition**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  statements...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### If/Else（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if **condition**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  statements...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  statements...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### If/Elif/Else（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if **first condition**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  statements...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
elif **second condition**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  statements...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
elif **third condition**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  statements...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  statements...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Discretion Conditions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Conditions are wrapped in discretion markers (`**...**`) for AI evaluation:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let analysis = session "Analyze the codebase"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if **the code has security vulnerabilities**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Fix security issues immediately"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
elif **the code has performance issues**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Optimize performance bottlenecks"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Proceed with normal review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Multi-line Conditions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use triple-asterisks for complex conditions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if ***（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  the test suite passes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  and the code coverage is above 80%（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  and there are no linting errors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
***:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Deploy to production"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Fix issues before deploying"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Simple If（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Check system health"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if **the system is healthy**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Continue with normal operations"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### If/Else（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let review = session "Review the pull request"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if **the code changes are safe and well-tested**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Approve and merge the PR"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: review（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Request changes"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: review（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Multiple Elif（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let status = session "Check project status"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if **the project is on track**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Continue as planned"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
elif **the project is slightly delayed**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Adjust timeline and communicate"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
elif **the project is significantly delayed**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Escalate to management"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Create recovery plan"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Assess project viability"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Nested Conditionals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if **the request is authenticated**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  if **the user has admin privileges**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Process admin request"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  else:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Process standard user request"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Return authentication error"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Combining with Other Constructs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### With Try/Catch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Attempt operation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  if **operation succeeded partially**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Complete remaining steps"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
catch as err:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  if **error is recoverable**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Apply recovery procedure"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      context: err（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  else:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    throw "Unrecoverable error"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### With Loops（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **task complete** (max: 10):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Work on task"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  if **encountered blocker**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Resolve blocker"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Execution Semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When the OpenProse VM encounters an `if` statement:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Evaluate Condition**: Interpret the first discretion condition（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **If True**: Execute the then-body and skip remaining clauses（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **If False**: Check each `elif` condition in order（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Elif Match**: Execute that elif's body and skip remaining（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **No Match**: Execute the `else` body (if present)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **Continue**: Proceed to the next statement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Validation Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Check           | Severity | Message                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------------- | -------- | --------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Empty condition | Error    | If/elif condition cannot be empty |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Elif without if | Error    | Elif must follow if               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Else without if | Error    | Else must follow if or elif       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Multiple else   | Error    | Only one else clause allowed      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Empty body      | Warning  | Condition has empty body          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Syntax Reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if_statement ::= "if" discretion ":" NEWLINE INDENT statement+ DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                 elif_clause*（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                 [else_clause]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
elif_clause ::= "elif" discretion ":" NEWLINE INDENT statement+ DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else_clause ::= "else" ":" NEWLINE INDENT statement+ DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
discretion ::= "**" text "**" | "***" text "***"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Execution Model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenProse uses a two-phase execution model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Phase 1: Compilation (Static)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The compile phase handles deterministic preprocessing:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Parse**: Convert source code to AST（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Validate**: Check for syntax and semantic errors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Expand**: Normalize syntax sugar (when implemented)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Output**: Generate canonical program（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Phase 2: Runtime (Intelligent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The OpenProse VM executes the compiled program:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Load**: Receive the compiled program（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Collect Agents**: Register all agent definitions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Execute**: Process each statement in order（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Spawn**: Create subagents with resolved configurations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Coordinate**: Manage context passing between sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### OpenProse VM Behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Aspect               | Behavior                                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------------- | ----------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Execution order      | Strict - follows program exactly                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Session creation     | Strict - creates what program specifies         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Agent resolution     | Strict - merge properties deterministically     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Context passing      | Intelligent - summarizes/transforms as needed   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Completion detection | Intelligent - determines when session is "done" |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### State Management（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For the current implementation, state is tracked in-context (conversation history):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| State Type          | Tracking Approach                                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------- | --------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Agent definitions   | Collected at program start                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Execution flow      | Implicit reasoning ("completed X, now executing Y") |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Session outputs     | Held in conversation history                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Position in program | Tracked by OpenProse VM                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Validation Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The validator checks programs for errors and warnings before execution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Errors (Block Execution)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Code | Description                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---- | ---------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E001 | Unterminated string literal              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E002 | Unknown escape sequence in string        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E003 | Session missing prompt or agent          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E004 | Unexpected token                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E005 | Invalid syntax                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E006 | Duplicate agent definition               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E007 | Undefined agent reference                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E008 | Invalid model value                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E009 | Duplicate property                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E010 | Duplicate use statement                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E011 | Empty use path                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E012 | Invalid use path format                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E013 | Skills must be an array                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E014 | Skill name must be a string              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E015 | Permissions must be a block              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E016 | Permission pattern must be a string      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E017 | `resume:` requires persistent agent      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E018 | `resume:` with no existing memory        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E019 | Duplicate variable name (flat namespace) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E020 | Empty input name                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E021 | Duplicate input declaration              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E022 | Input after executable statement         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E023 | Empty output name                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E024 | Duplicate output declaration             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E025 | Unknown program in invocation            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E026 | Missing required input                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E027 | Unknown input name in invocation         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E028 | Unknown output property access           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Warnings (Non-blocking)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Code | Description                                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---- | --------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| W001 | Empty session prompt                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| W002 | Whitespace-only session prompt                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| W003 | Session prompt exceeds 10,000 characters            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| W004 | Empty prompt property                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| W005 | Unknown property name                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| W006 | Unknown import source format                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| W007 | Skill not imported                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| W008 | Unknown permission type                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| W009 | Unknown permission value                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| W010 | Empty skills array                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| W011 | `session:` on persistent agent with existing memory |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Error Message Format（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Errors include location information:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Error at line 5, column 12: Unterminated string literal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Hello（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ^（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Minimal Program（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Hello world"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Research Pipeline with Agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Define specialized agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent researcher:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You are a research assistant"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent writer:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You are a technical writer"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Execute workflow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Research recent developments in quantum computing"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: writer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Write a summary of the research findings"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Code Review Workflow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent reviewer:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You are an expert code reviewer"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: reviewer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Read the code in src/ and identify potential bugs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: reviewer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Suggest fixes for each bug found"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: reviewer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Create a summary of all changes needed"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Multi-step Task with Model Override（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent analyst:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: haiku（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You analyze data quickly"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Quick initial analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: analyst（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Scan the data for obvious patterns"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Detailed analysis with more powerful model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: analyst（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Perform deep analysis on the patterns found"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Comments for Documentation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Project: Quarterly Report Generator（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Author: Team Lead（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Date: 2024-01-01（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent data-collector:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You gather and organize data"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent analyst:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You analyze data and create insights"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Step 1: Gather data（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: data-collector（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Collect all sales data from the past quarter"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Step 2: Analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: analyst（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Perform trend analysis on the collected data"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Step 3: Report generation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: analyst（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Generate a formatted quarterly report with charts"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Workflow with Skills and Permissions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Import external programs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use "@anthropic/web-search"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use "@anthropic/file-writer" as file-writer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Define a secure research agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent researcher:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You are a research assistant"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  skills: ["web-search"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  permissions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    read: ["*.md", "*.txt"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bash: deny（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Define a writer agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent writer:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You create documentation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  skills: ["file-writer"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  permissions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    write: ["docs/"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bash: deny（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Execute workflow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Research AI safety topics"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: writer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Write a summary document"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Future Features（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All core features through Tier 12 have been implemented. Potential future enhancements:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tier 13: Extended Features（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Custom functions with return values（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Module system for code organization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Type annotations for validation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Async/await patterns for advanced concurrency（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tier 14: Tooling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Language server protocol (LSP) support（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- VS Code extension（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Interactive debugger（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Performance profiling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Syntax Grammar (Implemented)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
program     → statement* EOF（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
statement   → useStatement | inputDecl | agentDef | session | resumeStmt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            | letBinding | constBinding | assignment | outputBinding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            | parallelBlock | repeatBlock | forEachBlock | loopBlock（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            | tryBlock | choiceBlock | ifStatement | doBlock | blockDef（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            | throwStatement | comment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Program Composition（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
useStatement → "use" string ( "as" IDENTIFIER )?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
inputDecl   → "input" IDENTIFIER ":" string（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
outputBinding → "output" IDENTIFIER "=" expression（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
programCall → IDENTIFIER "(" ( IDENTIFIER ":" expression )* ")"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Definitions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agentDef    → "agent" IDENTIFIER ":" NEWLINE INDENT agentProperty* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agentProperty → "model:" ( "sonnet" | "opus" | "haiku" )（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              | "prompt:" string（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              | "persist:" ( "true" | "project" | string )（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              | "context:" ( IDENTIFIER | array | objectContext )（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              | "retry:" NUMBER（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              | "backoff:" ( "none" | "linear" | "exponential" )（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              | "skills:" "[" string* "]"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              | "permissions:" NEWLINE INDENT permission* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
blockDef    → "block" IDENTIFIER params? ":" NEWLINE INDENT statement* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
params      → "(" IDENTIFIER ( "," IDENTIFIER )* ")"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Control Flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallelBlock → "parallel" parallelMods? ":" NEWLINE INDENT parallelBranch* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallelMods  → "(" ( joinStrategy | onFail | countMod ) ( "," ( joinStrategy | onFail | countMod ) )* ")"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
joinStrategy  → string                              # "all" | "first" | "any"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
onFail        → "on-fail" ":" string                # "fail-fast" | "continue" | "ignore"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
countMod      → "count" ":" NUMBER                  # only valid with "any"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallelBranch → ( IDENTIFIER "=" )? statement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Loops（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
repeatBlock → "repeat" NUMBER ( "as" IDENTIFIER )? ":" NEWLINE INDENT statement* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
forEachBlock → "parallel"? "for" IDENTIFIER ( "," IDENTIFIER )? "in" collection ":" NEWLINE INDENT statement* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loopBlock   → "loop" ( ( "until" | "while" ) discretion )? loopMods? ( "as" IDENTIFIER )? ":" NEWLINE INDENT statement* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loopMods    → "(" "max" ":" NUMBER ")"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Error Handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tryBlock    → "try" ":" NEWLINE INDENT statement+ DEDENT catchBlock? finallyBlock?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
catchBlock  → "catch" ( "as" IDENTIFIER )? ":" NEWLINE INDENT statement+ DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
finallyBlock → "finally" ":" NEWLINE INDENT statement+ DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
throwStatement → "throw" string?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Conditionals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
choiceBlock → "choice" discretion ":" NEWLINE INDENT choiceOption+ DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
choiceOption → "option" string ":" NEWLINE INDENT statement+ DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ifStatement → "if" discretion ":" NEWLINE INDENT statement+ DEDENT elifClause* elseClause?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
elifClause  → "elif" discretion ":" NEWLINE INDENT statement+ DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
elseClause  → "else" ":" NEWLINE INDENT statement+ DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Composition（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
doBlock     → "do" ( ":" NEWLINE INDENT statement* DEDENT | IDENTIFIER args? )（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
args        → "(" expression ( "," expression )* ")"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
arrowExpr   → session ( "->" session )+（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session     → "session" ( string | ":" IDENTIFIER | IDENTIFIER ":" IDENTIFIER )（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              ( NEWLINE INDENT sessionProperty* DEDENT )?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
resumeStmt  → "resume" ":" IDENTIFIER ( NEWLINE INDENT sessionProperty* DEDENT )?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sessionProperty → "model:" ( "sonnet" | "opus" | "haiku" )（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                | "prompt:" string（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                | "context:" ( IDENTIFIER | array | objectContext )（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                | "retry:" NUMBER（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                | "backoff:" ( "none" | "linear" | "exponential" )（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bindings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
letBinding  → "let" IDENTIFIER "=" expression（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
constBinding → "const" IDENTIFIER "=" expression（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
assignment  → IDENTIFIER "=" expression（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Expressions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
expression  → session | doBlock | parallelBlock | repeatBlock | forEachBlock（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            | loopBlock | arrowExpr | pipeExpr | programCall | string | IDENTIFIER | array | objectContext（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Pipelines（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pipeExpr    → ( IDENTIFIER | array ) ( "|" pipeOp )+（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pipeOp      → ( "map" | "filter" | "pmap" ) ":" NEWLINE INDENT statement* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            | "reduce" "(" IDENTIFIER "," IDENTIFIER ")" ":" NEWLINE INDENT statement* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Properties（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
property    → ( "model" | "prompt" | "context" | "retry" | "backoff" | IDENTIFIER )（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            ":" ( IDENTIFIER | string | array | objectContext | NUMBER )（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Primitives（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
discretion  → "**" text "**" | "***" text "***"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
collection  → IDENTIFIER | array（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
array       → "[" ( expression ( "," expression )* )? "]"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
objectContext → "{" ( IDENTIFIER ( "," IDENTIFIER )* )? "}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
comment     → "#" text NEWLINE（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Strings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
string      → singleString | tripleString | interpolatedString（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
singleString → '"' character* '"'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tripleString → '"""' ( character | NEWLINE )* '"""'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
interpolatedString → string containing "{" IDENTIFIER "}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
character   → escape | non-quote（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
escape      → "\\" | "\"" | "\n" | "\t"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Compiler API（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a user invokes `/prose-compile` or asks you to compile a `.prose` file:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Read this document** (`compiler.md`) fully to understand all syntax and validation rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Parse** the program according to the syntax grammar（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Validate** syntax correctness, semantic validity, and self-evidence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Transform** to canonical form (expand syntax sugar, normalize structure)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Output** the compiled program or report errors/warnings with line numbers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For direct interpretation without compilation, read `prose.md` and execute statements as described in the Session Statement section.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
