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

## Native CLI path

Claude CLI execution bypasses agent-core: JSONL stdout callbacks in
`extensions/anthropic/cli-transport.ts` feed the async message handler and
`PassThrough` turn queue in `cli.runtime.ts`; `executeClaudeCli` yields its records;
`cli-backend.ts` delegates with `yield*`; plugin ownership binds the returned
iterator; `src/agents/cli-runner/execute-plugin-iterator.ts` races reads against
abort; `execute-plugin.ts` consumes records and serializes stdout handling.
The runtime generator owns process cancellation and settlement. Counts for this
path need a CLI-specific workload, rather than the agent-core probe.
