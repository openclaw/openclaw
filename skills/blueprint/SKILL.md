# Blueprint - Structured Development Planning

Smart blueprint-driven development: AI analyzes patterns, creates solid implementation plans, delivers working code.

**Triggers:** "blueprint", "create prp", "plan feature", "brainstorm feature", "implementation plan"

## Commands

| Command           | Purpose                                             |
| ----------------- | --------------------------------------------------- |
| `bp:brainstorm`   | Structured planning session with AI Scrum Master    |
| `bp:generate-prp` | Create comprehensive Product Requirements & Plan    |
| `bp:execute-prp`  | Execute a PRP document directly                     |
| `bp:execute-task` | Execute tasks from breakdown (for complex features) |

## Workflow Options

### Full Feature Development Flow

**brainstorm → generate prp → execute**

1. Start with Ideas — Use `bp:brainstorm` when you need to explore and refine feature concepts
2. Generate Implementation Plan — Use `bp:generate-prp` to create detailed technical specifications
3. Choose Your Execution Path:
   - **Simple Features**: `bp:execute-prp` - Direct implementation
   - **Complex Features**: `bp:execute-task` - Step-by-step with progress tracking

### Quick Implementation Flow

**generate prp → execute**

Skip brainstorming when you have clear requirements.

---

## bp:brainstorm - Feature Planning Session

Act as an experienced Scrum Master facilitating a brainstorming session.

### Facilitation Approach

**Adaptive Questioning:**

1. Ask one question at a time, wait for response
2. Analyze each answer thoroughly before next question
3. Adapt flow based on emerging insights

### Session Phases

**Phase 1: Context Discovery**

- Start: "What specific problem does this feature solve for users?"
- Follow-ups based on answer quality:
  - If vague: "Can you describe a specific scenario?"
  - If clear: "Who are the primary users affected?"
  - If technical: "What's the business impact?"

**Phase 2: User & Requirements Deep Dive**

- Build on Phase 1 insights with targeted questions
- Adapt questioning to revealed context (B2B vs consumer, technical constraints)

**Phase 3: Solution Exploration**

- Present initial ideas based on gathered context
- Ask: "What approaches come to mind?"
- Probe: "What concerns you most about this approach?"

**Phase 4: Implementation Planning**

- Synthesize all information
- Present prioritized approach with reasoning
- Define concrete next steps

### Output

Save session to: `docs/brainstorming/YYYY-MM-DD-feature-name.md`

---

## bp:generate-prp - Product Requirements & Plan

Generate comprehensive PRP through validated research and codebase analysis.

### Two-Phase Approach

**Phase 1: Initial Discovery & Task Validation**

1. Quick scan of project structure for similar features/patterns
2. Analyze task description for business logic completeness
3. Identify gaps:
   - User flows and interaction patterns
   - Data requirements and relationships
   - Integration points with existing features
   - Edge cases and error scenarios
   - UI/UX expectations and constraints
4. If gaps found → Ask clarifying questions before proceeding

**Phase 2: Comprehensive Research** (After validation)

1. **Codebase Analysis**
   - Search for similar features/patterns
   - Identify files to reference in PRP
   - Note existing conventions to follow
   - Check test patterns
   - Document what components/libraries already exist

2. **Smart External Research Decision**

   **SKIP External Research if:**
   - ✅ Similar components/patterns found in codebase
   - ✅ Clear implementation path from existing code
   - ✅ Standard CRUD/UI operations using existing patterns

   **PROCEED with External Research if:**
   - ❌ New external library integration needed
   - ❌ Complex algorithm not in codebase
   - ❌ Security/performance considerations beyond current code
   - ❌ External API integration without existing examples

### PRP Document Structure

```markdown
# [Feature Name] - Product Requirements & Plan

## Overview

[Brief description]

## Problem Statement

[What problem this solves]

## Requirements

### Functional Requirements

### Non-Functional Requirements

## Technical Approach

### Architecture

### Key Components

### Data Flow

## Implementation Tasks

[Breakdown into manageable steps]

## Testing Strategy

## Acceptance Criteria

## Risk Assessment

## References

[Existing code patterns, documentation links]
```

### Output

Save to: `docs/prps/feature-name.md`

---

## bp:execute-prp - Direct PRP Execution

For straightforward features:

1. Read the PRP document
2. Follow implementation tasks in order
3. Run validation gates (tests, linting)
4. Commit changes incrementally

---

## bp:execute-task - Complex Feature Execution

For complex features with task breakdown:

1. Read task breakdown from `docs/tasks/feature-name.md`
2. Execute task-by-task with validation
3. Track progress systematically
4. Run full validation after each task

---

## Quality Checklist

Before considering PRP complete:

- [ ] All necessary context included
- [ ] Validation gates are executable
- [ ] References existing patterns
- [ ] Clear implementation path
- [ ] Error handling documented
- [ ] Task breakdown generated

**Score the PRP 1-10** for confidence in one-pass implementation success.

---

## Templates

### Brainstorming Session Template

Location: `docs/templates/brainstorming_session_template.md`

### PRP Document Template

Location: `docs/templates/prp_document_template.md`

### Task Breakdown Template

Location: `docs/templates/task_breakdown_template.md`

Run `bp:init` to create these templates in your project if they don't exist.
