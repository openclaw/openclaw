# Interaction profiling

## Procedure

1. **Bound coverage.** Build a manifest of named actions, expected visible results,
   and relevant Gateway requests from the current route catalog and existing E2E
   recipes. Include the task's desktop/mobile, keyboard, loading/error, permission,
   and large-data states. Extend these scenarios within the existing harness.
   **Done:** each planned combination has a scenario ID and explicit assertions;
   exclusions are named. Route visits and test-file counts measure inventory,
   not interaction coverage.
2. **Prepare the production renderer.** Reuse `control-ui-e2e.ts` and its synthetic
   Gateway. Outside the shared suite, use
   `startProductionControlUiE2eServer(outDir, buildId)`. Match fixture
   `serverBuildId` and `serverVersion` to the built UI; a mismatch can show
   “Server updated,” retire the connection, and leave controls loading.
   Reuse parity scenario recipes with native clocks and rendering. The parity
   capture environment changes time, randomness, animations, and rendering flags.
   **Done:** build identity matches, the connection is accepted, and the controls
   needed by the first action are ready.
3. **Measure the interval.** Reuse CDP collection and source mapping from
   `scripts/bench-control-ui-cold-load.ts` and
   `scripts/lib/control-ui-cold-load-trace.ts`. Start tracing/profiling before the
   action and stop after its visible outcome and required requests are asserted.
   Keep navigation separate from warm interactions: document-scoped counters
   reset on navigation/reload. Use explicit step boundaries rather than the
   cold-load summarizer's navigation anchor. Count long tasks on the renderer main
   thread. Attribute interval traffic to the action only after accounting for
   deferred background work.
   **Done:** every measured step has valid start/end boundaries, its assertions,
   task/script/layout/style metrics, and interval RPC counts. Add RPC timing/bytes
   only when supported by the selected instrumentation.
4. **Verify capture.** Apply the main skill's artifact rules. Save per-step trace
   JSON, CPU profile, source-mapped hotspots, screenshot, status, and errors.
   Label trace/profiler overhead. `ui/src/test-helpers/control-ui-cold-load-probes.ts` records Solid
   pane render passes, explicit lifecycle notifications, and message delivery;
   fine-grained bindings and page snapshot computations are outside those render
   counts. Disclose instrumentation and simulated delays.
   Close CDP, browser, and server resources on success and failure.
   **Done:** artifacts are nonempty and readable, screenshots show the asserted
   states, mapping coverage is reported, and failed attempts remain inspectable.
5. **Report and calibrate.** Rank expensive steps in JSON/HTML with evidence links,
   revision, fixture size, viewport, browser, collection mode, and planned,
   executed, failed, and skipped counts. Report renderer/mock, isolated
   real-Gateway, and real-provider results separately. Label automation-to-
   assertion wall time as such; it is neither INP nor per-keystroke latency.
   **Done:** coverage counts reconcile and every conclusion matches its measurement.
   Begin report-only; enable timing gates after repeated same-machine baselines.
   A single successful sample establishes collection and behavior, not stable latency.

## Existing owners and examples

- `ui/src/app-route-paths.ts`: current route inventory; add dynamic states from
  the feature's E2E scenarios.
- `scripts/control-ui-parity/`: visual scenario recipes, with the measurement
  environment caveat in step 2.
- `ui/src/e2e/chat-stream-runtime-budgets.e2e.test.ts`: stream and idle budgets.
- `ui/src/e2e/cron-search.e2e.test.ts`: interaction-scoped tracing.
- `scripts/bench-control-ui-interactions.ts`: large-catalog input and sidebar measurements; `ui/src/e2e/chat-model-controls.e2e.test.ts` retains the behavior assertions.
- `ui/src/e2e/new-session-page.input-latency.e2e.test.ts`: input-latency proof.

Preserve the relevant behavior assertions and structural budgets in these tests.
Asset-size checks cover a different boundary. This procedure composes existing
primitives; verify whether a shared interaction profiler or complete manifest
exists before claiming either is available.
