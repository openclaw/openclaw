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

## Diagnostics and benchmarks

The `openclaw.worker.task` diagnostics channel reports queue, preparation, run,
and transfer durations. `hostWaitMs` adds time spent waiting for host responses;
it is a component of the existing `runMs`, not an additional duration to add to
it. This is internal diagnostics data, not a public configuration option.

Compare equivalent worker counts, admission limits, inputs, and warm-up state
when benchmarking. Report cold and warm completion time, queue latency,
preparation, host wait, transfer cost, and memory separately. Cancellation proof
must also observe the execution receipt and resource cleanup so a faster rejected
Promise is not mistaken for faster settlement.
