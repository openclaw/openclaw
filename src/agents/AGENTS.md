# Agent Runtime And Tests

Own agent assembly, run authority, and focused tests. Slow, import-bound tests
are architecture signals.

## Guardrails

- Benchmark performance edits before/after; reuse grouped artifacts or `/usr/bin/time -l pnpm test <file>`. Report seconds and RSS.
- Schema, capability, routing, and static-discovery tests use lightweight typed artifacts, not cold-loaded plugin/channel/provider runtimes. Keep runtime fallbacks; isolate expensive bootstrap/runners behind injection or narrow helpers.
- Hot paths use pure helpers/lightweight public artifacts for target parsing, peer-kind inference, setup hints, and descriptors before `getChannelPlugin()`/bundled runtime. Spawn/session/requester-origin normalization stays deterministic and runtime-free; test channel-prefix parsing.
- Prepared model/tool selection follows the plugin owner's [availability and selection contract](../plugins/AGENTS.md#availability-and-selection). Keep discovery outside repeated selection; user-requested model/tool execution remains allowed.
- Moving slow integration coverage must preserve and test exact production composition in a named helper.
- Avoid broad `importOriginal()` partial mocks/module resets. Use explicit factories, one-time imports, and reset only mutated state.

## Client Capability Scope

- Attached-client tools use current connection/session capabilities, never backend host flags; clients differ.
- Scope capability caches to connection/session lifecycles; only process-stable provider metadata is shared. Another client's cached answer must not select tools.
- Availability is not authorization: preserve server validation, tool grants, and live authority. Backend portable-artifact tools need no client merely for UI display.
- Prove differing clients on one backend, a supported remote client without a local UI flag, and retirement of cached capabilities.

## Run Authority

- Prepare one admitted context after runtime selection; retries/fallbacks reuse it, never mint authority.
- Close admission in the lifecycle owner's `finally` on terminal, error, cancellation, and unsupported recovery paths.
- Harness host capabilities capture exact admitted authority. Gate tool binding/preparation/execution, hooks, and approvals; revalidate after awaits before results cross the action boundary.
- Retained tools, preparers, callbacks, and approval handles fail after close, replacement, release, abort, claim loss, or lifecycle rotation.

## Source Reply Completion

- Only the canonical host-owned current-source completion fact suppresses required-reply finalization after settled, complete, non-dry-run delivery. A terminal reaction needs explicit `final: true` and a nonempty addition to the current channel/account/conversation/message. Acknowledgments, progress/removal/empty reactions, wrong targets, failures, partial delivery, no-ops, and dry runs never qualify. No channel/fallback-finalizer exceptions.
- A current-source `final: false` text send becomes completion only at settlement when it was the last tool batch and terminal response is empty or `NO_REPLY`. Work after or beside it, including asynchronous-send follow-up, keeps finalization.

## Verification

- Root proof policy applies: narrow trusted local proof, broad PR CI. Lazy-loading, plugin-runtime import, or bundled-artifact changes require `pnpm build`.
