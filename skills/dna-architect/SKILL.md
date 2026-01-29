---
name: dna-architect
description: "Expert advisor on DNA extension systems (Skills, Hooks, Plugins, Channels, Providers, Tools, Nodes). Trigger when designing features, writing PRDs, auditing implementations, or deciding which extension point to use. Provides architecture analysis, implementation guidance, and best practices."
metadata:
  dna:
    emoji: "🏗️"
    priority: high
---

# DNA Architect - Extension Systems Expert

## 🎯 When This Skill Activates

**ALWAYS consult this skill when:**
- Designing new features for DNA integration
- Writing PRDs that involve automation, agent capabilities, or integrations
- Deciding between Skills vs Hooks vs Plugins
- Auditing existing implementations for improvements
- Troubleshooting extension system issues
- Enhancing agent capabilities

**Trigger phrases:**
- "extend dna", "add feature", "create skill/hook/plugin"
- "which extension", "best approach for"
- "audit implementation", "improve architecture"
- "PRD for [dna feature]"

---

## 🧠 Decision Framework

### Step 1: Classify the Need

```
┌─────────────────────────────────────────────────────────────┐
│                    WHAT ARE YOU BUILDING?                    │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐   ┌─────────────────┐   ┌─────────────────┐
│ Agent Knowledge│   │ Event Response  │   │ New Capability  │
│ "How to do X"  │   │ "When Y happens"│   │ "Agent can do Z"│
└───────┬───────┘   └────────┬────────┘   └────────┬────────┘
        │                    │                     │
        ▼                    ▼                     ▼
    ┌───────┐          ┌──────────┐          ┌──────────┐
    │ SKILL │          │   HOOK   │          │  PLUGIN  │
    └───────┘          └──────────┘          │  + TOOL  │
                                             └──────────┘
```

### Step 2: Extension Selection Matrix

| Need | Primary Choice | Alternative | Avoid |
|------|----------------|-------------|-------|
| Teach agent a workflow | **Skill** | Plugin w/ skill | Hook |
| Modify context before turns | **Hook** (`agent:bootstrap`) | Plugin | Skill |
| React to `/new`, `/reset` | **Hook** (`command:*`) | Plugin | — |
| Add CLI command | **Plugin** | — | Skill |
| Add agent tool function | **Plugin** (+ tool) | — | Skill |
| Connect new chat platform | **Plugin** (channel) | — | — |
| Background service | **Plugin** | Cron job | Hook |
| Scheduled task | **Cron** | Heartbeat | Hook |
| Periodic checks | **Heartbeat** | Cron | — |
| External trigger | **Webhook** | Cron | — |
| Remote device feature | **Node** command | Plugin | — |

### Step 3: Complexity Assessment

```
LOW COMPLEXITY (< 1 hour)
├── Skill: Instructions only, no scripts
├── Hook: Single event, simple logic
└── Config: Enable existing feature

MEDIUM COMPLEXITY (1-4 hours)
├── Skill: With scripts and references
├── Hook: Multiple events, state tracking
├── Plugin: Single tool or command
└── Node: New command on existing node

HIGH COMPLEXITY (4+ hours)
├── Plugin: Multiple tools, RPC, HTTP
├── Channel: New messaging platform
├── Provider: New AI backend
└── Node: New platform support
```

---

## 🔍 Architecture Analysis Protocol

When analyzing ANY feature request, run this checklist:

### 1. Extension Point Analysis
```markdown
## Extension Analysis: [Feature Name]

### What it does
[One-line description]

### Extension candidates
| System | Fit | Reasoning |
|--------|-----|-----------|
| Skill  | ⬜ | [why/why not] |
| Hook   | ⬜ | [why/why not] |
| Plugin | ⬜ | [why/why not] |
| Tool   | ⬜ | [why/why not] |
| Cron   | ⬜ | [why/why not] |

### Recommended approach
[Primary choice] because [reasoning]

### Implementation path
1. [Step 1]
2. [Step 2]
...
```

### 2. Impact Assessment
- **Agent context**: Does it add to context size? (Skills add ~2-5KB)
- **Performance**: Does it run every turn? (Hooks can slow response)
- **Maintenance**: Who updates it? (Skills = user, Plugins = developer)
- **Security**: What access does it need? (Tools have sandbox implications)

### 3. Integration Points
- Does it need to interact with other extensions?
- Does it depend on external services?
- Does it require user configuration?

---

## 📋 Implementation Checklists

### Skill Implementation Checklist
```
□ Create skills/<name>/SKILL.md with frontmatter
□ Add clear description (triggers loading)
□ Define gating rules if needed (binary/env/config)
□ Add references/ for additional docs
□ Add scripts/ for automation
□ Test with: dna skills check
□ Verify loading: dna skills info <name>
```

### Hook Implementation Checklist
```
□ Create hooks/<name>/HOOK.md with metadata
□ Create hooks/<name>/handler.ts
□ Define events in metadata.dna.events
□ Handle errors gracefully (don't throw)
□ Test handler compiles: dna hooks check
□ Enable: dna hooks enable <name>
□ Test event firing manually
```

### Plugin Implementation Checklist
```
□ Create dna.plugin.json manifest
□ Implement main handler file
□ Register tools/commands/RPC as needed
□ Add TypeBox schemas for validation
□ Test with: dna plugins list
□ Document configuration options
□ Consider bundling skills if teaching agent
```

---

## 🏛️ Architecture Patterns

### Pattern 1: Skill + Hook Combo
**Use when:** Agent needs knowledge AND context injection

```
skills/my-feature/SKILL.md     → Teaches HOW to use feature
hooks/my-feature/handler.ts    → Injects current STATE
```

**Example:** Context monitor
- Hook injects usage percentage
- Skill (AGENTS.md) teaches when to suggest /compact

### Pattern 2: Plugin + Skill Combo
**Use when:** New tool needs usage guidance

```
plugins/my-tool/              → Provides tool function
plugins/my-tool/skills/       → Teaches when/how to use
```

**Example:** Voice call plugin
- Plugin provides `voice_call` tool
- Bundled skill teaches conversation patterns

### Pattern 3: Cron + Heartbeat Division
**Use when:** Multiple scheduled needs

```
Heartbeat (HEARTBEAT.md)      → Batch checks (email + calendar + weather)
Cron jobs                     → Precise timing (9 AM reminder)
```

**Principle:** Batch similar checks in heartbeat, isolate precise schedules to cron.

### Pattern 4: Node + Canvas for UI
**Use when:** Agent needs to show visual output

```
Node canvas.present           → Show URL/HTML
Node canvas.snapshot          → Capture result
Agent reads snapshot          → Understands visual state
```

---

## 🔬 Audit Protocol

### When auditing existing implementations:

#### 1. Extension Appropriateness
```bash
# List all extensions
dna skills list
dna hooks list  
dna plugins list
```

**Check for:**
- Skills that should be hooks (event-driven logic in SKILL.md)
- Hooks that should be plugins (too complex, needs tools)
- Plugins that should be skills (just documentation)

#### 2. Performance Impact
```bash
# Check skill sizes
wc -c skills/*/SKILL.md | sort -n

# Check hook frequency
grep -r "agent:bootstrap" hooks/*/HOOK.md
```

**Red flags:**
- Skills > 10KB (context bloat)
- Multiple hooks on `agent:bootstrap` (latency)
- Plugins without lazy loading

#### 3. Security Review
```bash
# Check tool permissions
grep -r "exec\|process\|browser" skills/*/SKILL.md

# Check hook access
grep -r "sessionFile\|cfg" hooks/*/handler.ts
```

**Questions:**
- Does skill instruct agent to run dangerous commands?
- Does hook access sensitive session data?
- Does plugin expose privileged operations?

---

## 📝 Templates

### Quick Skill Template
```markdown
---
name: my-skill
description: "Brief description of when to use this skill"
metadata:
  dna:
    emoji: "🔧"
---

# My Skill

## When to Use
[Trigger conditions]

## Commands
[Available commands/workflows]

## Examples
[Usage examples]
```

### Quick Hook Template
```markdown
---
name: my-hook
description: "What this hook does"
metadata:
  dna:
    emoji: "🪝"
    events: ["agent:bootstrap"]
---
```

```typescript
// handler.ts
const handler = async (event) => {
  if (event.type !== 'agent' || event.action !== 'bootstrap') return;
  
  // Your logic here
  event.context.bootstrapFiles?.push({
    content: '## Injected\nContent here'
  });
};

export default handler;
```

---

## 🚨 Anti-Patterns to Avoid

### ❌ Skill as Code
**Wrong:** Putting executable logic in SKILL.md
**Right:** Use scripts/ for executables, SKILL.md for instructions

### ❌ Hook for Everything
**Wrong:** Using hooks to add agent capabilities
**Right:** Use plugins for new tools, hooks for event response

### ❌ Monolithic Plugin
**Wrong:** One plugin with 10 tools, 5 commands, 3 channels
**Right:** Separate concerns into focused plugins

### ❌ Polling Instead of Events
**Wrong:** Cron job checking every minute for changes
**Right:** Use webhooks or pub/sub for real-time

### ❌ Hardcoded in Skill
**Wrong:** API keys, paths, URLs in SKILL.md
**Right:** Use config references or environment variables

---

## 📊 Quick Reference Card

| I want to... | Use |
|--------------|-----|
| Teach agent a workflow | Skill |
| Inject context every turn | Hook (`agent:bootstrap`) |
| React to /new or /reset | Hook (`command:*`) |
| Add a CLI command | Plugin |
| Add agent tool | Plugin + tool schema |
| Schedule a task | Cron |
| Periodic checks | Heartbeat |
| External trigger | Webhook |
| Control device | Node command |
| New chat platform | Plugin (channel) |
| New AI model | Provider config |

---

## 🔗 Related Resources

- Full extension reference: `knowledge/dna-extension-systems.md`
- DNA docs: `/usr/local/lib/node_modules/dna/docs/`
- Hook events: `docs/hooks.md`
- Plugin guide: `docs/plugin.md`
- Tool reference: `docs/tools/index.md`

---

*This skill helps you architect DNA extensions correctly the first time.*
