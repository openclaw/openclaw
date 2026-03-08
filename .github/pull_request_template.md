## Summary

Describe the problem and fix in 2–5 bullets:

- Problem: In web chat UI, assistant message copy button is hidden on desktop unless hover is available, which reduces discoverability and slows copy workflow.
- Why it matters: Users often copy assistant output into docs/notes; visible affordance improves usability and accessibility.
- What changed: Updated chat copy-button styling so copy action is visible and clickable by default in assistant message bubbles.
- What did NOT change (scope boundary): No backend/gateway/tooling changes, no message rendering logic changes, no clipboard API behavior changes.

## Change Type (select all)

- [ ] Bug fix
- [x] Feature
- [ ] Refactor
- [ ] Docs
- [ ] Security hardening
- [ ] Chore/infra

## Scope (select all touched areas)

- [ ] Gateway / orchestration
- [ ] Skills / tool execution
- [ ] Auth / tokens
- [ ] Memory / storage
- [ ] Integrations
- [ ] API / contracts
- [x] UI / DX
- [ ] CI/CD / infra

## Linked Issue/PR

- Closes #
- Related #

## User-visible / Behavior Changes

- Assistant bubbles now show copy button by default (not only on hover).
- Copy button remains keyboard-focusable and clickable.
- Existing copied/error visual states remain unchanged.

## Security Impact (required)

- New permissions/capabilities? (`No`)
- Secrets/tokens handling changed? (`No`)
- New/changed network calls? (`No`)
- Command/tool execution surface changed? (`No`)
- Data access scope changed? (`No`)
- If any `Yes`, explain risk + mitigation:

## Repro + Verification

### Environment

- OS: macOS (Apple Silicon)
- Runtime/container: local dev runtime
- Model/provider: N/A (UI-only change)
- Integration/channel (if any): web chat UI
- Relevant config (redacted): default

### Steps

1. Open web chat UI with assistant messages.
2. Observe top-right area of assistant bubble.
3. Click copy button and verify copied/error state feedback.

### Expected

- Copy button is visible by default on assistant bubbles.
- Button copies message text and shows copied/error feedback.

### Actual

- Matches expected.

## Evidence

Attach at least one:

- [ ] Failing test/log before + passing after
- [ ] Trace/log snippets
- [x] Screenshot/recording
- [ ] Perf numbers (if relevant)

## Human Verification (required)

What you personally verified (not just CI), and how:

- Verified scenarios: assistant bubble displays copy button by default; click action still works; copied/error styles still work.
- Edge cases checked: hover and non-hover behavior, focus-visible behavior.
- What you did **not** verify: full cross-browser matrix and E2E automation.

## Compatibility / Migration

- Backward compatible? (`Yes`)
- Config/env changes? (`No`)
- Migration needed? (`No`)
- If yes, exact upgrade steps:

## Failure Recovery (if this breaks)

- How to disable/revert this change quickly: revert CSS block in `ui/src/styles/chat/grouped.css` for `.chat-copy-btn` opacity/pointer-events.
- Files/config to restore: `ui/src/styles/chat/grouped.css`
- Known bad symptoms reviewers should watch for: visual overlap in very narrow bubbles or unwanted visual noise from always-visible controls.

## Risks and Mitigations

List only real risks for this PR. Add/remove entries as needed. If none, write `None`.

- Risk: Always-visible icon may feel visually busy in dense chat threads.
  - Mitigation: keep icon compact, maintain subtle styling, preserve existing copied/error feedback only on interaction.
