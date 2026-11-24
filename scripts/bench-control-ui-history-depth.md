# Control UI older-history depth benchmark

`bench-control-ui-history-depth.ts` measures how the cost of loading one older
history page grows with the history already loaded. It starts an isolated real
Gateway the way `ui/src/e2e/chat-loading-performance.real-gateway.e2e.test.ts`
does (`createOpenClawTestInstance`, `sessions.create`, `appendTranscriptMessages`),
serves an already-built Control UI bundle through that Gateway, enters the
session through the `openclaw dashboard --json` handoff, and pages backward with
real wheel input until the history is exhausted.

The Gateway runs from this checkout's `dist/` (run `pnpm build` first). The UI
bundle is any built `dist/control-ui` directory; the runner never builds or changes
it. It copies each bundle into the isolated state and serves it through
`gateway.controlUi.root`, which opts out of the bundled build-identity check, so
base and head bundles can share one Gateway. Configured roots are served
uncompressed and revalidated; every sample uses a fresh browser over loopback, so
delivery stays out of the paging measurement. The page also loads the real-Gateway
E2E pane adapter (`createControlUiPaneRuntimeTestAdapterScript`) to read the
pane's loaded messages and loading state.

```sh
node --import ./scripts/tsx.mjs scripts/bench-control-ui-history-depth.ts \
  --bundle-dir /absolute/base/dist/control-ui \
  --compare-bundle-dir /absolute/head/dist/control-ui \
  --pairs 3 --output .artifacts/history-depth/compare
```

| Flag                                   | Default                                      | Effect                                                                               |
| -------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `--bundle-dir`, `--compare-bundle-dir` | `dist/control-ui`, none                      | Base and optional head bundle. With both, samples alternate order each pair.         |
| `--pairs`                              | 1                                            | Samples per bundle. Each sample uses a fresh browser and handoff.                    |
| `--messages`                           | 30000                                        | Seeded transcript rows in the measured session.                                      |
| `--pages`                              | 0 (all)                                      | Stop after this many older pages.                                                    |
| `--early-pages`                        | 5                                            | Width of the early and late windows in the summary.                                  |
| `--skills`                             | 0                                            | Workspace `SKILL.md` files written before Gateway start.                             |
| `--other-sessions`                     | 0                                            | Extra 200-message sessions that receive background `chat.inject` writes.             |
| `--inject-interval-ms`                 | 1000                                         | Fixed interval of those writes (admin-scoped setup client).                          |
| `--cpu-throttle`                       | 1                                            | `Emulation.setCPUThrottlingRate` for the paging phase.                               |
| `--profile-pages`                      | none                                         | Comma-separated pages that also record a source-mapped CPU profile.                  |
| `--settle-ms`                          | 250                                          | Quiet time before each page.                                                         |
| `--gateway-start-timeout-ms`           | 180000                                       | Gateway readiness budget; a loaded host can exceed the test helper's default.        |
| `--gateway-stop-timeout-ms`            | 60000                                        | Gateway teardown budget.                                                             |
| `--output`                             | `.artifacts/control-ui-history-depth/<time>` | `results.json`, `summary.md`, and per-sample screenshots, profiles and browser logs. |

The transcript cycles through user questions with markdown and links, assistant
tool calls, tool results of 20 to 220 lines, and replies with headings, tables,
links and fenced code. Every sample opens the session at its tail, positions the
pointer over the thread, and repeats one page:

1. Wait until the pane is not loading, has no pending history intent, and no
   `chat.history` read is in flight, then wait `--settle-ms`.
2. Start CDP `Performance` metrics (thread ticks), arm the in-page probe, and send
   one real wheel event that reaches the top (smooth scrolling is disabled).
   A wheel that starts no load within 5 s (no consumed history intent, loading
   state or new first message) is retried twice; the wheel that starts the load
   starts the interval, however long the load then takes.
3. Stop after the first loaded message changes, the pane is quiet for two
   frames, and the staged successor read started by this commit has returned.

Each page records wheel-to-first-message-change and wheel-to-idle (pane quiet)
wall time. Over the whole interval of step 3 it records ScriptDuration,
TaskDuration, LayoutDuration and RecalcStyleDuration deltas, layout and style
counts, long tasks, and every `chat.history` read sent with its latency, response
bytes and message count; it also records JS heap and rendered rows. After paging, the runner checks that loaded messages have
unique ids and strictly ascending transcript sequence numbers; `complete` reports
whether every seeded row loaded.

The summary prints medians for the early and late windows, their late/early
ratio, a per-page table, and host load. Profiled pages are excluded from the
medians because the profiler inflates them; inspect their `page-N.cpu.txt` tables
instead. Wall times are automation-observed (rAF-sampled) intervals, not INP.
On a shared host, judge script/task CPU and counts before wall time, and use the
base bundle as both `--bundle-dir` and `--compare-bundle-dir` for an A/A control.

Results are written before Gateway teardown. A teardown that exceeds its budget
is recorded in `gateway.cleanup` and does not discard the measurement.
