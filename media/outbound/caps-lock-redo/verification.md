Closes #205063

## What Problem This Solves

After selecting a person in the Control UI composer, pressing Ctrl+Shift+Z with Caps Lock on undoes another edit instead of redoing it. Text after the mention disappears, and Send submits the shortened message.

## User Impact

Redo restores the complete draft and its selected recipient. Chat and New Session share the fix. No configuration changes, migration, or dependency update is required; other history shortcuts still use the existing editor history.

## Why This Change Was Made

The inline mention editor introduced in [ee465500](https://github.com/openclaw/openclaw/commit/ee465500a4575d90bf62446765233b9c01c8703d) (#192242) explicitly intended to preserve undo/redo. CodeMirror matches printable keys without Shift first, so the lowercase `z` produced by Caps Lock + Shift reaches Undo before Redo.

Match the shifted redo chord first through the existing shared keyboard-shortcut matcher, then call CodeMirror's existing redo command. Consume the chord even when the redo stack is empty so it cannot fall through to Undo. The history store, recipient mapping, and controller event forwarding remain unchanged.

Reported and reproduction evidence supplied by @daniel-lxs. The fix commit includes `Co-authored-by: daniel-lxs <57051444+daniel-lxs@users.noreply.github.com>`.

## Work sessions

Linked for team reference; these sessions aren’t public.

- [Discussion, implementation and verification](https://team.openclaw.ai/chat/roboclaw/~key/task-t_i5c4ua)

## Evidence

- Verified the introducing commit and its stated intent; GitHub ancestry checks show both reported failing beta/release revisions contain it.
- Independently reproduced through the real Control UI source, real person/emoji pickers and Send button on Linux x64 / Chromium 156.0.8078.4. Synthetic Gateway fixture data supplied the person and session. Trusted browser CDP events reproduced the reported uppercase Undo/lowercase shifted Redo key values; this was not an OS-level Caps Lock test.
- Before: outgoing `chat.send.message` was `Tuesday @Quinn Harbor`. After: `Tuesday @Quinn Harbor arrives 😄`, with the same `fixture-quinn` recipient span at 8–21. Uppercase Ctrl+Y and Caps-Lock-off Ctrl+Shift+Z also restore the full sentence on the final source.
- Regression: both Caps Lock-on cases (Chat and New Session) fail on the unchanged editor; both off controls pass. All four cases pass on the final repair (Vitest duration 0.671 s). Repeated Redo with an empty redo stack preserves the draft.
- Existing editor suite: 57/59 passed (5.83 s). The two autosize/reflow cases fail with `expected 60 to be less than 60`. One bounded full-file run against the unchanged production editor reproduced those exact failures (5.91 s), alongside the two expected Caps Lock failures. Their cause was not established; no safe unrelated repair or assertion weakening was made.
- UI typecheck, targeted lint, formatting, and `git diff --check` pass. Auto Review completed with no P0 findings; it reviewed but did not execute the tests.
- `pr-simplify` completed: one existing shortcut matcher and one existing history owner, no new state/helper or dependency patch. Delta against the base: +24 production lines and +34 test lines. The added code is the modifier-first dispatch and its behavioral regression; no unrelated cleanup.

Not checked: OS-native Caps Lock, Chromium 159/Ubuntu arm64, Safari/macOS/Windows, live Gateway delivery or recipient inbox, the original package builds, full build or broad CI. Original stable/beta/release observations in the issue are attributed to the supplied report, not claimed as independently rerun. CI time is not yet available.

### Real-app screenshots

Inspected clean and annotated before/after crops are being attached through the managed GitHub evidence uploader. Before source: `ad96c24c0f07274111d92606b292ded245353a13`; after source: `4c37287b707a197c3b7ac36de125777cd8b7ebda`. The images show the actual app with synthetic fixture data; annotations are on copies, not modifications to the UI.
