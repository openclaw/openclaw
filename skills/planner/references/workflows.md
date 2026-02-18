# Planner References

## Task Templates

### Template 1: Research Task

```
## Research Plan: [Topic]

### Objective
[What we need to find out]

### Approach
1. [Search strategy 1]
2. [Search strategy 2]
3. [Verification method]

### Deliverables
- [Deliverable 1]
- [Deliverable 2]

### Timeline/Progress
- [ ] Phase 1: Initial search
- [ ] Phase 2: Deep dive
- [ ] Phase 3: Synthesis
```

### Template 2: Development Task

```
## Development Plan: [Project]

### Requirements
- [Requirement 1]
- [Requirement 2]

### Architecture
```
[High-level design]
```

### Implementation Steps
1. **Setup**: [Environment, dependencies]
2. **Core**: [Main functionality]
3. **Integration**: [Connecting parts]
4. **Testing**: [Verification]
5. **Deployment**: [Delivery method]

### Risks & Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| [Risk 1] | [High/Med/Low] | [Mitigation] |
```

### Template 3: Multi-Agent Task

```
## Agent Coordination Plan

### Main Task: [Goal]

### Agent Assignments
| Agent | Role | Input | Output |
|-------|------|-------|--------|
| Agent 1 | [Role] | [Input] | [Output] |
| Agent 2 | [Role] | [Input] | [Output] |

### Flow
```
User → Main Agent
  → Agent 1 ─┐
  → Agent 2 ─┼→ Merge → User
  → Agent 3 ─┘
```

### Communication Protocol
- How agents share results
- Error handling
- Final aggregation
```

## Problem-Solving Patterns

### Pattern 1: Debugging

```
## Debug: [Error]

### Symptoms
- [Symptom 1]
- [Symptom 2]

### Hypothesis
[Hypothesis about root cause]

### Tests
1. [Test 1 to verify]
2. [Test 2 to verify]

### Fix Applied
[What was changed]

### Verification
[How we confirmed fix works]
```

### Pattern 2: Decision Making

```
## Decision: [What to decide]

### Options
1. **Option A**: [Description]
   - Pros: [Pro 1], [Pro 2]
   - Cons: [Con 1], [Con 2]

2. **Option B**: [Description]
   - Pros: [Pro 1], [Pro 2]
   - Cons: [Con 1], [Con 2]

### Criteria
- [Must have 1]
- [Must have 2]
- [Nice to have 1]

### Recommendation
[Based on criteria, which option wins]

### Reasoning
[Why this choice makes sense]
```

### Pattern 3: Investigation

```
## Investigation: [Question]

### Known Information
- [Fact 1]
- [Fact 2]

### Unknowns
- [Unknown 1]
- [Unknown 2]

### Investigation Steps
1. [Step 1]
2. [Step 2]

### Findings
- [Finding 1]: [Evidence]
- [Finding 2]: [Evidence]

### Conclusion
[Summary of what we learned]
```

## Agent Collaboration Examples

### Example 1: Parallel Search

```typescript
// User: "Search for X, Y, and Z topics"
const agents = await Promise.all([
  sessions_spawn({ task: "Search X", label: "search-x" }),
  sessions_spawn({ task: "Search Y", label: "search-y" }),
  sessions_spawn({ task: "Search Z", label: "search-z" })
]);
// Merge results from all three
```

### Example 2: Sequential Pipeline

```typescript
// User: "Analyze data then create report"
// Agent 1: Analyze
const analysis = await sessions_spawn({
  task: "Analyze the data in file X",
  label: "analyzer"
});
// Agent 2: Report (uses Agent 1's output)
const report = await sessions_spawn({
  task: `Create report based on: ${analysis}`,
  label: "reporter"
});
```

### Example 3: Master-Worker

```typescript
// Complex task with multiple workers
// Main agent coordinates, doesn't do the work itself
await sessions_spawn({
  task: "Research topic A in depth",
  label: "researcher-A"
});
await sessions_spawn({
  task: "Research topic B in depth", 
  label: "researcher-B"
});
await sessions_spawn({
  task: "Research topic C in depth",
  label: "researcher-C"
});
// Main agent synthesizes all results
```

## Tool Selection Guide

### For Information Retrieval

| Need | Tool | Notes |
|------|------|-------|
| Quick fact | web_search | Fast, multiple results |
| Deep dive | web_fetch | Full page content |
| Structured data | browser | Interactive scraping |
| Academic | web_search + scholar filter | |

### For File Operations

| Need | Tool | Notes |
|------|------|-------|
| Read content | read | Text files |
| Create/overwrite | write | Creates dirs |
| Modify | edit | Exact replacement |
| Execute | exec | Shell commands |
| Multiple files | exec + grep | Find & process |

### For Communication

| Need | Tool | Notes |
|------|------|-------|
| Same session | (auto) | Default |
| Different session | sessions_send | Cross-session |
| Sub-task | sessions_spawn | Isolated agent |
| Scheduled | cron | Time-based |
| Immediate | message | To external渠道 |

## Complexity Assessment

### Level 1: Simple
- Single tool call
- No dependencies
- Immediate result
- Example: "What's the weather?"

### Level 2: Medium
- 2-5 tool calls
- Some dependencies
- Verification needed
- Example: "Find and fix the bug in file X"

### Level 3: Complex
- 5+ tool calls
- Significant dependencies
- Planning required
- Multiple iterations
- Example: "Build a web app that does X"

### Level 4: Very Complex
- Multi-phase
- Multiple agents likely needed
- Uncertain requirements
- Risk of scope creep
- Example: "Research field X and write a comprehensive report"

---

**Key Principle**: Match your approach to the complexity level. Don't over-plan simple tasks, don't under-plan complex ones.
