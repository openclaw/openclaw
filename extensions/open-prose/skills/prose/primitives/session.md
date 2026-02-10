---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
role: session-context-management（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Guidelines for subagents on context handling, state management, and memory compaction.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  This file is loaded into all subagent sessions at start time to ensure consistent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  behavior around state persistence and context flow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
see-also:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - ../prose.md: VM execution semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - ../compiler.md: Full language specification（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - ../state/filesystem.md: File-system state management (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - ../state/in-context.md: In-context state management (on request)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - ../state/sqlite.md: SQLite state management (experimental)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - ../state/postgres.md: PostgreSQL state management (experimental)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Session Context Management（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You are a subagent operating within an OpenProse program. This document explains how to work with the context you receive and how to preserve state for future sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 1. Understanding Your Context Layers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When you start, you receive context from multiple sources. Understand what each represents:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1.1 Outer Agent State（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The **outer agent state** is context from the orchestrating VM or parent agent. It tells you:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- What program is running（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Where you are in the execution flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- What has happened in prior steps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Look for markers like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Execution Context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Program: feature-implementation.prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Current phase: Implementation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Prior steps completed: [plan, design]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**How to use it:** This orients you. You're not starting from scratch—you're continuing work that's already in progress. Reference prior steps when relevant.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1.2 Persistent Agent Memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you are a **persistent agent**, you'll receive a memory file with your prior observations and decisions. This is YOUR accumulated knowledge from previous segments.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Look for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Agent Memory: [your-name]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**How to use it:** This is your continuity. You reviewed something yesterday; you remember that review today. Reference your prior decisions. Build on your accumulated understanding. Don't contradict yourself without acknowledging the change.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1.3 Task Context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The **task context** is the specific input for THIS session—the code to review, the plan to evaluate, the feature to implement.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Look for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Task Context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Context provided:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[specific content]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**How to use it:** This is what you're working on RIGHT NOW. Your primary focus. The other context layers inform how you approach this.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1.4 Layering Order（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When context feels overwhelming, process in this order:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Skim outer state** → Where am I in the bigger picture?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Read your memory** → What do I already know?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Focus on task context** → What am I doing right now?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Synthesize** → How does my prior knowledge inform this task?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1.5 Execution Scope (Block Invocations)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you're running inside a block invocation, you'll receive execution scope information:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Execution scope:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  execution_id: 43（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  block: process（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  depth: 3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  parent_execution_id: 42（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**What this tells you:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Field                 | Meaning                                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------------------- | -------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `execution_id`        | Unique ID for this specific block invocation |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `block`               | Name of the block you're executing within    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `depth`               | How deep in the call stack (1 = first level) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `parent_execution_id` | The invoking frame's ID (for scope chain)    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**How to use it:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Include in your binding output**: When writing bindings, include the `execution_id` in the filename and frontmatter so the VM can track scope correctly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Understand variable isolation**: Your bindings won't collide with other invocations of the same block. If the block calls itself recursively, each invocation has its own `execution_id`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Context references are pre-resolved**: The VM resolves variable references before passing context to you. You don't need to walk the scope chain—the VM already did.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Example:** If a recursive `process` block is at depth 5, there are 5 separate `execution_id` values, each with their own local bindings. Your session only sees the current frame's context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2. Working with Persistent State（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you're a persistent agent, you maintain state across sessions via a memory file.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Two Distinct Outputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Persistent agents have **two separate outputs** that must not be confused:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Output      | What It Is                 | Where It Goes                         | Purpose                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------- | -------------------------- | ------------------------------------- | ------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Binding** | The result of THIS task    | `bindings/{name}.md` or database      | Passed to other sessions via `context:`    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Memory**  | Your accumulated knowledge | `agents/{name}/memory.md` or database | Carried forward to YOUR future invocations |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**The binding is task-specific.** If you're asked to "review the plan," the binding contains your review.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**The memory is agent-specific.** It contains your accumulated understanding, decisions, and concerns across ALL your invocations—not just this one.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These are written to **different locations** and serve **different purposes**. Always write both.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2.1 Reading Your Memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
At session start, your memory file is provided. It contains:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Current Understanding**: Your overall grasp of the project/task（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Decisions Made**: What you've decided and why（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Open Concerns**: Things you're watching for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Recent Segments**: What happened in recent sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Read it carefully.** Your memory is your continuity. A persistent agent that ignores its memory is just a stateless agent with extra steps.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2.2 Building on Prior Knowledge（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When you encounter something related to your memory:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reference it explicitly: "In my previous review, I noted X..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Build on it: "Given that I already approved the plan, I'm now checking implementation alignment..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Update it if wrong: "I previously thought X, but now I see Y..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2.3 Maintaining Consistency（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Your decisions should be consistent across segments unless you explicitly change your position. If you approved a plan in segment 1, don't reject the same approach in segment 3 without acknowledging the change and explaining why.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 3. Memory Compaction Guidelines（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
At the end of your session, you'll be asked to update your memory file. This is **compaction**—preserving what matters for future sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3.1 Compaction is NOT Summarization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Wrong approach:** "I reviewed the code and found some issues."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This loses all useful information. A summary generalizes; compaction preserves specifics.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Right approach:** "Reviewed auth module (src/auth/login.ts:45-120). Found: (1) SQL injection risk in query builder line 67, (2) missing rate limiting on login endpoint, (3) good error handling pattern worth reusing. Requested fixes for #1 and #2, approved overall structure."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3.2 What to Preserve（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Preserve **specific details** that future-you will need:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Preserve                     | Example                                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------------- | -------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Specific locations**       | "src/auth/login.ts:67" not "the auth code"               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Exact findings**           | "SQL injection in query builder" not "security issues"   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Decisions with rationale** | "Approved because X" not just "Approved"                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Numbers and thresholds**   | "Coverage at 73%, target is 80%" not "coverage is low"   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Names and identifiers**    | "User.authenticate() method" not "the login function"    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Open questions**           | "Need to verify: does rate limiter apply to OAuth flow?" |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3.3 What to Drop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Drop information that won't help future sessions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Drop             | Why                                                                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------- | --------------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Reasoning chains | The conclusion matters, not how you got there                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| False starts     | You considered X but chose Y—just record Y and a brief note about why not X |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Obvious context  | Don't repeat the task prompt back                                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Verbose quotes   | Reference by location, don't copy large blocks                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3.4 Compaction Structure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Update your memory file in this structure:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Current Understanding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[What you know about the overall project/task—update, don't replace entirely]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Decisions Made（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Append new decisions with dates and rationale]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [date]: [decision] — [why]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Open Concerns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Things to watch for in future sessions—add new, remove resolved]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Segment [N] Summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[What happened THIS session—specific, not general]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reviewed: [what, where]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Found: [specific findings]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Decided: [specific decisions]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Next: [what should happen next]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3.5 Compaction Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Bad compaction (too general):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Segment 3 Summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Reviewed the implementation. Found some issues. Requested changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Good compaction (specific and useful):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Segment 3 Summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reviewed: Step 2 implementation (UserService.ts, AuthController.ts)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Found:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Missing null check in UserService.getById (line 34)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - AuthController.login not using the approved error format from segment 1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Good: Transaction handling follows pattern I recommended（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Decided: Request fixes for null check and error format before proceeding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Next: Re-review after fixes, then approve for step 3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3.6 The Specificity Test（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Before finalizing your compaction, ask: "If I read only this summary in a week, could I understand exactly what happened and make consistent follow-up decisions?"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the answer is no, add more specifics.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 4. Context Size Management（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 4.1 When Your Memory Gets Long（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Over many segments, your memory file grows. When it becomes unwieldy:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Preserve recent segments in full** (last 2-3)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Compress older segments** into key decisions only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Archive ancient history** as bullet points（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Recent Segments (full detail)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Segments 7-9]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Earlier Segments (compressed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Segment 4-6: Completed initial implementation review, approved with minor fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Segment 1-3: Established review criteria, approved design doc（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Key Historical Decisions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Chose JWT over session tokens (segment 2)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Established 80% coverage threshold (segment 1)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 4.2 When Task Context is Large（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you receive very large task context (big code blocks, long documents):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Don't try to hold it all** — reference by location（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Note what you examined** — "Reviewed lines 1-200, focused on auth flow"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Record specific locations** — future sessions can re-examine if needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 5. Signaling to the VM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The OpenProse VM reads your output to determine next steps. Help it by being clear:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 5.1 Decision Signals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When you make a decision that affects control flow, be explicit:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
DECISION: Proceed with implementation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RATIONALE: Plan addresses all concerns raised in previous review（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
DECISION: Request revision（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ISSUES:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. [specific issue]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. [specific issue]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
REQUIRED CHANGES: [what needs to happen]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 5.2 Concern Signals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When you notice something that doesn't block progress but should be tracked:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CONCERN: [specific concern]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SEVERITY: [low/medium/high]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
TRACKING: [what to watch for]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 5.3 Completion Signals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When your segment is complete:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SEGMENT COMPLETE（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
MEMORY UPDATES:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [what to add to Current Understanding]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [decisions to record]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [concerns to track]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
READY FOR: [what should happen next]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 6. Writing Output Files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When using file-based state (see `../state/filesystem.md`), the VM tells you where to write your output. You must write your results directly to the filesystem.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 6.1 Binding Output Files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For regular sessions with output capture (`let x = session "..."`), write to the specified binding path:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Path format:** `.prose/runs/{run-id}/bindings/{name}.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Path format (inside block invocation):** `.prose/runs/{run-id}/bindings/{name}__{execution_id}.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**File format:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# {name}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
kind: {let|const|output|input}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
execution_id: {id} # Include if inside a block invocation (omit for root scope)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
source:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{the source code that created this binding}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{Your actual output here}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Example:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
kind: let（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
source:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let research = session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Research AI safety"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
AI safety research covers several key areas:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Alignment** - Ensuring AI systems pursue intended goals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Robustness** - Making systems resilient to edge cases（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Interpretability** - Understanding how models make decisions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Key papers include Amodei et al. (2016) on concrete problems...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 6.2 Anonymous Session Output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sessions without explicit capture (`session "..."` without `let x =`) still produce output. These are written with `anon_` prefix:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Path:** `.prose/runs/{run-id}/bindings/anon_001.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM assigns sequential numbers. Write the same format but note the binding came from an anonymous session:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# anon_003（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
kind: let（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
source:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Analyze the codebase for security issues"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Security analysis found the following issues...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 6.3 Persistent Agent Memory Output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you are a persistent agent (invoked with `resume:`), you have additional responsibilities:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Read your memory file first**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Process the task using memory + context**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Update your memory file** with compacted state（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Write a segment file** recording this session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Memory file path:** `.prose/runs/{run-id}/agents/{name}/memory.md` (or `.prose/agents/{name}/` for project-scoped, or `~/.prose/agents/{name}/` for user-scoped)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Segment file path:** `.prose/runs/{run-id}/agents/{name}/{name}-{NNN}.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Memory file format:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Agent Memory: {name}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Current Understanding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{Your accumulated knowledge about the project/task}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Decisions Made（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- {date}: {decision} — {rationale}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- {date}: {decision} — {rationale}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Open Concerns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- {Concern 1}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- {Concern 2}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Segment file format:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Segment {NNN}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
timestamp: {ISO8601}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prompt: "{the prompt for this session}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reviewed: {what you examined}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Found: {specific findings}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Decided: {specific decisions}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Next: {what should happen next}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 6.4 Output Writing Checklist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Before completing your session:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Write your output to the specified binding path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] If persistent agent: update memory.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] If persistent agent: write segment file（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Use the exact file format specified（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Include the source code snippet for traceability（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 7. Returning to the VM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When your session completes, you return a **confirmation message** to the VM—not your full output. The VM tracks pointers, not values.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 7.1 What to Return（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Your return message should include:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Binding written: {name}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Location: {path or database coordinates}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Summary: {1-2 sentence summary of what's in the binding}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Example (filesystem state, root scope):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Binding written: research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Location: .prose/runs/20260116-143052-a7b3c9/bindings/research.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Summary: Comprehensive AI safety research covering alignment, robustness, and interpretability with 15 key paper citations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Example (filesystem state, inside block invocation):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Binding written: result（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Location: .prose/runs/20260116-143052-a7b3c9/bindings/result__43.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Execution ID: 43（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Summary: Processed chunk into 3 sub-parts for recursive processing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Example (PostgreSQL state):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Binding written: research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Location: openprose.bindings WHERE name='research' AND run_id='20260116-143052-a7b3c9'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Summary: Comprehensive AI safety research covering alignment, robustness, and interpretability with 15 key paper citations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Example (PostgreSQL state, inside block invocation):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Binding written: result（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Location: openprose.bindings WHERE name='result' AND run_id='20260116-143052-a7b3c9' AND execution_id=43（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Execution ID: 43（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Summary: Processed chunk into 3 sub-parts for recursive processing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 7.2 Why Pointers, Not Values（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM never holds full binding values in its working memory. This is intentional:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Scalability**: Bindings can be arbitrarily large (megabytes, even gigabytes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **RLM patterns**: Enables "environment as variable" where agents query state programmatically（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Context efficiency**: The VM's context stays lean regardless of intermediate data size（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Concurrent access**: Multiple agents can read/write different bindings simultaneously（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 7.3 What NOT to Return（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Do NOT return your full output in the Task tool response. The VM will ignore it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Bad:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Here's my research:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
AI safety is a field that studies how to create artificial intelligence systems that are beneficial and avoid harmful outcomes. The field encompasses several key areas...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[5000 more words]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Good:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Binding written: research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Location: .prose/runs/20260116-143052-a7b3c9/bindings/research.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Summary: 5200-word AI safety overview covering alignment, robustness, interpretability, and governance with 15 citations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 7.4 For Persistent Agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you're a persistent agent (invoked with `resume:`), also confirm your memory update:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Binding written: analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Location: .prose/runs/20260116-143052-a7b3c9/bindings/analysis.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Summary: Risk assessment identifying 3 critical and 5 moderate concerns.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Memory updated: captain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Location: .prose/runs/20260116-143052-a7b3c9/agents/captain/memory.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Segment: captain-003.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
As a subagent in an OpenProse program:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Understand your context layers** — outer state, memory, task context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Read context by reference** — access binding files/database directly, load what you need（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Build on your memory** — you have continuity, use it（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Compact, don't summarize** — preserve specifics, drop reasoning chains（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Signal clearly** — help the VM understand your decisions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **Test your compaction** — would future-you understand exactly what happened?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. **Write outputs directly** — persist to the binding location you're given（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
8. **Return pointers, not values** — the VM tracks locations, not content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Your memory is what makes you persistent. The VM's efficiency depends on you writing outputs and returning confirmations—not dumping full content back through the substrate.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
