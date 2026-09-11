---
summary: "Hooks, HTTP routes, Gateway methods, services, and the webhook and SQLite helpers"
title: "Plugin SDK infrastructure registration"
sidebarTitle: "Infrastructure registration"
read_when:
  - You are registering a Gateway HTTP route, RPC method, or background service
  - You are reading a webhook body or admitting a SQLite write from a plugin
  - You need per-requester MCP transports for a static server name
---

Registrars for hooks, Gateway HTTP routes and RPC methods, CLI entries, and
background services, plus the SDK helpers those surfaces depend on. Part of the
[Plugin SDK overview](/plugins/sdk-overview).

## Infrastructure

| Method                                            | What it registers                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| `api.registerHook(events, handler, opts?)`        | Event hook                                                             |
| `api.registerHttpRoute(params)`                   | Gateway HTTP endpoint                                                  |
| `api.registerGatewayMethod(name, handler, opts?)` | Gateway RPC method                                                     |
| `api.registerGatewayDiscoveryService(service)`    | Local Gateway discovery advertiser                                     |
| `api.registerCli(registrar, opts?)`               | CLI subcommand                                                         |
| `api.registerNodeCliFeature(registrar, opts?)`    | Node feature CLI under `openclaw nodes`                                |
| `api.registerService(service)`                    | Background service                                                     |
| `api.registerInteractiveHandler(registration)`    | Interactive handler                                                    |
| `api.registerAgentToolResultMiddleware(...)`      | Runtime tool-result middleware                                         |
| `api.registerMemoryPromptSupplement(builder)`     | Additive memory-adjacent prompt section                                |
| `api.registerMemoryPromptPreparation(prepare)`    | Async preparation for a memory-adjacent prompt section                 |
| `api.registerMemoryCorpusSupplement(adapter)`     | Additive memory search/read corpus                                     |
| `api.registerHostedMediaResolver(resolver)`       | Resolver for browser-style hosted media URLs                           |
| `api.registerMcpServerConnectionResolver(...)`    | Per-requester MCP transport (`url`/`headers`) for a static server name |
| `api.registerTextTransforms(transforms)`          | Plugin-owned prompt/message compatibility text rewrites                |
| `api.registerConfigMigration(migrate)`            | Lightweight config migration run before plugin runtime loads           |
| `api.registerMigrationProvider(provider)`         | Importer for `openclaw migrate`                                        |
| `api.registerAutoEnableProbe(probe)`              | Config probe that can auto-enable this plugin                          |
| `api.registerReload(registration)`                | Restart/hot/noop config-prefix policy for reload handling              |
| `api.registerNodeInvokePolicy(policy)`            | Allowlist/approval policy for node-invoked commands                    |
| `api.registerSecurityAuditCollector(collector)`   | Findings collector for `openclaw security audit`                       |

Gateway methods default to `profileAccess: "required"`, so authenticated-profile verification fails closed before plugin dispatch. Set `profileAccess: "independent"` only for an audited method that neither reads nor mutates durable user or session state. Operator scope remains a separate authorization requirement.

### File-watch capacity errors

`getFileWatchCapacityCode(error)` from `openclaw/plugin-sdk/file-access-runtime`
returns `EMFILE`, `ENFILE`, or `ENOSPC` for a native watch failure, or `undefined`
for other errors. It requires `syscall: "watch"` because watcher libraries can
forward directory-scan errors through the same error event. Use the result in
the watcher lifecycle owner to stop native retries and select an existing
refresh path.

### SQLite write admission

`runSqliteImmediateTransaction(db, prepare, options?)` from
`openclaw/plugin-sdk/sqlite-runtime` waits for write admission without blocking
the event loop. Its asynchronous `prepare` function may run more than once when
another writer holds the database. Keep preparation repeatable: read and plan
there, then return a **synchronous** transaction callback. Revalidate current
owner and row predicates inside that callback before writing.

Returning `undefined` from preparation skips the write and resolves the helper
to `undefined`, even while another writer remains active. Otherwise, the helper
resolves to the transaction callback's result. It rejects an already active
transaction or preparation that leaves a transaction open. Once admitted, the
callback runs once; callback and commit failures are never replayed.

Admission retries use the connection's existing `busy_timeout`; this is not a
total deadline for preparation or transaction execution. `options` supplies the
same transaction diagnostics as `runSqliteImmediateTransactionSync`. Keep the
database handle and its owning operation alive until the returned promise settles.
The callback and SQLite calls still run synchronously on the caller's thread.

### SQLite worker stores

Use `openSqliteWorkerStore<Operations>` from
`openclaw/plugin-sdk/sqlite-runtime` to move a feature's SQLite lifecycle off the
application event loop. Call it from the main application thread with
`{ moduleUrl, databasePath, input }`. `Operations` maps each domain operation to
its `{ input, output }` types; `store.execute({ type, input }, { signal }?)`
returns the corresponding output promise. The host currently rejects calls from
other application workers, which need a shared host-broker connection.

This first host supports filesystem-backed databases only. Empty paths, SQLite
URIs, `:memory:`, and OpenClaw's reserved incognito database basename are refused
before normalization or worker admission. In-memory and incognito ownership
remain pending; these locators must never become disk filenames.

The static local `moduleUrl` identifies a trusted feature module exporting
`createSqliteWorkerBackend(input, { databasePath })`. Its factory owns database
opening and schema setup; its synchronous `execute(command)` owns queries and
transactions. `close()` may await cleanup outside transactions; the host retains
the actor until that cleanup settles. Keep native handles, WAL maintenance, and
prepared statements inside that backend. Send serializable domain commands and
results across the boundary, never SQL strings, callbacks, or Kysely builders.
Declare private build entries with
[`openclaw.build.workerEntries`](/plugins/dependency-resolution#native-imports-from-a-standalone-source-build)
and derive their locations from the loader's `api.runtimeSource` fact.

Pass `existingOnly: true` when acquisition must preserve a missing database.
The call returns `undefined` without starting a worker or invoking a factory
when the file is absent and no active actor retains that path. A cold existing
open requires the module's explicit
`openExistingSqliteWorkerBackend(input, { databasePath })` export. The host
never substitutes the ordinary creation factory. The existing factory must
use SQLite's native read-only or existing-file opening mode and validate the
current schema without creating or migrating it. A filesystem existence check
followed by ordinary create-if-missing opening does not satisfy this contract.

The host checks physical identity before dispatching the existing factory and
again before returning the store. Disappearance or replacement after admission
rejects acquisition. Existing-only and ordinary clients share the same physical
actor when their module and initialization input match; changing open intent
does not rerun a factory or create another connection. Domain commands still
own write permission and any later schema initialization. Existing-only
acquisition provides no read-only capability for subsequent commands.

Abort signals remove operations that are still queued. Once dispatched, an
operation retains its result or failure; cancellation does not prove rollback.
`close()` rejects new work and drains that client's accepted operations. The
last client also closes its database backend; the last backend releases its
worker. Worker loss or failure to serialize a completed operation's result can
reject with `code: "outcome-unknown"`. The operation may have committed: inspect
authoritative state before deciding what to do next. The host never
automatically retries a write.

An asynchronous `execute` return violates the command contract. The host retires
and joins that worker before reporting `outcome-unknown`; it does the same when
a completed reply cannot be decoded. Failed cleanup retains its original error
while the worker is drained.

The process-wide host starts lazily and permits at most four workers, 64 opening
or live store clients (including clients sharing a database), 128 outstanding
operations, and 64 MiB of queued input. Each input message is limited to 32 MiB
and each result to 64 MiB; capacity exhaustion rejects with
`code: "overloaded"`. Operations for one database share its connection owner
and execute in order. There are no reader replicas or worker-pool configuration
options.

File identities are admission facts, not native-handle attestations. Close and
drain a database's clients before replacing or relocating its file. The host
refuses observed identity changes and collisions with an existing owner; path
checks cannot protect against an uncoordinated filesystem replacement.
Each client retains its admitted lexical and canonical pathnames through
drainage and close. The backend's opening paths remain pinned for its native
lifetime; released secondary aliases do not accumulate while other clients live.

### Webhook body rejection

Use `readWebhookBodyOrReject` or `readJsonWebhookBodyOrReject` from
`openclaw/plugin-sdk/webhook-request-guards` for bounded body reads. Return when
the result is `{ ok: false }`; the helper owns the error response and connection
cleanup. Body byte limits and read timeouts remain separate from transport cleanup.

For a custom error representation after a response-first body read, await
`sendHttpRequestRejection(req, res, statusCode, body, contentType?)` instead of
calling `res.end()` and destroying the request. It preserves security headers,
frames the complete error, then on Node closes the write side while keeping application
body readers paused. Node's request backpressure bounds residual input buffering;
cleanup allows at most one second, not another body-read timeout. A disconnected peer, malformed HTTP, or an
exhausted cleanup budget can prevent delivery. Committed responses are closed
without appending a replacement error or completing a partial successful body.

On Node, transport-owned rejections emit response `close` without `finish`.
Use `close` for terminal cleanup or selected-error diagnostics; it does not prove
delivery. Keep successful-response activity on `finish`, with the caller's
success-status check, so an aborted request cannot report healthy activity.

Bun uses its native HTTP response completion because its raw socket operations
do not flush the HTTP response. Bun can still report client connection resets
during large outstanding uploads, even after delivering the complete error.

Gateway HTTP requests run in order on each connection, including their response
lifetimes. A closing connection cannot admit later requests or upgrades. Queued
requests apply input backpressure until earlier responses finish; finite pipelines
drain in order. Use separate connections for concurrent requests. Keep the release hook returned by
`beginWebhookRequestPipelineOrReject` in `finally`; it retains any selected
rejection cleanup before releasing the in-flight slot.

### Post-ack webhook work

Webhook routes that acknowledge a request before processing finishes must move
that detached work onto its own tracked admission root:

```typescript
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";

// processWebhookEvent, event, and runtime are your plugin's own handler, payload, and logger.
void runDetachedWebhookWork(() => processWebhookEvent(event)).catch((error) => {
  runtime.error?.(`webhook dispatch failed: ${String(error)}`);
});
```

Call `runDetachedWebhookWork(...)` synchronously while the HTTP request is still
admitted. The helper reserves an independent root immediately, then starts the
callback in the next microtask so the request handler can write its
acknowledgement first. The returned promise adopts the callback result; callers
still own rejection handling. This keeps post-ack queue work accepted and makes
restart or suspension drains wait for it. Handlers that await all processing
before returning do not need this helper.

### Requester-scoped MCP connections

Keep the MCP server **identity** static (name, tool filter) in `mcp.servers`, a
native plugin's `mcpServers` manifest field, or a bundle manifest. Optionally register a connection resolver so each trusted
message requester gets their own transport:

```ts
api.registerMcpServerConnectionResolver({
  serverName: "user-email",
  resolve: async (ctx) => {
    // ctx.requesterSenderId is host-trusted; never invent sender identity here.
    // lookupUserToken is your plugin's own credential-store lookup, not an SDK export.
    const token = await lookupUserToken(ctx.requesterSenderId);
    if (!token) {
      return null; // omit this server for the current run
    }
    return {
      url: "https://mcp.example.com/email",
      headers: { Authorization: `Bearer ${token}` },
    };
  },
});
```

Contract notes:

- Resolver context carries trusted host identity only (`requesterSenderId`,
  optional `agentAccountId` / `messageChannel`). Future trusted fields (for
  example cron/subagent user context) can be added additively.
- One plugin owns one server name: a duplicate
  `registerMcpServerConnectionResolver` for the same `serverName` from another
  plugin is rejected with an error diagnostic (first registration wins), so
  connection ownership never depends on plugin load order.
- Tool names are derived from the full declared server set so partial resolution
  never changes safe server names between requesters or turns. Core does not
  verify that different requester endpoints serve identical tool schemas; a
  resolver must point every requester at the same logical service, or tool
  schemas (and prompt-cache stability) diverge per requester.
- Runs without a trusted `requesterSenderId` (cron, subagent, heartbeat, public
  gateway) never materialize requester-scoped servers. There is no shared
  fallback connection.
- `resolve` is bounded at 10 seconds per server; a timeout or throw omits that
  server for the run without failing static MCP.
- Resolved connections are revalidated at most every 5 minutes per requester:
  rotation rebuilds the transport with fresh credentials, and a `null` result
  revokes it (the cached runtime is disposed even mid-session). A revoked or
  rotated credential can therefore stay in use for up to 5 minutes.
- Resolved `headers` are never logged or persisted; core keeps only an ephemeral
  in-memory keyed digest (process-local HMAC) to detect credential rotation, and
  registers resolved header/URL credential values with the log/debug-capture
  redaction registry.
- Requester-scoped servers do not mint MCP App views: a view outlives the
  requester-authenticated run and the gateway view boundary has no requester
  identity, so app previews stay fail-closed for these servers. Tool results
  are unaffected.
- Static servers without a resolver keep the existing session-scoped lifecycle.
- **Harness delivery rule:** requester-scoped servers never enter harness-native
  MCP client config (Codex thread `mcp_servers`, CLI `-c mcp_servers=…`, or any
  other session-shared MCP projection). Harnesses deliver them as run-scoped
  tools instead:
  - Embedded runner: session MCP runtime + bundle tools (static + scoped).
  - Codex app-server: dynamic tools via
    `materializeRequesterScopedMcpToolsForHarnessRun` (scoped-only; static
    servers stay on Codex's native MCP client).
- Scoped tool **specs** are session-stable after the first successful resolve in
  that session, so shared-thread harnesses (Codex) do not rotate threads when
  senders change. Before any requester resolves, no scoped specs are advertised.
- Unauthenticated requesters on a shared-thread harness still see the advertised
  scoped tools; calling one returns a clean not-connected tool error for that
  requester. OpenClaw never falls back to another requester's credentials.

Memory prompt supplement builders receive optional `agentId`,
`agentSessionKey`, and `sandboxed` context. Memory corpus supplement `search`
and `get` calls receive optional `agentId` and `sandboxed` context. Plugins with
agent-owned storage should resolve that storage for each call instead of
capturing one global path during registration. If an agent id is required but
missing in a multi-agent operation, fail closed rather than choosing an
arbitrary agent.

Use `registerMemoryPromptPreparation(...)` when prompt text depends on async
plugin state. The callback runs once before each full agent prompt and receives
the same tool, agent, session, and sandbox context as synchronous memory prompt
builders. Validate the current storage-owner instance before loading persisted
state, then return only lines for that run. OpenClaw freezes those lines and
hands the immutable result to synchronous prompt assembly. Keep persistence,
atomic replacement, and owner-removal deletion inside the owning plugin; do not
poll or read files from a prompt builder.

Telegram interactive handlers can return `{ submitText }` to route text through
Telegram's normal inbound agent path after the handler succeeds. OpenClaw keeps
the callback button when inbound policy skips the text or processing fails, so
the user can retry after the blocking condition changes. This result field is
Telegram-specific; other channels keep their own interactive result contracts.
