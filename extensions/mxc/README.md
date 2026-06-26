# @openclaw/mxc-sandbox

Official MXC sandbox execution plugin for OpenClaw.

This plugin lets OpenClaw run tool execution through MXC on Windows hosts with
ProcessContainer support.

## Install

```bash
openclaw plugins install @openclaw/mxc-sandbox
```

Restart the Gateway after installing or updating the plugin.

## Configure

After installing the plugin, configure an agent to use the `mxc` sandbox backend:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "mxc",
        workspaceAccess: "none",
      },
    },
  },
}
```

This plugin is an early prerelease for testing, so expect configuration and
readiness behavior to change as MXC host support matures.

## Package

- Plugin id: `mxc`
- Package: `@openclaw/mxc-sandbox`
- Minimum OpenClaw host: `2026.6.10`

## Supported

- Windows hosts with the MXC executor installed through `@microsoft/mxc-sdk`.
- Explicit opt-in after plugin install with `sandbox.backend: "mxc"`.
- MXC `process` containment, which resolves to Windows ProcessContainer.
- `workspaceAccess`:
  - `none`: isolated sandbox workspace is writable.
  - `ro`: sandbox workdir is read-only.
  - `rw`: agent workspace is writable.
- `scope` workspace selection:
  - `session`, `agent`, and `shared` choose the OpenClaw workspace directory
    passed to MXC.
- SDK-only executor discovery from `@microsoft/mxc-sdk/bin/<arch>` or
  `@microsoft/mxc-sdk/bin`; use `mxcBinaryPath` only for an explicit override.

## Not supported yet

- Non-Windows hosts.
- Docker-style long-lived containers per `scope`. MXC ProcessContainer runs are
  per command; scope controls workspace reuse, not container lifetime.
- Windows filesystem-deny and host-list network policy knobs are not exposed by
  this plugin until MXC can enforce them on ProcessContainer.

## Test setup with `openclaw config`

This patch creates a default `main` agent, then adds a dedicated `mxc-test`
agent so MXC testing does not change the default agent. It uses
[`openclaw config patch --stdin`](https://docs.openclaw.ai/cli/config#config-patch)
so setup is one validated config write instead of several path-based
`config set` commands.

If you already have `agents.list` entries, copy them into the patch before
`mxc-test` instead of replacing the list.

```powershell
$mxcConfigPatch = @'
{
  agents: {
    list: [
      {
        id: "main",
        workspace: "~/.openclaw/workspace",
      },
      {
        id: "mxc-test",
        workspace: "~/.openclaw/workspace-mxc-test",
        sandbox: {
          mode: "all",
          backend: "mxc",
          scope: "agent",
          workspaceAccess: "none",
        },
      },
    ],
  },
  plugins: {
    entries: {
      mxc: {
        enabled: true,
        config: {
          containment: "process",
          network: "none",
        },
      },
    },
  },
}
'@

$mxcConfigPatch | openclaw config patch --stdin --dry-run
$mxcConfigPatch | openclaw config patch --stdin
```

Resulting config shape:

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "main",
        "workspace": "~/.openclaw/workspace",
      },
      {
        "id": "mxc-test",
        "workspace": "~/.openclaw/workspace-mxc-test",
        "sandbox": {
          "mode": "all",
          "backend": "mxc",
          "scope": "agent",
          "workspaceAccess": "none",
        },
      },
    ],
  },
  "plugins": {
    "entries": {
      "mxc": {
        "enabled": true,
        "config": {
          "containment": "process",
          "network": "none",
        },
      },
    },
  },
}
```

Run the TUI as that agent:

```powershell
openclaw tui --session agent:mxc-test:main
```

For local embedded testing without a Gateway:

```powershell
openclaw tui --local --session agent:mxc-test:main
```

## Cleanup

If you used the exact sample above, remove the test agent and MXC plugin
configuration by patching the config back to the default-only shape:

```powershell
$mxcCleanupPatch = @'
{
  agents: {
    list: [
      {
        id: "main",
        workspace: "~/.openclaw/workspace",
      },
    ],
  },
  plugins: {
    entries: {
      mxc: null,
    },
  },
}
'@

$mxcCleanupPatch | openclaw config patch --stdin --dry-run
$mxcCleanupPatch | openclaw config patch --stdin
```

## Host readiness

IsoEnvBroker must be available on the host OS. The plugin checks this before
registering the sandbox backend.

Host preparation is advisory. If directory listing inside the sandbox fails with
`Access is denied`, run this once from an elevated prompt:

```powershell
wxc-host-prep prepare-system-drive
```

`wxc-host-prep` ships with `@microsoft/mxc-sdk` under
`node_modules/@microsoft/mxc-sdk/bin/<arch>/`.

## Testing

```powershell
pnpm test extensions/mxc
```
