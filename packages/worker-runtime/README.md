# Worker runtime

`@openclaw/worker-runtime` is OpenClaw's private worker execution package. One
scheduler serves ordinary computation and retained tasks: admission, input
preparation, dispatch, host exchanges, completion, and retirement share the same
implementation. Resource owners retain their authority and cleanup contracts
through an explicit host adapter.

Plugins continue to use `WorkerTaskPool` from
`openclaw/plugin-sdk/process-runtime` and `serveWorkerTasks` from
`openclaw/plugin-sdk/worker-task-server`. Extracting the implementation into this
workspace package does not change those public SDK entrypoints or add a plugin
dependency on this private package.

## Why an internal package

[Piscina](https://github.com/piscinajs/piscina) and
[Tinypool](https://github.com/tinylibs/tinypool) provide useful worker-pool
mechanisms: bounded admission, ready handshakes, direct task channels, explicit
transfers, and task-scoped async context. OpenClaw applies those ideas within its
existing ownership model.

OpenClaw also has tasks whose result becomes available before their owner can
release the worker, input, or database resources. Those owners need execution
and cleanup receipts that remain observable even when the caller cannot run
Promise reactions. Cancellation must respect protected native operations, and
independent compute pools must share the host's CPU budget. Replacing
the scheduler with a general-purpose pool would still require this coordination
around it.

The private package keeps one scheduler for these contracts. The host adapter
supplies application-specific authority and resources; the scheduler owns their
admission and settlement order. Consider a replacement only if it can absorb
that lifecycle without leaving a second scheduler or resource owner beside it.

## Choose a contributor entrypoint

For a new plugin worker, start with the public
[worker task admission guide](https://docs.openclaw.ai/plugins/sdk-overview/infrastructure#worker-task-admission)
and [cleanup contracts](https://docs.openclaw.ai/plugins/sdk-runtime/config-and-utilities).
Use this README when changing the scheduler, task protocol, or host adapter. The
[agent runtime architecture](https://docs.openclaw.ai/agent-runtime-architecture#compute-workers)
describes how application callers share capacity and retain mutation authority.

## Run the contributor example

From a source checkout with its dependencies installed, run the synthetic
round-trip example through the real pool, host adapter, and worker task server:

```bash
node --import ./scripts/tsx.mjs scripts/bench-worker-runtime.ts \
  --transport both --scenario roundtrip --workers 1 \
  --tasks 100 --warmup 16 --runs 2
```

The [benchmark runner](../../scripts/bench-worker-runtime.ts) exercises the shared
scheduler with both the ordinary worker host and the internal retained-task host. It
checks task outputs and joins pool closure before finishing. Start there when
changing the protocol; plugin implementations should keep the public SDK imports
described above.

Use `--scenario all --workers 2 --concurrency 8` to include saturated admission
and host exchanges. `--payload-bytes` controls the synthetic payload and
`--exchanges` controls host round trips. `--json` emits machine-readable evidence;
`--output <path>` saves a report. Run `--help` for limits and defaults. Each
scenario separates a cold first wave from warm-up and steady-state measurements.
Use `--diagnostics off` to measure without the stage subscriber, and
`--transfer move` to compare owned-buffer transfer with the default cloning.

For a retained-port polling experiment, use `--transport retained` with
`--service-passes 10000`. This measures repeated native servicing while real
workers wait for host responses; it does not represent normal Gateway service
frequency. Compare against the same workload with the same arguments before
adopting a polling optimization.

## Imports

| Entrypoint                           | Purpose                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `@openclaw/worker-runtime`           | Host scheduler, admission capacity, pool types, errors, and owned-task joins. |
| `@openclaw/worker-runtime/worker`    | Worker task protocol and native-section control.                              |
| `@openclaw/worker-runtime/lifecycle` | Retained operations and worker lifecycle contracts.                           |

Worker entrypoints use `/worker`; code that only needs retained operations or
lifecycle types uses `/lifecycle`. Keep those entrypoints independent of the host
scheduler and OpenClaw's application state. Package source depends on its host
contracts rather than importing `src/infra` or database owners.

## Host adapter

`WorkerTaskHost` supplies process-specific capabilities before a pool admits
work. The OpenClaw adapter in `src/infra/worker-task-host.ts` owns native worker
creation, runtime entrypoint options, temporary-directory cleanup, database fence
capture, worker accounting, the live-pool registry, and shared compute capacity.
The package controls when those operations run and holds admission until their
required settlement receipts arrive.

Each synchronous pool or rotation pass captures its native workers and asks the
host to service them. OpenClaw's host binds a pool to one native source, so one
service call advances that shared source. Nested calls capture a fresh pass;
individual stop and resource operations retain their own servicing. Reference
changes still check current transport availability and refresh native liveness,
while repeated `ref()` or `unref()` calls avoid redundant control messages.

Worker creation returns a `WorkerLifecycle` and, when needed, its
`RetainedNativeWorker`. The native owner keeps runtime-generation and resource
custody. Worker-side `WorkerTaskServerHost` installs the captured context and
provides memory sampling, logging initialization, and idle hooks without importing
those application concerns into the protocol implementation.

Retained task hosts provide a dedicated message port through a private startup
message, leaving `workerData` unchanged. Task
inputs, results, host exchanges, and resource-close requests use that channel;
the supervisor continues to own startup, native exit, and resource settlement.
The native handle buffers task messages until startup is recorded and drains
admitted messages before terminal lifecycle events. A failed startup discards
unadmitted data. Losing the task channel is a transport
failure, never an execution or cleanup receipt. Ordinary SDK workers keep their
parent-port transport.

Private served transports declare `requiresReady` on the host and acknowledge
readiness only after the task server installs its message listener. A native
failure before that acknowledgment stops further worker construction for the
pool generation. Healthy ready siblings keep serving queued work; if none
remain, queued and subsequent submissions fail without repeated startup
attempts. A successful `rotate()` joins the old generation and clears this
failure, as does creating a new pool. Input preparation and serialization errors
and ordinary failures from ready workers do not latch startup failure. Arbitrary
SDK Workers have no readiness requirement and retain their existing recovery
behavior.

## Results and settlement

A task result, an execution receipt, and resource release are distinct facts.
An owned task can return a result while its owner still retains the worker slot
and input charge. `close()` or retained `release()` joins the required cleanup;
`read()` and `service()` let native owners observe and advance settlement when
Promise reactions cannot run.

Cancellation closes native-section admission before terminating execution. A
protected native operation finishes before its worker is stopped. Native exit
releases execution capacity; terminal pool close also joins temporary-file
cleanup. Failed retirement retains custody for a later retry. Neither a rejected
result nor a cancellation request alone proves that execution or resources have
settled.

When queued work competes with a task waiting for a host response, `yieldSignal`
requests a cooperative checkpoint. The host operation retains its own lifetime;
queue pressure does not grant permission to cancel its underlying work. A
checkpoint releases the task's execution slot through the ordinary settlement
path, and continuation work rejoins admission.

The caller's execution deadline also bounds host exchanges. Responses may
shorten that deadline, never renew it. Code Mode explicitly uses
`hostTimeout: "owner"` because its host budget already accounts for approval
pauses; its response rearms the pool clock with the remaining execution budget.
Timeout aborts the host signal without claiming that accepted host effects have
settled. Those effects remain under their existing owner's cleanup contract.

### Async context lifetime

Each task captures its caller with an `OpenClaw.WorkerTask` `AsyncResource`.
Preparation, host exchanges, cancellation observers, and settlement callbacks
run in that task's scope. Worker creation, idle timers, and retirement use the
pool scope so a warm worker does not retain its first caller.

`captureWorkerTaskContext()` must keep the `AsyncResource` in an independent
closure. Other task callbacks must not capture that resource through a shared
closure: an owned task handle can remain readable after release. Release replaces
its context runner with the pool runner so the caller can be collected while the
handle survives. Keep automatic `AsyncResource` destruction enabled; result
fulfillment is too early to destroy a context that retained cleanup or a late
host-response callback can still need. Garbage collection supplies the destroy
notification when that context is no longer reachable; it is not an execution or
resource-release receipt.

## Diagnostics and benchmarks

The `openclaw.worker.task` diagnostics channel reports queue, preparation, run,
and transfer durations. `hostWaitMs` adds time spent waiting for host responses;
it is a component of the existing `runMs`, not an additional duration to add to
it. `runMs` is elapsed wall time, including startup and completion work, rather
than worker CPU time. This is internal diagnostics data, not a public
configuration option.

The benchmark's diagnostic subscriber in
`scripts/lib/gateway-bench-diagnostics.ts` retains count, total, and maximum for
validated numeric metrics. Duration metrics also expose approximate `p50`,
`p95`, and `p99` values in milliseconds using bounded histograms. The collector
allocates at most 256 histograms, with microsecond quantization and two
significant digits. Values above one hour are clamped only in the histogram;
raw totals and maxima remain intact. Check `histogramCount`, `clampedCount`, and
`droppedHistogramSamples` before interpreting percentiles. Count and byte metrics
keep simple aggregates. Histogram allocation and recording belong to the
subscriber, so an unsubscribed pool pays none of that collection cost.

Compare equivalent worker counts, admission limits, inputs, and warm-up state
when benchmarking. Report cold and warm completion time, queue latency,
preparation, host wait, transfer cost, and memory separately. Cancellation proof
must also observe the execution receipt and resource cleanup so a faster rejected
Promise is not mistaken for faster settlement.

### Applying upstream patterns

Borrow a mechanism where it improves a measured workload while preserving the
settlement contracts above. Record the runtime version, source revision,
benchmark arguments, and comparison results in the change's evidence. Synthetic
round-trip improvements describe pool overhead, not whole-Gateway throughput.

The retained transport already separates task traffic from native lifecycle
receipts, and readiness acknowledgments prevent repeated failed bootstrap
attempts. Explicit transfer hooks already exist for inputs, results, and host
responses. Transfer only buffers the sender owns: copying an input can be
necessary when its caller will reuse it.

Blocking worker-side `Atomics.wait()` is not the default here. Idle workers must
still run scheduled garbage collection, answer memory requests on another port,
and close retained resources. An optimization that assumes only a new task can
arrive while idle would suppress that work. Response counters that merely avoid
empty host-side port polls have a different tradeoff. The initial Node 26 probe
found empty polling was a small part of full native servicing, which still needs
transport-loss checks. Keep event-driven delivery and unconditional terminal
draining unless a full-path comparison demonstrates a useful saving. A worker
can stop after posting its final reply but before publishing a counter increment;
the hint must never hide that reply or stand in for an execution receipt.

Use the producer's existing admission owner for backpressure. Image processing
defers its input copy until pool admission, model-catalog requests propagate
overload without a retry loop, and the SQLite writer broker already owns bounded
capacity waiters. A generic `drain` notification would add no useful producer
control to those paths. Add one only for a caller that can pause before buffering
or allocating its next input, and observe actual admission release, including
retained ownership, rather than task-result completion.

Memory-driven recycling needs evidence of growth after garbage collection and
must weigh recovered heap and external memory against worker startup cost.
