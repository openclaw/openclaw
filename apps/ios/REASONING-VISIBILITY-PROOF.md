# iOS Reasoning Visibility — Verification & Proof

Tracks PR #151966 (`fix/ios-reasoning-visibility`, closes #151953) and the
ClawSweeper "needs real behavior proof" gate.

## Contract (mirrors the Control UI)

Reasoning ("thinking") rows render only when **both** hold:

1. the session's Gateway-authoritative `reasoningLevel` is `"on"`
   (`/reasoning` directive; the exact Control UI condition
   `activeSession?.reasoningLevel === "on"`), and
2. the device-local "Show reasoning & tool activity" toggle is on.

Tool activity remains a purely local preference; an absent `reasoningLevel`
(older Gateway) defaults to hidden, matching the Control UI.

## Wire sources of `reasoningLevel`

- History summaries (`OpenClawChatSessionInfo`) on bootstrap/reload.
- Session rows (`OpenClawChatSessionEntry`) in `sessions.list` responses.
- `sessions.changed` events, including lifecycle (`start`/`end`/`error`)
  snapshots merged via `mergedLifecycleSession`.

## Regression coverage (apps/shared/OpenClawKit/Tests)

- `ChatReasoningVisibilityTests`: decode of `reasoningLevel` from history
  summaries, session rows, and `sessions.changed` events; sidebar projection
  applies it; absent key preserves a known value; history reload projects
  `sessionInfo.reasoningLevel` through `applyInFlightRunSnapshot` into the
  active session row.
- `ChatReasoningVisibilityGateTests` (in `ChatViewModelTests.swift`):
  `currentSessionReasoningVisible` is true only for `"on"`; lifecycle snapshot
  merges carry `reasoningLevel`; a capped (50-row) session list that omits the
  active session retains its authoritative reasoning state, and re-listing the
  row reasserts authoritative ownership.

## Behavior proof checklist (needs a macOS/iOS run)

- [ ] `swift test` (focused: reasoning visibility + view-model suites) passes
      on macOS.
- [ ] iOS app builds; no SwiftUI/typography regressions.
- [ ] Fresh install: `/reasoning off` hides reasoning after acknowledgement and
      after relaunch; `/reasoning on` restores it.
- [ ] Upgraded device with cached session metadata + saved local trace
      preference behaves identically.
- [ ] Local toggle on alone does not surface reasoning while the session
      directive is not `"on"`.
- [ ] Selecting an older session omitted from the 50-row list still reflects
      its history's `reasoningLevel`.
- [ ] Before/after screenshots (redacted) attached in the originating chat and
      the PR, per the root UI screenshot gate.

Host note: the authoring host is Windows with no Swift/Xcode toolchain, so the
boxes above intentionally stay unchecked until CI or a macOS run produces them.
