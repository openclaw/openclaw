# Control UI data-page interaction workloads

These scenarios extend `scripts/bench-control-ui-interactions.ts`. They use the
production UI bundle and the existing synthetic Gateway transport. Each scenario
prepares its prerequisite state before the measured action, then asserts its
visible result. The tables below describe workload contracts, not successful runs;
the runner's retained `results.json` records passed, failed, and skipped cells.

```sh
node --import ./scripts/tsx.mjs scripts/bench-control-ui-interactions.ts \
  --bundle-dir <base-bundle> --compare-bundle-dir <head-bundle> \
  --control-bundle-dir <base-bundle> \
  --data-pages --viewport desktop --pairs 20 --cpu-throttle 1 \
  --thread-cpu-time --first-pair-screenshots --output <artifact-parent>
```

Run again at `--cpu-throttle 4`. Use `--steps <comma-separated-ids>` to select a
focused subset. `--control-bundle-dir` requires a comparison bundle and runs each
pair serially as baseline/candidate/control. Point control at the baseline bundle
to collect an A/A noise control in the same run; `summary.json` separates
`comparisons` from `controlComparisons` and the manifest labels all three roles.
The same-machine performance rule is median regression at most 5% with no worse
p95; if wall time is noisy, use 20 interleaved pairs of renderer CPU and structural
counts. Report absolute task time against the lane's 100 ms at 1× / 200 ms at 4×
targets. A single smoke pair verifies setup and assertions, not latency stability.

All results retain task, script, layout and style time, long tasks, RPC counts,
DOM counts, and JavaScript heap endpoints. Heap values are **unforced** samples:
GC timing affects the delta, so these are not retained-heap or leak measurements.
Raw `TaskDuration` includes DevTools command work. Report it separately from
`TaskDuration - DevToolsCommandDuration`; the subtraction is derived attribution,
not independently measured latency or INP. Scroll cases use programmatic jumps
or wheel events, not sustained trackpad scrolling.
`--trace` is a separate attribution run; profiler overhead is not mixed with
untraced timing. First-render cases measure the first route/reveal action after
the shell is ready, not full document startup.

Use a separate retained-memory run for the long log stream:

```sh
node --import ./scripts/tsx.mjs scripts/bench-control-ui-interactions.ts \
  --bundle-dir <head-bundle> --steps data-logs-long-stream --viewport desktop \
  --retained-heap --pairs 1 --output <memory-artifact-parent>
```

`--retained-heap` invokes `HeapProfiler.collectGarbage` before action metrics and
tracing start, then again after the action metrics and trace interval close. It
adds `retainedHeap.beforeBytes`, `afterBytes`, and `deltaBytes` alongside the
unforced heap endpoints. This collection is labeled GC-controlled proof in the
manifest; keep its timing results separate from normal CPU comparisons.
The long-stream fixture releases consumed response arrays before both heap
endpoints so its synthetic response queue is not mistaken for UI retention.

## Usage

The synthetic Gateway holds 12,000 sessions across 180 calendar days, 96 model
IDs, 100 agent IDs, and 80 tool names. It calls the real `buildUsageOverview`
owner for date selection, population filtering, sort and paging. Browser responses
contain at most 50 session rows. Most warm cases select all 180 days in preparation.

| Scenario                  | Measured action and visible assertion                                                |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `data-usage-first-render` | Open Usage from Pages; await its first bounded session list and query control.       |
| `data-usage-date-range`   | Expand the date range to 180 days; assert the 12,000-session total.                  |
| `data-usage-model-filter` | Select one model from the filter menu; assert 125 matching sessions.                 |
| `data-usage-search`       | Apply the final session's label; assert that one result.                             |
| `data-usage-sort`         | Change the default cost order to recent; await the new Gateway query and ready rows. |
| `data-usage-refresh`      | Refresh the full date range; await the query and retained visible session rows.      |
| `data-usage-scroll`       | Scroll the session card into view; record its bounded mounted row count.             |

## Plugins and agents

Installed plugins, catalog entries, skills, and tool summaries each contain 1,000
items. The catalog uses 100-item cursor pages. The agent roster contains 300 agents;
the tool report has 40 groups of 25 tools with effective-access diagnostics.

| Scenario                     | Measured action and visible assertion                                         |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `data-plugins-render`        | Open installed-plugin settings; assert 1,000 rows.                            |
| `data-plugins-filter`        | Type a label prefix; assert 100 matching rows.                                |
| `data-plugins-refresh`       | Deliver a plugin-change receipt; await the updated 1,000-row inventory.       |
| `data-plugins-scroll`        | Scroll the final installed plugin into view.                                  |
| `data-catalog-load-more`     | Append the final 100-item cursor page to 900 existing cards.                  |
| `data-catalog-search`        | Search through the debounced Gateway query; assert 100 results.               |
| `data-agent-selection`       | Reopen the hydrated 300-agent selector and select its final agent.            |
| `data-agent-selection-100ms` | Repeat hydrated selection with 100 ms simulated identity-RPC round trips.     |
| `data-agent-skills-render`   | Reveal the Skills panel; assert 1,000 skill rows.                             |
| `data-agent-skills-filter`   | Filter to the final skill; assert one row.                                    |
| `data-agent-skills-refresh`  | Refresh skills; await the report and preserved rows.                          |
| `data-agent-skills-scroll`   | Scroll the final skill into view.                                             |
| `data-agent-tools-render`    | Reveal Tools; assert 1,000 summaries and record mounted detail panels.        |
| `data-agent-tool-disclosure` | Open one tool; assert its effective-access details and record mounted panels. |

## Activity and logs

Activity has 1,000 sessions with current summaries, presented through its real
100-row Gateway window. Logs arrive in 500-line JSONL tails, with mixed levels,
20 subsystems, and every hundredth line containing the filter sentinel. The UI
retains at most 2,000 lines. Warm log preparation lets four real polls fill the
buffer and disables auto-follow through its visible control except in the
explicit follow case. Tail measurements hold the next native poll before the
interval, then release that response during the measured action.

| Scenario                     | Measured action and visible assertion                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data-activity-first-render` | Open Activity from Pages; assert its 100-row window.                                                                                                                                                 |
| `data-activity-search`       | Search for the final session beyond the initial window; assert its title.                                                                                                                            |
| `data-activity-time-filter`  | Select All time; await the bounded 100-row replacement.                                                                                                                                              |
| `data-activity-live-update`  | Deliver one current session receipt; assert its updated recap and retained 100-row window.                                                                                                           |
| `data-activity-scroll`       | Scroll to the last row and assert its label and retained count.                                                                                                                                      |
| `data-logs-first-render`     | Open Logs from the settings sidebar; assert the newest of 500 lines.                                                                                                                                 |
| `data-logs-filter`           | Filter the full buffer by sentinel; assert 20 matching rows and the final sentinel.                                                                                                                  |
| `data-logs-level-filter`     | Disable info; assert 800 warning/error results and a bounded mounted window.                                                                                                                         |
| `data-logs-tail-update`      | Release 500 new lines; assert the retained reader position, 2,000-line cap, and eviction of the oldest.                                                                                              |
| `data-logs-follow-update`    | Release a tail with auto-follow enabled; assert a bottom gap below 120 px before and after.                                                                                                          |
| `data-logs-refresh`          | Refresh from a full buffer; assert replacement by the latest 500 lines.                                                                                                                              |
| `data-logs-scroll`           | Scroll up, release a tail, assert no scroll jump, then scroll to the bottom.                                                                                                                         |
| `data-logs-long-stream`      | Enable auto-follow, deliver 10,000 lines over 20 native two-second polls, then assert newest line and 2,000-line cap. Expected wall duration is about 40 seconds; its wait is bounded at 60 seconds. |

Logs always render a variable-height window. The scenarios
read the retained result count from list-item `aria-setsize` and assert fewer than
100 mounted rows; eager comparison builds use their DOM count. The append-only
tail scenario keeps auto-follow disabled and verifies that the retained last
line's position moves from 2,000 to 1,500 after trim. Follow and scroll scenarios
separately reach the newest line. The plain End key converges on the final row
as wrapped heights settle; the Logs browser regression covers desktop and narrow
viewports. The application filter and export still cover all retained lines;
browser Find and native text selection cover mounted rows.

## Board, dashboards, and workspace

The board holds 1,000 native core report widgets across four tabs, each with metrics
and a 12-point chart; 250 are visible per tab. Native reports isolate board work
from iframe process startup. The gallery has 1,000 saved dashboards with one preview
widget each. Workspace browsing has 20 folders with 250 files per folder (the real
per-folder cap); warm tree cases open all folders before measuring the action.

| Scenario                                | Measured action and visible assertion                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| `data-board-first-render`               | Open Dashboard; assert 250 visible report widgets.                                      |
| `data-board-tab-switch`                 | Switch to another tab; assert its 250 reports and retain the visited tab.               |
| `data-board-live-update`                | Deliver a receipt updating one report; assert its new value and widget count.           |
| `data-board-scroll`                     | Scroll the board; assert its mounted reports remain.                                    |
| `data-dashboards-first-render`          | Open Dashboards from Pages; assert 1,000 cards.                                         |
| `data-dashboards-search`                | Search by final title; assert one card.                                                 |
| `data-dashboards-sort`                  | Sort by title; assert all 1,000 cards and their new leading title.                      |
| `data-dashboards-scroll`                | Scroll to the last gallery row; record nearby preview reads.                            |
| `data-dashboards-responsive-navigation` | Verify native keyboard navigation and 3/2/1-column geometry at 1280/900/520 px.         |
| `data-workspace-first-render`           | Open Files; assert the 20-folder root listing.                                          |
| `data-workspace-expand`                 | Open the last folder after the other 19; await its final child and record mounted rows. |
| `data-workspace-search`                 | Search the loaded tree; assert 20 authoritative matches.                                |
| `data-workspace-filter`                 | Select Changed; assert modified files and their folders.                                |
| `data-workspace-scroll`                 | Scroll within the expanded 5,000-file Files panel.                                      |

`data-dashboards-responsive-navigation` is correctness/capture proof; exclude it
from timing comparisons. At widths of 1280, 900, and 520 px, it expects three,
two, and one columns respectively, with no horizontal grid or document overflow.
It scrolls to and focuses the final card, waits for its author and report preview,
and checks that its original native anchor retains identity and focus. Shift+Tab
reaches the preceding card and Tab returns to the final card. All 1,000 cards,
anchors, and titles remain mounted. The scenario preserves the viewport height
and restores the original viewport before the harness's normal capture; it does
not produce a screenshot at each tested width.

## Boundaries and exclusions

These are renderer measurements, not real-Gateway, filesystem, provider, network
throughput, or backend-query benchmarks. No model or external service is called.
Agent selection waits for all 300 identity-only emoji avatars before measuring
reopening and selection. Its two variants use local responses or a 100 ms delay
on each identity RPC; this is not a whole-network latency simulation. Other
scenarios install no network delay. Gateway callbacks use the existing mock transport;
Usage filtering/paging and session-window selection reuse production owners.

The workload does not invent sort controls on pages without them. Plugin-provided
views and heavy iframe documents belong to their separate lane. Mobile coverage
is available through `--viewport mobile` but is not implied by desktop results.
The log endurance case demonstrates bounded row retention; a claim of bounded
retained memory additionally needs repeated heap evidence with GC control.
