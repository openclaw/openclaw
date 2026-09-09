---
summary: "YOLO and guardian approval presets, and sandboxed native execution paths"
read_when:
  - You are choosing between YOLO and guardian approval
  - You are running Codex native execution inside an OpenClaw sandbox
  - You are placing Codex execution on a node or cloud worker
title: "Codex approval and sandbox modes"
sidebarTitle: "Approval and sandbox"
---

The approval and sandbox posture of a Codex turn, and where native execution runs. Part of the [Codex harness reference](/plugins/codex-harness-reference); [Where each section moved](/plugins/codex-harness-reference#where-each-section-moved) lists every section.

## Approval and sandbox modes

Local stdio app-server sessions default to YOLO mode:
`approvalPolicy: "never"`, `approvalsReviewer: "user"`, and
`sandbox: "danger-full-access"`. This trusted local operator posture lets
unattended OpenClaw turns and heartbeats make progress without native approval
prompts that nobody is around to answer.

If Codex's local system requirements file disallows implicit YOLO approval,
reviewer, or sandbox values, OpenClaw treats the implicit default as guardian
instead and selects allowed guardian permissions. `tools.exec.mode: "auto"`
also forces guardian-reviewed Codex approvals and does not preserve unsafe
legacy `approvalPolicy: "never"` or `sandbox: "danger-full-access"` overrides;
set `tools.exec.mode: "full"` for an intentional no-approval posture.
Hostname-matching `[[remote_sandbox_config]]` entries in the same requirements
file are honored for the sandbox default decision.

Set `appServer.mode: "guardian"` for Codex guardian-reviewed approvals:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            mode: "guardian",
            serviceTier: "priority",
          },
        },
      },
    },
  },
}
```

The `guardian` preset expands to `approvalPolicy: "on-request"`,
`approvalsReviewer: "auto_review"`, and `sandbox: "workspace-write"` when those
values are allowed. Individual policy fields override `mode`. The older
`guardian_subagent` reviewer value is still accepted as a compatibility alias,
but new configs should use `auto_review`.

When an OpenClaw sandbox is active, the local Codex app-server process still
runs on the Gateway host. OpenClaw therefore disables Codex native Code Mode,
user MCP servers, and app-backed plugin execution for that turn instead of
treating Codex host-side sandboxing as equivalent to the OpenClaw sandbox
backend. Shell access is exposed through OpenClaw sandbox-backed dynamic tools
such as `sandbox_exec` and `sandbox_process` when the normal exec/process tools
are available.

<Note>
On Docker-backed OpenClaw sandbox hosts (`agents.defaults.sandbox.mode` set to
a Docker backend), `openclaw doctor` probes whether the host allows the
unprivileged user (and, when Docker sandbox network egress is disabled,
network) namespaces that nested Codex `bwrap` needs for `workspace-write`
shell execution inside the sandbox container. A failed probe usually surfaces
as `bwrap: setting up uid map: Permission denied` or
`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` on
Ubuntu/AppArmor hosts. Fix the reported host namespace policy for the OpenClaw
service user and restart the gateway; prefer a scoped AppArmor profile for the
service process over the host-wide
`kernel.apparmor_restrict_unprivileged_userns=0` fallback, and do not grant
broader Docker container privileges just to satisfy nested `bwrap`.
</Note>

## Sandboxed native execution

The stable default is fail-closed: active OpenClaw sandboxing disables native
Codex execution surfaces that would otherwise run from the Codex app-server
host. Use `appServer.experimental.sandboxExecServer: true` only when you want
to try Codex's remote environment support with OpenClaw's sandbox backend.
This preview path uses the pinned Codex `0.153.4` app-server.

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            experimental: {
              sandboxExecServer: true,
            },
          },
        },
      },
    },
  },
}
```

When the flag is on and the current OpenClaw session is sandboxed, OpenClaw
starts a local loopback exec-server backed by the active sandbox, registers it
with Codex app-server, and starts the Codex thread and turn with that
OpenClaw-owned environment. If the app-server cannot register the environment,
the run fails closed instead of silently falling back to host execution.

Sandboxed process output streams as ordered stdout, stderr, or PTY
notifications. OpenClaw retains only a bounded recent-output buffer for polling
and replay, so long-running processes cannot grow the app-server bridge without
limit. Process exit and cleanup remain tied to the sandbox-owned process.

This preview path is local-only. A remote WebSocket app-server cannot reach
the loopback exec-server unless it is running on the same host, so OpenClaw
rejects that combination.

Node-backed `remote-exec` placement on a paired device or enrolled Crabbox
cloud worker is a separate, placement-owned execution path and does not require
`appServer.experimental.sandboxExecServer`. The Gateway keeps Codex
app-server and provider auth local, while the authorized node runs the managed,
pinned Codex exec-server over its existing duplex connection. It requires
explicit `gateway.nodes.commands.allow` authorization for
`codex.exec-server.stdio.v1`, the approved pairing surface, and launch
authorization for each attempt. A deliberately selected session **Full access**
permission can replace the critical allow-once prompt only while the exact
admitted turn and placement remain current and both node-local `tools.exec`
and exec-approvals floors allow full/off execution. Ordinary and raw callers
still require human approval. Local deny blocks either launch; local ask and
allowlist policies cannot be bypassed with Full access. Changed local policy
during setup refuses the launch. Gateway and node must both support this
authorization path; missing node policy support fails closed. The node receives a
fresh private home and sanitized environments, never Gateway provider, cloud,
or GitHub credentials. A lost node connection terminates the attempt and
process instead of resuming it. Each node-backed attempt uses its own Gateway
app-server client because Codex can register a remote environment but cannot
remove one from a running app-server. The node exec-server does not consume an
OpenClaw worker slot. HTTP requests containing authentication, cookies, API
keys, or other credential-bearing headers are rejected before reaching the
node; use a Gateway-owned authenticated request or a credential-free endpoint
instead.
Normal Codex turns are supported, but `/btw` side questions are unavailable
until they can be bound to the active placement.
The managed placement workspace is not an OS sandbox: approved processes and
files have the node account's full access. Use a separate least-privilege node
account when isolation is required.
See [Run Codex on a paired device](/plugins/codex-harness/placement#run-codex-on-a-paired-device)
and [Run Codex on a cloud worker](/plugins/codex-harness/placement#run-codex-on-a-cloud-worker).
