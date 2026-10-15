# Agent Runtime And Tests

Own agent assembly, run authority, focused tests. Slow, import-bound tests = architecture signals.

## Guardrails

- Performance edits: benchmark before/after; reuse grouped artifacts or `/usr/bin/time -l pnpm test <file>`. Report seconds + RSS.
- Schema, capability, routing, static-discovery tests: lightweight typed artifacts, not cold-loaded plugin/channel/provider runtimes. Keep runtime fallbacks; isolate expensive bootstrap/runners behind injection/narrow helpers.
- Hot paths: pure helpers/lightweight public artifacts for target parsing, peer-kind inference, setup hints, descriptors before `getChannelPlugin()`/bundled runtime. Spawn/session/requester-origin normalization: deterministic, runtime-free; test channel-prefix parsing.
- Prepared model/tool selection: follow plugin owner's [availability and selection contract](../plugins/AGENTS.md#availability-and-selection). Discovery outside repeated selection; user-requested model/tool execution remains allowed.
- Moving slow integration coverage: preserve + test exact production composition in named helper.
- Avoid broad `importOriginal()` partial mocks/module resets. Explicit factories, one-time imports; reset only mutated state.

## Client Capability Scope

- Attached-client tools: current connection/session capabilities, never backend host flags; clients differ.
- Capability caches: connection/session lifecycles; share only process-stable provider metadata. Never select tools from another client's cached answer.
- Availability ≠ authorization: preserve server validation, tool grants, live authority. Backend portable-artifact tools need no client merely for UI display.
- Prove differing clients on one backend, supported remote client without local UI flag, retirement of cached capabilities.

## Run Authority

- Prepare one admitted context after runtime selection; retries/fallbacks reuse it, never mint authority.
- Lifecycle owner's `finally`: close admission on terminal, error, cancellation, unsupported recovery paths.
- Harness host capabilities capture exact admitted authority. Gate tool binding/preparation/execution, hooks, approvals; revalidate after awaits before results cross action boundary.
- Retained tools, preparers, callbacks, approval handles: fail after close, replacement, release, abort, claim loss, lifecycle rotation.

## Source Reply Completion

- Only canonical host-owned current-source completion fact suppresses required-reply finalization after settled, complete, non-dry-run delivery. Terminal reaction: explicit `final: true` + nonempty addition to current channel/account/conversation/message. Acknowledgments, progress/removal/empty reactions, wrong targets, failures, partial delivery, no-ops, dry runs never qualify. No channel/fallback-finalizer exceptions.
- Current-source `final: false` text send becomes completion only at settlement when last tool batch + terminal response empty or `NO_REPLY`. Work after/beside it, including asynchronous-send follow-up, keeps finalization.

## Verification

- Root proof policy: narrow trusted local proof, broad PR CI. Lazy-loading, plugin-runtime import, or bundled-artifact changes: `pnpm build` required.
