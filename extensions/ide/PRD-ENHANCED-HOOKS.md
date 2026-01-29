# PRD: Enhanced Hook System for DNA

**Author:** Clawd + Ivan  
**Date:** 2026-01-29  
**Status:** Draft  
**Priority:** High  
**Estimated Effort:** 40-60 hours  

---

## Executive Summary

Upgrade DNA's hook system to match and exceed Claude Code's capabilities. The current system supports basic lifecycle events but lacks the power, flexibility, and developer experience of modern agent hook systems.

**Goal:** Make DNA's hooks the most powerful and developer-friendly in the ecosystem.

---

## Current State Analysis

### What Works
- Basic lifecycle events (`agent:bootstrap`, `command:new`, `gateway:startup`)
- HOOK.md + handler.js pattern
- Config-based enable/disable
- Workspace hooks directory

### What's Missing (vs Claude Code)
| Feature | Claude Code | DNA | Gap |
|---------|-------------|----------|-----|
| Tool hooks (before/after) | ✅ PreToolUse/PostToolUse | ❌ | Critical |
| Pattern matchers | ✅ Regex on tool names | ❌ | High |
| Exit code control | ✅ Exit 2 = block | ❌ | High |
| JSON stdin context | ✅ Full context | ❌ | Medium |
| Permission hooks | ✅ PermissionRequest | ❌ | Medium |
| Subagent hooks | ✅ SubagentStop | ❌ | Medium |
| Shell command hooks | ✅ Native | ❌ JS only | Low |

---

## Proposed Solution

### Phase 1: New Event Types (Week 1)
**Priority: Critical**

Add these events to the hook system:

```javascript
// Tool lifecycle
'tool:before'      // Before any tool call (can block)
'tool:after'       // After tool completes (can modify output)

// Message lifecycle  
'message:before'   // Before processing user message
'message:after'    // After assistant reply generated

// Permission
'permission:request'  // When tool needs permission (can auto-approve)

// Subagent
'subagent:start'   // When subagent spawned
'subagent:stop'    // When subagent completes

// Error handling
'tool:error'       // When a tool call fails (for auto-retry or follow-up)

// Behavioral enforcement (NEW - from Ivan's feedback)
'assistant:idle'   // When assistant doesn't respond within X seconds after tool call
'commitment:detected' // When assistant commits to an action ("let me check...")
'subagent:stop'    // When subagent completes

// Compaction
'compact:before'   // Before context compaction
'compact:after'    // After compaction complete
```

**Implementation:**
```javascript
// In gateway's tool executor
async executeTool(toolName, input, context) {
  // Fire tool:before hooks
  const beforeResult = await this.hooks.fire('tool:before', {
    tool: toolName,
    input,
    context,
    block: false  // hooks can set this to true
  });
  
  if (beforeResult.block) {
    return { blocked: true, reason: beforeResult.reason };
  }
  
  // Execute tool
  const output = await this.tools[toolName](input);
  
  // Fire tool:after hooks
  const afterResult = await this.hooks.fire('tool:after', {
    tool: toolName,
    input,
    output,
    context
  });
  
  return afterResult.output ?? output;
}
```

### Phase 2: Pattern Matchers (Week 1-2)
**Priority: High**

Allow hooks to specify which tools/events they care about:

```yaml
# HOOK.md
---
name: format-on-save
metadata:
  dna:
    events: ["tool:after"]
    matchers:
      - "Edit|Write"        # Regex pattern
      - "file_path: *.ts"   # Field pattern
---
```

```javascript
// handler.js
module.exports = {
  name: 'format-on-save',
  events: ['tool:after'],
  matchers: ['Edit|Write'],  // Only run for Edit or Write tools
  
  async handler(context) {
    const { tool, input, output } = context;
    if (input.file_path?.endsWith('.ts')) {
      await exec(`npx prettier --write "${input.file_path}"`);
    }
  }
};
```

### Phase 3: Hook Control Flow (Week 2)
**Priority: High**

Let hooks control agent behavior via return values:

```javascript
module.exports = {
  name: 'production-guard',
  events: ['tool:before'],
  matchers: ['Edit|Write|Bash'],
  
  async handler(context) {
    const { tool, input } = context;
    
    // Check for production files
    if (input.file_path?.includes('/prod/') || 
        input.command?.includes('production')) {
      return {
        block: true,
        reason: '🛑 Production files require explicit approval',
        feedback: 'Please confirm you want to modify production files.'
      };
    }
    
    // Allow to proceed
    return { block: false };
  }
};
```

**Control Flow Options:**
| Return Value | Effect |
|--------------|--------|
| `{ block: true, reason }` | Stop the action, show reason |
| `{ block: false }` | Allow action to proceed |
| `{ modify: true, input: {...} }` | Modify input before tool runs |
| `{ feedback: "..." }` | Inject feedback into agent context |
| `{ output: {...} }` | Override tool output (tool:after only) |

### Phase 4: Rich Context (Week 2-3)
**Priority: Medium**

Pass comprehensive context to hooks:

```javascript
// Context object passed to all hooks
{
  // Event info
  event: 'tool:before',
  timestamp: '2026-01-29T10:00:00Z',
  
  // Tool info (for tool events)
  tool: 'Edit',
  input: { file_path: 'src/app.js', content: '...' },
  output: null,  // Populated for tool:after
  
  // Session info
  session: {
    key: 'whatsapp:+19168329521',
    channel: 'whatsapp',
    contextUsage: 0.65,  // 65%
    messageCount: 42,
    startedAt: '2026-01-29T09:00:00Z'
  },
  
  // User info
  user: {
    id: '+19168329521',
    isOwner: true
  },
  
  // Recent context
  recentMessages: [
    { role: 'user', content: 'Fix the login bug' },
    { role: 'assistant', content: 'I\'ll look at...' }
  ],
  
  // Workspace
  workspace: '/Users/nutic/clawd',
  
  // Helpers
  helpers: {
    log: (msg) => { /* structured logging */ },
    inject: (text) => { /* inject into context */ },
    getMemory: (key) => { /* read from memory */ },
    setMemory: (key, value) => { /* write to memory */ }
  }
}
```

### Phase 5: Shell Command Hooks (Week 3)
**Priority: Medium**

Support simple shell commands as hooks (like Claude Code):

```yaml
# HOOK.md
---
name: log-commands
metadata:
  dna:
    events: ["tool:after"]
    matchers: ["Bash"]
    type: "shell"  # Shell command instead of JS
    command: "jq -r '.input.command' >> ~/.dna/command-log.txt"
---
```

**Shell hooks receive JSON on stdin:**
```json
{
  "event": "tool:after",
  "tool": "Bash",
  "input": { "command": "ls -la" },
  "output": { "stdout": "..." },
  "session": { "key": "..." }
}
```

**Shell hook exit codes:**
| Exit Code | Effect |
|-----------|--------|
| 0 | Success, continue |
| 1 | Error (logged but continues) |
| 2 | Block action |
| 3 | Modify (read modified JSON from stdout) |

### Phase 6: Hook Composition & Ordering (Week 3-4)
**Priority: Medium**

Control hook execution order and dependencies:

```javascript
module.exports = {
  name: 'my-hook',
  events: ['tool:before'],
  
  // Execution control
  priority: 100,           // Higher = runs first (default: 50)
  runBefore: ['other-hook'], // Explicit ordering
  runAfter: ['setup-hook'],
  
  // Conditional execution
  when: {
    channels: ['whatsapp', 'telegram'],  // Only these channels
    users: ['+19168329521'],              // Only these users
    hours: { start: 9, end: 17 },         // Business hours only
    tools: ['Edit', 'Write'],             // Tool filter
  },
  
  async handler(context) { /* ... */ }
};
```

### Phase 7: Behavioral Enforcement Hooks (Week 3-4)
**Priority: High** *(Added based on real-world failure 2026-01-29)*

Hooks that enforce agent behavioral rules (SOUL.md compliance):

#### 7.1 Task Completion Guard

**Problem:** Agent says "Let me check..." then goes silent, requiring user to ask "Did you check?"

**Solution:** `commitment:detected` and `assistant:idle` events

```javascript
// commitment:detected fires when assistant uses commitment phrases
module.exports = {
  name: 'task-completion-guard',
  events: ['commitment:detected'],
  
  async handler({ commitment, timeoutMs = 30000 }) {
    // Start a timer - if no follow-up within timeoutMs, inject reminder
    return {
      trackCompletion: true,
      timeoutMs,
      onTimeout: {
        systemNote: "⏰ You committed to check something. Report the results."
      }
    };
  }
};
```

#### 7.2 Tool Error Recovery

**Problem:** Tool call fails, agent doesn't retry or explain

**Solution:** `tool:error` event

```javascript
module.exports = {
  name: 'tool-error-handler', 
  events: ['tool:error'],
  
  async handler({ tool, error, input }) {
    // Log the error
    console.error(`Tool ${tool} failed:`, error);
    
    // Inject guidance
    return {
      systemNote: `⚠️ Tool "${tool}" failed: ${error.message}\nRetry or explain to user.`
    };
  }
};
```

#### 7.3 SOUL.md Rule Enforcer

**Problem:** Agent violates behavioral rules defined in SOUL.md

**Solution:** Hook that parses SOUL.md rules and checks compliance

```javascript
module.exports = {
  name: 'soul-enforcer',
  events: ['assistant:before_reply'],
  
  async handler({ draft, soulRules }) {
    const violations = checkViolations(draft, soulRules);
    if (violations.length > 0) {
      return {
        systemNote: `⚠️ SOUL.md violation: ${violations[0].rule}\n${violations[0].guidance}`
      };
    }
  }
};
```

#### Commitment Detection Patterns

```javascript
const COMMITMENT_PATTERNS = [
  /let me (check|verify|test|run|look|restart)/i,
  /I'll (check|verify|run|restart|investigate)/i,
  /checking now/i,
  /one moment/i,
  /hold on/i,
];
```

---

### Phase 8: Hook DevEx (Week 4)
**Priority: Low**

Developer experience improvements:

1. **Hook Generator CLI:**
```bash
dna hooks create my-hook --event tool:before --matcher "Edit|Write"
```

2. **Hook Testing:**
```bash
dna hooks test my-hook --event tool:before --input '{"file_path": "test.js"}'
```

3. **Hook Debugging:**
```bash
dna hooks debug  # Live view of hook executions
```

4. **Hook Marketplace:**
- Share hooks on ClawdHub
- One-click install
- Version management

---

## Migration Path

### For Existing Hooks

Old hooks using `agent:bootstrap` continue to work. New events are additive.

### Gradual Adoption

1. Add new events without breaking changes
2. Document migration for each hook type
3. Provide codemods for common patterns

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Hook events available | 15+ (from current 10) |
| Hooks with matchers | 80% of new hooks |
| Hook execution latency | <50ms p99 |
| Community hooks on ClawdHub | 50+ in 6 months |

---

## Technical Considerations

### Performance
- Hooks run in parallel where possible
- Matcher compilation cached
- Shell hooks run in subprocess pool

### Security
- Hooks run with user's permissions
- No network access by default (opt-in)
- Sandboxed execution option

### Backwards Compatibility
- All existing hooks continue to work
- New features are opt-in
- Deprecation warnings for old patterns

---

## Implementation Timeline

| Phase | Scope | Estimate | Dependencies |
|-------|-------|----------|--------------|
| 1 | New event types | 8-12h | Core gateway changes |
| 2 | Pattern matchers | 8-12h | Phase 1 |
| 3 | Hook control flow | 6-10h | Phase 1 |
| 4 | Rich context | 6-8h | Phase 1 |
| 5 | Shell command hooks | 8-10h | Phase 4 |
| 6 | Composition & ordering | 6-8h | Phase 2 |
| 7 | DevEx improvements | 8-12h | All phases |

**Total: 50-72 hours**

---

## Open Questions

1. **Hook timeout:** What's the max execution time before killing a hook?
2. **Hook failures:** Should a failing hook block the action or log and continue?
3. **Hook permissions:** Should hooks have their own permission model?
4. **Async hooks:** Support for long-running hooks that don't block?

---

## References

- [Claude Code Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
- [OpenAI Codex Hooks PR](https://github.com/openai/codex/pull/9796)
- [DNA Hooks Docs](https://docs.clawd.bot/hooks)

---

## Appendix: Example Hooks

### A. Auto-Format on Save
```javascript
module.exports = {
  name: 'auto-format',
  events: ['tool:after'],
  matchers: ['Edit|Write'],
  
  async handler({ input }) {
    const { file_path } = input;
    if (file_path.endsWith('.ts')) {
      await exec(`npx prettier --write "${file_path}"`);
    } else if (file_path.endsWith('.go')) {
      await exec(`gofmt -w "${file_path}"`);
    }
  }
};
```

### B. Production File Guard
```javascript
module.exports = {
  name: 'prod-guard',
  events: ['tool:before'],
  matchers: ['Edit|Write|Bash'],
  
  async handler({ input, helpers }) {
    const dangerous = ['/prod/', '.env', 'secrets'];
    const path = input.file_path || input.command || '';
    
    if (dangerous.some(d => path.includes(d))) {
      return {
        block: true,
        feedback: '🛑 This action affects production. Please confirm explicitly.'
      };
    }
  }
};
```

### C. Command Logger
```yaml
# HOOK.md - Shell hook example
---
name: command-logger
metadata:
  dna:
    events: ["tool:after"]
    matchers: ["Bash"]
    type: "shell"
    command: |
      jq -r '"[\(.timestamp)] \(.input.command)"' >> ~/.dna/commands.log
---
```

### D. Context Alert
```javascript
module.exports = {
  name: 'context-alert',
  events: ['message:after'],
  
  async handler({ session, helpers }) {
    if (session.contextUsage > 0.8) {
      helpers.inject('\n\n⚠️ Context at ' + 
        Math.round(session.contextUsage * 100) + 
        '%. Consider `/compact` or `/new`.');
    }
  }
};
```

### E. Permission Auto-Approve
```javascript
module.exports = {
  name: 'auto-approve-read',
  events: ['permission:request'],
  
  async handler({ tool, input }) {
    // Auto-approve read operations
    if (tool === 'Read' || tool === 'Glob') {
      return { approve: true };
    }
    // Block dangerous writes
    if (input.file_path?.includes('node_modules')) {
      return { deny: true, reason: 'Cannot modify node_modules' };
    }
    // Let user decide
    return { prompt: true };
  }
};
```
