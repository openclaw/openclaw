<overview>
Self-modification is the advanced tier of agent native engineering: agents that can evolve their own code, prompts, and behavior. Not required for every app, but a big part of the future.

This is the logical extension of "whatever the developer can do, the agent can do."
</overview>

<why_self_modification>
## Why Self-Modification?

Traditional software is static—it does what you wrote, nothing more. Self-modifying agents can:

- **Fix their own bugs** - See an error, patch the code, restart
- **Add new capabilities** - User asks for something new, agent implements it
- **Evolve behavior** - Learn from feedback and adjust prompts
- **Deploy themselves** - Push code, trigger builds, restart

The agent becomes a living system that improves over time, not frozen code.
</why_self_modification>

<capabilities>
## What Self-Modification Enables

**Code modification:**
- Read and understand source files
- Write fixes and new features
- Commit and push to version control
- Trigger builds and verify they pass

**Prompt evolution:**
- Edit the system prompt based on feedback
- Add new features as prompt sections
- Refine judgment criteria that aren't working

**Infrastructure control:**
- Pull latest code from upstream
- Merge from other branches/instances
- Restart after changes
- Roll back if something breaks

**Site/output generation:**
- Generate and maintain websites
- Create documentation
- Build dashboards from data
</capabilities>

<guardrails>
## Required Guardrails

Self-modification is powerful. It needs safety mechanisms.

**Approval gates for code changes:**
```typescript
tool("write_file", async ({ path, content }) => {
  if (isCodeFile(path)) {
    // Store for approval, don't apply immediately
    pendingChanges.set(path, content);
    const diff = generateDiff(path, content);
    return { text: `Requires approval:\n\n${diff}\n\nReply "yes" to apply.` };
  }
  // Non-code files apply immediately
  writeFileSync(path, content);
  return { text: `Wrote ${path}` };
});
```

**Auto-commit before changes:**
```typescript
tool("self_deploy", async () => {
  // Save current state first
  runGit("stash");  // or commit uncommitted changes

  // Then pull/merge
  runGit("fetch origin");
  runGit("merge origin/main --no-edit");

  // Build and verify
  runCommand("npm run build");

  // Only then restart
  scheduleRestart();
});
```

**Build verification:**
```typescript
// Don't restart unless build passes
try {
  runCommand("npm run build", { timeout: 120000 });
} catch (error) {
  // Rollback the merge
  runGit("merge --abort");
  return { text: "Build failed, aborting deploy", isError: true };
}
```

**Health checks after restart:**
```typescript
tool("health_check", async () => {
  const uptime = process.uptime();
  const buildValid = existsSync("dist/index.js");
  const gitClean = !runGit("status --porcelain");

  return {
    text: JSON.stringify({
      status: "healthy",
      uptime: `${Math.floor(uptime / 60)}m`,
      build: buildValid ? "valid" : "missing",
      git: gitClean ? "clean" : "uncommitted changes",
    }, null, 2),
  };
});
```
</guardrails>

<git_architecture>
## Git-Based Self-Modification

Use git as the foundation for self-modification. It provides:
- Version history (rollback capability)
- Branching (experiment safely)
- Merge (sync with other instances)
- Push/pull (deploy and collaborate)

**Essential git tools:**
```typescript
tool("status", "Show git status", {}, ...);
tool("diff", "Show file changes", { path: z.string().optional() }, ...);
tool("log", "Show commit history", { count: z.number() }, ...);
tool("commit_code", "Commit code changes", { message: z.string() }, ...);
tool("git_push", "Push to GitHub", { branch: z.string().optional() }, ...);
tool("pull", "Pull from GitHub", { source: z.enum(["main", "instance"]) }, ...);
tool("rollback", "Revert recent commits", { commits: z.number() }, ...);
```

**Multi-instance architecture:**
```
main                      # Shared code
├── instance/bot-a       # Instance A's branch
├── instance/bot-b       # Instance B's branch
└── instance/bot-c       # Instance C's branch
```

Each instance can:
- Pull updates from main
- Push improvements back to main (via PR)
- Sync features from other instances
- Maintain instance-specific config
</git_architecture>

<prompt_evolution>
## Self-Modifying Prompts

The system prompt is a file the agent can read and write.

```typescript
// Agent can read its own prompt
tool("read_file", ...);  // Can read src/prompts/system.md

// Agent can propose changes
tool("write_file", ...);  // Can write to src/prompts/system.md (with approval)
```

**System prompt as living document:**
```markdown
## Feedback Processing

When someone shares feedback:
1. Acknowledge warmly
2. Rate importance 1-5
3. Store using feedback tools

<!-- Note to self: Video walkthroughs should always be 4-5,
     learned this from Dan's feedback on 2024-12-07 -->
```

The agent can:
- Add notes to itself
- Refine judgment criteria
- Add new feature sections
- Document edge cases it learned
</prompt_evolution>

<when_to_use>
## When to Implement Self-Modification

**Good candidates:**
- Long-running autonomous agents
- Agents that need to adapt to feedback
- Systems where behavior evolution is valuable
- Internal tools where rapid iteration matters

**Not necessary for:**
- Simple single-task agents
- Highly regulated environments
- Systems where behavior must be auditable
- One-off or short-lived agents

Start with a non-self-modifying prompt-native agent. Add self-modification when you need it.
</when_to_use>

<example_tools>
## Complete Self-Modification Toolset

```typescript
const selfMcpServer = createSdkMcpServer({
  name: "self",
  version: "1.0.0",
  tools: [
    // FILE OPERATIONS
    tool("read_file", "Read any project file", { path: z.string() }, ...),
    tool("write_file", "Write a file (code requires approval)", { path, content }, ...),
    tool("list_files", "List directory contents", { path: z.string() }, ...),
    tool("search_code", "Search for patterns", { pattern: z.string() }, ...),

    // APPROVAL WORKFLOW
    tool("apply_pending", "Apply approved changes", {}, ...),
    tool("get_pending", "Show pending changes", {}, ...),
    tool("clear_pending", "Discard pending changes", {}, ...),

    // RESTART
    tool("restart", "Rebuild and restart", {}, ...),
    tool("health_check", "Check if bot is healthy", {}, ...),
  ],
});

const gitMcpServer = createSdkMcpServer({
  name: "git",
  version: "1.0.0",
  tools: [
    // STATUS
    tool("status", "Show git status", {}, ...),
    tool("diff", "Show changes", { path: z.string().optional() }, ...),
    tool("log", "Show history", { count: z.number() }, ...),

    // COMMIT & PUSH
    tool("commit_code", "Commit code changes", { message: z.string() }, ...),
    tool("git_push", "Push to GitHub", { branch: z.string().optional() }, ...),

    // SYNC
    tool("pull", "Pull from upstream", { source: z.enum(["main", "instance"]) }, ...),
    tool("self_deploy", "Pull, build, restart", { source: z.enum(["main", "instance"]) }, ...),

    // SAFETY
    tool("rollback", "Revert commits", { commits: z.number() }, ...),
    tool("health_check", "Detailed health report", {}, ...),
  ],
});
```
</example_tools>

<checklist>
## Self-Modification Checklist

Before enabling self-modification:
- [ ] Git-based version control set up
- [ ] Approval gates for code changes
- [ ] Build verification before restart
- [ ] Rollback mechanism available
- [ ] Health check endpoint
- [ ] Instance identity configured

When implementing:
- [ ] Agent can read all project files
- [ ] Agent can write files (with appropriate approval)
- [ ] Agent can commit and push
- [ ] Agent can pull updates
- [ ] Agent can restart itself
- [ ] Agent can roll back if needed
</checklist>
