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
- Minimum OpenClaw host: `2026.6.11`

## Supported

- Windows hosts with the MXC executor installed through `@microsoft/mxc-sdk`.
- Explicit opt-in after plugin install with `sandbox.backend: "mxc"`.
- MXC `process` containment, which resolves to Windows ProcessContainer.
- `workspaceAccess`:
  - `none`: sandbox workdir is mounted read-only by default.
  - `ro`: sandbox workdir is mounted read-only by default.
  - `rw`: sandbox workdir is mounted read-write by default.
  - Use policy `filesystem.additionalReadwritePaths` for additional explicit
    writable host paths shared by every MXC sandbox.
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
$mxcPolicyPath = Join-Path $env:TEMP "openclaw-mxc-policy.json"
@'
{
  "filesystem": {
    "restrictToProjectDir": true,
    "additionalReadonlyPaths": [],
    "additionalReadwritePaths": []
  },
  "process": {
    "timeoutSeconds": 120
  }
}
'@ | Set-Content -Path $mxcPolicyPath -Encoding utf8

$mxcPolicyPathLiteral = ConvertTo-Json $mxcPolicyPath -Compress
$mxcConfigPatch = @"
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
          mxcPolicyPaths: [$mxcPolicyPathLiteral],
        },
      },
    },
  },
}
"@

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
          "mxcPolicyPaths": ["C:\\Users\\you\\AppData\\Local\\Temp\\openclaw-mxc-policy.json"],
        },
      },
    },
  },
}
```

## Sandbox policy files

MXC reads optional host policy files listed in
`plugins.entries.mxc.config.mxcPolicyPaths`. Policy files constrain the
filesystem and process defaults used by every MXC sandbox run on the host. When
`mxcPolicyPaths` is omitted or empty, MXC uses the built-in sandbox baseline and
does not read any implicit user or machine policy path.

`mxcPolicyPaths` must contain absolute paths. JSON arrays preserve order, and
MXC treats that order as the policy layering order. Missing files are ignored.
If a file exists but is malformed or includes an unsupported field, MXC fails
plugin load with an error that includes the policy file path and invalid field.

Example policy:

```json
{
  "filesystem": {
    "restrictToProjectDir": true,
    "additionalReadonlyPaths": ["C:\\Tools\\OpenClaw\\shared-readonly"],
    "additionalReadwritePaths": ["D:\\OpenClawScratch"]
  },
  "process": {
    "timeoutSeconds": 120
  }
}
```

Policy schema:

- `filesystem.restrictToProjectDir`: `true`, default `true`. Hardening-only.
  The default already restricts the sandbox to the project/workspace directory;
  policy files can assert `true` but cannot loosen this.
- `filesystem.additionalReadonlyPaths`: `string[]`, default `[]`. Extra host
  paths to expose read-only.
- `filesystem.additionalReadwritePaths`: `string[]`, default `[]`. Extra host
  paths to expose read-write. These must not overlap read-only roots or
  protected skill overlays.
- `process.timeoutSeconds`: positive `number`, default `300`. Per-command upper
  bound. Values must be finite and at least `1`.

Only the `filesystem` and `process` sections are supported. Unknown sections or
unknown fields are rejected so policy files fail closed when they drift from the
implemented MXC ProcessContainer surface.

When multiple configured policy files exist, OpenClaw layers them
deterministically in `mxcPolicyPaths` array order:

- readonly and read-write path arrays are appended and de-duplicated while
  preserving first-seen order.
- the effective timeout is the smallest value from the default and configured
  policy files.
- `restrictToProjectDir` remains enabled because the field is hardening-only.

Protected OpenClaw skill overlays stay read-only even when
`workspaceAccess: "rw"` makes the general workspace writable. If a configured
read-write path overlaps a read-only path or protected skill root, MXC fails the
command before launch instead of silently weakening the sandbox.

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
Remove-Item -Path $mxcPolicyPath -ErrorAction SilentlyContinue
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

For policy-only edits, the focused coverage is in:

```powershell
pnpm test extensions/mxc/test/config.test.ts extensions/mxc/test/sandbox-policy-loader.test.ts extensions/mxc/test/mxc-backend.test.ts
```
