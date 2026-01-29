# Extended Workflow Documentation

## Table of Contents
1. [Discovery Phase Deep Dive](#discovery-phase-deep-dive)
2. [PRD Creation Process](#prd-creation-process)
3. [Implementation Best Practices](#implementation-best-practices)
4. [Progress Tracking](#progress-tracking)
5. [Git Integration](#git-integration)
6. [AI-Assisted Development Patterns](#ai-assisted-development-patterns)

---

## Discovery Phase Deep Dive

### Questions to Ask

**Problem Space:**
- What specific problem are we solving?
- Who experiences this problem? How often?
- What's the cost of not solving it?
- Are there workarounds today? What's wrong with them?

**Solution Space:**
- What would success look like?
- What's the minimum viable solution?
- What's the dream solution (no constraints)?
- What constraints do we have? (time, budget, tech)

**Market Space:**
- Who else solves this? How?
- What do they do well? Poorly?
- What's our unfair advantage?
- Is this a growing or shrinking market?

**User Space:**
- Who are the primary users? Secondary?
- What's their technical sophistication?
- What devices/platforms do they use?
- What's their workflow today?

### Discovery Outputs

By end of discovery, you should have:
1. **Problem statement** - One paragraph describing the problem
2. **User personas** - 2-3 with names, contexts, pain points
3. **Competitor list** - 3-5 with strengths/weaknesses
4. **Success criteria** - How we know we've won
5. **Constraints** - Non-negotiables and limitations

---

## PRD Creation Process

### Step 1: Start with Why (30 min)
Write the Executive Summary first. If you can't articulate why this needs to exist in 2-3 paragraphs, you're not ready to build.

### Step 2: Know Your Enemy (1-2 hours)
Competitive analysis. Use each competitor's product. Document:
- What they do well (patterns to adopt)
- What they do poorly (opportunities)
- What they're missing (your differentiator)

### Step 3: Know Your User (1 hour)
Write detailed personas. Include:
- Name and role
- Technical context
- Goals and pain points
- "Jobs to Be Done" framing
- Quotes they might say

### Step 4: Design the Solution (2-4 hours)
Feature specification with ASCII mockups. For each feature:
- Priority (P0/P1/P2)
- User story ("As a [user], I want [feature] so that [benefit]")
- ASCII UI mockup
- Technical notes
- Acceptance criteria

### Step 5: Plan the Build (1 hour)
- Group features into phases
- Estimate effort (be realistic, then add 50%)
- Identify dependencies
- Set milestones

### Step 6: Define Success (30 min)
- Quantitative metrics (usage, performance, revenue)
- Qualitative metrics (user feedback, satisfaction)
- How and when you'll measure

---

## Implementation Best Practices

### The Build Loop

```
1. Pick highest-priority incomplete feature
2. Re-read its PRD section
3. Build it (code, test, polish)
4. Update PRD status marker
5. Commit with meaningful message
6. Repeat
```

### Code Quality Standards

- Every feature should be production-ready before marking ✅
- "Works on my machine" ≠ complete
- Include error handling and edge cases
- Write tests for critical paths (or at minimum, test manually)

### When to Deviate from PRD

It's okay to deviate when:
- You discover a better approach during implementation
- User feedback contradicts assumptions
- Technical constraints force changes

When deviating:
1. Document WHY in the PRD (don't just change it silently)
2. Update affected sections
3. Note in commit message

---

## Progress Tracking

### Daily Check-In
- What did I complete yesterday?
- What will I complete today?
- Any blockers?

### Weekly Review
- Update all status markers
- Review remaining work vs timeline
- Adjust priorities if needed

### Phase Completion
- All P0 items ✅ before moving to next phase
- Quick retrospective: what worked, what didn't
- Update learnings.md

### Status Summary Format

When asked "what's the status", respond with:

```
## [Project] Status - [Date]

### Phase 1: [Name] — [X]% Complete
- ✅ Feature A
- ✅ Feature B  
- 🔄 Feature C (in progress)
- 📋 Feature D

### Phase 2: [Name] — Not Started
...

### Blockers
- [Any blockers]

### Next Up
- [Highest priority incomplete item]
```

---

## Git Integration

### Commit Message Format

```
type(scope): description

[optional body]

[optional footer]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation (including PRD updates)
- `refactor`: Code restructuring
- `test`: Adding tests
- `chore`: Maintenance

Examples:
```
feat(editor): add split pane support

Implements horizontal and vertical splits with drag handles.
Closes Phase 1, Section 1.1 of PRD.

docs(prd): update Phase 3 status markers

- Browser tabs: 📋 → ✅
- DevTools: 📋 → 🔄 (Console done, Elements pending)
```

### Branch Strategy

For solo projects:
- `main` - Always deployable
- Feature branches optional for large changes

For team projects:
- `main` - Production
- `dev` - Integration
- `feature/*` - Individual features

---

## AI-Assisted Development Patterns

### Pattern 1: PRD as Context

Always give the AI access to the PRD when working on features:
```
"Read the PRD at [path], specifically section [X], then implement [feature]"
```

### Pattern 2: Incremental Building

Don't ask for entire features at once:
```
1. "Set up the basic structure for [feature]"
2. "Now add [specific behavior]"
3. "Handle edge case [X]"
4. "Add error handling"
```

### Pattern 3: Review Against PRD

After implementing:
```
"Compare what we built against the PRD spec. Any gaps?"
```

### Pattern 4: Status Updates

After completing work:
```
"Update the PRD status markers to reflect what we just completed"
```

### Pattern 5: What's Next

When resuming work:
```
"Read the PRD and tell me the highest-priority incomplete item"
```

---

## Common Pitfalls

1. **PRD too vague** - If you can't write ASCII mockups, you don't understand the feature yet
2. **Skipping phases** - Phase 1 must be solid before Phase 2
3. **Not updating status** - PRD becomes stale and useless
4. **Scope creep** - New ideas go in "Future" section, not current phase
5. **Perfectionism** - "Good enough" shipped beats "perfect" never shipped
6. **No retrospective** - Same mistakes repeated across projects
