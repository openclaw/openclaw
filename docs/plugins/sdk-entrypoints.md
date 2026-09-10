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

- [SDK Overview](/plugins/sdk-overview) - registration API and subpath reference
- [Runtime Helpers](/plugins/sdk-runtime) - `api.runtime` and `createPluginRuntimeStore`
- [Setup and Config](/plugins/sdk-setup) - manifest and setup entry loading
- [Channel Plugins](/plugins/sdk-channel-plugins) - building the `ChannelPlugin` object
- [Provider Plugins](/plugins/sdk-provider-plugins) - provider registration and hooks

## MCP subprocess runtime

**Import:** `mcpStdioRuntime` from `openclaw/plugin-sdk/agent-harness-runtime` using dynamic `import()` when opening a connection. Its frozen object lazily loads one factory:

```ts
const { mcpStdioRuntime } = await import("openclaw/plugin-sdk/agent-harness-runtime");
const { createMcpStdioClient } = await mcpStdioRuntime.load();
```

Use `createMcpStdioClient(params)` for a caller-owned MCP proxy subprocess fronting a stateful driver. OpenClaw owns the subprocess and its descendants, newline framing and JSON-RPC validation, initialization, request admission, deadlines, and shutdown. The client starts connecting when the factory returns. Keep this runtime out of plugin registration and paths that do not open MCP connections.

Supply `command`, optional `args`, and an exact `env`; the child inherits no other environment variables. Set `clientInfo` (`name` and `version`), the required `protocolVersion`, `startupTimeoutMs`, `maxPendingRequests`, and `maxFrameBytes`. The server must return exactly the requested protocol version. OpenClaw retains a fixed 32 KiB stderr tail for unexpected-exit diagnostics. The decoder bounds pending bytes plus each incoming chunk before buffering, preserves fragmented UTF-8, skips empty lines, and requires safe integer response IDs.

The caller supplies `errors.unavailable(message, cause?)` and `errors.protocol(message, cause?)`, each returning an `Error`. The first classifies process, lifecycle, admission, deadline, and cancellation failures. The second classifies malformed frames, non-timeout JSON-RPC errors, and handshake contract violations. Plugin-specific tool-result normalization stays with the caller.

The returned client exposes three methods:

- `isAvailable()` synchronously reports whether initialization completed and the connection remains usable.
- `request(method, params, { timeoutMs, signal? })` waits for startup and returns the object result. An already-aborted signal or a full pending-request limit rejects only that call. After admission, cancellation or timeout retires the entire connection and rejects pending requests with the retained fatal error. The client suppresses SDK cancellation notifications because it terminates the process instead. A non-timeout JSON-RPC error response rejects only its matching request through `errors.protocol`.
- `stop()` closes admission, retires pending requests, and awaits startup settlement and owned-process cleanup. It rejects through `errors.unavailable` with `proxy cleanup could not be confirmed` if cleanup is uncertain. It never stops a separately started service reached through the proxy's socket.

Malformed frames, incompatible initialization, write failures, and unexpected process exit also retire the whole connection. The first fatal error is retained; create a new client to reconnect. Timeout classification follows the SDK error code, so a timeout-coded server error also retires the connection.
