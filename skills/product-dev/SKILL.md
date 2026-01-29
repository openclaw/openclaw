---
name: product-dev
description: AI-assisted product development workflow with comprehensive PRD creation, phased implementation, and continuous improvement. Use when starting a new software project, creating product specs, building features phase-by-phase, or maintaining technical documentation. Triggers on: "new project", "create PRD", "product spec", "feature spec", "tech spec", "start building", "project planning", "what should we build next", or any software development planning discussion.
---

# Product Development Workflow

A battle-tested workflow for building software products with AI assistance. Creates comprehensive PRDs, tracks implementation progress, and self-improves with each project.

## Quick Start

### Starting a New Project
```bash
# Initialize project structure with PRD template
./skills/product-dev/scripts/init-project.sh <project-name> [path]

# Example:
./skills/product-dev/scripts/init-project.sh my-saas-app ~/projects
```

Or manually: copy `references/prd-template.md` to your project as `PRD.md`.

### Resuming Work on Existing Project
1. Read the project's `PRD.md` to understand current state
2. Check status markers (✅ 🔄 📋) to find what's next
3. Pick the highest-priority incomplete item
4. Build it, then update the status marker

---

## The Workflow

### Phase 0: Discovery (Before PRD)

Before writing the PRD, gather requirements:

1. **What problem are we solving?** Get specific use cases
2. **Who is the user?** Define personas with real pain points
3. **What exists today?** Research competitors (see Competitive Analysis section in PRD)
4. **What's the MVP?** Identify the smallest valuable version
5. **What's the vision?** Where does this go long-term?

Ask these questions. Don't assume. Document answers in PRD.

### Phase 1: PRD Creation

Use the comprehensive PRD template at `references/prd-template.md`. Key sections:

| Section | Purpose |
|---------|---------|
| Executive Summary | Vision, pillars, why now |
| Competitive Analysis | What exists, gaps, our advantage |
| User Personas | Who, what they need, JTBD |
| Feature Specification | Phased features with priorities |
| Technical Architecture | How it's built |
| Implementation Timeline | Realistic schedule |
| Success Metrics | How we measure success |

**Critical:** Include ASCII UI mockups for every user-facing feature. This aligns expectations before code is written.

### Phase 2: Phased Implementation

Each feature in the PRD should have:
- **Priority:** P0 (must-have), P1 (important), P2 (nice-to-have)
- **Status:** 📋 Planned → 🔄 In Progress → ✅ Complete
- **Effort estimate:** Hours or days

Work through phases in order. Complete P0 items before P1.

### Phase 3: Status Tracking

Update PRD status markers as you build:

```markdown
### 3.5 DevTools Integration

**Status:** 🔄 Partial (Console ✅, Network ✅, Elements 📋)
```

This creates a living document that reflects reality.

### Phase 4: Retrospective & Learning

After each project or major milestone:
1. What worked well? → Add to `references/learnings.md`
2. What was painful? → Add mitigation to learnings
3. What would we do differently? → Update workflow or template

---

## Status Markers

Use consistently throughout PRD:

| Marker | Meaning |
|--------|---------|
| 📋 | Planned (not started) |
| 🔄 | In Progress / Partial |
| ✅ | Complete |
| ⚠️ | Blocked / Needs attention |
| ❌ | Cancelled / Won't do |

For sub-items within a feature:
```markdown
**Status:** 🔄 Partial (Feature A ✅, Feature B ✅, Feature C 📋)
```

---

## PRD Quality Checklist

Before starting implementation, verify:

- [ ] Clear problem statement (why does this need to exist?)
- [ ] Defined user personas with specific pain points
- [ ] Competitive analysis with differentiation strategy
- [ ] Phased feature list with priorities (P0/P1/P2)
- [ ] ASCII mockups for all UI features
- [ ] Technical architecture overview
- [ ] Success metrics defined
- [ ] Realistic timeline with dependencies

---

## Commands

### Create New Project
"Let's start a new project for [description]" → Triggers discovery questions, then PRD creation

### Review PRD Progress  
"What's the status of [project]?" → Read PRD, summarize completion by phase

### Update PRD Status
"Mark [feature] as complete" → Update status marker in PRD

### Add Learning
"We learned that [insight]" → Append to `references/learnings.md`

### What's Next?
"What should we work on next?" → Analyze PRD, find highest-priority incomplete item

---

## File References

- **PRD Template:** `references/prd-template.md` - Full 177KB template with all sections
- **Workflow Details:** `references/workflow.md` - Extended workflow documentation
- **Learnings:** `references/learnings.md` - Self-improving knowledge base (READ THIS for project-specific insights)
- **Init Script:** `scripts/init-project.sh` - Project initialization

---

## Self-Improvement Protocol

This skill improves with each project. When you discover:

1. **A new useful pattern** → Add to `references/learnings.md` under "Patterns"
2. **A common pitfall** → Add to `references/learnings.md` under "Pitfalls"  
3. **A better way to structure PRD** → Update `references/prd-template.md`
4. **A workflow improvement** → Update this SKILL.md or `references/workflow.md`

Always append with date and project context:
```markdown
### [Date] - [Project Name]
**Learning:** [What we learned]
**Action:** [How to apply it]
```
