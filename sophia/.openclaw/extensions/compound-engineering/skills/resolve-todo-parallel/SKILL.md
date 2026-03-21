---
name: resolve-todo-parallel
description: Resolve all pending CLI todos using parallel processing, compound on lessons learned, then clean up completed todos.
argument-hint: "[optional: specific todo ID or pattern]"
---

Resolve all TODO comments using parallel processing, document lessons learned, then clean up completed todos.

## Workflow

### 1. Analyze

Get all unresolved TODOs from the /todos/*.md directory

If any todo recommends deleting, removing, or gitignoring files in `docs/brainstorms/`, `docs/plans/`, or `docs/solutions/`, skip it and mark it as `wont_fix`. These are compound-engineering pipeline artifacts that are intentional and permanent.

### 2. Plan

Create a TodoWrite list of all unresolved items grouped by type. Make sure to look at dependencies that might occur and prioritize the ones needed by others. For example, if you need to change a name, you must wait to do the others. Output a mermaid flow diagram showing how we can do this. Can we do everything in parallel? Do we need to do one first that leads to others in parallel? I'll put the to-dos in the mermaid diagram flow-wise so the agent knows how to proceed in order.

### 3. Implement (PARALLEL)

Spawn a pr-comment-resolver agent for each unresolved item in parallel.

So if there are 3 comments, it will spawn 3 pr-comment-resolver agents in parallel. Like this:

1. Task pr-comment-resolver(comment1)
2. Task pr-comment-resolver(comment2)
3. Task pr-comment-resolver(comment3)

Always run all in parallel subagents/Tasks for each Todo item.

### 4. Commit & Resolve

- Commit changes
- Remove the TODO from the file, and mark it as resolved.
- Push to remote

GATE: STOP. Verify that todos have been resolved and changes committed. Do NOT proceed to step 5 if no todos were resolved.

### 5. Compound on Lessons Learned

Run the `ce:compound` skill to document what was learned from resolving the todos.

The todo resolutions often surface patterns, recurring issues, or architectural insights worth capturing. This step ensures that knowledge compounds rather than being lost.

GATE: STOP. Verify that the compound skill produced a solution document in `docs/solutions/`. If no document was created (user declined or no non-trivial learnings), continue to step 6.

### 6. Clean Up Completed Todos

List all todos and identify those with `done` or `resolved` status, then delete them to keep the todo list clean and actionable.

After cleanup, output a summary:

```
Todos resolved: [count]
Lessons documented: [path to solution doc, or "skipped"]
Todos cleaned up: [count deleted]
```
