# Trade-off Analysis & ADR

> Document every architectural decision with trade-offs.

## Decision Framework

For EACH architectural component, document:

```markdown
## Architecture Decision Record

### Context
- **Problem**: [What problem are we solving?]
- **Constraints**: [Team size, scale, timeline, budget]

### Options Considered

| Option | Pros | Cons | Complexity | When Valid |
|--------|------|------|------------|-----------|
| Option A | Benefit 1 | Cost 1 | Low | [Conditions] |
| Option B | Benefit 2 | Cost 2 | High | [Conditions] |

### Decision
**Chosen**: [Option B]

### Rationale
1. [Reason 1 - tied to constraints]
2. [Reason 2 - tied to requirements]

### Trade-offs Accepted
- [What we're giving up]
- [Why this is acceptable]

### Consequences
- **Positive**: [Benefits we gain]
- **Negative**: [Costs/risks we accept]
- **Mitigation**: [How we'll address negatives]

### Revisit Trigger
- [When to reconsider this decision]
```

## ADR Template

```markdown
# ADR-[XXX]: [Decision Title]

## Status
Proposed | Accepted | Deprecated | Superseded by [ADR-YYY]

## Context
[What problem? What constraints?]

## Decision
[What we chose - be specific]

## Rationale
[Why - tie to requirements and constraints]

## Trade-offs
[What we're giving up - be honest]

## Consequences
- **Positive**: [Benefits]
- **Negative**: [Costs]
- **Mitigation**: [How to address]
```

## ADR Storage

```
docs/
└── architecture/
    ├── adr-001-use-nextjs.md
    ├── adr-002-postgresql-over-mongodb.md
    └── adr-003-adopt-repository-pattern.md
```
