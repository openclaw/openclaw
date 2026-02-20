# Perspectives Review

Multi-perspective adversarial review using parallel sub-agents. Same model, different lenses — catches blind spots a single review would miss.

**Triggers:** "review from multiple perspectives", "adversarial review", "perspectives review", "multi-angle critique"

## When to Use

- Before implementing major features
- For competition submissions or demos
- For specs/PRDs that will be hard to change later
- When you want to stress-test a document

## Perspectives Available

| Perspective                  | Focus                                      | Catches                          |
| ---------------------------- | ------------------------------------------ | -------------------------------- |
| **Security Engineer**        | Auth, encryption, data exposure, injection | Vulnerabilities, attack vectors  |
| **Junior Developer**         | Clarity, tribal knowledge, missing context | Documentation gaps, confusion    |
| **QA Engineer**              | Edge cases, error scenarios, boundaries    | Untested paths, failure modes    |
| **Oncall Engineer**          | Debugging, logging, monitoring, incidents  | Operability issues, 3am problems |
| **Product Manager**          | User value, success metrics, scope         | Feature gaps, unclear outcomes   |
| **Accessibility Specialist** | WCAG, screen readers, keyboard nav         | A11y violations, UX barriers     |

## Workflow

### Step 1: Select Document

Identify the spec, PRD, or design document to review.

### Step 2: Spawn Reviewers (parallel)

Use `sessions_spawn` for each perspective. Example prompts:

**Security Engineer:**

```
Review this document as a SECURITY ENGINEER. Look for:
- Authentication and authorization gaps
- Data exposure risks (PII, secrets, logs)
- Input validation vulnerabilities
- Injection attack vectors (SQL, XSS, command)
- Encryption and transport security
- Session management issues

Be adversarial. Think like an attacker. Quote specific sections with concerns.

Document: [paste or path]
```

**Junior Developer:**

```
Review this document as a JUNIOR DEVELOPER (6 months experience). Look for:
- Unclear or ambiguous instructions
- Assumed knowledge not explained
- Missing context or prerequisites
- Tribal knowledge (things only insiders would know)
- Jargon without definitions
- Steps that seem to be missing

Flag anything confusing. Ask "dumb" questions. Quote specific sections.

Document: [paste or path]
```

**QA Engineer:**

```
Review this document as a QA ENGINEER. Look for:
- Untested edge cases
- Missing error scenarios
- Boundary conditions (empty, null, max, min)
- Race conditions and timing issues
- State transitions not covered
- Integration failure modes

Be thorough. Think about what could go wrong. Quote specific sections.

Document: [paste or path]
```

### Step 3: Collect Results

Wait for all sub-agents to complete. Gather their critiques.

### Step 4: Synthesize

1. **Deduplicate** — Multiple reviewers may flag the same issue
2. **Categorize** — Group by severity (critical/high/medium/low)
3. **Prioritize** — What must be fixed vs nice-to-have
4. **Consolidate** — Create unified list of improvements

### Step 5: Revise

Update the document addressing the critiques. For each fix:

- Note which perspective caught it
- Explain the change made
- Verify the concern is resolved

## Quick Command

For a fast 3-perspective review:

```bash
# Spawn all three in parallel
sessions_spawn --task "Security review: [doc]" --label "review-security"
sessions_spawn --task "Junior dev review: [doc]" --label "review-junior"
sessions_spawn --task "QA review: [doc]" --label "review-qa"

# Check results
sessions_list --kinds isolated
sessions_history --sessionKey "review-security"
```

## Custom Perspectives

Create your own perspectives for domain-specific reviews:

**Fintech Compliance:**

```
Review as a FINTECH COMPLIANCE OFFICER. Look for GDPR, PCI-DSS,
KYC/AML issues. Flag regulatory violations and data handling concerns.
```

**Performance Engineer:**

```
Review as a PERFORMANCE ENGINEER. Look for N+1 queries, missing
indexes, unbounded loops, memory leaks, cache opportunities.
```

## Output Template

```markdown
# Perspectives Review: [Document Name]

## Summary

- **Reviewers:** Security, Junior Dev, QA
- **Critical Issues:** N
- **Total Findings:** N

## Critical Issues (must fix)

1. [Issue] — caught by [perspective]
   - Location: [section/line]
   - Recommendation: [fix]

## High Priority

...

## Medium Priority

...

## Low Priority / Nice to Have

...

## Synthesis Notes

[Overall observations, patterns, recurring themes]
```

## Tips

- **Don't skip perspectives** — each catches different things
- **Use parallel spawning** — faster than sequential
- **Quote specific sections** — vague critiques are hard to act on
- **Track which perspective caught what** — helps calibrate future reviews
- **Re-run after major revisions** — fresh eyes on updated doc
