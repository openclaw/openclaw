<overview>
Agent-native architecture has consequences for how products feel, not just how they're built. This document covers progressive disclosure of complexity, discovering latent demand through agent usage, and designing approval flows that match stakes and reversibility.
</overview>

<progressive_disclosure>
## Progressive Disclosure of Complexity

The best agent-native applications are simple to start but endlessly powerful.

### The Excel Analogy

Excel is the canonical example: you can use it for a grocery list, or you can build complex financial models. The same tool, radically different depths of use.

Claude Code has this quality: fix a typo, or refactor an entire codebase. The interface is the same—natural language—but the capability scales with the ask.

### The Pattern

Agent-native applications should aspire to this:

**Simple entry:** Basic requests work immediately with no learning curve
```
User: "Organize my downloads"
Agent: [Does it immediately, no configuration needed]
```

**Discoverable depth:** Users find they can do more as they explore
```
User: "Organize my downloads by project"
Agent: [Adapts to preference]

User: "Every Monday, review last week's downloads"
Agent: [Sets up recurring workflow]
```

**No ceiling:** Power users can push the system in ways you didn't anticipate
```
User: "Cross-reference my downloads with my calendar and flag
       anything I downloaded during a meeting that I haven't
       followed up on"
Agent: [Composes capabilities to accomplish this]
```

### How This Emerges

This isn't something you design directly. It **emerges naturally from the architecture:**

1. When features are prompts and tools are composable...
2. Users can start simple ("organize my downloads")...
3. And gradually discover complexity ("every Monday, review last week's...")...
4. Without you having to build each level explicitly

The agent meets users where they are.

### Design Implications

- **Don't force configuration upfront** - Let users start immediately
- **Don't hide capabilities** - Make them discoverable through use
- **Don't cap complexity** - If the agent can do it, let users ask for it
- **Do provide hints** - Help users discover what's possible
</progressive_disclosure>

<latent_demand_discovery>
## Latent Demand Discovery

Traditional product development: imagine what users want, build it, see if you're right.

Agent-native product development: build a capable foundation, observe what users ask the agent to do, formalize the patterns that emerge.

### The Shift

**Traditional approach:**
```
1. Imagine features users might want
2. Build them
3. Ship
4. Hope you guessed right
5. If wrong, rebuild
```

**Agent-native approach:**
```
1. Build capable foundation (atomic tools, parity)
2. Ship
3. Users ask agent for things
4. Observe what they're asking for
5. Patterns emerge
6. Formalize patterns into domain tools or prompts
7. Repeat
```

### The Flywheel

```
Build with atomic tools and parity
           ↓
Users ask for things you didn't anticipate
           ↓
Agent composes tools to accomplish them
(or fails, revealing a capability gap)
           ↓
You observe patterns in what's being requested
           ↓
Add domain tools or prompts to optimize common patterns
           ↓
(Repeat)
```

### What You Learn

**When users ask and the agent succeeds:**
- This is a real need
- Your architecture supports it
- Consider optimizing with a domain tool if it's common

**When users ask and the agent fails:**
- This is a real need
- You have a capability gap
- Fix the gap: add tool, fix parity, improve context

**When users don't ask for something:**
- Maybe they don't need it
- Or maybe they don't know it's possible (capability hiding)

### Implementation

**Log agent requests:**
```typescript
async function handleAgentRequest(request: string) {
  // Log what users are asking for
  await analytics.log({
    type: 'agent_request',
    request: request,
    timestamp: Date.now(),
  });

  // Process request...
}
```

**Track success/failure:**
```typescript
async function completeAgentSession(session: AgentSession) {
  await analytics.log({
    type: 'agent_session',
    request: session.initialRequest,
    succeeded: session.status === 'completed',
    toolsUsed: session.toolCalls.map(t => t.name),
    iterations: session.iterationCount,
  });
}
```

**Review patterns:**
- What are users asking for most?
- What's failing? Why?
- What would benefit from a domain tool?
- What needs better context injection?

### Example: Discovering "Weekly Review"

```
Week 1: Users start asking "summarize my activity this week"
        Agent: Composes list_files + read_file, works but slow

Week 2: More users asking similar things
        Pattern emerges: weekly review is common

Week 3: Add prompt section for weekly review
        Faster, more consistent, still flexible

Week 4: If still common and performance matters
        Add domain tool: generate_weekly_summary
```

You didn't have to guess that weekly review would be popular. You discovered it.
</latent_demand_discovery>

<approval_and_agency>
## Approval and User Agency

When agents take unsolicited actions—doing things on their own rather than responding to explicit requests—you need to decide how much autonomy to grant.

> **Note:** This framework applies to unsolicited agent actions. If the user explicitly asks the agent to do something ("send that email"), that's already approval—the agent just does it.

### The Stakes/Reversibility Matrix

Consider two dimensions:
- **Stakes:** How much does it matter if this goes wrong?
- **Reversibility:** How easy is it to undo?

| Stakes | Reversibility | Pattern | Example |
|--------|---------------|---------|---------|
| Low | Easy | **Auto-apply** | Organizing files |
| Low | Hard | **Quick confirm** | Publishing to a private feed |
| High | Easy | **Suggest + apply** | Code changes with undo |
| High | Hard | **Explicit approval** | Sending emails, payments |

### Patterns in Detail

**Auto-apply (low stakes, easy reversal):**
```
Agent: [Organizes files into folders]
Agent: "I organized your downloads into folders by type.
        You can undo with Cmd+Z or move them back."
```
User doesn't need to approve—it's easy to undo and doesn't matter much.

**Quick confirm (low stakes, hard reversal):**
```
Agent: "I've drafted a post about your reading insights.
        Publish to your feed?"
        [Publish] [Edit first] [Cancel]
```
One-tap confirm because stakes are low, but it's hard to un-publish.

**Suggest + apply (high stakes, easy reversal):**
```
Agent: "I recommend these code changes to fix the bug:
        [Shows diff]
        Apply? Changes can be reverted with git."
        [Apply] [Modify] [Cancel]
```
Shows what will happen, makes reversal clear.

**Explicit approval (high stakes, hard reversal):**
```
Agent: "I've drafted this email to your team about the deadline change:
        [Shows full email]
        This will send immediately and cannot be unsent.
        Type 'send' to confirm."
```
Requires explicit action, makes consequences clear.

### Implementation

```swift
enum ApprovalLevel {
    case autoApply       // Just do it
    case quickConfirm    // One-tap approval
    case suggestApply    // Show preview, ask to apply
    case explicitApproval // Require explicit confirmation
}

func approvalLevelFor(action: AgentAction) -> ApprovalLevel {
    let stakes = assessStakes(action)
    let reversibility = assessReversibility(action)

    switch (stakes, reversibility) {
    case (.low, .easy): return .autoApply
    case (.low, .hard): return .quickConfirm
    case (.high, .easy): return .suggestApply
    case (.high, .hard): return .explicitApproval
    }
}

func assessStakes(_ action: AgentAction) -> Stakes {
    switch action {
    case .organizeFiles: return .low
    case .publishToFeed: return .low
    case .modifyCode: return .high
    case .sendEmail: return .high
    case .makePayment: return .high
    }
}

func assessReversibility(_ action: AgentAction) -> Reversibility {
    switch action {
    case .organizeFiles: return .easy  // Can move back
    case .publishToFeed: return .hard  // People might see it
    case .modifyCode: return .easy     // Git revert
    case .sendEmail: return .hard      // Can't unsend
    case .makePayment: return .hard    // Money moved
    }
}
```

### Self-Modification Considerations

When agents can modify their own behavior—changing prompts, updating preferences, adjusting workflows—the goals are:

1. **Visibility:** User can see what changed
2. **Understanding:** User understands the effects
3. **Rollback:** User can undo changes

Approval flows are one way to achieve this. Audit logs with easy rollback could be another. **The principle is: make it legible.**

```swift
// When agent modifies its own prompt
func agentSelfModify(change: PromptChange) async {
    // Log the change
    await auditLog.record(change)

    // Create checkpoint for rollback
    await createCheckpoint(currentState)

    // Notify user (could be async/batched)
    await notifyUser("I've adjusted my approach: \(change.summary)")

    // Apply change
    await applyChange(change)
}
```
</approval_and_agency>

<capability_visibility>
## Capability Visibility

Users need to discover what the agent can do. Hidden capabilities lead to underutilization.

### The Problem

```
User: "Help me with my reading"
Agent: "What would you like help with?"
// Agent doesn't mention it can publish to feed, research books,
// generate introductions, analyze themes...
```

The agent can do these things, but the user doesn't know.

### Solutions

**Onboarding hints:**
```
Agent: "I can help you with your reading in several ways:
        - Research any book (web search + save findings)
        - Generate personalized introductions
        - Publish insights to your reading feed
        - Analyze themes across your library
        What interests you?"
```

**Contextual suggestions:**
```
User: "I just finished reading 1984"
Agent: "Great choice! Would you like me to:
        - Research historical context?
        - Compare it to other books in your library?
        - Publish an insight about it to your feed?"
```

**Progressive revelation:**
```
// After user uses basic features
Agent: "By the way, you can also ask me to set up
        recurring tasks, like 'every Monday, review my
        reading progress.' Just let me know!"
```

### Balance

- **Don't overwhelm** with all capabilities upfront
- **Do reveal** capabilities naturally through use
- **Don't assume** users will discover things on their own
- **Do make** capabilities visible when relevant
</capability_visibility>

<designing_for_trust>
## Designing for Trust

Agent-native apps require trust. Users are giving an AI significant capability. Build trust through:

### Transparency

- Show what the agent is doing (tool calls, progress)
- Explain reasoning when it matters
- Make all agent work inspectable (files, logs)

### Predictability

- Consistent behavior for similar requests
- Clear patterns for when approval is needed
- No surprises in what the agent can access

### Reversibility

- Easy undo for agent actions
- Checkpoints before significant changes
- Clear rollback paths

### Control

- User can stop agent at any time
- User can adjust agent behavior (prompts, preferences)
- User can restrict capabilities if desired

### Implementation

```swift
struct AgentTransparency {
    // Show what's happening
    func onToolCall(_ tool: ToolCall) {
        showInUI("Using \(tool.name)...")
    }

    // Explain reasoning
    func onDecision(_ decision: AgentDecision) {
        if decision.needsExplanation {
            showInUI("I chose this because: \(decision.reasoning)")
        }
    }

    // Make work inspectable
    func onOutput(_ output: AgentOutput) {
        // All output is in files user can see
        // Or in visible UI state
    }
}
```
</designing_for_trust>

<checklist>
## Product Design Checklist

### Progressive Disclosure
- [ ] Basic requests work immediately (no config)
- [ ] Depth is discoverable through use
- [ ] No artificial ceiling on complexity
- [ ] Capability hints provided

### Latent Demand Discovery
- [ ] Agent requests are logged
- [ ] Success/failure is tracked
- [ ] Patterns are reviewed regularly
- [ ] Common patterns formalized into tools/prompts

### Approval & Agency
- [ ] Stakes assessed for each action type
- [ ] Reversibility assessed for each action type
- [ ] Approval pattern matches stakes/reversibility
- [ ] Self-modification is legible (visible, understandable, reversible)

### Capability Visibility
- [ ] Onboarding reveals key capabilities
- [ ] Contextual suggestions provided
- [ ] Users aren't expected to guess what's possible

### Trust
- [ ] Agent actions are transparent
- [ ] Behavior is predictable
- [ ] Actions are reversible
- [ ] User has control
</checklist>
