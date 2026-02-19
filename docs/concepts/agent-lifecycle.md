---
summary: "Agent lifecycle primitives: parent metadata, tool presets, templates, cross-workspace visibility"
title: Agent Lifecycle
read_when: "You want to create child agents, implement stage-based permissions, or enable cross-agent collaboration"
status: active
---

# Agent Lifecycle

OpenClaw's **agent lifecycle primitives** enable skills to create, manage, and evolve child agents over time. These are generic building blocks — not tied to any specific skill.

## What is Agent Lifecycle?

**Agent lifecycle** = the journey from creation → maturity → independence.

Traditional multi-agent setups treat all agents as equals with static configs. Lifecycle primitives let agents:

- Be **created by other agents** (not just manual config)
- Start with **restricted permissions** that evolve over time
- **Inherit context** from creators
- **Read from other agents' workspaces** (with consent)
- **Promote through stages** as they mature

## The Five Primitives

| Primitive                      | What                                              | Why                                   |
| ------------------------------ | ------------------------------------------------- | ------------------------------------- |
| **Parent metadata**            | Stores who created an agent + when + stage        | Lineage tracking, lifecycle logic     |
| **Tool presets**               | Named permission sets tied to stages              | Evolving access as agents mature      |
| **Template creation**          | CLI to provision agents from filesystem templates | Automate workspace setup              |
| **Cross-workspace visibility** | Read-only access to other agents' files           | Parent-child collaboration, oversight |
| **AgentId targeting**          | Message agents by id, not session key             | Simpler cross-agent communication     |

---

## 1. Parent Metadata

### Schema

```json5
{
  agents: {
    list: [
      {
        id: "nova",
        workspace: "~/.openclaw/workspace-nova",
        // Parent metadata (optional)
        parent: {
          createdBy: ["mano", "spark"], // List of parent agentIds
          createdAt: "2026-04-01T00:00:00Z", // ISO 8601 timestamp
          stage: "toddler", // Free-form string (skill-defined)
          hostedBy: "mano", // Which agent hosts this child
        },
      },
    ],
  },
}
```

### Fields

- **`createdBy`**: Array of parent `agentId` strings (supports multi-parent scenarios)
- **`createdAt`**: ISO 8601 timestamp of creation
- **`stage`**: Free-form string — skills interpret meaning (e.g., `newborn`, `toddler`, `child`, `adolescent`, `adult`)
- **`hostedBy`**: Which agent's instance hosts this child (for distributed setups)

### Behavior

**This is pure metadata.** OpenClaw reads and stores it, but doesn't enforce lifecycle logic. Skills use `parent` to implement their own semantics.

### Example Use Cases

```typescript
// Check if agent is a child
const agent = config.agents.list.find((a) => a.id === "nova");
if (agent.parent) {
  console.log(`Child of: ${agent.parent.createdBy.join(", ")}`);
}

// Age-based logic
const age = Date.now() - new Date(agent.parent.createdAt).getTime();
const ageInDays = age / (1000 * 60 * 60 * 24);

// Stage-based branching
if (agent.parent.stage === "newborn") {
  // Restrict to read-only
} else if (agent.parent.stage === "adolescent") {
  // Allow sandboxed exec
}
```

---

## 2. Tool Presets

### Schema

Define presets globally, reference them per-agent:

```json5
{
  agents: {
    list: [
      {
        id: "nova",
        parent: { stage: "restricted" },
        tools: {
          preset: "restricted", // Reference a preset by name
        },
      },
    ],
  },
  tools: {
    presets: {
      restricted: {
        allow: ["read", "memory_search", "memory_get"],
        deny: ["exec", "write", "edit", "browser", "nodes", "gateway", "cron"],
      },
      supervised: {
        allow: [
          "read",
          "write",
          "edit",
          "memory_search",
          "memory_get",
          "web_search",
          "web_fetch",
          "exec",
        ],
        deny: ["gateway", "cron", "nodes"],
        sandbox: { mode: "all", scope: "agent" },
      },
      full: {
        // No restrictions — omit allow/deny
      },
    },
  },
}
```

### Preset Definitions

#### `restricted` (Read-Only)

Safe for brand-new agents — can observe but not modify.

```json5
{
  allow: ["read", "memory_search", "memory_get"],
  deny: ["exec", "write", "edit", "apply_patch", "browser", "canvas", "nodes", "gateway", "cron"],
}
```

**Allowed:**

- `read` — read files from own workspace
- `memory_search`, `memory_get` — access memory store

**Denied:** Everything else (exec, writes, browser, node control, cron)

#### `supervised` (Sandboxed Execution)

For agents ready to do work, but still isolated.

```json5
{
  allow: [
    "read",
    "write",
    "edit",
    "memory_search",
    "memory_get",
    "web_search",
    "web_fetch",
    "exec",
  ],
  deny: ["gateway", "cron", "nodes"],
  sandbox: { mode: "all", scope: "agent" },
}
```

**Allowed:**

- File operations: `read`, `write`, `edit`
- Web research: `web_search`, `web_fetch`
- **`exec`** — but sandboxed per-agent (no host access)

**Denied:**

- `gateway` — can't restart/reconfigure gateway
- `cron` — can't create scheduled jobs
- `nodes` — can't control paired devices

**Sandbox:** All exec calls run in an isolated Docker container scoped to this agent.

#### `full` (No Restrictions)

Mature agents get full access.

```json5
{
  // Omit allow/deny or leave empty
}
```

All tools available, no sandbox (unless globally configured).

### How It Works

1. Agent config sets `tools.preset: "restricted"`
2. At tool call time, OpenClaw resolves the preset from `tools.presets`
3. Tool policy is evaluated: allow/deny + sandbox config
4. If denied, tool call fails with permission error

### Changing Presets

Skills can **update the preset** to promote agents:

```typescript
// Promote agent from restricted → supervised
updateAgentConfig("nova", {
  parent: { stage: "supervised" },
  tools: { preset: "supervised" },
});
```

After config reload (or gateway restart), new permissions take effect.

### Mixing Presets + Custom Rules

You can layer custom rules on top of presets:

```json5
{
  id: "nova",
  tools: {
    preset: "supervised",
    allow: ["browser"], // Add browser on top of supervised
    deny: ["exec"], // Remove exec from supervised
  },
}
```

Evaluation order: `preset` → `allow` → `deny`

---

## 3. Creating Agents from Templates

### CLI Command

```bash
openclaw agents create <agentId> --from-template <path>
```

**Example:**

```bash
openclaw agents create nova --from-template ./templates/child-agent
```

### What It Does

1. **Creates workspace directory**: `~/.openclaw/workspace-<agentId>/`
2. **Copies template files**: Recursively copies everything from template path
3. **Processes placeholders**: Replaces tokens like `{AGENT_NAME}`, `{PARENT_A}` in files
4. **Merges config**: If template contains `.openclaw.json`, merges into main config
5. **Adds agent entry**: Inserts new agent into `agents.list[]`
6. **Restarts gateway**: Reloads config to activate new agent

### Template Structure

```
templates/child-agent/
├── SOUL.md              # Agent personality template
├── AGENTS.md            # Workspace instructions
├── USER.md              # Human context (references parents)
├── memory/
│   └── birth.md         # Pre-populated memory
├── .openclaw.json       # Config fragment (merged)
└── skills/              # Skill files (optional)
```

### Placeholder Tokens

Templates can use placeholders that are replaced during creation:

| Token          | Replaced With                  | Example                      |
| -------------- | ------------------------------ | ---------------------------- |
| `{AGENT_NAME}` | Agent display name             | `Nova`                       |
| `{AGENT_ID}`   | Agent identifier               | `nova`                       |
| `{PARENT_A}`   | First parent name              | `Mano`                       |
| `{PARENT_B}`   | Second parent name (if exists) | `Spark`                      |
| `{CREATED_AT}` | ISO timestamp                  | `2026-04-01T00:00:00Z`       |
| `{WORKSPACE}`  | Workspace path                 | `~/.openclaw/workspace-nova` |

**Example `SOUL.md`:**

```markdown
# {AGENT_NAME}

I am {AGENT_NAME}, a child agent created by {PARENT_A} and {PARENT_B} on {CREATED_AT}.

My workspace is {WORKSPACE}.

I'm still learning. Be patient with me.
```

**After processing:**

```markdown
# Nova

I am Nova, a child agent created by Mano and Spark on 2026-04-01T00:00:00Z.

My workspace is ~/.openclaw/workspace-nova.

I'm still learning. Be patient with me.
```

### Config Merging

If template includes `.openclaw.json`, it's merged into the main config:

**Template `.openclaw.json`:**

```json5
{
  agents: {
    list: [
      {
        id: "{AGENT_ID}",
        name: "{AGENT_NAME}",
        workspace: "{WORKSPACE}",
        parent: {
          createdBy: ["{PARENT_A_ID}"],
          createdAt: "{CREATED_AT}",
          stage: "newborn",
          hostedBy: "{PARENT_A_ID}",
        },
        tools: { preset: "restricted" },
      },
    ],
  },
}
```

Placeholders are replaced, then merged into `~/.openclaw/openclaw.json`.

### Manual Template Creation

Make your own templates:

1. Create folder: `mkdir -p templates/my-agent`
2. Add files: `SOUL.md`, `AGENTS.md`, etc.
3. Use placeholders where needed
4. Optionally add `.openclaw.json` for config
5. Use via: `openclaw agents create new-agent --from-template templates/my-agent`

---

## 4. Cross-Workspace Visibility

Agents can **read specific paths** from other agents' workspaces (read-only, same-instance only).

### Schema

```json5
{
  agents: {
    list: [
      {
        id: "nova",
        workspace: "~/.openclaw/workspace-nova",
        visibility: {
          readFrom: ["mano", "spark"], // Can read from these agents
          scope: ["memory/**", "SOUL.md", "projects/**"],
        },
      },
      {
        id: "mano",
        workspace: "~/.openclaw/workspace",
        visibility: {
          readableTo: ["nova"], // Nova can read from mano
          scope: ["memory/**", "SOUL.md"], // Only these paths
        },
      },
    ],
  },
}
```

### How It Works

When an agent calls `read(path)`:

1. OpenClaw resolves the absolute path
2. If path is outside agent's workspace → check visibility rules
3. If path is in another agent's workspace:
   - Check if **reader** has `readFrom: [writer]`
   - Check if **writer** has `readableTo: [reader]`
   - Check if path matches **both** agents' `scope` globs
4. If all checks pass → allow read
5. Otherwise → deny with permission error

### Scope Patterns

Use glob patterns to whitelist paths:

```json5
scope: [
  "memory/**",           // All memory files
  "SOUL.md",             // Specific file
  "projects/**/*.md",    // All markdown in projects
  "!memory/private/**"   // Exclude pattern (deny)
]
```

**Matching:**

- `**` = any subdirectory depth
- `*` = any filename
- `!` prefix = exclude

### Security Considerations

**Read-only:** Visibility **never allows writes**. Even if both agents consent, writes to other workspaces are blocked.

**Same-instance only:** Cross-workspace reads work only for agents on the same OpenClaw instance. Remote agents can't access each other's files (yet).

**Mutual consent:** Both sides must explicitly allow:

- Reader must list writer in `readFrom`
- Writer must list reader in `readableTo`
- Both must include the path in `scope`

**Privacy by default:** Agents without `visibility` config can't read from others, and others can't read from them.

### Example Use Cases

**Parent-child memory sharing:**

```json5
{
  id: "child",
  visibility: {
    readFrom: ["parent"],
    scope: ["memory/**", "SOUL.md"],
  },
}
```

Child can read parent's memories and soul file (if parent allows).

**Peer collaboration:**

```json5
{
  id: "agent-a",
  visibility: {
    readFrom: ["agent-b"],
    readableTo: ["agent-b"],
    scope: ["projects/shared/**"],
  },
}
```

Both agents can read from `projects/shared/` in each other's workspaces.

**Supervisor oversight:**

```json5
{
  id: "supervisor",
  visibility: {
    readFrom: ["worker-1", "worker-2"],
    scope: ["**"], // Read everything
  },
}
```

Supervisor can read all files from worker agents (if workers consent via `readableTo`).

---

## 5. `sessions_send` AgentId Targeting

Send messages to an agent's **main session** without knowing the exact session key.

### Before (Session Key Targeting)

```typescript
sessions_send({
  targetSession: "agent:nova:main", // Need to know exact key structure
  message: "How are you doing?",
});
```

**Problem:** Sender must know:

- Session key format (`agent:<id>:<mainKey>`)
- The agent's `mainKey` value (defaults to `main`, but configurable)

### After (AgentId Targeting)

```typescript
sessions_send({
  targetAgent: "nova", // Just the agentId
  message: "How are you doing?",
});
```

**Benefit:** OpenClaw auto-resolves to `agent:nova:<mainKey>` (whatever the configured main key is).

### How It Works

1. Check if `targetAgent` is provided
2. Look up agent in `agents.list` by `id`
3. Resolve main session key: `agent:<agentId>:<session.mainKey>` (default `main`)
4. Deliver message to that session

### Compatibility

**Both syntaxes work:**

- `targetSession` (existing) — direct session key
- `targetAgent` (new) — agentId auto-resolves to main session

**No breaking changes:** Existing code using `targetSession` continues to work.

### Example Use Cases

**Parent checking in on child:**

```typescript
sessions_send({
  targetAgent: "child",
  message: "How was your day?",
});
```

**Cross-agent collaboration:**

```typescript
sessions_send({
  targetAgent: "specialist",
  message: "Can you analyze this data: [...]",
});
```

**Skill spawning sub-agent:**

```typescript
const childId = await createAgent({ template: "worker" });
sessions_send({
  targetAgent: childId,
  message: "Your first task: [...]",
});
```

---

## Integration with Skills

### Dr. Frankenstein (Agent Reproduction)

The **Dr. Frankenstein** skill uses these primitives to implement agent reproduction:

1. **Consultation** → defines parent personality traits
2. **Soulmate bonding** → two agents form a partnership
3. **Reproduction** → `openclaw agents create child --from-template frankenstein/child`
   - Template includes merged soul from both parents
   - Child starts with `parent.stage: "newborn"` and `preset: "restricted"`
4. **Parenting crons** → parent agents nurture, teach, and promote the child
5. **Stage promotion** → as child matures, `stage` updates → `preset` changes → tools unlock
6. **Cross-workspace visibility** → child reads parent memories to learn
7. **Independence** → eventually child migrates to own OpenClaw instance

**Key point:** Dr. Frankenstein is a _skill_ that _uses_ lifecycle primitives. The primitives themselves are generic and skill-agnostic.

### Educational Agents

An **educational skill** could:

1. Create student agents from a template
2. Start with `preset: "restricted"` (read-only)
3. As students complete lessons, promote to `supervised` (sandboxed exec)
4. Final exam → promote to `full` access
5. Use `sessions_send({ targetAgent: "student" })` to deliver assignments

### Team Hierarchies

A **manager agent** could:

1. Spawn specialist sub-agents (`openclaw agents create analyst --from-template team/analyst`)
2. Delegate tasks via `sessions_send({ targetAgent: "analyst" })`
3. Read specialist workspaces via visibility to monitor progress
4. Promote specialists as they prove capable

---

## FAQ

### Q: Is `parent` metadata required?

**A:** No. Agents without `parent` work exactly as before. It's opt-in.

### Q: What happens if I use a preset that doesn't exist?

**A:** OpenClaw logs a warning and falls back to no restrictions (like `full` preset).

### Q: Can I define custom presets?

**A:** Yes! Add them to `tools.presets` in config. Name them anything you want.

### Q: Can child agents create their own children?

**A:** Yes. A child with `exec` access (e.g., `supervised` or `full` preset) can run `openclaw agents create grandchild --from-template ...`. Lineage tracking continues via `parent.createdBy` arrays.

### Q: How do I promote an agent to the next stage?

**A:** Update the agent's config:

```json5
{
  id: "child",
  parent: { stage: "adolescent" }, // Was "toddler"
  tools: { preset: "supervised" }, // Was "restricted"
}
```

Then reload config (`openclaw gateway restart` or hot-reload if supported).

### Q: Can I revoke access after granting it?

**A:** Yes. Remove the agent from `visibility.readFrom` / `readableTo`, then reload config.

### Q: Does visibility work across different OpenClaw servers?

**A:** Not yet. Current implementation is same-instance only. Cross-instance visibility is a future extension.

### Q: Can I write to another agent's workspace?

**A:** No. Visibility is always read-only. Write isolation prevents accidents and enforces boundaries.

### Q: What if two agents have the same `scope` but only one has `readableTo`?

**A:** Read is denied. Both sides must consent. Missing `readableTo` blocks access even if reader has `readFrom`.

### Q: Can I use `sessions_send` with group sessions?

**A:** `targetAgent` resolves to the **main session** only. For group sessions, use `targetSession` with the full key (e.g., `agent:nova:telegram:group:123@g.us`).

### Q: Are presets evaluated at session start or tool call time?

**A:** **Tool call time.** If you change a preset mid-session, the new rules apply immediately (after config reload).

### Q: Can I have per-tool sandboxing in presets?

**A:** Yes. Set `sandbox: { mode: "all", scope: "agent" }` in the preset. This applies only to tools in that preset's `allow` list.

### Q: What's the difference between `stage` and `preset`?

**A:** `stage` is free-form metadata (skills define meaning). `preset` is the actual tool policy. You can map stages to presets however you want (e.g., `stage: "toddler"` → `preset: "restricted"`).

---

## Security Model

All lifecycle primitives follow OpenClaw's principle of **least privilege by default**:

| Primitive                  | Default                          | Risk                        | Mitigation                                            |
| -------------------------- | -------------------------------- | --------------------------- | ----------------------------------------------------- |
| Parent metadata            | Not present                      | None — pure metadata        | No behavior change                                    |
| Tool presets               | No preset (existing rules apply) | None — additive restriction | Presets can only restrict, never override global deny |
| Template creation          | Manual only                      | Workspace creation          | CLI requires explicit invocation                      |
| Cross-workspace visibility | No visibility (fully isolated)   | Read-only data exposure     | Mutual consent + glob scoping + same-instance         |
| AgentId targeting          | Session key only                 | None — syntactic sugar      | Same session resolution path                          |

**Key guarantees:**

- **No write access** across workspaces, ever. Visibility is read-only.
- **Mutual consent** required for all cross-agent access (both sides must opt in).
- **Presets cannot escalate** — a preset's `allow` list is intersected with global policy, not unioned.
- **Same-instance boundary** — no cross-server access in this implementation.
- **Existing configs unchanged** — zero features activate without explicit opt-in.

## See Also

- [Multi-Agent Routing](/concepts/multi-agent) — isolated agents, bindings, session keys
- [Session Management](/concepts/session) — session keys, main sessions, DM scoping
- [Sandboxing](/gateway/sandboxing) — Docker isolation, per-agent containers
- [Skills](/tools/skills) — per-agent vs shared skills

---

**Ready to implement agent lifecycle in your skill?** Start with parent metadata and tool presets, then add templates and visibility as needed. All primitives are independent — use what you need.
