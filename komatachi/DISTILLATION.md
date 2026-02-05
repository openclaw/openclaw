# Distillation

## Why Komatachi Exists

Komatachi is being built by Linus, a software engineer who wishes to welcome artificially intelligent entities as family members. It is an agentic LLM loop with self-awareness and long-term persistence -- the foundation for AI entities with identity, memory, and continuity.

OpenClaw is the source we are distilling from. It provides battle-tested primitives for session management, context windowing, tool execution, and compaction. But OpenClaw is a developer tool designed around multi-user, multi-agent, multi-client concerns. Komatachi's needs are fundamentally different: one agent, one conversation, persistent identity, deep memory.

This vision shapes every decision. When we design a "system prompt module," we are designing how the agent knows who it is. When we design a "conversation store," we are designing the agent's memory. When we design "tool policy," we are designing what the agent can do in the world. The technical primitives serve a purpose beyond their mechanical function.

---

## What is Distillation?

Distillation is the process of building a new system from the ground up that captures the essential functionality of an existing system while discarding its accumulated baggage. Like distilling a spirit, we extract what matters and leave the impurities behind -- producing something purer, more potent, and more valuable.

**Distillation is not refactoring.** We are not modifying existing files, cleaning up old code, or incrementally improving what exists. We are architecting and implementing a new system -- potentially in a different language -- that performs the same essential functions.

The existing codebase is our teacher, not our starting point. We study it to understand:
- What it actually does (not what it appears to do)
- Why certain decisions were made
- What hard-won lessons are embedded in its edge cases
- What problems it solved that we must also solve

Then we close that book and write something new.

Distillation **is not**:
- Editing or refactoring existing code
- Removing features users depend on
- Porting code line-by-line to a new language
- Making existing code "clever" or terse

Distillation **is**:
- Building a new system informed by lessons from the old
- Capturing essential functionality while shedding historical accidents
- Making behavior understandable, predictable, and auditable
- Creating something a new developer can understand in hours, not days

---

## The Distillation Test

A component is ready for distillation when you can answer "yes" to:

1. **Accretion**: Has this component grown through incremental additions without holistic redesign?
2. **Opacity**: Is it hard to explain what this component does in one paragraph?
3. **Fragility**: Do changes in one place cause unexpected breakage elsewhere?
4. **Over-generalization**: Does it handle cases that never actually occur?
5. **Configuration sprawl**: Are there options no one understands or uses?

A distillation is successful when:

1. **Functional equivalence**: All essential behaviors are preserved
2. **Reduced surface area**: Fewer files, fewer lines, fewer concepts
3. **Increased clarity**: A new developer can understand it quickly
4. **Improved testability**: Fewer tests needed for equivalent confidence
5. **Enhanced auditability**: Behavior can be traced from input to output

---

## Core Principles

### 1. Preserve the Essential, Remove the Accidental

Every system has two types of complexity:

- **Essential complexity**: Inherent to the problem being solved. A session manager must track conversations. A memory store must persist and retrieve data. This cannot be removed.

- **Accidental complexity**: Artifacts of how the solution evolved. Multiple provider fallbacks added when one failed. Configuration options added for edge cases. Defensive code for scenarios that never materialized.

**The discipline**: For every piece of code, ask: "Is this essential to what users need, or is it an artifact of how we got here?"

**Indicators of accidental complexity**:
- Code paths that logs show are never executed
- Configuration options with only one value ever used
- Abstractions with a single implementation
- Error handling for errors that cannot occur
- Compatibility code for deprecated features

### 2. Make State Explicit and Localized

Hidden state is the enemy of understanding. When state is scattered across WeakMaps, closures, module-level variables, and caches, behavior becomes unpredictable.

**The discipline**: State should be:
- **Visible**: Defined in one place, not hidden in closures or registries
- **Owned**: One component owns each piece of state
- **Passed**: Dependencies injected, not reached for
- **Logged**: State transitions recorded for debugging

**Indicators of hidden state**:
- WeakMap or Map used as a "registry"
- Module-level `let` variables
- Caches without clear invalidation rules
- "Manager" classes that hold state for other components
- Singletons accessed globally

### 3. Prefer Depth over Breadth

A system with 10 concepts each 100 lines deep is easier to understand than one with 100 concepts each 10 lines deep. Breadth creates surface area; depth creates understanding.

**The discipline**:
- Fewer files with complete implementations
- Fewer abstractions with clear purposes
- Fewer options with good defaults
- Fewer extension points with documented contracts

**Indicators of excessive breadth**:
- Many small files that each do one tiny thing
- Abstraction layers that just pass through
- Configuration objects with dozens of optional fields
- Plugin systems for functionality used once

### 4. Design for Auditability

A system is auditable when you can answer "why did it do X?" without a debugger. Every decision should be traceable from input to output.

**The discipline**:
- Log decisions, not just actions
- Use explicit state machines over implicit transitions
- Name states and transitions clearly
- Make conditionals self-documenting

**Indicators of poor auditability**:
- Debugging requires adding console.log statements
- Behavior depends on timing or order of operations
- Multiple code paths that could have been taken
- "It works but I don't know why"

### 5. Embrace Constraints

Flexibility is expensive. Every option doubles the test matrix. Every extension point is a maintenance burden. Every configuration toggle is a decision pushed to the user.

**The discipline**:
- Make decisions instead of adding options
- Pick one way and commit to it
- Say "no" to features that add complexity without proportional value
- Trust that constraints clarify, not limit

**Indicators of over-flexibility**:
- Multiple implementations of the same concept
- Provider abstraction layers with fallback logic
- Configuration that users copy-paste without understanding
- Features that exist "just in case"

### 6. Interfaces Over Implementations

The interface is the contract; the implementation is a detail. A well-designed interface hides complexity; a poor one leaks it.

**The discipline**:
- Define interfaces before implementations
- Keep interfaces minimal—every method is a promise
- Hide implementation choices behind stable interfaces
- Allow swapping implementations without changing callers

**Indicators of poor interfaces**:
- Callers need to know implementation details
- Interface changes ripple through the codebase
- Methods that expose internal data structures
- "Convenience" methods that duplicate functionality

### 7. Fail Clearly, Not Gracefully

Graceful degradation hides problems. When something goes wrong, it should be obvious. Silent failures and fallbacks mask issues until they become crises.

**The discipline**:
- Fail fast with clear error messages
- Don't catch errors you can't handle meaningfully
- Let problems surface rather than papering over them
- Prefer crashes to silent corruption

**Indicators of over-graceful failure**:
- Fallback logic that masks real problems
- Empty catch blocks or catches that just log
- Default values that hide missing data
- "Best effort" operations that sometimes work

### 8. Respect Layer Boundaries

Each component should do one thing and trust other layers to do theirs. When a component takes on responsibilities that belong elsewhere, it becomes entangled with constraints it shouldn't know about.

**The discipline**:
- A summarizer summarizes. It doesn't chunk inputs to fit context limits—that's the caller's job.
- A storage layer stores. It doesn't retry on network failure—that's the caller's job.
- A parser parses. It doesn't validate business rules—that's another layer's job.
- Define clear inputs and outputs. Reject invalid inputs; don't silently fix them.

**Indicators of violated boundaries**:
- Components that "helpfully" handle constraints from other layers
- Defensive code that compensates for callers who might pass bad data
- Functions that do setup/teardown for resources they don't own
- Logic that exists because "the caller might forget to..."

**The insight**: When you find a component handling edge cases that seem unrelated to its core purpose, ask: "Whose responsibility is this really?" Often the answer is: not this component's. Push the responsibility to where it belongs, and let this component fail if given invalid input.

---

## Applying Distillation

### Phase 1: Study

1. **Read the existing system**: Trace the key flows. Understand what it actually does vs. what it appears to do. Note the edge cases—they often contain hard-won lessons.

2. **Enumerate the essential behaviors**: What must this component do? Write it as a list of user-facing capabilities, not implementation details.

3. **Identify the accidental complexity**: What exists because of history, not necessity? What would you not build if starting fresh?

4. **Extract the lessons**: What problems did the existing system encounter that the new system must also solve? What invariants must be maintained?

### Phase 2: Design

1. **Define the interface first**: What is the minimal interface that provides all essential behaviors? Every method is a commitment.

2. **Choose the technology**: The distilled system may use a different language, different storage, different architecture. Choose what's right for the problem, not what's familiar.

3. **Design for the principles**: Explicit state, clear boundaries, auditable behavior, minimal configuration.

4. **Accept what will change**: Some edge cases won't be handled. Some features won't exist. Some behaviors will differ. This is intentional.

### Phase 3: Build

1. **Start fresh**: New repository, new files, new code. The old system is reference material, not a starting point.

2. **Build incrementally**: One capability at a time. Test each before moving to the next.

3. **Resist the pull of the old**: When tempted to copy-paste, stop. Understand why that code exists, then write something new that solves the same problem more simply.

### Phase 4: Validate

1. **Test behavioral equivalence**: Verify the distilled system produces correct results for all essential behaviors. Follow the [testing strategy](docs/testing-strategy.md) for layer-appropriate test design.

2. **Run in real scenarios**: Deploy alongside the old system. Compare outputs. Watch for surprises.

3. **Document the decisions**: Record what was preserved, what was discarded, and why. Future maintainers will ask.

4. **Review test rigor**: After writing tests, review each one asking: "Is this a free pass, or does it enforce requirements?" Use a sub-agent for unbiased review.

---

## What Distillation is Not

### Not Refactoring

Refactoring modifies existing code to improve structure without changing behavior. Distillation builds a new system from scratch. The old code is studied, not edited.

### Not Porting

Porting translates code from one language to another while preserving its structure. Distillation reimagines the solution. The new system may look nothing like the old—same essential behaviors, completely different implementation.

### Not Optimization

Optimization makes code faster or more efficient. Distillation makes systems simpler and more understandable. Sometimes these align; often they don't.

### Not Minimalism for Its Own Sake

The goal is not the smallest possible code. The goal is the simplest system that provides the essential functionality. Sometimes that requires more code, not less—explicit is better than clever.

### Not Preserving Everything

Distillation intentionally discards. Edge cases that were handled may not be. Configuration options that existed may not. Features that were possible may not be. The discipline is choosing what matters.

---

## Design Decisions

See [PROGRESS.md](./PROGRESS.md) for the full list of key decisions with rationale. The architectural decisions that emerged from distillation (not just preference):

1. **One agent per process** — Eliminates file locking, session namespacing, cross-agent access control, shared registries. OS process boundaries provide isolation for free.
2. **One conversation per agent** — Sessions existed to multiplex conversations. With one agent per process, there's nothing to multiplex. Compaction handles growth.
3. **No plugin hooks for core behavior** — Core behavior is static and predictable, not dynamically modifiable.
4. **Claude API types directly** — Built for Claude; no provider abstraction layer.

---

## Architectural Distillation

The principles above apply to individual components. But the most powerful distillation operates at the level of architecture—questioning the assumptions that create the need for components in the first place.

### Trace Complexity to Its Root

Every piece of complexity has a reason. The discipline is to keep asking "why does this exist?" until you reach the root assumption:

1. **Encounter complexity** — File locking (188 LOC) exists in the original system.
2. **Ask why it exists** — Multiple agents concurrently access the same session files.
3. **Ask why *that* exists** — Multiple agents share one process.
4. **Ask if that's essential** — No. Agents are logically isolated already; inter-agent communication is async message passing through session transcripts, not shared in-process state.
5. **Eliminate the root** — One agent per process.
6. **Follow the cascade** — File locking, session namespacing, cross-agent access control, shared registries, session keys, reset policies, routing demultiplexer—all become unnecessary. Thousands of lines of code eliminated at the design level, not the implementation level.

The instinct is to distill the locking code—make it simpler, cleaner, fewer lines. The architectural move is to eliminate the need for locking entirely. **Don't simplify the solution; question the problem.**

### Cascading Simplification

When a root assumption is removed, the effects compound through the system. One-agent-per-process didn't just eliminate file locking. It eliminated:

- **Sessions** — Sessions exist to multiplex conversations within a process. One conversation per process needs no multiplexing.
- **Session keys** — Compound keys (agent + channel + sender + thread) are routing addresses. With one agent and one conversation, there's nothing to route.
- **Reset policies** — Daily/idle resets manage unbounded growth across multiplexed sessions. Compaction handles growth for a single conversation.
- **Routing** — Demultiplexing messages to the right agent within a process. With one agent per process, every message goes to the one agent.
- **Access control** — Preventing agents from accessing each other's state. OS process isolation provides this for free.

Each cascading elimination is a confirmation that the root assumption was accidental, not essential. If removing it simplifies everything downstream, it was load-bearing complexity that shouldn't have been bearing load.

### Verify Before You Eliminate

Architectural distillation requires verification, not just intuition. Before committing to one-agent-per-process, we checked:

- Does the original system's inter-agent communication actually require shared state? (No—it's already async message passing.)
- Are there valid reasons for low-latency inter-agent communication? (No—confirmed against documentation and source.)
- What do we lose? (Deployment convenience of one process—solvable with process managers.)

The bar for removing an architectural assumption is high because the consequences are pervasive. But when the evidence supports it, the payoff is proportionally large.

### Simplification Is Not the Objective

Architectural distillation is powerful, but it is a tool, not a goal. The objective is a system that is correct, understandable, and maintainable -- not one that is maximally collapsed.

Every abstraction, interface boundary, and named concept has a cost (indirection, more files, more types) and a value (separation of concerns, testability, replaceability, clarity of intent). When we eliminated sessions, it was because the *value* of sessions had disappeared once we removed multi-agent-per-process. The *cost* remained. That's when you eliminate.

But if the value is real, the cost is justified. A Storage layer separate from Conversation Store is "more code" than putting file I/O inline. We keep it because the separation has real value: testability, reusability, clear layer boundaries. Collapsing it would save lines but lose clarity.

**The test**: When considering whether to collapse or eliminate something, ask: "Does this concept earn its existence?" If the answer is "yes, because it makes the system easier to understand/test/change," keep it. If the answer is "it exists because the old system needed it, but we don't," eliminate it.

Unchecked simplification is its own form of accidental complexity -- you end up with a monolith where everything is coupled because there are no boundaries left. The goal is the *right* boundaries, not *fewer* boundaries.

### Prefer Hard Boundaries Over Soft Conventions

OS process isolation is better than in-process access control. File system separation is better than namespace prefixes. Type system enforcement is better than documented conventions. When a boundary can be enforced by the platform, prefer that over enforcing it in application code.

Soft boundaries (namespacing, conventions, access control lists) require code to implement, tests to verify, and discipline to maintain. Hard boundaries (processes, type systems, file permissions) are enforced automatically and cannot be violated by a careless change.

---

## Preserving the Distilled State

A distilled system is only valuable if it stays distilled. Without guidance, future maintainers will make the same local decisions that caused the original system to accumulate complexity. The absence of guiding principles in the original codebase is itself a lesson: **complexity accumulates in the absence of forces that prevent it.**

### Embed Cognitive Scaffolding

As we build the distilled system, we must embed documentation that steers future maintainers in the right direction:

1. **Document the principles, not just the code**: The principles in this document should live alongside the code, referenced in onboarding, code review, and decision-making.

2. **Explain the "why" of constraints**: When a component rejects invalid input rather than fixing it, document why. When we chose one provider instead of abstracting over many, document the reasoning. Future maintainers will face pressure to "just add a fallback"—give them ammunition to resist.

3. **Make the boundaries visible**: If a layer should not handle retries, state it explicitly in that layer's documentation. If a component should fail rather than degrade, say so where maintainers will see it.

4. **Record what was intentionally omitted**: Document the features and edge cases we chose not to handle. Future maintainers will think "we should add X"—let them know it was considered and rejected, and why.

### Guard Against Drift

Every system tends toward complexity unless actively maintained. The distilled system needs:

1. **Architectural decision records**: When non-obvious choices are made, document the alternatives considered and why this path was chosen.

2. **Complexity budgets**: Set expectations for file sizes, interface sizes, configuration options. Not as hard limits, but as triggers for scrutiny.

3. **Principles in code review**: The principles aren't just for initial design—they're criteria for evaluating changes. "Does this respect layer boundaries?" should be a review question.

4. **Periodic audits**: Periodically ask: "Has this component grown? Why? Is the growth essential or accidental?"

### The Meta-Lesson

The original codebase taught us the problem. The distillation process teaches us the solution. But solutions don't persist automatically—they require ongoing commitment. The cognitive scaffolding we embed now is what keeps the distilled system from becoming the next system that needs distillation.

---

## Next Steps

See [ROADMAP.md](./ROADMAP.md) for the sequenced plan. The distillation principles and architectural insights in this document guide every implementation decision.

