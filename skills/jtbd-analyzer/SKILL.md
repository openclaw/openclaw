---
name: jtbd-analyzer
description: Uncover the real "job" customers hire your product to do. Goes beyond features to understand functional, emotional, and social motivations. Use when user says "jobs to be done", "jtbd", "why do customers", "what job", "customer motivation", "what problem", "user needs", "why do people buy".
---

# Jobs-To-Be-Done Analyzer

## The Core Concept

Customers don't buy products. They HIRE products to do a job.

"People don't want a quarter-inch drill. They want a quarter-inch hole."
Actually: They want a shelf → to display photos → to feel proud of family.

## The Three Job Dimensions

| Dimension | Question | Format |
|-----------|----------|--------|
| **Functional** | What task needs doing? | "Help me [verb] [object]" |
| **Emotional** | How do I want to feel? | "Make me feel [emotion]" |
| **Social** | How do I want to be seen? | "Help me be seen as [quality]" |

## The Process

1. **Job Statement:** "When [situation], I want to [motivation], so I can [outcome]"
2. **Map all 3 dimensions** for each user type
3. **Find real competition:** What ELSE could do this job?
4. **Prioritize:** Which jobs are most critical and underserved?

## Output Format

```
PRODUCT: [What you're analyzing]

For [User Type]:
JOB: "When [situation], I want [motivation], so I can [outcome]"

📋 FUNCTIONAL: [Task to accomplish]
💜 EMOTIONAL: [Feeling desired]
👥 SOCIAL: [Perception desired]

ALTERNATIVES: [What else could do this job?]
UNDERSERVED: [What part isn't done well?]
PRIORITY: Critical / Important / Nice-to-have
```

## Key Questions

1. "What were you trying to accomplish when you [action]?"
2. "Walk me through the last time you needed to [job]"
3. "What would you do if [product] didn't exist?"
4. "What's frustrating about how you currently [job]?"

## Integration

Compounds with:
- **first-principles-decomposer** → Decompose job to atomic need
- **cross-pollination-engine** → Find how others solve similar jobs
- **app-planning-skill** → Use JTBD to inform features

---
See references/examples.md for Artem-specific JTBD analyses
