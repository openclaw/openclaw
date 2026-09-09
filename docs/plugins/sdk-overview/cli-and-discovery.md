---
summary: "Gateway discovery services, CLI registrars and descriptors, and CLI backend registration"
title: "Plugin SDK CLI and discovery registration"
sidebarTitle: "CLI and discovery"
read_when:
  - You are adding a plugin-owned CLI command or node feature
  - You are registering a local Gateway discovery advertiser
  - You own the default config for a local AI CLI backend
---

Registrars for local Gateway discovery, plugin-owned CLI commands, and local AI
CLI backends. Part of the [Plugin SDK overview](/plugins/sdk-overview).

## Gateway discovery registration

`api.registerGatewayDiscoveryService(...)` lets a plugin advertise the active
Gateway on a local discovery transport such as mDNS/Bonjour. OpenClaw calls the
service during Gateway startup when local discovery is enabled, passes the
current Gateway ports and non-secret TXT hint data, and calls the returned
`stop` handler during Gateway shutdown.

```typescript
api.registerGatewayDiscoveryService({
  id: "my-discovery",
  async advertise(ctx) {
    const handle = await startMyAdvertiser({
      gatewayPort: ctx.gatewayPort,
      tls: ctx.gatewayTlsEnabled,
      displayName: ctx.machineDisplayName,
    });
    return { stop: () => handle.stop() };
  },
});
```

Gateway discovery plugins must not treat advertised TXT values as secrets or
authentication. Discovery is a routing hint; Gateway auth and TLS pinning still
own trust.

## CLI registration metadata

`api.registerCli(registrar, opts?)` accepts two kinds of command metadata:

- `commands`: explicit command names owned by the registrar
- `descriptors`: parse-time command descriptors used for CLI help,
  routing, and lazy plugin CLI registration
- `parentPath`: optional parent command path for nested command groups, such as
  `["nodes"]`

For paired-node features, prefer
`api.registerNodeCliFeature(registrar, opts?)`. It is a small wrapper around
`api.registerCli(..., { parentPath: ["nodes"] })` and makes commands such as
`openclaw nodes canvas` explicit plugin-owned node features.

Reuse the core node CLI owners when a plugin-owned node command needs the same
Gateway flags, invoke envelope, terminal presentation, and authorization hints:

```typescript
import {
  buildNodeInvokeParams,
  getNodesTheme,
  nodesCallOpts,
  runNodesCommand,
} from "openclaw/plugin-sdk/node-cli-runtime";
```

If you want a plugin command to stay lazy-loaded in the normal root CLI path,
provide `descriptors` that cover every top-level command root exposed by that
registrar.

```typescript
api.registerCli(
  async ({ program }) => {
    const { registerMatrixCli } = await import("./src/cli.js");
    registerMatrixCli({ program });
  },
  {
    descriptors: [
      {
        name: "matrix",
        description: "Manage Matrix accounts, verification, devices, and profile state",
        hasSubcommands: true,
      },
    ],
  },
);
```

A root descriptor can also declare `machineOutput({ argv, stdoutIsTTY })` when
the command reserves stdout for JSON, JSONL, or another machine-readable format
without relying exclusively on a literal `--json` flag. OpenClaw evaluates this
resolver before plugin activation so startup diagnostics can be routed to
stderr. The resolver must be synchronous, pure, and dependency-light: inspect
only the supplied raw argv and stdout TTY state. Reuse the same resolver in
lightweight CLI metadata and full registration so discovery and execution do
not disagree. Use `getRootOptionAwareCommandPath` from
`openclaw/plugin-sdk/cli-argv` when the resolver needs command-path tokens; it
accepts supported root options before or after the command root. `machineOutput`
is root metadata; nested descriptors cannot use it because their owning root
must already be active before they are visible.

Nested commands receive the resolved parent command as `program`:

```typescript
api.registerCli(
  async ({ program }) => {
    const { registerNodesCanvasCommands } = await import("./src/cli.js");
    registerNodesCanvasCommands(program);
  },
  {
    parentPath: ["nodes"],
    descriptors: [
      {
        name: "canvas",
        description: "Present hosted widgets on a paired Mac",
        hasSubcommands: true,
      },
    ],
  },
);
```

Use `commands` by itself only when you do not need lazy root CLI registration.
That eager compatibility path remains supported, but it does not install
descriptor-backed placeholders for parse-time lazy loading.

## CLI backend registration

`api.registerCliBackend(...)` lets a plugin own the default config for a local
AI CLI backend such as `claude-cli` or `my-cli`.

- The backend `id` becomes the provider prefix in model refs like `my-cli/gpt-5`.
- The backend `config` is the authoritative command adapter: argv, environment,
  parser, session, image, and reliability behavior live in plugin code.
- Users select the backend through model refs or model-scoped `agentRuntime.id`;
  `openclaw.json` does not rewrite the adapter.
- Use `normalizeConfig` when registered static fields need a runtime-aware
  normalization pass.
- Use `resolveExecutionArgs` for request-scoped argv rewrites that belong to
  the CLI dialect, such as mapping OpenClaw thinking levels to a native effort
  flag. The hook receives `ctx.executionMode`; use `"side-question"` to add
  backend-native isolation flags for ephemeral `/btw` calls. If those flags
  reliably disable native tools for an otherwise always-on CLI, declare
  `sideQuestionToolMode: "disabled"` too.
- Use `prepareExecution` for backend-owned launch environment or temporary
  auth/config bridges. Its `ctx.contextTokenBudget` is the effective token
  limit selected for the run, so native-compaction backends can align their
  own threshold without provider-specific core branches. Its optional
  `ctx.thinkingLevel` is the effective `off`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, `adaptive`, or `max` selection for backends that apply the
  level through launch environment or staged configuration. It also receives
  the core-prepared `ctx.env` when backend staging must extend bundled MCP settings.
- Backends that can disable all native tools for a specific run may declare
  `nativeToolMode: "selectable"`. Restricted calls pass an exact
  `ctx.toolAvailability.native` list plus canonical
  `ctx.toolAvailability.openClaw` names. Declare
  `toolAvailabilityEnforcement: "execution-args"` and enforce the contract in
  final fresh/resume argv, or declare `"prepare-execution"`, enforce it in
  staged policy, and return `toolAvailabilityEnforced: true`. OpenClaw disables
  native tools for runtime caps such as cron `toolsAllow` and fails closed when
  the declared enforcement path is incomplete.

For an end-to-end authoring guide, see
[CLI backend plugins](/plugins/cli-backend-plugins).
