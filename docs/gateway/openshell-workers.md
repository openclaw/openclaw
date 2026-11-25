---
summary: "Run worker-local inference with OpenShell-brokered credentials without OCE or Kubernetes"
title: "OpenShell worker inference"
read_when:
  - Running native worker inference with an OpenShell credential broker
  - Using a Docker- or Podman-backed OpenShell gateway
---

# OpenShell worker inference

The OpenShell plugin can prepare and run a dedicated node for
[worker-local inference](/gateway/cloud-workers/native-inference). Unlike its
[sandbox-only backend](/gateway/openshell), the native agent loop and coding
tools run inside OpenShell. The OpenClaw Gateway keeps session authority,
transcripts, and placement. **OCE and Kubernetes are not required.**

The commands use OpenShell's shared gateway API through its CLI. Select a
Docker- or Podman-backed gateway through normal OpenShell setup; the plugin
never talks to the container engine directly. This is opt-in: existing sandbox
behavior is unchanged, and worker settings alone launch nothing.

## Compatibility and rollback

Existing sandbox-only configurations keep their `mirror`/`remote` behavior and
defaults when `worker` is absent. The new CLI is additive; registering it does
not create a sandbox, start a node, or select a worker profile. This plugin adds
no database migration or worker wire protocol.

Use matching, qualified Gateway and node builds for the new worker mode. The
plugin package’s general host/API version bounds are not a guarantee that an
older host or image implements native worker inference, required profiles, or
the private pairing-file command. Follow the selected build’s
[Node requirements](/install/node-compatibility); a generic image containing an
older Node or OpenClaw executable is not sufficient. For example, the released
OpenClaw `v2026.10.1` does not include the native worker-inference stack or
`cloudWorkers.requiredProfile`. Installing this plugin alone on that release
does not backport those features.

Before rolling back to a plugin without this mode, remove
`plugins.entries.openshell.config.worker`: older strict plugin schemas reject
that field. First finish or stop turns, reclaim native placements, and remove
any required/native worker profiles while the compatible Gateway and node are
still available. Follow the complete
[worker-local inference downgrade procedure](/gateway/cloud-workers/native-inference#upgrade-and-downgrade),
including pending browser messages; deleting configuration alone does not
migrate recorded placements or recovery state. Preserve other sandbox settings.
This is a cleanup procedure, not a claim of tested cross-version database
downgrade compatibility.

## Prerequisites

- OpenShell **v0.1.3 or newer**, configured for the OS user running OpenClaw. This
  minimum applies to the new worker commands, not a new version check on the
  existing sandbox-only backend.
- A Linux sandbox workload on a host whose kernel supports complete OpenShell
  enforcement, including Landlock. Docker or Podman alone does not provide those
  kernel capabilities. Native Windows worker-local inference is unsupported; a
  container-engine choice is not a platform-compatibility guarantee.
- Compatible OpenClaw Gateway and node builds supporting native worker inference,
  required profiles, and `connect --target-file`.
- An OpenShell source image with Node, OpenClaw, Git, `ps`, and `sleep` on
  `PATH`. Git backs managed workspaces; process tooling verifies workspace
  quiescence. The image owns these installations; the plugin does not download
  an unpinned node runtime.
- An imported OpenShell provider profile allowing the **actual Node executable**
  in your image, the intended provider endpoint, TLS inspection, and credential
  substitution. A curl- or Codex-only binary list is insufficient.
- A sandbox policy permitting the node's outbound Gateway connection, DNS/TLS,
  workspace writes, and a private node-state directory.

Complete package installation during the image build, including OpenClaw lifecycle
scripts, and check `openclaw --version` as the intended non-root runtime user.
Do not rely on first-run package repair inside a read-only sandbox.

For a WSS pairing target that pins the Gateway certificate, preserve end-to-end
Gateway TLS: set `tls: skip` only on the exact Gateway host/port network rule.
TLS interception changes that certificate and correctly fails its pin check.
Keep TLS inspection and credential substitution enabled on model-provider
endpoints; the Gateway exception must not apply to those endpoints.

OpenShell v0.1.3 uses the **real provider endpoint and model**, not the removed
workspace inference route or `inference.local`. Follow its
[inference contract](https://github.com/NVIDIA/OpenShell/blob/v0.1.3/docs/how-it-works/inference.mdx)
and adapt the [OpenAI profile example](https://github.com/NVIDIA/OpenShell/blob/v0.1.3/providers/openai.yaml)
to your image before importing it. Upgrading an older OpenShell deployment to
v0.1.3 is a separate migration: its retired managed inference route is not
converted automatically, and upstream requires replacing pre-upgrade sandboxes.
Follow OpenShell’s
[migration checklist](https://github.com/NVIDIA/OpenShell/blob/v0.1.3/docs/how-it-works/inference.mdx#migration-checklist)
before that upgrade. This plugin does not upgrade OpenShell or migrate its
provider records. For a prepared profile with ID `openai`:

```bash
openshell --workspace workers profile lint -f /etc/openshell/openai-worker.yaml
openshell --workspace workers profile import -f /etc/openshell/openai-worker.yaml
# Reads the operator environment variable; do not paste a key into argv.
openshell --workspace workers provider create --name model-broker --type openai --credential OPENAI_API_KEY
```

Keep real keys in OpenShell providers—not the image, sandbox environment,
workspace, node config, or Gateway worker profile. Worker creation always uses
`--no-auto-providers`, regardless of the sandbox-only `autoProviders` option.

## Configure the plugin

```json5
{
  plugins: {
    entries: {
      openshell: {
        enabled: true,
        config: {
          gateway: "local-container",
          workspace: "workers",
          from: "example/openclaw-worker:qualified-build",
          policy: "/etc/openshell/worker-policy.yaml",
          providers: ["model-broker"],
          worker: {
            nodeExecutable: "/usr/local/bin/node",
            nodeCommand: "/usr/local/bin/openclaw",
            stateDir: "/sandbox/.openclaw-node",
            model: {
              provider: "openai",
              id: "gpt-4.1-mini",
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              credentialEnv: "OPENAI_API_KEY",
              contextWindow: 1047576,
              maxTokens: 32768,
              input: ["text", "image"],
              reasoning: false,
            },
          },
        },
      },
    },
  },
}
```

This initial integration configures one model using `openai-completions`,
`openai-responses`, or `anthropic-messages`. Supply actual model capabilities.
`nodeExecutable` and `nodeCommand` default to `node` and `openclaw`.
`stateDir` defaults to `/sandbox/.openclaw-node` and must be private, owned by
the node user, and under `/sandbox` or `/agent`.

The generated node config holds only an auth environment reference. Bootstrap
requires that variable to contain an OpenShell `openshell:resolve:env:…`
placeholder: missing or literal provider keys fail before node startup.
If `NODE_EXTRA_CA_CERTS` is unset, OpenShell's `SSL_CERT_FILE` supplies it.
An explicit Node CA bundle must include the OpenShell inspection CA. Certificate
verification is never disabled.

## Bind one agent's canonical files (optional)

For a dedicated agent, add `worker.agentWorkspace` to the OpenShell plugin
configuration before starting its node:

```json5 validate=false
// plugins.entries.openshell.config.worker
{
  // Keep the model and node settings from the example above.
  agentWorkspace: { agentId: "assistant", remoteRoot: "/agent/assistant" },
}
```

This is a **remote-canonical** binding, not a mount or synchronization policy.
Every session for that agent reads the same agent documents, even when its task
worktree differs. Inference location does not choose the document owner.
The Gateway keeps authentication, configuration, databases, transcripts, and
Codex home; none of those directories is copied into the bound workspace.

Prepare the remote directory with the node user's ownership and mode `0700`
and place the intended agent documents there yourself. Use a persistent path
below `/agent` or `/sandbox`, separate from `worker.stateDir`, without symlink
aliases or glob characters. Setup requires an existing directory, never seeds
files, and never overwrites remote edits. An existing private node configuration
with different settings is refused: reconcile it explicitly while the node is
stopped, or use a new private state directory and enroll its new identity.

Review these existing Gateway node-command grants before configuring the binding:

```json5 validate=false
// gateway.nodes.commands.allow
[
  "file.fetch",
  "file.stat",
  "file.write",
  "file.create",
  "dir.list",
  "workspace.memory",
  "workspace.skills",
]
```

Preserve your other grants. Setup does not change command approvals, override a
deny, or broaden a restricted plugin allowlist. The updated node advertises File
Transfer commands; approve its pairing or command-surface upgrade normally.
Keep File Transfer enabled and allow `file_fetch`/`file_write` in any restricted
agent tool policy. The node's OpenShell filesystem policy must permit this root.

After starting and pairing the node, the existing `worker configure --apply`
step also saves `file-transfer.config.workspaces.<agentId>` with the exact node ID
read from that sandbox. It refuses a conflicting binding or an unconfigured
agent. The selected agent must not silently redirect another agent sharing its
Gateway workspace. Existing File Transfer policies, including display-name and
wildcard selectors, are retained without adding an overriding exact-node grant.
Review them if they deny or do not cover the intended operations. Only an empty
node-policy map gets scoped reads under this remote root and writes to owner documents, Memory,
workspace Skills and their metadata, and private inbound attachment staging.
No host-wide file grant is added.

The agent receives a routing hint to use the existing `file_fetch` and
`file_write` tools for canonical documents. Ordinary `read`/`write`/`edit`
and shell operations still address the session's task workspace; this option
does not make those filesystem operations transparently remote. Personal,
authenticated-user instructions retain their separate owner.

Removing `cloudWorkers.requiredProfile` or restarting the Gateway does not
remove this File Transfer binding or copy documents back. Keep the paired node
available: a disconnected or stopped node makes bound workspace access fail,
with **no local-file fallback**. Stopping `worker run` stops its sandbox too.
Concurrent writers retain the existing File Transfer/document-owner semantics;
this is not two-way merge or cross-host compare-and-swap. Read current contents
before editing and do not overwrite another session's changes.

Before retiring that node or downgrading to a build without remote workspace
support, stop all writers. Explicitly copy and verify the intended agent files
in the destination workspace, then remove this agent's File Transfer binding and
`worker.agentWorkspace`. Preserve unrelated bindings and grants. Removing only
the worker profile does not migrate files or make a local copy current.

## Create, enroll, and select

Create a dedicated retained sandbox:

```bash
openclaw openshell worker create native-worker
```

Get a single-use join target from the Gateway Devices page or
`openclaw devices join-code`. Save it in a private local file outside your
repository, then run the node in a dedicated foreground terminal:

```bash
openclaw openshell worker run native-worker --target-file /private/path/join-target
```

Each provider is attached using OpenShell's `--wait` readiness contract before
launch. Failure starts no node. Pairing travels on stdin, not process arguments;
the remote private handoff file is removed at completion or failure. The local
file is retained: remove it after enrollment. Never print broker placeholders
into a model conversation.

In another terminal, derive the exact node identity from the sandbox and preview
or apply its Gateway profile:

```bash
openclaw openshell worker configure native-worker --worker-profile openshell-native --required
openclaw openshell worker configure native-worker --worker-profile openshell-native --required --apply
```

`configure` uses the read-only `openclaw node identity --json` inside the
configured sandbox state directory. Optional `--device <id>` asserts an expected
identity and rejects a mismatch. The canonical config writer saves the existing
`provider: "device"` and `settings.inference: "worker"` profile. No new pairing
owner or inference transport is introduced; conflicting profiles are not replaced.

`--worker-profile` selects the worker profile. OpenClaw's global `--profile` flag
selects a configuration profile and is not a worker selector.

**`--required` affects every session on this Gateway:** unavailable workers
block turns. Omit it for optional administrator-selected dispatch. No config is
written without `--apply`; other required destinations and unrelated settings
are preserved. Existing placement snapshots do not change.

Select the same model reference and the OpenClaw runtime in the Gateway agent
configuration. A custom model needs matching **non-secret catalog metadata**,
not node endpoints or credentials. Follow
[model configuration and dispatch](/gateway/cloud-workers/native-inference#select-the-placement-on-the-gateway).
Worker inference errors never switch that turn to Gateway inference.

## Restart, rotate, and retire

After confirming the old node has stopped, reconnect without a new join target:

```bash
openclaw openshell worker run native-worker
```

Run only one node process per state directory. **Use a dedicated sandbox:** this
foreground command stops the entire named sandbox on exit, cancellation, or an
uncertain exec failure, and waits for OpenShell to confirm it stopped. Stopping
the local CLI alone would leave OpenShell's unary remote exec running. A cleanup
failure explicitly reports that the node may still be active; inspect and stop
it before retrying. This integration does not install a detached service. Start
the stopped sandbox through OpenShell's lifecycle before reconnecting.

OpenShell owns rotation and revocation. Static credential updates need a new node
process so its native model snapshot receives a fresh placeholder. Withdrawal
uses OpenShell's acknowledged provider-detach flow; stopping a turn does not
revoke a broker credential.

Changed model configuration is not silently written over an existing node config.
Stop the old node and deliberately prepare a new private state directory and
pairing, or reconcile its canonical configuration yourself. Never use another
application's state directory.

Reclaim active OpenClaw placements before removing profiles or deleting sandboxes.
Reclaim releases the device worker's logical lease, **not** its sandbox or pairing.
Remove the paired node through the Gateway and retire the sandbox/providers through
OpenShell when no longer needed. Failed or uncertain creation never blindly deletes
or replaces resources.

## Trust and qualification

Attachment readiness means OpenShell applied the attachment—not that an upstream
model call succeeded. Identity readback binds setup to the selected sandbox state;
dispatch still checks pairing, connection, model authorization, and capability.
Placeholder format is not cryptographic attestation. Trusted OpenShell provisioning,
endpoint/binary policy, enforced egress, and external key custody remain required.

Tests cover Node bootstrap processes and canonical config writes with synthetic
credentials and a controlled OpenShell CLI boundary. They do not qualify live Docker
or Podman deployments, TLS interception, upstream providers, or revocation. Qualify
those against your selected gateway and image before production. Sessions on one
node share its OpenShell user and outer sandbox; workspace grants are not mutual
OS isolation.
