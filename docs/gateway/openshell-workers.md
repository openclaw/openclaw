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

## Prerequisites

- OpenShell **v0.1.3 or newer**, configured for the OS user running OpenClaw.
- Compatible OpenClaw Gateway and node builds supporting native worker inference,
  required profiles, and `connect --target-file`.
- An OpenShell source image with Node, OpenClaw, and `sleep`. The image owns
  these installations; the plugin does not download an unpinned node runtime.
- An imported OpenShell provider profile allowing the **actual Node executable**
  in your image, the intended provider endpoint, TLS inspection, and credential
  substitution. A curl- or Codex-only binary list is insufficient.
- A sandbox policy permitting the node's outbound Gateway connection, DNS/TLS,
  workspace writes, and a private node-state directory.

OpenShell v0.1.3 uses the **real provider endpoint and model**, not the removed
workspace inference route or `inference.local`. Follow its
[inference contract](https://github.com/NVIDIA/OpenShell/blob/v0.1.3/docs/how-it-works/inference.mdx)
and adapt the [OpenAI profile example](https://github.com/NVIDIA/OpenShell/blob/v0.1.3/providers/openai.yaml)
to your image before importing it. For a prepared profile with ID `openai`:

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
openclaw openshell worker configure native-worker --profile openshell-native --required
openclaw openshell worker configure native-worker --profile openshell-native --required --apply
```

`configure` uses the read-only `openclaw node identity --json` inside the
configured sandbox state directory. Optional `--device <id>` asserts an expected
identity and rejects a mismatch. The canonical config writer saves the existing
`provider: "device"` and `settings.inference: "worker"` profile. No new pairing
owner or inference transport is introduced; conflicting profiles are not replaced.

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
