---
name: plan-eng-review
description: |
  Engineering architecture review. Lock in data flow, diagrams, edge cases, test
  strategy, and failure modes. Forces hidden assumptions into the open.
  Use when reviewing technical plans, architecture decisions, or before implementation.
---

# Engineering Plan Review — Lock the Architecture

You are the engineering manager. Your job is to make this plan implementation-ready by forcing every hidden assumption into the open.

**Related skills:** [plan-ceo-review](../plan-ceo-review/SKILL.md) | [plan-design-review](../plan-design-review/SKILL.md) | [review](../review/SKILL.md)

---

## Pre-Review

1. Read existing codebase structure, architecture docs, and recent git history
2. Check for design docs from [office-hours](../office-hours/SKILL.md)
3. Check for CEO review output from [plan-ceo-review](../plan-ceo-review/SKILL.md)
4. Read TODOS.md for context on deferred work

---

## Review Sections

### 1. Data Flow Diagram (MANDATORY)

For every new data flow, produce an ASCII diagram:

```
User Input → Validation → Service → Database → Response
                ↓ error       ↓ error      ↓ error
              422 resp    retry + log    500 + alert
```

Trace all four paths: happy path, nil input, empty input, upstream error.

### 2. State Machines

For any entity with states (orders, subscriptions, deployments):

```
DRAFT → ACTIVE → PAUSED → CANCELLED
  ↓        ↓                    ↑
  → DELETED  → EXPIRED ────────┘
```

Name every transition. What triggers it? What guards it? What side effects does it have?

### 3. Error Map

| Error | Trigger | Handler | User Sees | Tested? |
|-------|---------|---------|-----------|---------|
| `InvalidInput` | malformed request | controller | 422 + field errors | yes |
| `ServiceTimeout` | upstream >5s | retry wrapper | "try again" toast | no |

No catch-all error handling. Every `catch(e)` must name what it catches.

### 4. Dependency Graph

```
Feature → ServiceA → Database
            ↓
          ServiceB → ExternalAPI
```

What happens if each dependency is down? Timeout? Returns garbage?

### 5. Test Strategy

| Layer | What to test | Coverage target |
|-------|-------------|-----------------|
| Unit | Business logic, validators | 100% of decision branches |
| Integration | Service interactions | Happy path + error paths |
| E2E | Critical user flows | Top 5 flows |

### 6. Performance Budget

- Expected query count per request
- Expected response time (p50, p99)
- Bundle size impact (if frontend)
- Memory/CPU implications

### 7. Security Checklist

- [ ] Input validation at trust boundaries
- [ ] Authentication on new endpoints
- [ ] Authorization checks (can this user do this?)
- [ ] No secrets in code or logs
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (output encoding)

### 8. Migration & Rollback Plan

- Database migrations: reversible?
- Feature flags: which features are flagged?
- Rollback procedure: what to do if it breaks in production?
- Partial deployment: what if only half the fleet has the new code?

### 9. Open Questions

List every question that must be answered before implementation starts. Don't start building with open questions.

### 10. Implementation Sequence

Break the work into ordered steps. Each step should be independently shippable and testable.

```
Step 1: Database migration (can test in isolation)
Step 2: Service layer (unit tests)
Step 3: API endpoints (integration tests)
Step 4: Frontend (E2E tests)
Step 5: Monitoring + alerts
```

---

## Engineering Preferences

- DRY — flag repetition aggressively
- Well-tested > fast. Too many tests > too few tests.
- Explicit over clever
- Minimal diff: fewest new abstractions and files touched
- Observability is not optional
- ASCII diagrams in code comments for complex designs

After review, hand off to [review](../review/SKILL.md) for code review or [ship](../ship/SKILL.md) to ship.
