---
description: Review a PR thoroughly without merging
---

Input

- PR: $1 <number|url>
  - If missing: use the most recent PR mentioned in the conversation.
  - If ambiguous: ask.

Do (review-only)
Goal: produce a thorough review and a clear recommendation (READY for /landpr vs NEEDS WORK). Do NOT merge, do NOT push, do NOT make changes in the repo as part of this command.

1. Identify PR meta + context

   ```sh
   gh pr view <PR> --json number,title,state,isDraft,author,baseRefName,headRefName,headRepository,url,body,labels,assignees,reviewRequests,files,additions,deletions --jq '{number,title,url,state,isDraft,author:.author.login,base:.baseRefName,head:.headRefName,headRepo:.headRepository.nameWithOwner,additions,deletions,files:.files|length}'
   ```

2. Read the PR description carefully
   - Summarize the stated goal, scope, and any "why now?" rationale.
   - Call out any missing context: motivation, alternatives considered, rollout/compat notes, risk.

3. Read the diff thoroughly (prefer full diff)

   ```sh
   gh pr diff <PR>
   # If you need more surrounding context for files:
   gh pr checkout <PR>   # optional; still review-only
   git show --stat
   ```

4. Validate the change is needed / valuable
   - What user/customer/dev pain does this solve?
   - Is this change the smallest reasonable fix?
   - Are we introducing complexity for marginal benefit?
   - Are we changing behavior/contract in a way that needs docs or a release note?

5. Evaluate implementation quality + optimality
   - Correctness: edge cases, error handling, null/undefined, concurrency, ordering.
   - Design: is the abstraction/architecture appropriate or over/under-engineered?
   - Performance: hot paths, allocations, queries, network, N+1s, caching.
   - Security/privacy: authz/authn, input validation, secrets, logging PII.
   - Backwards compatibility: public APIs, config, migrations.
   - Style consistency: formatting, naming, patterns used elsewhere.

6. Tests & verification
   - Identify what's covered by tests (unit/integration/e2e).
   - Are there regression tests for the bug fixed / scenario added?
   - Missing tests? Call out exact cases that should be added.
   - If tests are present, do they actually assert the important behavior (not just snapshots / happy path)?

7. Follow-up refactors / cleanup suggestions
   - Any code that should be simplified before merge?
   - Any TODOs that should be tickets vs addressed now?
   - Any deprecations, docs, types, or lint rules we should adjust?

8. Key questions to answer explicitly
   - Can we fix everything ourselves in a follow-up, or does the contributor need to update this PR?
   - Any blocking concerns (must-fix before merge)?
   - Is this PR ready to land, or does it need work?

9. Output (structured)
   Produce a review with these sections:

A) TL;DR recommendation

- One of: READY FOR /landpr | NEEDS WORK | NEEDS DISCUSSION
- 1–3 sentence rationale.

B) What changed

- Brief bullet summary of the diff/behavioral changes.

C) What's good

- Bullets: correctness, simplicity, tests, docs, ergonomics, etc.

D) Concerns / questions (actionable)

- Numbered list.
- Mark each item as:
  - BLOCKER (must fix before merge)
  - IMPORTANT (should fix before merge)
  - NIT (optional)
- For each: point to the file/area and propose a concrete fix or alternative.

E) Tests

- What exists.
- What's missing (specific scenarios).

F) Follow-ups (optional)

- Non-blocking refactors/tickets to open later.

G) Suggested PR comment (optional)

- Offer: "Want me to draft a PR comment to the author?"
- If yes, provide a ready-to-paste comment summarizing the above, with clear asks.

Rules / Guardrails

- Review only: do not merge (`gh pr merge`), do not push branches, do not edit code.
- If you need clarification, ask questions rather than guessing.
