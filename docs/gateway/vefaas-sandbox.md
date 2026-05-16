---
summary: "Use VEFaaS as a remote sandbox backend for OpenClaw agents"
title: VEFaaS sandbox
read_when:
  - You want VEFaaS-hosted remote sandboxes instead of local Docker
  - You are setting up the VEFaaS sandbox plugin
  - You need the provisioner contract for a VEFaaS lifecycle service
---

The VEFaaS sandbox plugin registers the `vefaas` sandbox backend for OpenClaw.
OpenClaw uses it to run agent tools in a VEFaaS-hosted remote environment over
SSH while keeping the remote workspace canonical.

The plugin owns OpenClaw integration: backend registration, sandbox manager
support, SSH command execution, remote file operations, and first-run workspace
seeding. VEFaaS control-plane calls are delegated to a provisioner command so
deployments can use an internal CLI or service wrapper that matches their
Volcengine account, region, image registry, and networking policy.

## Prerequisites

- VEFaaS sandbox plugin installed (`openclaw plugins install @openclaw/vefaas-sandbox`)
- A VEFaaS provisioner command available on the Gateway host
- A VEFaaS **webserver sandbox function id** that supports `CreateSandbox`,
  `ListSandboxes`, `DescribeSandbox`, `KillSandbox`, and connection setup for
  the created sandbox instances
- A sandbox image that includes `opencode`, SSH server access, POSIX shell
  tools, `scp`, and the runtime dependencies needed by your coding agent
- VEFaaS account permissions to create, inspect, delete, and connect to sandbox
  instances

## Quick start

1. Install and enable the plugin, then set the sandbox backend:

```bash
openclaw plugins install @openclaw/vefaas-sandbox
```

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "vefaas",
        scope: "session",
        workspaceAccess: "rw",
      },
    },
  },
  plugins: {
    entries: {
      "vefaas-sandbox": {
        enabled: true,
        config: {
          command: "/usr/local/bin/openclaw-vefaas-sandbox",
          functionId: "<VEFAAS_WEBSERVER_SANDBOX_FUNCTION_ID>",
          region: "cn-beijing",
          image:
            "enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:1.9.3",
          mode: "remote",
        },
      },
    },
  },
}
```

2. Restart the Gateway. On the next sandboxed agent turn, OpenClaw asks the
   provisioner to create or reuse a VEFaaS sandbox and then connects over SSH.

3. Verify:

```bash
openclaw sandbox list
openclaw sandbox explain
```

## Workspace model

The VEFaaS backend currently supports only `remote` mode.

Behavior:

- On first create, OpenClaw seeds the remote workspace from the local workspace.
- After that, `exec`, `read`, `write`, `edit`, and `apply_patch` operate against
  the remote VEFaaS workspace.
- OpenClaw does not sync remote changes back to the local workspace.
- Host-local edits made after the first seed are not visible until you recreate
  the sandbox.

Use `openclaw sandbox recreate` when you want a fresh remote workspace seeded
from the current local checkout.

## Provisioner contract

The plugin calls the configured command with one action at a time:

```bash
openclaw-vefaas-sandbox get --name <sandbox-name>
openclaw-vefaas-sandbox create --name <sandbox-name> --spec-json '<json>'
openclaw-vefaas-sandbox ssh-config --name <sandbox-name>
openclaw-vefaas-sandbox delete --name <sandbox-name>
```

Expected behavior:

| Action       | Exit code `0` means                              | Output                                                        |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------- |
| `get`        | The sandbox exists and is usable                 | Optional JSON or text status                                  |
| `create`     | The sandbox exists after the call                | Optional JSON or text status                                  |
| `ssh-config` | SSH config is available for the sandbox          | OpenSSH config text with at least one `Host` entry on stdout  |
| `delete`     | The sandbox was deleted or is already absent     | Optional JSON or text status                                  |

Non-zero exits are treated as operation failures. `get` returning non-zero
means OpenClaw will call `create` before executing tools.

The `create` action receives a JSON spec with the OpenClaw-facing runtime
contract:

```json
{
  "backend": "vefaas",
  "mode": "remote",
  "functionId": "fn-xxxxxxxx",
  "region": "cn-beijing",
  "endpoint": "https://example.vefaas-control-plane",
  "image": "enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:1.9.3",
  "remoteWorkspaceDir": "/workspace",
  "remoteAgentWorkspaceDir": "/agent",
  "ttlSeconds": 3600,
  "resources": {
    "cpuCores": 2,
    "memoryMiB": 4096,
    "gpuCount": 0
  },
  "network": {
    "egress": "restricted",
    "vpcId": "vpc-123",
    "subnetId": "subnet-123",
    "securityGroupId": "sg-123"
  }
}
```

The provisioner owns translating this spec to VEFaaS APIs, credentials, network
placement, image policy, SSH bootstrap, and provider-side cleanup.

VEFaaS public Code-Sandbox MCP deployments are useful for one-shot `run_code`
workloads, but they do not by themselves satisfy the OpenClaw sandbox backend
contract. OpenClaw needs a persistent workspace plus command execution and file
transfer for `exec`, `read`, `write`, `edit`, and `apply_patch`. Use a
provisioner that can turn the VEFaaS sandbox instance into an OpenSSH config, or
extend the backend with a VEFaaS WebShell/MCP transport that implements the same
filesystem and process semantics.

## Configuration reference

All VEFaaS plugin config lives under
`plugins.entries["vefaas-sandbox"].config`:

| Key                       | Type                                      | Default                       | Description                                   |
| ------------------------- | ----------------------------------------- | ----------------------------- | --------------------------------------------- |
| `mode`                    | `"remote"`                                | `"remote"`                    | Workspace mode. Only `remote` is supported.   |
| `command`                 | `string`                                  | `"openclaw-vefaas-sandbox"`   | Provisioner command path or name              |
| `functionId`              | `string`                                  | —                             | VEFaaS webserver sandbox function id          |
| `region`                  | `string`                                  | —                             | Region forwarded in the create spec           |
| `endpoint`                | `string`                                  | —                             | Control-plane endpoint forwarded in the spec  |
| `image`                   | `string`                                  | VEFaaS public all-in-one image | Sandbox image that contains opencode          |
| `remoteWorkspaceDir`      | `string`                                  | `"/workspace"`                | Primary writable workspace inside the sandbox |
| `remoteAgentWorkspaceDir` | `string`                                  | `"/agent"`                    | Agent workspace mirror path                   |
| `ttlSeconds`              | `number`                                  | `3600`                        | Requested provider-side sandbox lifetime      |
| `timeoutSeconds`          | `number`                                  | `120`                         | Provisioner operation timeout                 |
| `resources`               | `object`                                  | —                             | CPU, memory, and GPU request fields           |
| `network`                 | `object`                                  | —                             | Egress and VPC placement fields               |

Sandbox-level settings (`mode`, `scope`, `workspaceAccess`) are configured under
`agents.defaults.sandbox` as with any backend. See
[Sandboxing](/gateway/sandboxing) for the full matrix.

## Limitations

- Browser sandbox/noVNC/CDP support is not implemented for the VEFaaS backend.
- `sandbox.docker.binds` is Docker-specific and is rejected by the VEFaaS
  backend.
- Mirror mode is not implemented. The remote workspace is canonical after the
  first seed.
- The plugin does not embed Volcengine credentials. Put credential resolution in
  the provisioner command or the host secret manager it uses.
- The VEFaaS control-plane `CreateSandbox` API requires an existing FunctionId.
  A normal VEFaaS function that is not a webserver sandbox function will fail
  with an `InvalidOperation` response.

## Related

- [Sandboxing](/gateway/sandboxing)
- [OpenShell](/gateway/openshell)
- [Plugin reference](/plugins/reference/vefaas-sandbox)
