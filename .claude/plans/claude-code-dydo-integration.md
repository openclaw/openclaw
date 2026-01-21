# Claude Code ↔ DyDo Integration Redesign

## Problem Statement

Currently, when Claude Code asks questions or needs decisions, the orchestrator makes **isolated API calls** to `claude-sonnet-4`:
- No conversation context from DyDo's main session
- No memory of user's preferences/history
- Questions don't flow through DyDo naturally
- DyDo can't ask the user for input on complex decisions

Additionally, `/claude` commands bypass DyDo entirely:
- User instruction goes directly to Claude Code
- DyDo has no opportunity to understand the task first
- DyDo lacks project context for better decision-making

## Design Decision

**Approach B: Keep /claude but add DyDo planning phase**

When user runs `/claude juzi implement dark mode`:
1. DyDo intercepts and analyzes the task
2. DyDo loads/explores project context
3. DyDo may ask clarifying questions
4. DyDo spawns Claude Code with enriched prompt
5. DyDo guides the session with full context

## Project Context Storage

**Location:** `/Users/dydo/clawd/projects/<project-name>/`

```
/Users/dydo/clawd/projects/
├── juzi/
│   ├── context.yaml       # Cached project context
│   ├── exploration.md     # DyDo's notes from exploring
│   └── sessions.jsonl     # History of Claude Code sessions
├── clawdbot/
│   ├── context.yaml
│   └── ...
└── monitor-v3/            # Already exists
    └── ...
```

**context.yaml structure:**
```yaml
name: juzi
path: /Users/dydo/Documents/agent/juzi
lastExplored: 2024-01-21T10:30:00Z

# Auto-detected
type: "React + TypeScript"
packageManager: pnpm
testFramework: vitest

# From exploration
structure:
  src/components/: "React components"
  src/hooks/: "Custom hooks"
  src/context/: "React contexts (ThemeContext, AuthContext)"
  src/styles/: "CSS files with variables"

conventions:
  - "Functional components with hooks"
  - "CSS variables for theming"
  - "Tests colocated in __tests__"

# From CLAUDE.md if exists
claudeMd: |
  ... contents ...

# DyDo's learned preferences
preferences:
  - "User prefers Tailwind over styled-components"
  - "Always run tests after changes"
```

## Existing Infrastructure

clawdbot already has robust subagent communication:

```
┌─────────────────────────────────────────────────────────────────┐
│ queueEmbeddedPiMessage(sessionId, text)                         │
│ - Injects message into active DyDo run                          │
│ - Returns true if DyDo is streaming and message was queued      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ maybeQueueSubagentAnnounce()                                    │
│ - Routes triggers to main agent based on queue mode             │
│ - Modes: steer, steer-backlog, followup, collect, interrupt     │
└─────────────────────────────────────────────────────────────────┘
```

## Proposed Solution

Route Claude Code questions through DyDo's main conversation using a **tool-based response mechanism**.

### Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ 1. Claude Code asks question                                         │
│    onQuestion("Should I use TypeScript or JavaScript?")              │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 2. Build trigger message for DyDo                                    │
│    "[Claude Code Question - Project: juzi]                           │
│     Claude Code asks: Should I use TypeScript or JavaScript?         │
│     Use claude_code_respond tool to answer."                         │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 3. Steer into DyDo's active conversation                             │
│    queueEmbeddedPiMessage(dyDoSessionId, trigger)                    │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 4. DyDo processes question with FULL CONTEXT                         │
│    - Knows user's preferences                                        │
│    - Has conversation history                                        │
│    - Can ask user if unsure                                          │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 5. DyDo calls claude_code_respond tool                               │
│    claude_code_respond({                                             │
│      sessionId: "abc123",                                            │
│      response: "Use TypeScript - this project uses strict typing"    │
│    })                                                                │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 6. Response routed back to Claude Code                               │
│    emitClaudeCodeResponse(sessionId, response)                       │
│    → Resolves the waiting Promise in onQuestion                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Key Components

#### 1. Response Queue (New File: `claude-code-response-queue.ts`)

```typescript
/**
 * Queue for Claude Code responses waiting from DyDo.
 * Allows bidirectional communication: CC question → DyDo → CC answer
 */

type PendingResponse = {
  resolve: (response: string | null) => void;
  timeout: NodeJS.Timeout;
  questionText: string;
  projectName: string;
};

const pendingResponses = new Map<string, PendingResponse>();

/**
 * Wait for DyDo's response to a Claude Code question.
 */
export function waitForDyDoResponse(
  sessionId: string,
  timeoutMs = 60000
): Promise<string | null>;

/**
 * Emit a response from DyDo to a waiting Claude Code session.
 * Called by the claude_code_respond tool.
 */
export function emitClaudeCodeResponse(
  sessionId: string,
  response: string
): boolean;

/**
 * Check if a session is waiting for a response.
 */
export function isWaitingForResponse(sessionId: string): boolean;

/**
 * Get pending question info (for DyDo context).
 */
export function getPendingQuestion(sessionId: string): {
  questionText: string;
  projectName: string;
} | undefined;
```

#### 2. DyDo Tool (New in `clawdbot-tools.ts`)

```typescript
/**
 * Tool for DyDo to respond to Claude Code questions.
 */
export function createClaudeCodeRespondTool(): AnyAgentTool {
  return {
    label: "Claude Code",
    name: "claude_code_respond",
    description:
      "Send a response to a Claude Code session that is waiting for input. " +
      "Use this when you see a Claude Code question and want to provide an answer.",
    parameters: Type.Object({
      sessionId: Type.String({ description: "The Claude Code session ID" }),
      response: Type.String({ description: "Your response to Claude Code's question" }),
    }),
    execute: async (_toolCallId, args) => {
      const { sessionId, response } = args as { sessionId: string; response: string };

      const success = emitClaudeCodeResponse(sessionId, response);

      if (success) {
        return jsonResult({
          status: "sent",
          message: `Response sent to Claude Code session ${sessionId.slice(0,8)}`
        });
      }

      return jsonResult({
        status: "not_found",
        message: "No pending question for this session"
      });
    },
  };
}
```

#### 3. Modified onQuestion Callback (Update `commands-claude.ts`)

```typescript
onQuestion: async (questionText) => {
  if (!sessionId) return null;

  // Show question in Telegram UI
  await sendQuestionToChat({ sessionId, questionText });

  // Get DyDo's session ID from the command context
  const dyDoSessionId = params.ctx.SessionId; // or resolve from session store

  // Build trigger message for DyDo
  const trigger = buildClaudeCodeQuestionTrigger({
    sessionId,
    projectName,
    taskDescription: originalPrompt,
    questionText,
  });

  // Try to steer into DyDo's active conversation
  if (dyDoSessionId) {
    const steered = queueEmbeddedPiMessage(dyDoSessionId, trigger);

    if (steered) {
      // DyDo is active - wait for tool response
      const response = await waitForDyDoResponse(sessionId, 60000);

      if (response) {
        logVerbose(`[claude-code] DyDo responded: ${response.slice(0, 100)}...`);
        return response;
      }

      // DyDo didn't respond in time - fall through to fallback
      logVerbose(`[claude-code] DyDo timeout - using fallback`);
    }
  }

  // Fallback: Use isolated orchestrator (current behavior)
  // This handles cases where DyDo is not active
  const context: OrchestratorContext = {
    projectName,
    workingDir,
    resumeToken: resumeToken ?? "",
    originalTask: originalPrompt,
    recentActions: state?.recentActions ?? [],
  };

  return generateOrchestratorResponse(context, questionText);
}
```

#### 4. DyDo System Prompt Addition

Add to DyDo's system prompt:

```
## Claude Code Sessions

You may receive messages about Claude Code sessions asking questions.
These look like:

[Claude Code Question - Session abc123]
Project: juzi
Task: implement the auth system
Claude Code asks: Should I use bcrypt or argon2 for password hashing?

When you see these:
1. Consider the context - the project, task, and your conversation history with the user
2. If you can make a reasonable decision, use the `claude_code_respond` tool
3. If you need user input, tell the user what Claude Code is asking and wait for their response
4. Then use `claude_code_respond` with the answer

Example responses:
- Simple decision: claude_code_respond(sessionId, "Use argon2 - it's more modern and secure")
- Need user input: "Claude Code is asking about password hashing. Should I tell it to use bcrypt or argon2?"
```

### Fallback Strategy

When DyDo is NOT active (not streaming), the system falls back to:

1. **Primary**: Try to trigger DyDo via queue/followup mode
2. **Secondary**: Use isolated orchestrator (current behavior) for time-sensitive questions
3. **Tertiary**: For non-urgent questions, queue until DyDo becomes active

### Event Categories

| Event Type | Routing | Rationale |
|------------|---------|-----------|
| Question (needs answer) | Steer into DyDo | Needs context + may need user input |
| Tool call (progress) | Update bubble only | UI concern, no decision needed |
| Completion | Announce to DyDo | Inform user naturally |
| Error | Announce to DyDo + bubble | Needs user awareness |
| Idle (auto-continue?) | DyDo decides | Context-dependent decision |

### Implementation Steps

**Phase 1: Response Queue Infrastructure**
- [ ] Create `src/agents/claude-code/response-queue.ts`
- [ ] Implement `waitForDyDoResponse()`, `emitClaudeCodeResponse()`
- [ ] Add tests for queue behavior

**Phase 2: DyDo Tool**
- [ ] Add `claude_code_respond` tool to clawdbot-tools.ts
- [ ] Register tool in tool builder
- [ ] Add tests for tool execution

**Phase 3: Question Routing**
- [ ] Modify `onQuestion` in commands-claude.ts
- [ ] Get DyDo's sessionId from context
- [ ] Build question trigger messages
- [ ] Implement steer + fallback logic

**Phase 4: DyDo System Prompt**
- [ ] Add Claude Code handling instructions
- [ ] Document tool usage patterns
- [ ] Add examples

**Phase 5: Testing & Refinement**
- [ ] Test with active DyDo session
- [ ] Test fallback when DyDo inactive
- [ ] Test user-input flow (DyDo asks user)
- [ ] Tune timeouts

### Open Questions

1. **Session ID resolution**: How to get DyDo's sessionId in the command handler?
   - Option A: Store in context when /claude command starts
   - Option B: Resolve from session store using channel/accountId
   - Recommendation: Option B - more robust

2. **Timeout duration**: How long to wait for DyDo's response?
   - Too short: Falls back unnecessarily
   - Too long: Claude Code waits too long
   - Recommendation: 60s with progress indicator

3. **Multiple questions**: What if Claude Code asks multiple questions rapidly?
   - Queue them separately
   - DyDo can batch-respond if needed
   - Each question has its own pending entry

4. **Conversation pollution**: Every question injects into DyDo's context
   - Keep trigger messages concise
   - Consider summarizing after session ends
   - Maybe: Special "Claude Code context" that doesn't persist

### Success Criteria

- [ ] Claude Code questions appear in DyDo's conversation naturally
- [ ] DyDo can answer with full context awareness
- [ ] DyDo can ask user for input when needed
- [ ] Fallback to isolated orchestrator works when DyDo inactive
- [ ] No significant latency increase for simple questions
- [ ] Telegram bubble still shows question indicator

---

## Part 2: DyDo Planning Phase

### Overview

Instead of `/claude` bypassing DyDo, the command triggers a planning phase where DyDo:
1. Receives and analyzes the task
2. Loads or explores project context
3. Asks clarifying questions if needed
4. Formulates an enriched prompt
5. Spawns Claude Code with full context

### Flow Diagram

```
User: "/claude juzi implement dark mode"
              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 1. Command Handler intercepts /claude                           │
│    - Extracts: project="juzi", task="implement dark mode"       │
│    - Does NOT spawn Claude Code directly                        │
│    - Routes to DyDo's conversation as a planning request        │
└─────────────────────────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. DyDo receives planning request                               │
│                                                                 │
│    "[Claude Code Planning Request]                              │
│     Project: juzi                                               │
│     Task: implement dark mode                                   │
│                                                                 │
│     Please analyze this task and prepare a Claude Code session. │
│     Use the project_context tool to load/explore the project."  │
└─────────────────────────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. DyDo loads project context                                   │
│                                                                 │
│    project_context({ project: "juzi", action: "load" })         │
│    → Returns cached context or triggers exploration             │
│                                                                 │
│    If stale or missing:                                         │
│    project_context({ project: "juzi", action: "explore" })      │
│    → DyDo explores repo, updates context.yaml                   │
└─────────────────────────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. DyDo analyzes task with context                              │
│                                                                 │
│    "juzi is a React app with CSS variables for theming.         │
│     There's already a ThemeContext in src/context/.             │
│     The task 'implement dark mode' should:                      │
│     - Add dark theme CSS variables                              │
│     - Extend ThemeContext with dark mode state                  │
│     - Add UI toggle component"                                  │
└─────────────────────────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. DyDo asks clarifying questions (optional)                    │
│                                                                 │
│    DyDo → User: "For dark mode, should I:                       │
│    1. Auto-detect system preference?                            │
│    2. Just add a manual toggle?                                 │
│    3. Both with override?"                                      │
│                                                                 │
│    User → DyDo: "Both with override"                            │
└─────────────────────────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6. DyDo spawns Claude Code with enriched prompt                 │
│                                                                 │
│    claude_code_start({                                          │
│      project: "juzi",                                           │
│      prompt: `Implement dark mode for this React app.           │
│                                                                 │
│        Context:                                                 │
│        - Uses CSS variables (src/styles/variables.css)          │
│        - Has ThemeContext in src/context/ThemeContext.tsx       │
│        - User wants system preference detection with override   │
│                                                                 │
│        Requirements:                                            │
│        1. Add dark theme CSS variables                          │
│        2. Extend ThemeContext with isDarkMode state             │
│        3. Add useMediaQuery for system preference               │
│        4. Create DarkModeToggle component                       │
│        5. Persist preference to localStorage`,                  │
│      context: { ... loaded context ... }                        │
│    })                                                           │
└─────────────────────────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 7. Claude Code session runs with DyDo guidance                  │
│                                                                 │
│    - DyDo has full context for answering questions              │
│    - DyDo remembers user's "both with override" preference      │
│    - Telegram bubble shows progress                             │
│    - Part 1 (response queue) handles Q&A                        │
└─────────────────────────────────────────────────────────────────┘
```

### New Tools for DyDo

#### 1. `project_context` - Load/explore project context

```typescript
{
  name: "project_context",
  description: "Load or explore a project's context for Claude Code planning",
  parameters: {
    project: string,      // Project name or path
    action: "load" | "explore" | "update",
    path?: string,        // Override path if not registered
  },
  execute: async (params) => {
    if (action === "load") {
      // Load from /Users/dydo/clawd/projects/<project>/context.yaml
      // Return cached context or indicate needs exploration
    }
    if (action === "explore") {
      // Read CLAUDE.md if exists
      // Scan directory structure
      // Detect package.json, tsconfig, etc.
      // Check git history
      // Build and cache context.yaml
    }
    if (action === "update") {
      // Merge new info into existing context
    }
  }
}
```

#### 2. `claude_code_start` - Spawn Claude Code with context

```typescript
{
  name: "claude_code_start",
  description: "Start a Claude Code session with project context",
  parameters: {
    project: string,
    prompt: string,           // Enriched prompt from DyDo
    context?: object,         // Project context to include
    workingDir?: string,      // Override working directory
    worktree?: string,        // Branch/worktree name
  },
  execute: async (params) => {
    // Store context for session
    // Spawn Claude Code via existing mechanism
    // Register session for Q&A routing
    // Return session info
  }
}
```

### Modified `/claude` Command Flow

```typescript
// In commands-claude.ts

export const handleClaudeCommand: CommandHandler = async (params) => {
  const parsed = parseClaudeCommand(params.command.commandBodyNormalized);

  // Status, cancel, say, etc. - handle directly (no change)
  if (parsed.action === "status") { ... }
  if (parsed.action === "cancel") { ... }

  // START or RESUME - route through DyDo planning
  if (parsed.action === "start" || parsed.action === "resume") {

    // Build planning request for DyDo
    const planningRequest = buildPlanningRequest({
      action: parsed.action,
      project: parsed.project,
      task: parsed.prompt,
      resumeToken: parsed.token,
    });

    // Route to DyDo's conversation
    // DyDo will use project_context and claude_code_start tools
    return {
      shouldContinue: true,  // Let DyDo handle it
      reply: null,           // DyDo will respond
      injectMessage: planningRequest,  // Inject into DyDo's context
    };
  }
};
```

### Quick Mode (Optional)

For simple tasks, allow bypassing planning:

```
/claude juzi fix typo --quick     → Direct to Claude Code (current behavior)
/claude juzi implement auth       → Through DyDo planning (new default)
```

Or detect automatically:
- Short tasks (< 5 words, obvious scope) → Quick mode
- Complex tasks → Planning mode

### Context Staleness

**When to refresh context:**
- `lastExplored` > 7 days old
- User explicitly requests: `/claude juzi --refresh`
- Project path changed
- Major version bump detected

**Incremental updates:**
- After each Claude Code session, DyDo can note learnings
- "User prefers X over Y" → Add to preferences
- New conventions discovered → Add to conventions

### Implementation Phases

**Phase 1: Project Context Infrastructure**
- [ ] Create `/Users/dydo/clawd/projects/` structure
- [ ] Implement `project_context` tool (load/explore/update)
- [ ] Build context exploration logic
- [ ] Add context.yaml read/write

**Phase 2: DyDo Planning Flow**
- [ ] Modify `/claude` to route through DyDo
- [ ] Add `claude_code_start` tool
- [ ] Build planning request format
- [ ] Connect to existing session spawning

**Phase 3: Integration with Part 1**
- [ ] Store session context for Q&A
- [ ] Pass context to response queue
- [ ] DyDo uses context when answering questions

**Phase 4: Polish**
- [ ] Add --quick flag for bypassing
- [ ] Implement context staleness detection
- [ ] Add learning/preference updates
- [ ] Test full flow

### Example Interaction

```
User: /claude juzi implement user authentication

DyDo: Let me check juzi's project context...
      [Uses project_context tool]

DyDo: I see juzi is a React + Express app. For authentication,
      I have a few questions:

      1. Session-based or JWT tokens?
      2. OAuth providers needed (Google, GitHub)?
      3. Should I add password reset flow?

User: JWT, Google OAuth only, yes to password reset

DyDo: Got it. I'll start a Claude Code session with these requirements:
      - JWT authentication with refresh tokens
      - Google OAuth integration
      - Password reset via email
      - Using your existing Express backend structure

      [Uses claude_code_start tool]

      Session started. I'll monitor progress and help if Claude Code
      has questions.

[Claude Code works, asks a question]

DyDo: Claude Code is asking whether to store JWT in localStorage
      or httpOnly cookies. Given this is a web app with sensitive
      data, I'd recommend httpOnly cookies. Should I tell it that?

User: yes

DyDo: [Uses claude_code_respond tool]
      Done. Claude Code is continuing with httpOnly cookies.
```
