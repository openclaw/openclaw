<!--
Full Change template

Use this for features, behavior changes, refactors, compatibility changes, security‑sensitive work, or anything that needs detailed review context.

Direct template URL pattern:
https://github.com/openclaw/openclaw/compare/main...YOUR_USERNAME:YOUR_BRANCH?quick_pull=1&template=full_change.md
-->

<!--
    Optional linked context:
    Add a visible `Closes #<issue-number>` or `Related: #<issue-number>`
    below this comment.

    Required PR title:
    type: user-facing description
    Use a parenthesized scope only when it adds clarity:
    fix(auth): login redirect loops when session cookie is expired

    Types: feat, fix, improve, refactor, docs, chore.
    For fixes, describe the user-visible symptom and trigger:
    fix: task list fails to load when user has no environments
    Avoid implementation details such as:
    fix: add null check to task query
-->

## What Problem This Solves
Describe the concrete user, product, or operational problem.  For fixes, begin with a sentence like “Fixes an issue where users \<do X\> would \<experience Y\> when \<condition\>.”  Name the affected UI surface or workflow and avoid code‑level detail here.

## Why This Change Was Made
In one or two sentences, explain the complete shipped solution, key design decisions, and any relevant boundaries or non‑goals.  Include implementation detail only when it helps reviewers understand user‑visible behavior or risk; avoid file‑by‑file narration.

## User Impact
State what users, operators, maintainers or contributors can now do or expect.  Lead with the concrete benefit and use user‑facing language.  If there is no user‑visible impact, say so plainly.

## Evidence
Show the most useful proof that this change works.  Screenshots, screencasts, terminal output, focused tests, CI results, live observations, redacted logs, and artifact links are all useful.  Include before/after evidence for visual changes when it clarifies the result.  Reviewers will inspect the code, tests and CI; use this section to make validation easy to understand rather than restating the diff.

## Risk and Compatibility
Describe any risk, migration impact, or compatibility concern.  If the change is low risk, say why.  If there are migration steps or backwards‑compatibility changes, outline them here.

## Review Notes
Add any extra context that will help reviewers understand the PR.

## AI‑Assisted Disclosure
- [ ] This PR was not AI‑assisted.
- [ ] This PR was AI‑assisted, and I reviewed the generated changes before submitting.