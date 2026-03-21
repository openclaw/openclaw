---
name: document-review
description: This skill should be used to refine requirements or plan documents before proceeding to the next workflow step. It applies when a requirements document or plan document exists and the user wants to improve it.
---

# Document Review

Improve requirements or plan documents through structured review.

## Step 1: Get the Document

**If a document path is provided:** Read it, then proceed to Step 2.

**If no document is specified:** Ask which document to review, or look for the most recent requirements/plan in `docs/brainstorms/` or `docs/plans/`.

## Step 2: Assess

Read through the document and ask:

- What is unclear?
- What is unnecessary?
- What decision is being avoided?
- What assumptions are unstated?
- Where could scope accidentally expand?

These questions surface issues. Don't fix yet—just note what you find.

## Step 3: Evaluate

Score the document against these criteria:

| Criterion | What to Check |
|-----------|---------------|
| **Clarity** | Problem statement is clear, no vague language ("probably," "consider," "try to") |
| **Completeness** | Required sections present, constraints stated, and outstanding questions clearly marked as blocking or deferred |
| **Specificity** | Concrete enough for next step (requirements → can plan, plan → can implement) |
| **Appropriate Level** | Requirements doc stays at behavior/scope level and does not drift into implementation unless the document is inherently technical |
| **YAGNI** | Avoid speculative complexity whose carrying cost outweighs its value; keep low-cost, meaningful polish when it is easy to maintain |

If invoked within a workflow (after `/ce:brainstorm` or `/ce:plan`), also check:
- **User intent fidelity** — Document reflects what was discussed, assumptions validated

## Step 4: Identify the Critical Improvement

Among everything found in Steps 2-3, does one issue stand out? If something would significantly improve the document's quality, this is the "must address" item. Highlight it prominently.

## Step 5: Make Changes

Present your findings, then:

1. **Auto-fix** minor issues (vague language, formatting) without asking
2. **Ask approval** before substantive changes (restructuring, removing sections, changing meaning)
3. **Update** the document inline—no separate files, no metadata sections

### Simplification Guidance

Simplification is purposeful removal of unnecessary complexity, not shortening for its own sake.

**Simplify when:**
- Content serves hypothetical future needs without enough current value to justify its carrying cost
- Sections repeat information already covered elsewhere
- Detail exceeds what's needed to take the next step
- Abstractions or structure add overhead without clarity

**Don't simplify:**
- Constraints or edge cases that affect implementation
- Rationale that explains why alternatives were rejected
- Open questions that need resolution
- Deferred technical or research questions that are intentionally carried forward to the next stage

**Also remove when inappropriate:**
- Library choices, file structures, endpoints, schemas, or other implementation details that do not belong in a non-technical requirements document

## Step 6: Offer Next Action

After changes are complete, ask:

1. **Refine again** - Another review pass
2. **Review complete** - Document is ready

### Iteration Guidance

After 2 refinement passes, recommend completion—diminishing returns are likely. But if the user wants to continue, allow it.

Return control to the caller (workflow or user) after selection.

## What NOT to Do

- Do not rewrite the entire document
- Do not add new sections or requirements the user didn't discuss
- Do not over-engineer or add complexity
- Do not create separate review files or add metadata sections
