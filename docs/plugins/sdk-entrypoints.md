---
summary: "Reference for defineToolPlugin, definePluginEntry, defineChannelPluginEntry, and defineSetupPluginEntry"
title: "Plugin entry points"
sidebarTitle: "Entry Points"
read_when:
  - You need the exact type signature of defineToolPlugin, definePluginEntry, or defineChannelPluginEntry
  - You want to understand registration mode (full vs setup vs CLI metadata)
  - You are looking up entry point options
---

Every plugin exports a default entry object. The SDK provides a helper for
each entry shape: `defineToolPlugin`, `definePluginEntry`,
`defineChannelPluginEntry`, `defineSetupPluginEntry`.

All plugin APIs are [experimental](/plugins/sdk-overview#api-stability),
including these entry helpers. Pin and test the OpenClaw host versions your
plugin supports.

<Tip>
  **Looking for a walkthrough?** See [Tool Plugins](/plugins/tool-plugins),
  [Channel Plugins](/plugins/sdk-channel-plugins), or
  [Provider Plugins](/plugins/sdk-provider-plugins) for step-by-step guides.
</Tip>

## Where each section moved

Every section of the single-page version now lives on this page or on one of
the eight child pages below. The anchors from the single-page version still
resolve here.

- <a id="tool-policy-vocabulary" />[Tool policy vocabulary](/plugins/sdk-entrypoints/tool-policy-and-sandbox#tool-policy-vocabulary)
- <a id="sandbox-bind-parsing" />[Sandbox bind parsing](/plugins/sdk-entrypoints/tool-policy-and-sandbox#sandbox-bind-parsing)
- <a id="package-entries" />[Package entries](/plugins/sdk-entrypoints/package-entries#package-entries)
- <a id="definetoolplugin" />[defineToolPlugin](/plugins/sdk-entrypoints/define-tool-plugin#definetoolplugin)
- <a id="definepluginentry" />[definePluginEntry](/plugins/sdk-entrypoints/define-plugin-entry#definepluginentry)
- <a id="native-provider-factories" />[Native provider factories](/plugins/sdk-entrypoints/native-providers#native-provider-factories)
- <a id="computer-use-providers" />[Computer Use providers](/plugins/sdk-entrypoints/native-providers#computer-use-providers)
- <a id="definechannelpluginentry" />[defineChannelPluginEntry](/plugins/sdk-entrypoints/define-channel-plugin-entry#definechannelpluginentry)
- <a id="definesetuppluginentry" />[defineSetupPluginEntry](/plugins/sdk-entrypoints/define-setup-plugin-entry#definesetuppluginentry)
- <a id="registration-mode" />[Registration mode](/plugins/sdk-entrypoints/registration-mode#registration-mode)

## Plugin shapes

OpenClaw classifies loaded plugins by their registration behavior:

| Shape                 | Description                                        |
| --------------------- | -------------------------------------------------- |
| **plain-capability**  | One capability type (e.g. provider-only)           |
| **hybrid-capability** | Multiple capability types (e.g. provider + speech) |
| **hook-only**         | Only hooks, no capabilities                        |
| **non-capability**    | Tools/commands/services but no capabilities        |

Use `openclaw plugins inspect <id>` to see a plugin's shape.

## Related

- [Plugin SDK overview](/plugins/sdk-overview) - registration API and subpath reference
- [Plugin runtime helpers](/plugins/sdk-runtime) - `api.runtime` and `createPluginRuntimeStore`
- [Plugin setup and config](/plugins/sdk-setup) - manifest and setup entry loading
- [Building channel plugins](/plugins/sdk-channel-plugins) - building the `ChannelPlugin` object
- [Building provider plugins](/plugins/sdk-provider-plugins) - provider registration and hooks
- [Decision models](/plugins/sdk-overview/capabilities#decision-models-contract-version-1) - `openclaw/plugin-sdk/decisions` and the typed decision provider contract

## Code Mode executor runtime

Use `openclaw/plugin-sdk/code-mode-executor-runtime` to implement the `quickjs`
executor choice. Code Mode has two selectable IDs: `node`, owned by core, and
`quickjs`, supplied by an executor plugin. The plugin's installation ID can
differ from its executor ID. Declare `quickjs` in `contracts.codeModeExecutors`
and export `codeModeExecutor` from the plugin's top-level `code-mode-executor-api`
artifact. The host resolves this artifact only when QuickJS is selected;
ordinary plugin registration remains lightweight.

Selected bundled executors preserve core runtime availability despite global
plugin disablement or a restrictive allowlist. Explicit owner denies and
disabled entries still apply. External executors retain the full plugin policy.

`CodeModeExecutor.execute(input, options)` receives the guest source,
tool declarations, namespace descriptors, resource limits, and a scoped host
bridge. Return a bounded completion or failure, or a waiting result containing
an executor-owned `CodeModeExecutorContinuation`. Its `resume` method transfers
custody once, `retainedBytes` reports a diagnostic size estimate, and `dispose` joins
cleanup and keeps failed cleanup retryable. Disposing an already consumed continuation has no effect. The selected
executor stays attached to the continuation across configuration changes.

The SDK supplies the common guest controller, source preparation, result
capture, bounded error text, and worker protocol types. Executors own their
engine and suspended state. Core owns permissions, approvals, tool dispatch,
settlement receipts, output delivery, expiry, and cancellation. Missing or
disabled executors fail explicitly; the host never substitutes a less isolated
executor.

## MCP subprocess runtime

**Import:** `mcpStdioRuntime` from `openclaw/plugin-sdk/agent-harness-runtime` using dynamic `import()` when opening a connection. Its frozen object lazily loads one factory:

```ts
const { mcpStdioRuntime } = await import("openclaw/plugin-sdk/agent-harness-runtime");
const { createMcpStdioClient } = await mcpStdioRuntime.load();
```

Use `createMcpStdioClient(params)` for a caller-owned MCP proxy subprocess fronting a stateful driver. OpenClaw owns the subprocess and its descendants, newline framing and JSON-RPC validation, initialization, request admission, deadlines, and shutdown. The client starts connecting when the factory returns. Keep this runtime out of plugin registration and paths that do not open MCP connections.

Supply `command`, optional `args`, and an exact `env`. The child inherits no other environment variables. Set `clientInfo` (`name` and `version`), the required `protocolVersion`, `startupTimeoutMs`, `maxPendingRequests`, and `maxFrameBytes`. The server must return exactly the requested protocol version. OpenClaw retains a fixed 32 KiB stderr tail for unexpected-exit diagnostics. The decoder applies `maxFrameBytes` to each message, including its terminating newline, so a single stdout chunk can contain several valid messages. It rejects an oversized frame before retaining any bytes from that chunk, preserves fragmented UTF-8, skips empty lines, and requires safe integer response IDs.

The caller supplies `errors.unavailable(message, cause?)` and `errors.protocol(message, cause?)`, each returning an `Error`. The first classifies process, lifecycle, admission, deadline, and cancellation failures. The second classifies malformed frames, non-timeout JSON-RPC errors, and handshake contract violations. Plugin-specific tool-result normalization stays with the caller.

The returned client exposes three methods:

- `isAvailable()` synchronously reports whether initialization completed and the connection remains usable.
- `request(method, params, { timeoutMs, signal? })` waits for startup and returns the object result. An already-aborted signal or a full pending-request limit rejects only that call. After admission, cancellation or timeout retires the entire connection and rejects pending requests with the retained fatal error. The client suppresses SDK cancellation notifications because it terminates the process instead. A non-timeout JSON-RPC error response rejects only its matching request through `errors.protocol`.
- `stop()` closes admission, retires pending requests, and awaits startup settlement and owned-process cleanup. It rejects through `errors.unavailable` with `proxy cleanup could not be confirmed` if cleanup is uncertain. It never stops a separately started service reached through the proxy's socket.

After successful `stop()`, the optional read-only `cleanupResult` records forced relay retirement: `reason: "forced-relay-exit"`, `signalRequested`, the observed relay `exit` code and signal, `durationMs`, and `escalationAfterMs`. It retains `signalError` when signal delivery reported failure but exit was subsequently confirmed. It is absent for ordinary cleanup. Closed control/output/lineage pipes and a matching closing receipt admit escalation; pending force requests are reconsidered as closure and group-exit facts arrive. A live anchor is killed and reaped through its relay. Confirmed anchor-group absence permits direct native termination of an unresponsive relay. Actual relay exit and server-group disappearance must then be confirmed within the original hard deadline. Uncertain cleanup retains missing closure facts and timing or signal-delivery details in the error's cause chain.

Malformed frames, incompatible initialization, write failures, and unexpected process exit also retire the whole connection. The first fatal error is retained. Create a new client to reconnect. Timeout classification follows the SDK error code, so a timeout-coded server error also retires the connection.

## Workspace access

Use `openclaw/plugin-sdk/agent-workspace-runtime` to declare, register, and acquire
`AgentWorkspaceAccess` without loading the agent execution runtime. Declare a
configured remote workspace during registration so callers cannot fall back to
local files before its service starts. Register its bridge when ready and release
it when the service stops. Callers keep their existing document authorization.

The bridge's optional `createFileExclusive` operation publishes a complete file
only if its path does not exist, returning `"created"` or `"exists"`. It must use
an atomic exclusive-create operation, never a separate existence check followed
by an ordinary write. Workspace access forwards this capability with the same
service-lifetime checks as other bridge operations. Providers that omit it still
support their existing reads and writes, but `agents.files.set` with
`expectedMissing: true` visibly refuses creation without changing the file. Update
the provider, or create the file on its host and reload it before editing.

`createWorkspaceBootstrapFilePolicy({ workspaceDir, config })` lets adapters
restrict this bridge to native bootstrap documents and the configured
`bootstrap-extra-files` patterns. Check `canList` for directory metadata,
`canRead` for file bytes, and `canWrite` for the four owner-editable documents.
Directory access does not grant reads of other files. The underlying bridge
still enforces filesystem containment and returns the read's canonical source.

Workspace access that has not started or has stopped throws
`WorkspaceAccessUnavailableError`. Use `isWorkspaceAccessUnavailableError(error)`
to recognize this condition through wrapped errors or separate SDK instances.
The error code is `WORKSPACE_ACCESS_UNAVAILABLE`; do not match message text.

The optional `memoryFiles` provider keeps workspace Memory files on the host while
the native index, embedding providers and original sessions stay on Gateway. It
supplies discovery, file inspection, reads and change notifications. Both indexing
and `memory_get` use it; index publication rechecks the host file. The canonical
source returned with a read supplies provenance, without resolving a stale Gateway
copy. Stopping the workspace binding revokes retained file access and subscriptions.
The Memory file worker supports `--files <workspace>` for native file
operations without opening a host index or receiving embedding credentials. A
provider can invoke it through its existing subprocess transport.
`createWorkspaceMemoryFileClient` maps Gateway/host paths and preserves native
errors for this worker. Supply `request` for one JSON exchange and `subscribe`
for the `--watch-files` JSON-line stream, plus the binding's abort signal.
Neither callback depends on Codex; providers own transport and authorization.

`memoryFiles.maintenance` routes existing dreaming, promotion, corpus and forget
file operations to the host. Compound writes reuse native atomic publication and
conflict handling; maintenance decisions, locks and SQLite state stay on Gateway.
A remote binding without maintenance support fails instead of using Gateway files.
The file worker implements these operations and native change notifications.
The paired-node file-transfer adapter connects these operations through the
existing service-owned node channel and node file policy.

Task-time Skill preparation uses remote discovery. Channel-native menus use
Gateway-owned Skills without waiting for the Harness; remote menu support is
tracked in [Enterprise #241](https://github.com/openclaw/openclaw-enterprise/issues/241).

The optional `skillResources` provider handles Skill reads separately from Agent
document access. Its `readInstructions` reads the selected instruction file for
Code Mode; `readSkillFiles` supplies a bundle for worker delivery. Gateway-owned
bundled, plugin, Library, Workshop and user-level sources keep their Gateway paths.
Workspace-owned sources use the remote provider. Gateway preserves source precedence
and uses existing resource delivery for workers. Discovery assigns file ownership; a provider cannot
request Gateway-local reads by returning a source label or `fileHost` value.
Stopping the binding revokes retained host readers.

The Skills worker also runs install and ClawHub operations. Install/remove use
an authenticated adapter's duplex channel so Gateway policy and mutation checks
run before the native filesystem operation. The adapter admits source roots and
uploads; the worker uses its host account's permissions.

For a remote workspace, dependency installation uses `installSkillDependencies`.
Gateway selects the recipe and runs install policy; the host runs the existing
installer through the worker's `installDependencies` operation. Requests contain
the Skill key, recipe, installation preferences and timeout. Recipe choices use
the host's OS and binaries. Missing host support fails without installing on Gateway.
File-inspecting Gateway policies receive a temporary tree from the existing Skill
resource reader; Gateway-owned sources remain local. Resource bundle limits apply.

`readWorkspaceSkillResources` lazily reuses the bounded native bundle reader.
File-transfer adapters can check each file's requested and verified canonical paths
before returning a bundle; admitting the Skill directory alone does not admit every child.

Hosts can provide `watchSkills(request, onChange, signal)` to notify the existing
snapshot cache when admitted Skill sources change. Keep the subscription alive
until aborted, and send `change` after the initial scan and later edits. Send
`unavailable` if file watching stops: preparation then refreshes on each call,
without reopening the subscription. Hosts without `watchSkills` use that same
fallback. `skills.load.watch: false` disables the subscription and this fallback.
Gateway watches Workshop locally under the same snapshot invalidation lifecycle.

The paired-node file-transfer adapter also connects Skill discovery, resource reads,
watching and dependency installation through `workspace.skills`. Its native worker
launcher uses `resolveWorkspaceWorkerArgv("memory" | "skills")` from
`agent-workspace-runtime`, then appends the operation arguments. Use the same
OpenClaw version on Gateway and node.

This adapter does not implement remote Skill source install/update/remove or
ClawHub lifecycle operations; those remain tracked in
[Enterprise #242](https://github.com/openclaw/openclaw-enterprise/issues/242).

## Tool failure diagnostics

Agent harnesses can import `readToolOperatorHint(error)` from
`openclaw/plugin-sdk/agent-harness-runtime` to read optional operator advice
attached to a tool failure. Include it only in the operator log. Keep it out of
model responses, tool-result callbacks, and serialized transcripts, and preserve
the original error message. An unannotated or immutable error needs no substitute
hint; the reader returns `undefined` when no advice is available.

## ACP harness turns

Pass optional `currentInboundContext` to `resolveAgentHarnessBeforePromptBuildResult` from
`openclaw/plugin-sdk/agent-harness-runtime`. It combines the prompt with its inbound context
and channel-provided joiner before prompt hooks run. Frame ordinary chat
with prose section labels so a leading file path cannot become a native slash command. Keep
one admitted user turn while assigning each provider attempt its own request and reply identity.

Host `requestApproval` normalizes the title and description within the shared display bounds
and preserves full action evidence in `detail`. Its response acknowledges the request with
an ID. Call `waitForApproval` with
that ID to obtain the decision, then recheck the turn's signal and authority before allowing
the native operation.

Use the plugin approval timeout independently of the agent-run timeout. Authenticated
Control UI reviewers can inspect `detail`, while channel messages retain
the bounded description. Oversized detail is rejected by the existing request schema.
