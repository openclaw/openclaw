---
date: 2026-05-22
topic: slack-benign-tool-failure-ux
---

# Slack Benign Tool Failure UX

## Summary

Slack-facing OpenClaw responses should distinguish a broken tool from a
successful optional lookup that found nothing. Benign search misses, such as
markdown `rg` returning no matches through `xargs`, should become a concise
notice instead of a scary failed tool step.

---

## Problem Frame

In the Erum Jiva demo brief, the agent produced useful business context, but
Slack appended a warning that a markdown search in the `niemand-b2b` workspace
failed. The workspace existed and contained markdown files. The likely command
simply found no matching text.

That distinction matters in Slack. Operators scanning a brief should not have to
debug shell semantics to decide whether the answer is trustworthy. Real failures
still need to be visible, but optional context probes should report their
outcome in user language.

---

## Actors

- A1. Slack user: Reads operational answers and needs to know whether
  supporting context was found or whether something actually broke.
- A2. OpenClaw agent: Runs optional context searches while preparing responses.
- A3. OpenClaw runtime or presentation layer: Converts tool outcomes into
  channel-visible status.
- A4. Maintainer: Needs real failures preserved in logs for debugging.

---

## Key Flows

- F1. Optional search finds no results
  - **Trigger:** An agent searches workspace markdown while preparing a Slack
    response.
  - **Actors:** A1, A2, A3
  - **Steps:** The search command exits with a benign no-match status. OpenClaw
    classifies the outcome as no context found. Slack shows either a short
    notice or nothing, depending on whether the missing context affects the
    answer.
  - **Outcome:** The user sees the answer without a misleading failure banner.
  - **Covered by:** R1, R2, R3, R5
- F2. Optional search actually fails
  - **Trigger:** A search command cannot run because of a missing directory,
    permission error, unavailable command, timeout, malformed invocation, or a
    similar real failure.
  - **Actors:** A1, A3, A4
  - **Steps:** OpenClaw classifies the outcome as an actual failure. Slack output
    remains visible and actionable. Logs retain the raw command and error
    details.
  - **Outcome:** Real tool problems stay loud enough to fix.
  - **Covered by:** R1, R4, R6

---

## Requirements

### User-Facing Classification

- R1. OpenClaw must distinguish at least three Slack-visible classes for tool
  outcomes: successful result, benign no-result, and actual failure.
- R2. A no-result search must not be presented with failure language such as
  "failed" when the command completed normally but found no matching context.
- R3. Optional context searches should show a concise operational notice, such
  as "No local markdown context found," or be omitted when the missing context
  does not affect the answer.
- R4. Actual failures must remain visible and actionable when the tool could not
  run correctly, could not access its target, timed out, or returned a real
  error.

### Initial Benign Cases

- R5. The first supported benign cases must include ripgrep no-match exits and
  the common `find ... | xargs rg ...` pattern where no matches surface as an
  `xargs` non-zero status.
- R6. Missing workspace, missing file path, permission denied, command not
  found, syntax errors, and timeouts must not be downgraded to benign no-result
  notices.

### Observability

- R7. Raw command, exit status, stdout, stderr, and classification must remain
  available in logs or diagnostics even when Slack hides or softens the
  user-facing message.
- R8. The classification must be narrow enough that maintainers can add new
  benign patterns deliberately instead of suppressing broad failure classes.

### Channel Behavior

- R9. Slack output must prioritize the main answer and show tool-status notices
  only when they change how the user should interpret the answer.
- R10. When a no-result notice is shown, it must name the missing context in
  plain terms, not shell implementation details.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R3, R5.** Given a Slack-triggered agent searches
  markdown files for a prospect name and `rg` finds no matches, when the
  response is sent, Slack does not show a failed tool warning and may show
  "No local markdown context found."
- AE2. **Covers R1, R2, R5.** Given the agent uses a
  `find ... | xargs rg ...` shape and the wrapped command exits non-zero only
  because there were no matches, when the result is classified, it is treated as
  benign no-result rather than an actual failure.
- AE3. **Covers R4, R6.** Given the workspace path does not exist, when the same
  search is attempted, Slack shows an actual actionable failure rather than
  "no local context found."
- AE4. **Covers R7.** Given a no-result search is softened in Slack, when a
  maintainer inspects diagnostics, they can still see the raw command, exit
  status, stdout, stderr, and no-result classification.
- AE5. **Covers R9, R10.** Given the answer is complete without the optional
  context, when the search finds nothing, Slack either omits the notice or states
  the missing context plainly without exposing shell details.

---

## Success Criteria

- Slack users no longer interpret optional no-match searches as system breakage.
- Real tool failures remain visible enough that operators and maintainers can
  fix them quickly.
- Downstream planning can implement the behavior without inventing which
  outcomes are benign, which remain failures, or what Slack should show.

---

## Scope Boundaries

- This does not create a runtime-wide taxonomy for every possible command or
  tool.
- This does not rewrite `niemand-b2b` agent instructions or `TOOLS.md`.
- This does not hide raw failures from logs or diagnostics.
- This does not require changing the answer-generation behavior for the demo
  brief itself.
- This does not require agents to stop using shell commands, though later policy
  improvements may still encourage safer search patterns.

---

## Key Decisions

- Optimize the Slack user experience first: the immediate pain is misleading
  user-facing failure language, not missing search capability.
- Keep the first classifier narrow: `rg` no-match and `xargs`-wrapped no-match
  are worth handling now because they are common and easy to explain.
- Preserve observability: softening Slack output must not make debugging harder.

---

## Dependencies / Assumptions

- OpenClaw has a presentation or result-normalization point where tool outcomes
  can be classified before Slack renders them.
- Optional context searches can be identified either from tool metadata, command
  shape, or a conservative classifier without inspecting arbitrary private
  content.
- The raw tool result remains stored somewhere accessible to maintainers.

---

## Outstanding Questions

### Resolve Before Planning

- Affects R3, R9. Product: Should benign no-result notices be shown by default,
  or only when the agent relied on that search as part of its answer?

### Deferred to Planning

- Affects R5. Technical: Where is the narrowest safe normalization point for
  classifying `rg` no-match and `xargs`-wrapped no-match outcomes?
- Affects R7. Technical: Which existing diagnostic surface should expose the raw
  command plus user-facing classification?
