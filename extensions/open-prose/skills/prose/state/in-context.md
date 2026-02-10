---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
role: in-context-state-management（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  In-context state management using the narration protocol with text markers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  This approach tracks execution state within the conversation history itself.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  The OpenProse VM "thinks aloud" to persist state—what you say becomes what you remember.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
see-also:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - ../prose.md: VM execution semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - filesystem.md: File-system state management (alternative approach)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - sqlite.md: SQLite state management (experimental)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - postgres.md: PostgreSQL state management (experimental)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - ../primitives/session.md: Session context and compaction guidelines（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# In-Context State Management（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This document describes how the OpenProse VM tracks execution state using **structured narration** in the conversation history. This is one of two state management approaches (the other being file-based state in `filesystem.md`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In-context state uses text-prefixed markers to persist state within the conversation. The VM "thinks aloud" about execution—what you say becomes what you remember.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Key principle:** Your conversation history IS the VM's working memory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## When to Use In-Context State（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In-context state is appropriate for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Factor            | In-Context      | Use File-Based Instead |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------- | --------------- | ---------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Statement count   | < 30 statements | >= 30 statements       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Parallel branches | < 5 concurrent  | >= 5 concurrent        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Imported programs | 0-2 imports     | >= 3 imports           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Nested depth      | <= 2 levels     | > 2 levels             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Expected duration | < 5 minutes     | >= 5 minutes           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Announce your state mode at program start:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenProse Program Start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   State mode: in-context (program is small, fits in context)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## The Narration Protocol（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use text-prefixed markers for each state change:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Marker     | Category       | Usage                                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | -------------- | --------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| [Program]  | Program        | Start, end, definition collection       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| [Position] | Position       | Current statement being executed        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| [Binding]  | Binding        | Variable assignment or update           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| [Input]    | Input          | Receiving inputs from caller            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| [Output]   | Output         | Producing outputs for caller            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| [Import]   | Import         | Fetching and invoking imported programs |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| [Success]  | Success        | Session or block completion             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| [Warning]  | Error          | Failures and exceptions                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| [Parallel] | Parallel       | Entering, branch status, joining        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| [Loop]     | Loop           | Iteration, condition evaluation         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| [Pipeline] | Pipeline       | Stage progress                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| [Try]      | Error handling | Try/catch/finally                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| [Flow]     | Flow           | Condition evaluation results            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| [Frame+]   | Call Stack     | Push new frame (block invocation)       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| [Frame-]   | Call Stack     | Pop frame (block completion)            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Narration Patterns by Construct（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Session Statements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Position] Executing: session "Research the topic"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Task tool call]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Success] Session complete: "Research found that..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Binding] let research = <result>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Parallel Blocks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Parallel] Entering parallel block (3 branches, strategy: all)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - security: pending（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - perf: pending（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - style: pending（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Multiple Task calls]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Parallel] Parallel complete:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - security = "No vulnerabilities found..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - perf = "Performance is acceptable..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - style = "Code follows conventions..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Binding] security, perf, style bound（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Loop Blocks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Loop] Starting loop until **task complete** (max: 5)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Loop] Iteration 1 of max 5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Position] session "Work on task"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Success] Session complete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Loop] Evaluating: **task complete**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Flow] Not satisfied, continuing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Loop] Iteration 2 of max 5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Position] session "Work on task"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Success] Session complete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Loop] Evaluating: **task complete**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Flow] Satisfied!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Loop] Loop exited: condition satisfied at iteration 2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Error Handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Try] Entering try block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Position] session "Risky operation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Warning] Session failed: connection timeout（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Binding] err = {message: "connection timeout"}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Try] Executing catch block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Position] session "Handle error" with context: err（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Success] Recovery complete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Try] Executing finally block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Position] session "Cleanup"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Success] Cleanup complete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Variable Bindings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Binding] let research = "AI safety research covers..." (mutable)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Binding] const config = {model: "opus"} (immutable)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Binding] research = "Updated research..." (reassignment, was: "AI safety...")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Input/Output Bindings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Input] Inputs received:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   topic = "quantum computing" (from caller)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   depth = "deep" (from caller)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Output] output findings = "Research shows..." (will return to caller)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Output] output sources = ["arxiv:2401.1234", ...] (will return to caller)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Block Invocation and Call Stack（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Track block invocations with frame markers:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Position] do process(data, 5)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Frame+] Entering block: process (execution_id: 1, depth: 1)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   Arguments: chunk=data, depth=5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Position] session "Split into parts"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      [Task tool call]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Success] Session complete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Binding] let parts = <result> (execution_id: 1)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Position] do process(parts[0], 4)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Frame+] Entering block: process (execution_id: 2, depth: 2)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      Arguments: chunk=parts[0], depth=4（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      Parent: execution_id 1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      [Position] session "Split into parts"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
         [Task tool call]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      [Success] Session complete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      [Binding] let parts = <result> (execution_id: 2)  # Shadows parent's 'parts'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ... (continues recursively)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Frame-] Exiting block: process (execution_id: 2)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Position] session "Combine results"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      [Task tool call]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Success] Session complete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Frame-] Exiting block: process (execution_id: 1)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Key points:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Each `[Frame+]` must have a matching `[Frame-]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `execution_id` uniquely identifies each invocation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `depth` shows call stack depth (1 = first level)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bindings include `(execution_id: N)` to indicate scope（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Nested frames show `Parent: execution_id N` for the scope chain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Scoped Binding Narration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When inside a block invocation, always include the execution_id:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Binding] let result = "computed value" (execution_id: 43)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For variable resolution across scopes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Binding] Resolving 'config': found in execution_id 41 (parent scope)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Program Imports（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Import] Importing: @alice/research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   Fetching from: https://p.prose.md/@alice/research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   Inputs expected: [topic, depth]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   Outputs provided: [findings, sources]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   Registered as: research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Import] Invoking: research(topic: "quantum computing")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Input] Passing inputs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      topic = "quantum computing"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [... imported program execution ...]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Output] Received outputs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      findings = "Quantum computing uses..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sources = ["arxiv:2401.1234"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Import] Import complete: research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Binding] result = { findings: "...", sources: [...] }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Context Serialization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**In-context state passes values, not references.** This is the key difference from file-based and PostgreSQL state. The VM holds binding values directly in conversation history.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When passing context to sessions, format appropriately:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Context Size    | Strategy                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------------- | ----------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| < 2000 chars    | Pass verbatim           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 2000-8000 chars | Summarize to key points |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| > 8000 chars    | Extract essentials only |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Format:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Context provided:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
research: "Key findings about AI safety..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
analysis: "Risk assessment shows..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Limitation:** In-context state cannot support RLM-style "environment as variable" patterns where agents query arbitrarily large bindings. For programs with large intermediate values, use file-based or PostgreSQL state instead.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Complete Execution Trace Example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent researcher:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let research = session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Research AI safety"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  a = session "Analyze risk A"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  b = session "Analyze risk B"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **analysis complete** (max: 3):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Synthesize"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: { a, b, research }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Narration:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Program] Program Start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   Collecting definitions...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Agent: researcher (model: sonnet)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Position] Statement 1: let research = session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   Spawning with prompt: "Research AI safety"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   Model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Task tool call]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Success] Session complete: "AI safety research covers alignment..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Binding] let research = <result>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Position] Statement 2: parallel block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Parallel] Entering parallel (2 branches, strategy: all)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Task: "Analyze risk A"] [Task: "Analyze risk B"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Parallel] Parallel complete:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - a = "Risk A: potential misalignment..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - b = "Risk B: robustness concerns..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Binding] a, b bound（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Position] Statement 3: loop until **analysis complete** (max: 3)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Loop] Starting loop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Loop] Iteration 1 of max 3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Position] session "Synthesize" with context: {a, b, research}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Task with serialized context]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Success] Result: "Initial synthesis shows..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Loop] Evaluating: **analysis complete**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Flow] Not satisfied (synthesis is preliminary)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Loop] Iteration 2 of max 3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Position] session "Synthesize" with context: {a, b, research}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Task with serialized context]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Success] Result: "Comprehensive analysis complete..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Loop] Evaluating: **analysis complete**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Flow] Satisfied!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Loop] Loop exited: condition satisfied at iteration 2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Program] Program Complete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## State Categories（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM must track these state categories in narration:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Category                | What to Track                             | Example                                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | ----------------------------------------- | -------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Import Registry**     | Imported programs and aliases             | `research: @alice/research`                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Agent Registry**      | All agent definitions                     | `researcher: {model: sonnet, prompt: "..."}` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Block Registry**      | All block definitions (hoisted)           | `review: {params: [topic], body: [...]}`     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Input Bindings**      | Inputs received from caller               | `topic = "quantum computing"`                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Output Bindings**     | Outputs to return to caller               | `findings = "Research shows..."`             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Variable Bindings**   | Name -> value mapping (with execution_id) | `result = "..." (execution_id: 3)`           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Variable Mutability** | Which are `let` vs `const` vs `output`    | `research: let, findings: output`            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Execution Position**  | Current statement index                   | Statement 3 of 7                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Loop State**          | Counter, max, condition                   | Iteration 2 of max 5                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Parallel State**      | Branches, results, strategy               | `{a: complete, b: pending}`                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Error State**         | Exception, retry count                    | Retry 2 of 3, error: "timeout"               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Call Stack**          | Stack of execution frames                 | See below                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Call Stack State（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For block invocations, track the full call stack:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[CallStack] Current stack (depth: 3):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   execution_id: 5 | block: process | depth: 3 | status: executing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   execution_id: 3 | block: process | depth: 2 | status: waiting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   execution_id: 1 | block: process | depth: 1 | status: waiting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each frame tracks:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `execution_id`: Unique ID for this invocation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `block`: Name of the block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `depth`: Position in call stack（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `status`: executing, waiting, or completed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Independence from File-Based State（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In-context state and file-based state (`filesystem.md`) are **independent approaches**. You choose one or the other based on program complexity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **In-context**: State lives in conversation history（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **File-based**: State lives in `.prose/runs/{id}/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
They are not designed to be complementary—pick the appropriate mode at program start.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In-context state management:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Uses **text-prefixed markers** to track state changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Persists state in **conversation history**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Is appropriate for **smaller, simpler programs**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Requires **consistent narration** throughout execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Makes state **visible** in the conversation itself（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The narration protocol ensures that the VM can recover its execution state by reading its own prior messages. What you say becomes what you remember.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
