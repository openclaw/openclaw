# Retained Error stack proof

The script header documents the command and owner selectors. Run each arm in a
fresh Node process with `--expose-gc`; use `--mode heap --assert-collected` for the
retention regression and separate `timing` / `allocation` passes for cost. The
baseline directory holds the selected owner and `src/infra/error-graph-internal.ts`
at the baseline revision, plus `extensions/codex/src/app-server/spawn-error.ts`
for `catalog-backoff`. The script verifies that the baseline owner was loaded.

The three cache fixtures retain the real owner after failure, while releasing a
caller containing 10,000 synthetic sessions, 40 plugins, and an 8 MiB buffer.
SQLite also wraps the failure in `AggregateError.errors`, without a `cause` link.
Passing means every caller fixture is collectible while error identity, messages,
codes, nested identities, and retry/stop behavior remain intact. This does not
measure Gateway throughput or establish production failure frequency.

## Cost and retention

Five counterbalanced pairs of 3,000 operations per arm, baseline
`b4b328b903ecec99179255bbe6f6c95fac885f45`. Fixture creation is outside timing and
allocation. Allocation uses a separate inspector-sampling pass. CPU values are
medians of untraced arms; allocation values are medians of sampled bytes per op.

| Owner                      | CPU µs/op, base → candidate | Sampled bytes/op, base → candidate | Retained caller fixtures, base → candidate |
| -------------------------- | --------------------------: | ---------------------------------: | -----------------------------------------: |
| SQLite terminal-open latch |                5.79 → 22.05 |                     6,586 → 14,986 |                                      3 → 0 |
| Codex catalog backoff      |                4.20 → 14.75 |                     6,164 → 11,700 |                                      3 → 0 |
| Matrix SDK stop gate       |                4.01 → 15.91 |                      2,932 → 8,665 |                                      3 → 0 |

Each three-record retention run releases 24 MiB of buffer storage and roughly
5 MiB of session objects. Eager formatting adds about 11–16 µs per failure
recording in these fixtures. This is a retained-memory fix with a failure-path
CPU/allocation cost, not a throughput improvement. Ordinary successful data processing stays unchanged; terminal shutdown and
cancellation also format their retained reasons. The measurements are synthetic owner proof, not a live Gateway
load test.

## Census

The sweep classifies storage lifetime, not every `throw` expression. Formatting
belongs where an owner retains a failure; forwarding an already formatted error
does not require another policy or cache. The shared helper traverses nested
causes and aggregates, preserves the original objects, and tolerates immutable
or opaque diagnostic properties.

| Site                                                                                                                  | Retention lifetime                                                       | Disposition                                                              |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `src/infra/sqlite-terminal-open-latch.ts`                                                                             | Process path latch until repair/clear; used by state and agent DB caches | Materialize at record                                                    |
| `src/infra/node-duplex-framing.ts`                                                                                    | Closed endpoint's rejected drain promise                                 | Materialize close reason                                                 |
| `src/infra/worker-native-lifecycle.ts`                                                                                | Native source failure and cached close rejection                         | Materialize at failure/close/exit and rejected close producer            |
| `src/infra/worker-native-handle.ts`, `worker-native-task-port.ts`                                                     | Retained stop result and task-port failure                               | Materialize at their rejection/failure owners                            |
| `src/infra/postgres-sync/bridge.worker.ts`                                                                            | Connection failure until reconnect/close                                 | Materialize both assignment paths                                        |
| `src/state/openclaw-agent-execution-owner.ts`, `openclaw-agent-execution.worker.ts`, `openclaw-agent-worker-store.ts` | Executor cleanup retry, failed backend, terminal store                   | Materialize retained failure fields                                      |
| `src/state/openclaw-agent-db-maintenance-lease.ts`, `openclaw-state-lease.ts`                                         | Retained maintenance observation and lost-lease signal                   | Materialize without changing authority checks                            |
| `src/agents/sessions/auth-storage.ts`                                                                                 | AuthStorage instance diagnostic list/load failure                        | Materialize at common recording owner                                    |
| `src/agents/auth-profiles/legacy-source-diagnostic.ts`, `oauth-refresh-failure.ts`                                    | Migration cache and settlement-provenance association                    | Materialize retained errors and initiating cause                         |
| `src/agents/worktrees/run-lease.ts`, `run-end-lifecycle.ts`, `gc-artifacts.ts`                                        | Failed cleanup/uncertain run-end/orphan retry                            | Materialize failure producer; downstream cleanup map reuses it           |
| `src/agents/harness/native-session/binding-leases.ts`                                                                 | Unresolved binding failures until cleanup resolution                     | Materialize failed lease/block/renewal records                           |
| `src/agents/prepared-model-catalog-worker.ts`                                                                         | Retired catalog handle and probe signals                                 | Materialize stop error                                                   |
| `src/agents/mcp-stdio-client.ts`, `mcp-stdio-transport.ts`, `mcp-http-transport.ts`                                   | Failed/replaced client/transport and memoized shutdown                   | Materialize existing failure/rejection producers                         |
| `src/gateway/server-sidecar-owners.ts`                                                                                | Failed sidecar shutdown until retry                                      | Materialize retained failure                                             |
| `src/process/spawn-broker/resource-client.ts`, `resource-host.ts`, `resource-socket.ts`                               | Failed resource custody handles                                          | Materialize common failure owners                                        |
| `src/process/supervisor/service-child-relay-retirement.ts`                                                            | Retirement signal failures and aggregate diagnostics                     | Materialize recorded aggregate graph                                     |
| `src/shared/async-work-scope.ts`, `bounded-serial-queue.ts`                                                           | Caller failure Set, scope abort reason, first queue failure              | Materialize retained failure, preserving settlement/abort order          |
| `src/plugin-sdk/realtime-voice-provider.ts`, `provider-binary-stream.ts`                                              | Terminal voice/stream failure and memoized completion                    | Materialize existing failure producers                                   |
| `src/talk/client-voice-transcript-readiness.ts`, `realtime-session-lifecycle.ts`, `voice-selection-control.ts`        | Failed readiness and retained terminal connection signals                | Materialize owner failure/reason                                         |
| `src/worker/worker-rpc-transcript-client.ts`                                                                          | Terminal transcript client failure                                       | Materialize both nonretryable failure stores                             |
| `src/secrets/egress-proxy/proxy-worker.ts`                                                                            | Failed proxy worker handle                                               | Materialize synthesized terminal error                                   |
| `src/wizard/session.ts`, `tui/gateway-chat.ts`, `system-agent/tui-backend.ts`                                         | Closed input, pending connect failure, failed inference backend          | Materialize recorded errors                                              |
| `extensions/github/src/github-api.ts`                                                                                 | Fetch-keyed cooldown cache, up to 200 entries                            | Materialize insertion                                                    |
| `extensions/codex/src/session-catalog-source-backoff.ts`, `session-catalog-availability.ts`                           | Backoff cache/catalog generation                                         | Materialize stored errors                                                |
| `extensions/codex/src/app-server/spawn-error.ts`, `client.ts`, `turn-router.ts`                                       | Process command-failure cache and terminal client/router                 | Materialize retained failure and cause                                   |
| `extensions/cua-computer/src/driver-client.ts`                                                                        | Failed lazy driver until availability reset                              | Materialize load rejection                                               |
| `extensions/matrix/src/matrix/sdk/crypto-store-lifecycle.ts`, `indexeddb-session.ts`                                  | Failed initialization/stop/session lifetime                              | Materialize failure records and retirement rejection                     |
| `extensions/matrix/src/matrix/client/shared.ts`                                                                       | Failed shared generation and monitor-retirement promises                 | Materialize poison fields and retirement producer                        |
| `extensions/matrix/src/matrix/client/file-sync-store.ts`, `sdk.ts`                                                    | Unavailable sync store and latest sync error                             | Materialize installation                                                 |
| `extensions/memory-core/src/memory/file-watcher.ts`, `local-file-watcher.ts`, `manager-watch-ops.ts`                  | Failed watcher shutdown and exhausted shared transport                   | Materialize retained leaf/aggregate errors                               |
| `extensions/google/realtime-voice-provider.ts`, `extensions/x/src/spend.ts`                                           | Failed voice bridge and per-account accounting owner                     | Materialize terminal failure                                             |
| Supervisor cleanup, cron authority, subagent cleanup/delivery, plugin file caches                                     | Retained errors/signals                                                  | Keep: already materialized; aggregate traversal now also covers siblings |
| Knowledge evidence inspector                                                                                          | Cached failed verdict                                                    | Keep: already formats its stack                                          |
| Channel/account status, cron status, model registry diagnostics                                                       | Long-lived status                                                        | Keep: string/plain-record values, no captured frames                     |
| Error-keyed path/code/provenance WeakMaps with scalar values                                                          | Externally rooted Error lifetime                                         | Keep: weak keys do not root Errors                                       |
| Serialized worker failure payloads                                                                                    | Worker response or retained scalar payload                               | Keep: wire data contains stack strings, not captured frames              |
| Retry-local lastError, synchronous rollback/cleanup failure arrays                                                    | One active operation                                                     | Keep: no independent long-lived failure owner established                |
| Browser target reads, rejected relay bindings, provider binary metadata, capture finalization                         | In-flight work                                                           | Keep: rejection evicts or finally clears the stored promise              |
| `extensions/copilot/src/sdk-loader.ts`                                                                                | Persistent post-import fingerprint failure                               | Fixed inside existing async producer                                     |
| `extensions/browser/src/browser/pw-session-connection.ts`                                                             | Cached failed close promise                                              | Fixed at existing close producer                                         |
| `extensions/policy/src/doctor/evaluation.ts`                                                                          | Fresh per-invocation Doctor context                                      | Keep: no process failure cache                                           |

### Remaining follow-ups

These are not claimed fixed or proven harmless. Generic cached rejected promises
need producer-level treatment: attaching a new rejection observer can suppress
`unhandledRejection`, while wrapping can change Promise identity/timing.

| Site                                                                                                 | Lifetime / reason retained for follow-up                                                                             |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/shared/lazy-promise.ts` and cached-import consumers                                             | Generic promise identity/observation contract; fix rejecting producer rather than silently changing helper semantics |
| `src/plugins/plugin-lifecycle-lease.ts`, `plugin-instance.ts`                                        | Separate lifecycle work; retained refusal/cleanup errors remain                                                      |
| `src/gateway/server-methods/chat-metadata-runtime.ts`, `src/agents/sessions/session-manager-core.ts` | Separate owner work; retained metadata/transcript invalidation errors remain                                         |
| `src/state/agent-database-startup.ts`, `src/auto-reply/reply/queue/lifecycle.ts`                     | Separate startup/admission work; retained stop/custody failure remains                                               |
| `src/plugins/contracts/registry.ts` providerContractLoadError                                        | Contract-test loader cache, outside ordinary runtime                                                                 |
| Other service/call abort forwarding                                                                  | Requires concrete long-lived owner evidence before blanket instrumentation                                           |
