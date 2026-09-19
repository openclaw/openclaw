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

## MCP subprocess runtime

**Import:** `mcpStdioRuntime` from `openclaw/plugin-sdk/agent-harness-runtime` using dynamic `import()` when opening a connection. Its frozen object lazily loads one factory:

```ts
const { mcpStdioRuntime } = await import("openclaw/plugin-sdk/agent-harness-runtime");
const { createMcpStdioClient } = await mcpStdioRuntime.load();
```

Use `createMcpStdioClient(params)` for a caller-owned MCP proxy subprocess fronting a stateful driver. OpenClaw owns the subprocess and its descendants, newline framing and JSON-RPC validation, initialization, request admission, deadlines, and shutdown. The client starts connecting when the factory returns. Keep this runtime out of plugin registration and paths that do not open MCP connections.

Supply `command`, optional `args`, and an exact `env`. The child inherits no other environment variables. Set `clientInfo` (`name` and `version`), the required `protocolVersion`, `startupTimeoutMs`, `maxPendingRequests`, and `maxFrameBytes`. The server must return exactly the requested protocol version. OpenClaw retains a fixed 32 KiB stderr tail for unexpected-exit diagnostics. The decoder bounds pending bytes plus each incoming chunk before buffering, preserves fragmented UTF-8, skips empty lines, and requires safe integer response IDs.

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
