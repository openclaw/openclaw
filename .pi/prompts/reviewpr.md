---（轉為繁體中文）
description: Review a PR thoroughly without merging（轉為繁體中文）
---（轉為繁體中文）
（轉為繁體中文）
Input（轉為繁體中文）
（轉為繁體中文）
- PR: $1 <number|url>（轉為繁體中文）
  - If missing: use the most recent PR mentioned in the conversation.（轉為繁體中文）
  - If ambiguous: ask.（轉為繁體中文）
（轉為繁體中文）
Do (review-only)（轉為繁體中文）
Goal: produce a thorough review and a clear recommendation (READY for /landpr vs NEEDS WORK). Do NOT merge, do NOT push, do NOT make changes in the repo as part of this command.（轉為繁體中文）
（轉為繁體中文）
1. Identify PR meta + context（轉為繁體中文）
（轉為繁體中文）
   ```sh（轉為繁體中文）
   gh pr view <PR> --json number,title,state,isDraft,author,baseRefName,headRefName,headRepository,url,body,labels,assignees,reviewRequests,files,additions,deletions --jq '{number,title,url,state,isDraft,author:.author.login,base:.baseRefName,head:.headRefName,headRepo:.headRepository.nameWithOwner,additions,deletions,files:.files|length}'（轉為繁體中文）
   ```（轉為繁體中文）
（轉為繁體中文）
2. Read the PR description carefully（轉為繁體中文）
   - Summarize the stated goal, scope, and any "why now?" rationale.（轉為繁體中文）
   - Call out any missing context: motivation, alternatives considered, rollout/compat notes, risk.（轉為繁體中文）
（轉為繁體中文）
3. Read the diff thoroughly (prefer full diff)（轉為繁體中文）
（轉為繁體中文）
   ```sh（轉為繁體中文）
   gh pr diff <PR>（轉為繁體中文）
   # If you need more surrounding context for files:（轉為繁體中文）
   gh pr checkout <PR>   # optional; still review-only（轉為繁體中文）
   git show --stat（轉為繁體中文）
   ```（轉為繁體中文）
（轉為繁體中文）
4. Validate the change is needed / valuable（轉為繁體中文）
   - What user/customer/dev pain does this solve?（轉為繁體中文）
   - Is this change the smallest reasonable fix?（轉為繁體中文）
   - Are we introducing complexity for marginal benefit?（轉為繁體中文）
   - Are we changing behavior/contract in a way that needs docs or a release note?（轉為繁體中文）
（轉為繁體中文）
5. Evaluate implementation quality + optimality（轉為繁體中文）
   - Correctness: edge cases, error handling, null/undefined, concurrency, ordering.（轉為繁體中文）
   - Design: is the abstraction/architecture appropriate or over/under-engineered?（轉為繁體中文）
   - Performance: hot paths, allocations, queries, network, N+1s, caching.（轉為繁體中文）
   - Security/privacy: authz/authn, input validation, secrets, logging PII.（轉為繁體中文）
   - Backwards compatibility: public APIs, config, migrations.（轉為繁體中文）
   - Style consistency: formatting, naming, patterns used elsewhere.（轉為繁體中文）
（轉為繁體中文）
6. Tests & verification（轉為繁體中文）
   - Identify what's covered by tests (unit/integration/e2e).（轉為繁體中文）
   - Are there regression tests for the bug fixed / scenario added?（轉為繁體中文）
   - Missing tests? Call out exact cases that should be added.（轉為繁體中文）
   - If tests are present, do they actually assert the important behavior (not just snapshots / happy path)?（轉為繁體中文）
（轉為繁體中文）
7. Follow-up refactors / cleanup suggestions（轉為繁體中文）
   - Any code that should be simplified before merge?（轉為繁體中文）
   - Any TODOs that should be tickets vs addressed now?（轉為繁體中文）
   - Any deprecations, docs, types, or lint rules we should adjust?（轉為繁體中文）
（轉為繁體中文）
8. Key questions to answer explicitly（轉為繁體中文）
   - Can we fix everything ourselves in a follow-up, or does the contributor need to update this PR?（轉為繁體中文）
   - Any blocking concerns (must-fix before merge)?（轉為繁體中文）
   - Is this PR ready to land, or does it need work?（轉為繁體中文）
（轉為繁體中文）
9. Output (structured)（轉為繁體中文）
   Produce a review with these sections:（轉為繁體中文）
（轉為繁體中文）
A) TL;DR recommendation（轉為繁體中文）
（轉為繁體中文）
- One of: READY FOR /landpr | NEEDS WORK | NEEDS DISCUSSION（轉為繁體中文）
- 1–3 sentence rationale.（轉為繁體中文）
（轉為繁體中文）
B) What changed（轉為繁體中文）
（轉為繁體中文）
- Brief bullet summary of the diff/behavioral changes.（轉為繁體中文）
（轉為繁體中文）
C) What's good（轉為繁體中文）
（轉為繁體中文）
- Bullets: correctness, simplicity, tests, docs, ergonomics, etc.（轉為繁體中文）
（轉為繁體中文）
D) Concerns / questions (actionable)（轉為繁體中文）
（轉為繁體中文）
- Numbered list.（轉為繁體中文）
- Mark each item as:（轉為繁體中文）
  - BLOCKER (must fix before merge)（轉為繁體中文）
  - IMPORTANT (should fix before merge)（轉為繁體中文）
  - NIT (optional)（轉為繁體中文）
- For each: point to the file/area and propose a concrete fix or alternative.（轉為繁體中文）
（轉為繁體中文）
E) Tests（轉為繁體中文）
（轉為繁體中文）
- What exists.（轉為繁體中文）
- What's missing (specific scenarios).（轉為繁體中文）
（轉為繁體中文）
F) Follow-ups (optional)（轉為繁體中文）
（轉為繁體中文）
- Non-blocking refactors/tickets to open later.（轉為繁體中文）
（轉為繁體中文）
G) Suggested PR comment (optional)（轉為繁體中文）
（轉為繁體中文）
- Offer: "Want me to draft a PR comment to the author?"（轉為繁體中文）
- If yes, provide a ready-to-paste comment summarizing the above, with clear asks.（轉為繁體中文）
（轉為繁體中文）
Rules / Guardrails（轉為繁體中文）
（轉為繁體中文）
- Review only: do not merge (`gh pr merge`), do not push branches, do not edit code.（轉為繁體中文）
- If you need clarification, ask questions rather than guessing.（轉為繁體中文）
