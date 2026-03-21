<overview>
Agent execution patterns for building robust agent loops. This covers how agents signal completion, track partial progress for resume, select appropriate model tiers, and handle context limits.
</overview>

<completion_signals>
## Completion Signals

Agents need an explicit way to say "I'm done."

### Anti-Pattern: Heuristic Detection

Detecting completion through heuristics is fragile:

- Consecutive iterations without tool calls
- Checking for expected output files
- Tracking "no progress" states
- Time-based timeouts

These break in edge cases and create unpredictable behavior.

### Pattern: Explicit Completion Tool

Provide a `complete_task` tool that:
- Takes a summary of what was accomplished
- Returns a signal that stops the loop
- Works identically across all agent types

```typescript
tool("complete_task", {
  summary: z.string().describe("Summary of what was accomplished"),
  status: z.enum(["success", "partial", "blocked"]).optional(),
}, async ({ summary, status = "success" }) => {
  return {
    text: summary,
    shouldContinue: false,  // Key: signals loop should stop
  };
});
```

### The ToolResult Pattern

Structure tool results to separate success from continuation:

```swift
struct ToolResult {
    let success: Bool           // Did tool succeed?
    let output: String          // What happened?
    let shouldContinue: Bool    // Should agent loop continue?
}

// Three common cases:
extension ToolResult {
    static func success(_ output: String) -> ToolResult {
        // Tool succeeded, keep going
        ToolResult(success: true, output: output, shouldContinue: true)
    }

    static func error(_ message: String) -> ToolResult {
        // Tool failed but recoverable, agent can try something else
        ToolResult(success: false, output: message, shouldContinue: true)
    }

    static func complete(_ summary: String) -> ToolResult {
        // Task done, stop the loop
        ToolResult(success: true, output: summary, shouldContinue: false)
    }
}
```

### Key Insight

**This is different from success/failure:**

- A tool can **succeed** AND signal **stop** (task complete)
- A tool can **fail** AND signal **continue** (recoverable error, try something else)

```typescript
// Examples:
read_file("/missing.txt")
// → { success: false, output: "File not found", shouldContinue: true }
// Agent can try a different file or ask for clarification

complete_task("Organized all downloads into folders")
// → { success: true, output: "...", shouldContinue: false }
// Agent is done

write_file("/output.md", content)
// → { success: true, output: "Wrote file", shouldContinue: true }
// Agent keeps working toward the goal
```

### System Prompt Guidance

Tell the agent when to complete:

```markdown
## Completing Tasks

When you've accomplished the user's request:
1. Verify your work (read back files you created, check results)
2. Call `complete_task` with a summary of what you did
3. Don't keep working after the goal is achieved

If you're blocked and can't proceed:
- Call `complete_task` with status "blocked" and explain why
- Don't loop forever trying the same thing
```
</completion_signals>

<partial_completion>
## Partial Completion

For multi-step tasks, track progress at the task level for resume capability.

### Task State Tracking

```swift
enum TaskStatus {
    case pending      // Not yet started
    case inProgress   // Currently working on
    case completed    // Finished successfully
    case failed       // Couldn't complete (with reason)
    case skipped      // Intentionally not done
}

struct AgentTask {
    let id: String
    let description: String
    var status: TaskStatus
    var notes: String?  // Why it failed, what was done
}

struct AgentSession {
    var tasks: [AgentTask]

    var isComplete: Bool {
        tasks.allSatisfy { $0.status == .completed || $0.status == .skipped }
    }

    var progress: (completed: Int, total: Int) {
        let done = tasks.filter { $0.status == .completed }.count
        return (done, tasks.count)
    }
}
```

### UI Progress Display

Show users what's happening:

```
Progress: 3/5 tasks complete (60%)
✅ [1] Find source materials
✅ [2] Download full text
✅ [3] Extract key passages
❌ [4] Generate summary - Error: context limit exceeded
⏳ [5] Create outline - Pending
```

### Partial Completion Scenarios

**Agent hits max iterations before finishing:**
- Some tasks completed, some pending
- Checkpoint saved with current state
- Resume continues from where it left off, not from beginning

**Agent fails on one task:**
- Task marked `.failed` with error in notes
- Other tasks may continue (agent decides)
- Orchestrator doesn't automatically abort entire session

**Network error mid-task:**
- Current iteration throws
- Session marked `.failed`
- Checkpoint preserves messages up to that point
- Resume possible from checkpoint

### Checkpoint Structure

```swift
struct AgentCheckpoint: Codable {
    let sessionId: String
    let agentType: String
    let messages: [Message]          // Full conversation history
    let iterationCount: Int
    let tasks: [AgentTask]           // Task state
    let customState: [String: Any]   // Agent-specific state
    let timestamp: Date

    var isValid: Bool {
        // Checkpoints expire (default 1 hour)
        Date().timeIntervalSince(timestamp) < 3600
    }
}
```

### Resume Flow

1. On app launch, scan for valid checkpoints
2. Show user: "You have an incomplete session. Resume?"
3. On resume:
   - Restore messages to conversation
   - Restore task states
   - Continue agent loop from where it left off
4. On dismiss:
   - Delete checkpoint
   - Start fresh if user tries again
</partial_completion>

<model_tier_selection>
## Model Tier Selection

Different agents need different intelligence levels. Use the cheapest model that achieves the outcome.

### Tier Guidelines

| Agent Type | Recommended Tier | Reasoning |
|------------|-----------------|-----------|
| Chat/Conversation | Balanced (Sonnet) | Fast responses, good reasoning |
| Research | Balanced (Sonnet) | Tool loops, not ultra-complex synthesis |
| Content Generation | Balanced (Sonnet) | Creative but not synthesis-heavy |
| Complex Analysis | Powerful (Opus) | Multi-document synthesis, nuanced judgment |
| Profile Generation | Powerful (Opus) | Photo analysis, complex pattern recognition |
| Quick Queries | Fast (Haiku) | Simple lookups, quick transformations |
| Simple Classification | Fast (Haiku) | High volume, simple decisions |

### Implementation

```swift
enum ModelTier {
    case fast      // claude-3-haiku: Quick, cheap, simple tasks
    case balanced  // claude-sonnet: Good balance for most tasks
    case powerful  // claude-opus: Complex reasoning, synthesis

    var modelId: String {
        switch self {
        case .fast: return "claude-3-haiku-20240307"
        case .balanced: return "claude-sonnet-4-20250514"
        case .powerful: return "claude-opus-4-20250514"
        }
    }
}

struct AgentConfig {
    let name: String
    let modelTier: ModelTier
    let tools: [AgentTool]
    let systemPrompt: String
    let maxIterations: Int
}

// Examples
let researchConfig = AgentConfig(
    name: "research",
    modelTier: .balanced,
    tools: researchTools,
    systemPrompt: researchPrompt,
    maxIterations: 20
)

let quickLookupConfig = AgentConfig(
    name: "lookup",
    modelTier: .fast,
    tools: [readLibrary],
    systemPrompt: "Answer quick questions about the user's library.",
    maxIterations: 3
)
```

### Cost Optimization Strategies

1. **Start with balanced, upgrade if quality insufficient**
2. **Use fast tier for tool-heavy loops** where each turn is simple
3. **Reserve powerful tier for synthesis tasks** (comparing multiple sources)
4. **Consider token limits per turn** to control costs
5. **Cache expensive operations** to avoid repeated calls
</model_tier_selection>

<context_limits>
## Context Limits

Agent sessions can extend indefinitely, but context windows don't. Design for bounded context from the start.

### The Problem

```
Turn 1: User asks question → 500 tokens
Turn 2: Agent reads file → 10,000 tokens
Turn 3: Agent reads another file → 10,000 tokens
Turn 4: Agent researches → 20,000 tokens
...
Turn 10: Context window exceeded
```

### Design Principles

**1. Tools should support iterative refinement**

Instead of all-or-nothing, design for summary → detail → full:

```typescript
// Good: Supports iterative refinement
tool("read_file", {
  path: z.string(),
  preview: z.boolean().default(true),  // Return first 1000 chars by default
  full: z.boolean().default(false),    // Opt-in to full content
}, ...);

tool("search_files", {
  query: z.string(),
  summaryOnly: z.boolean().default(true),  // Return matches, not full files
}, ...);
```

**2. Provide consolidation tools**

Give agents a way to consolidate learnings mid-session:

```typescript
tool("summarize_and_continue", {
  keyPoints: z.array(z.string()),
  nextSteps: z.array(z.string()),
}, async ({ keyPoints, nextSteps }) => {
  // Store summary, potentially truncate earlier messages
  await saveSessionSummary({ keyPoints, nextSteps });
  return { text: "Summary saved. Continuing with focus on: " + nextSteps.join(", ") };
});
```

**3. Design for truncation**

Assume the orchestrator may truncate early messages. Important context should be:
- In the system prompt (always present)
- In files (can be re-read)
- Summarized in context.md

### Implementation Strategies

```swift
class AgentOrchestrator {
    let maxContextTokens = 100_000
    let targetContextTokens = 80_000  // Leave headroom

    func shouldTruncate() -> Bool {
        estimateTokens(messages) > targetContextTokens
    }

    func truncateIfNeeded() {
        if shouldTruncate() {
            // Keep system prompt + recent messages
            // Summarize or drop older messages
            messages = [systemMessage] + summarizeOldMessages() + recentMessages
        }
    }
}
```

### System Prompt Guidance

```markdown
## Managing Context

For long tasks, periodically consolidate what you've learned:
1. If you've gathered a lot of information, summarize key points
2. Save important findings to files (they persist beyond context)
3. Use `summarize_and_continue` if the conversation is getting long

Don't try to hold everything in memory. Write it down.
```
</context_limits>

<orchestrator_pattern>
## Unified Agent Orchestrator

One execution engine, many agent types. All agents use the same orchestrator with different configurations.

```swift
class AgentOrchestrator {
    static let shared = AgentOrchestrator()

    func run(config: AgentConfig, userMessage: String) async -> AgentResult {
        var messages: [Message] = [
            .system(config.systemPrompt),
            .user(userMessage)
        ]

        var iteration = 0

        while iteration < config.maxIterations {
            // Get agent response
            let response = await claude.message(
                model: config.modelTier.modelId,
                messages: messages,
                tools: config.tools
            )

            messages.append(.assistant(response))

            // Process tool calls
            for toolCall in response.toolCalls {
                let result = await executeToolCall(toolCall, config: config)
                messages.append(.toolResult(result))

                // Check for completion signal
                if !result.shouldContinue {
                    return AgentResult(
                        status: .completed,
                        output: result.output,
                        iterations: iteration + 1
                    )
                }
            }

            // No tool calls = agent is responding, might be done
            if response.toolCalls.isEmpty {
                // Could be done, or waiting for user
                break
            }

            iteration += 1
        }

        return AgentResult(
            status: iteration >= config.maxIterations ? .maxIterations : .responded,
            output: messages.last?.content ?? "",
            iterations: iteration
        )
    }
}
```

### Benefits

- Consistent lifecycle management across all agent types
- Automatic checkpoint/resume (critical for mobile)
- Shared tool protocol
- Easy to add new agent types
- Centralized error handling and logging
</orchestrator_pattern>

<checklist>
## Agent Execution Checklist

### Completion Signals
- [ ] `complete_task` tool provided (explicit completion)
- [ ] No heuristic completion detection
- [ ] Tool results include `shouldContinue` flag
- [ ] System prompt guides when to complete

### Partial Completion
- [ ] Tasks tracked with status (pending, in_progress, completed, failed)
- [ ] Checkpoints saved for resume
- [ ] Progress visible to user
- [ ] Resume continues from where left off

### Model Tiers
- [ ] Tier selected based on task complexity
- [ ] Cost optimization considered
- [ ] Fast tier for simple operations
- [ ] Powerful tier reserved for synthesis

### Context Limits
- [ ] Tools support iterative refinement (preview vs full)
- [ ] Consolidation mechanism available
- [ ] Important context persisted to files
- [ ] Truncation strategy defined
</checklist>
