# Agent stream update allocation

`agent-stream-update-measure.ts` runs the agent loop with 1,000 synthetic history
entries, 40 tools, and a replayed provider stream. It does not launch a Gateway or
measure the full provider transport stack. In particular, allocation attributed to
its generator is fixture allocation, not the sum of the production layers below.

Use `--transforms 0`, `1`, and `3` to measure no decorator, one real
`wrapStreamObjectEvents` decorator, and three adjacent decorators. The latter share
one iterator. Hooks count observations without changing replay bytes. Run timing,
allocation, and promise counting separately; instrumentation changes CPU costs.

```sh
node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-stream-update-measure.ts --mode timing --events 3000 --turns 100 --warmup 10 --transforms 3
# Repeat with --mode allocation and --mode promises.
node --import ./scripts/tsx.mjs scripts/perf/agent-stream-update-measure.ts --mode verify --transforms 3
```

Compare the same command on base and candidate, alternating AB/BA for five pairs.
Accept lower allocation/update with stable CPU, identical delivery/observation
counts, and identical recording hashes between revisions. Compare hashes at the
same decorator count: additional asynchronous boundaries can change the relative
ordering of concurrent tool events. The recording covers thinking, text,
partial-free text, async tool fragments, and a blocking tool continuation.

## Iterator inventory

The Responses path has two stages: raw transport events and assistant-message
events. A raw event can emit zero, one, or several assistant events. Conditional
layers depend on provider, request, and enabled features; adding their costs as
though every layer processed every event would be misleading.

| Raw Responses SSE layer, source to reducer | Owner under `packages/ai/src/`                                                       | Responsibility                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| SSE parsing and terminal drain             | `transports/openai-responses-replay-internal.ts`, `streamWithTerminalDrain`          | Reader cleanup and terminal buffering                     |
| Source failure attribution                 | Same file, `providerStream`                                                          | Distinguishes provider failure from consumer/hook failure |
| Response-model tracking, when enabled      | `transports/openai-transport-shared.ts`, `track`                                     | Attests the served model                                  |
| Compaction collection, when enabled        | `transports/openai-responses-compaction-v2.ts`, `observe`                            | Records compaction output                                 |
| Transport observation                      | `transports/openai-responses-stream-observer-internal.ts`, `observeResponsesStream`  | Event counters and final diagnostics                      |
| Provider response hook                     | `transports/transport-stream-shared.ts`, `withProviderResponseHook`                  | One-time hook and start admission, then delegation        |
| Replay/recovery                            | `transports/openai-responses-replay-internal.ts`                                     | Retry eligibility and replacement source                  |
| Continuation acceptance, when supplied     | `transports/openai-responses-request-lifecycle.ts`, `withResponsesRequestAcceptance` | Awaited receipt and live authority before output          |
| First-event timeout, when enabled          | `utils/stream-first-event-timeout.ts`                                                | First-read deadline and abandoned-source cleanup          |
| Cooperative scheduling                     | `transports/transport-stream-shared.ts`, `iterateModelStream`                        | Shared work budget and cancellation                       |
| Reducer                                    | `transports/openai-responses-stream-internal.ts`, `processResponsesStream`           | Consumes raw events and produces assistant events         |

WebSocket requests instead start at `openai-responses-websocket.ts` and
`openai-responses-websocket-recovery.ts`, then rejoin acceptance, timeout,
scheduling, and reduction.

| Assistant-event layer, source to consumer  | Owner                                                                            | Responsibility                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Event queue                                | `packages/llm-core/src/utils/event-stream.ts`, `EventStream`                     | Queue, waiter, producer result                                  |
| Host binding                               | Same file, `bindAssistantMessageEventStream`                                     | Synchronous context binding; forwards source promises/results   |
| Rate-limit observer, keyed requests only   | `src/llm/provider-rate-limit-stream.ts`                                          | Observes terminal failures                                      |
| Compaction repair settlement               | `src/agents/embedded-agent-runner/run/attempt-stream.ts` and `stream-wrapper.ts` | Repairs settle before affected events or completion             |
| Standalone tool-call promotion, with tools | `attempt-tool-call-text-promotion.ts`                                            | Can buffer or replace events                                    |
| Adjacent event transforms                  | `stream-wrapper.ts`, `wrapStreamObjectEvents`                                    | Ordered tool-name normalization, argument repair/decoding hooks |
| Plugin text replacement, when configured   | `src/agents/plugin-text-transforms.ts`                                           | Output replacement, including new event envelopes               |
| Stop-reason recovery                       | `attempt-stop-reason-recovery.ts`                                                | Stable promise continuation and synthetic failure terminal      |
| Idle/deadline guard, when enabled          | `llm-idle-timeout.ts`                                                            | Abort/timeout waiting and cleanup                               |
| Model-call diagnostics                     | `attempt.model-diagnostic-events.ts`                                             | Observation, overlapping-read order, completion                 |
| Agent consumer                             | `packages/agent-core/src/agent-stream-response.ts`                               | Final `for await` and agent event emission                      |

Unqualified attempt filenames above are under
`src/agents/embedded-agent-runner/run/`. `wrapStreamFnWithMessageTransform`
transforms request context, and `runAgentCoreStream` binds whole-consumer ownership:
neither adds a per-event iterator. Managed plugin ownership views can additionally
wrap provider surfaces; they are authority boundaries, not redundant observers.

## Promise and iterator-result accounting

For a native promise-returning source on Node, each plain `for await` read uses a
source promise and its consumption reaction. Typical additional costs are:

| Forwarding shape                               | Additional promises/event |           Additional iterator results/event |
| ---------------------------------------------- | ------------------------: | ------------------------------------------: |
| `for await (...) yield event` generator        |                         4 |                                           1 |
| `yield* source` generator                      |                         2 |                                           1 |
| `async next() { return await source.next(); }` |                         2 |                                           0 |
| `source.next().then(stableObserver)`           |                         1 | 0 if the observer returns the source result |
| Synchronous promise forwarding                 |                         0 |                                           0 |

These are language-shape counts, not a composed transport measurement. Timer races,
async hooks, source implementation, and retries add their own work. The probe's
`--mode promises` measures the real agent-loop composition for the selected
transform count. Its owner regression separately checks 16 reads: 16 source
promises plus 16 shared transform continuations, while retaining source result
identity. Async transforms still suspend before subsequent hooks and delivery;
`return()` and `throw()` stay with the existing iterator wrapper.

### Real-layer probe

`--layer` selects real production installers instead of the agent-loop workload.
The companion `agent-stream-update-layers.ts` imports the owners before enabling
instrumentation. It uses a native promise-returning synthetic source and compares
32 events with the requested event count, subtracting constant request setup and
teardown. The reported slope includes the source promise and consuming reaction
(2/event); subtract 2 to obtain the added forwarding cost. This is a steady serial
read workload, not a cancellation or concurrent-read correctness test.

```sh
node --import ./scripts/tsx.mjs scripts/perf/agent-stream-update-measure.ts --layer all --mode promises --events 256 --turns 1 --warmup 1
node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-stream-update-measure.ts --layer responses-observer --mode timing --events 3000 --turns 20 --warmup 5
# Repeat with --mode allocation, alternating base/candidate for five pairs.
node --import ./scripts/tsx.mjs scripts/perf/agent-stream-update-measure.ts --layer responses-observer --mode verify --events 256 --turns 1 --warmup 1
# The other shared observer owner uses the same four modes:
node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-stream-update-measure.ts --layer model-diagnostics --mode timing --events 3000 --turns 20 --warmup 5
node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-stream-update-measure.ts --layer model-diagnostics --mode allocation --events 3000 --turns 20 --warmup 5
node --import ./scripts/tsx.mjs scripts/perf/agent-stream-update-measure.ts --layer model-diagnostics --mode promises --events 3000 --turns 1 --warmup 1
node --import ./scripts/tsx.mjs scripts/perf/agent-stream-update-measure.ts --layer model-diagnostics --mode verify --events 240 --turns 1 --warmup 1
```

The observer's verification mode cycles a fixed eight-frame synthetic recording:
response creation, item creation, reasoning and text deltas, split tool arguments,
completed tool item, and terminal response with model, service tier, and usage.
It hashes every delivered frame. The original agent-loop verification above still
covers the assistant-event and blocking/async tool continuation recording.

`model-diagnostics` installs `wrapStreamFnWithDiagnosticModelCallEvents` with the
real model lifecycle, transport context, and observer; it does not supply a mock
lifecycle. Its context contains 1,000 synthetic history entries and 40 tools.
Timing, allocation, and promise modes use ordinary text updates; verification
cycles a twelve-event assistant recording containing start, thinking, text,
split tool arguments, a completed tool call, and done. Message timestamps and
tool identifiers are fixed. The hash includes delivered events and the final
result, excluding transient diagnostic timestamps and generated child trace IDs.
Result observation is awaited between requests so one request's diagnostic tail
cannot leak into the next measurement. This measures the ordinary observer with
no diagnostic subscribers or plugin hooks; content capture and subscriber sinks
are separate costs.

The steady-state inventory is below. Other than the two observer owners,
these rows record remaining work; this change does not rewrite their owners.
Both observer counts are measured with their real installers. The shared helper
projects one iterator-result object per delivered event so accessor-backed source
values are read exactly once.

| Probe layer          | Current forwarding shape                               | Total promises/event |               Added promises/event |
| -------------------- | ------------------------------------------------------ | -------------------: | ---------------------------------: |
| `source`             | Native resolved promise                                |                    2 |                                  0 |
| `responses-observer` | Stable `.then(observe, reject)` continuation           |                    3 |                                  1 |
| `model-diagnostics`  | Stable continuation inside the real model lifecycle    |                    3 |                                  1 |
| `response-model`     | `for await` / `yield`                                  |                    6 |                                  4 |
| `compaction-v2`      | `for await` / `yield`                                  |                    6 |                                  4 |
| `provider-hook`      | One-time admission, then `yield*`                      |                    4 |                                  2 |
| `acceptance`         | `for await` / `yield`                                  |                    6 |                                  4 |
| `first-event`        | Awaited reads / `yield` after first-read race          |                    6 |                                  4 |
| `scheduling`         | `for await` / `yield`, occasional budget await         |  6 plus budget waits |                4 plus budget waits |
| `event-queue`        | Async generator yielding buffered entries              |                    4 |                                  2 |
| `event-waiter`       | Async generator awaiting queue waiter                  |                    6 |                                  4 |
| `binding`            | Synchronous context-bound forwarding                   |                    2 |                                  0 |
| `rate-limit`         | Keyed `for await` / `yield` observer                   |                    6 |                                  4 |
| `promotion`          | Two nested `for await` / `yield` generators            |                   10 |                                  8 |
| `plugin-text`        | `async next()` awaiting source; replaces result        |                    4 |                                  2 |
| `idle`               | Async next, waiter promise, source continuation        |                    6 |                                  4 |
| `responses-sse`      | SDK/body plus terminal drain, attribution and recovery |                   22 | Composition, not an isolated layer |

At 32 versus 256 events the scheduling probe measured 6.054 total promises/event;
its shared work-budget suspension makes the exact slope depend on event counts.
Conditional installers are deliberately enabled here. Disabled tracker,
acceptance, first-event timeout, and unkeyed/inherited rate-limit wrappers return
their source unchanged. Acceptance awaits receipts only on `response.created`;
idle startup can additionally race its request deadline. These exceptional events
and timer races are not represented by the ordinary-event slope.

Three raw SSE owners are private to `createResponsesStreamWithRecovery`:
`streamWithTerminalDrain` uses `for await` / `yield` (+4), `providerStream` uses
`yield*` (+2), and replay/recovery uses `for await` / `yield` (+4). Those individual
figures are source-shape accounting, **not isolated measurements**. The
`responses-sse` probe exercises all three through the real OpenAI SDK and an
in-process synthetic fetch, including parsing and body reads. It sends no network
request. No new production exports are introduced solely to measure internals.

The already-converted assistant layers retain their previous inventory:
compaction settlement uses `async next()` / await (+2 on ordinary events, with
additional work when settlement is required); adjacent transforms share one stable
continuation (+1 for any number of adjacent synchronous transforms); stop-reason
recovery and uncontended model diagnostics each add one continuation (+1).
Their exceptional recovery/settlement and concurrent-read paths are not equivalent
to ordinary forwarding. The reducer and final agent consumer consume events;
they do not introduce an additional forwarding iterator.

Tool-call promotion's inner generator buffers, suppresses, and replaces events;
its outer generator records emitted text length. The 8-promise cost is measured
only for its ordinary one-to-one path. Keeping its buffering implementation intact
avoids replacing meaningful generator state with a competing manual state machine.
Plugin text replacement currently uses an async next callback, not a generator,
and intentionally creates replacement event/result envelopes.

## Native CLI path

Claude CLI execution bypasses agent-core: JSONL stdout callbacks in
`extensions/anthropic/cli-transport.ts` feed the async message handler and
`PassThrough` turn queue in `cli.runtime.ts`; `executeClaudeCli` yields its records;
`cli-backend.ts` delegates with `yield*`; plugin ownership binds the returned
iterator; `src/agents/cli-runner/execute-plugin-iterator.ts` races reads against
abort; `execute-plugin.ts` consumes records and serializes stdout handling.
The runtime generator owns process cancellation and settlement. Counts for this
path need a CLI-specific workload, rather than the agent-core probe.
