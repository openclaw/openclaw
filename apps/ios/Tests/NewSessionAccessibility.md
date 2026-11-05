# New session accessibility verification handoff

Related: [#193485](https://github.com/openclaw/openclaw/issues/193485).

This is a temporary coordination checklist, not an implementation or a passing
regression test. The draft containing it does not fix the reported layout defect.
Native reproduction, the layout change, and native verification are still pending.
Remove this handoff or fold its useful checks into the final regression coverage
before marking the PR ready.

## Baseline and source ownership

- The reference clean-main source is
  `1bf13d4df5c14654fe964dcbc42427ac74104c9f`. Recheck current `origin/main`
  before native reproduction and record the exact revision actually tested.
- Use an isolated, clean checkout, not an existing local Debug build with unrelated
  changes. Follow [the iOS build instructions](../README.md).
- Start with `apps/ios/Sources/Design/ChatProTab.swift` and
  `apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatSessionManagementViews.swift`.
  Verify the current presentation, shared view, callers, and scoped instructions
  before editing.
- Preserve the shared macOS popover and existing thread and working-copy behavior.
  Do not reduce the selected text size, add an explanatory banner, or assume one
  device height.

## Reproduce before changing the layout

1. Connect the iOS app to an isolated test Gateway with an available agent and a
   disposable Git workspace. Do not use production sessions or user worktrees.
2. Choose a representative supported iPhone Simulator viewport and a smaller
   supported viewport. Record device model, viewport, iOS version, build revision,
   and Dynamic Type category for each run.
3. Set Dynamic Type to accessibility-extra-extra-extra-large. Open
   **Chat actions → New session options…**, with **Separate working copy** OFF
   and no keyboard open.
4. Capture the surrounding sheet and attempt normal scrolling. Record whether
   the title, explanation, toggle label, Cancel, and Create Thread are readable
   or reachable. The report says scrolling does not recover the clipped controls;
   downward sheet dismissal still works. Confirm the actual baseline behavior.
5. Repeat at the default text size, without changing other scenario details.

## Required patched verification

Run each viewport at both default and maximum accessibility text sizes. Record
actual outcomes rather than treating these unchecked items as evidence.

- [ ] With Separate working copy OFF and keyboard hidden, title, explanation,
      toggle label, and actions are readable or reachable by normal scrolling.
- [ ] Tap Cancel and verify dismissal without a new thread or working copy.
- [ ] Reopen, tap Create Thread, and verify the created thread through the test
      Gateway and app, not merely the existence of a button. Record its identifier.
- [ ] Repeat with Separate working copy ON, including every additional field.
- [ ] Focus the additional editable fields, show the keyboard, and verify that
      fields and actions remain reachable. Check keyboard-hidden behavior too.
- [ ] Verify Cancel with the ON/keyboard scenario creates nothing.
- [ ] Create a thread with Separate working copy ON and verify both the thread
      result and the separate working copy in the disposable test workspace.
- [ ] Run focused native tests and an iOS build using the repository instructions.
- [ ] Check the shared macOS popover, including OFF/ON behavior and its actions,
      and run the applicable shared/macOS tests or build.

## Evidence to return to the draft

Provide the exact baseline SHA, patched SHA or diff, build/test commands and
results, simulator settings, and thread/working-copy verification results.
Capture actual native before/after screenshots with the same scenario, viewport,
and maximum accessibility size; show the surrounding sheet and reaching and
activating controls. Inspect and sanitize media before sharing.

Display **Before**, its image, then **After**, its image in chat, and include
accessible evidence in the PR. Follow the repository media guidance and use the
currently supported authorized GitHub upload route first. If recording video,
read the proof-video skill before recording. A local path or a picture of a
button alone is not sufficient verification.

Do not mark ready, merge, or deploy on the strength of this checklist.
