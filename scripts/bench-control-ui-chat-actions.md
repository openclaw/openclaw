# Chat micro-interaction census

The `chat-actions` group in `bench-control-ui-engines.ts` exercises the production
Control UI with synthetic Gateway responses, 400-message transcripts, 1,000
sessions, 200 plugin commands, and 50 mentionable people. Run serially on the same
host; use a built bundle from each revision for comparisons.

```sh
node --import ./scripts/tsx.mjs scripts/bench-control-ui-engines.ts \
  --steps chat-actions --engines chromium,webkit --viewport both --pairs 3 \
  --output .artifacts/chat-actions/engines
node --import ./scripts/tsx.mjs scripts/bench-control-ui-engines.ts \
  --steps chat-actions --engines chromium --cpu-throttle 4 --viewport both --pairs 3 \
  --output .artifacts/chat-actions/throttled
```

Each scenario can also be selected individually by its `chat-actions-*` ID.
The group is opt-in; it does not expand the runner's default census. Add
`--compare-bundle-dir <head> --control-bundle-dir <base> --pairs 10` for interleaved
base/head/base comparisons, and use a separate `--trace` run for attribution.
All browser runs are headless. Results, screenshots, and profiles stay under the
selected artifact directory and are not committed.

| Flow                                                   | Scenario suffix                                   |
| ------------------------------------------------------ | ------------------------------------------------- |
| Slash menu open, filter, keyboard selection            | `slash`                                           |
| Mention menu open, filter, keyboard selection          | `mention`                                         |
| Transcript find and close                              | `search`                                          |
| Paste 256 KiB text into an existing draft              | `paste-text`                                      |
| Paste or drop a 2048×2048 PNG                          | `paste-image`, `drop-image`                       |
| Message toolbar reveal and copy                        | `hover`, `copy`                                   |
| Rewind, edit, and resubmit                             | `edit-resubmit`                                   |
| Retry or discard a failed unsent message               | `retry`, `discard`                                |
| Fork a session from a message                          | `fork`                                            |
| Long-message or grouped-tool context menu              | `context-long`, `context-tool`                    |
| Reasoning/work and tool disclosure                     | `reasoning-toggle`, `tool-toggle`                 |
| One disclosure action, with 15 or 400 messages         | `{reasoning,tool}-{expand,collapse}-{short,long}` |
| Reopen already-loaded tool content                     | `tool-reopen-{short,long}`                        |
| Open and close terminal, review diff, split pane       | `terminal`, `diff`, `split-view`                  |
| Keyboard session selection through the command palette | `keyboard-session-navigation`                     |

The current product has no direct edit/delete/retry actions on a settled message.
The benchmark exercises Rewind, failed-send retry/discard, and Fork instead.
Split creation is desktop-only; mobile split cells are explicitly skipped.
Clipboard writes terminate at a deterministic in-page boundary in both engines;
the full copied text and visible success state are asserted. Paste/drop events
carry real `File`/`DataTransfer` objects through the application handlers; OS
clipboard transfer and drag initiation are outside the measurement.
Image cases wait for a ready, decoded preview. Mention queries use the synthetic
directory's filtered responses. Tool disclosure uses its keyboard control; the
context-menu case targets the expanded output's code-copy action.

The two `*-toggle` cases are complete open/close cycles. Their input-to-commit
span includes the driver and assertion waits between inputs; do not attribute
that whole span to disclosure rendering. Use the single-action cases to compare
engines or attribute an expansion versus a collapse. For example:

```sh
node --import ./scripts/tsx.mjs scripts/bench-control-ui-engines.ts \
  --steps chat-actions-tool-expand-long,chat-actions-tool-collapse-long,chat-actions-reasoning-expand-short,chat-actions-reasoning-collapse-short \
  --engines chromium,webkit --viewport both --pairs 20 \
  --output .artifacts/chat-actions/disclosures
```

Each single-action case prepares the opposite state outside the measurement,
then sends one native activation and checks both the expanded state and content
visibility. Tool rows use Space; completed-work summaries use a pointer click.
The short fixture retains the same work, tool output, and final answer as the
long fixture, removing only its 385 preceding messages. Expansion includes the
first lazy content load; collapse starts with that content loaded. The tool
`reopen` cases also open and close once during preparation, then measure a single
expansion with the lazy module already loaded. Add the same
bundle as `--compare-bundle-dir` for an interleaved A/A control.

Chromium reports main-thread task/script CPU, long tasks (50 ms or longer), and
native event-handler-to-next-animation-frame callback times. A zero `longestLongTaskMs` means no
observed task reached 50 ms, not that the action consumed no CPU. The event frame
samples exclude automation transport and assertion polling; `wallMs` includes
them and is not INP. The animation-frame callback precedes that frame's layout
and paint and excludes input queueing; it is not completed visual latency.
Menu cycles and multi-step actions report their full interval,
not a fictitious single-input task.

Standard CLS (`layoutShift`) excludes recent-input shifts, which are recorded
separately. Support flags accompany both Long Tasks and Layout Instability data:
unsupported metrics must be reported as unavailable, not zero. WebKit's untraced
task/script counters are unavailable; use its separate Inspector timeline for
elapsed-time attribution, never its aged CPU utilization as action CPU.

Rank against longest task ≤50 ms at Chromium 1×, ≤200 ms at 4×, event-to-frame
≤100 ms at 4×, CLS zero, and WebKit/Chromium untraced input-to-commit application
ratio ≤1.3 for single actions. Keep compound cycles diagnostic. One sample
only diagnoses coverage. A claimed optimization needs ten serial interleaved
pairs and an A/A control: median regressions ≤5% and no worse p95, or ten further
pairs confirming that band. On a noisy host, use Chromium task/script CPU and
row insertion/removal counts alongside timing. Keep results in the PR body.
