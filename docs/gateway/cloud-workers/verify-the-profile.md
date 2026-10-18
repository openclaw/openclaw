---
summary: "Validate config, confirm the profile is advertised, and prove a new cloud worker profile end to end"
title: "Verify a cloud worker profile"
read_when: "You added or changed a cloud worker profile and want to prove it works before relying on it."
---

The checks to run after saving a profile change, and the end-to-end flow that read-only readiness checks do not substitute for.

## Verify the profile

After saving the change, validate the saved config and the provider runtime:

```bash
openclaw config validate --json
openclaw plugins inspect crabbox --runtime --json
```

Changes under `cloudWorkers` apply without restarting the Gateway: the default `gateway.reload.mode: "hybrid"` watches the config and reloads the worker provider plugins in place. With `gateway.reload.mode: "off"`, saves through the Control UI or other Gateway config writes restart the Gateway to apply them, while direct file edits wait for a manual `openclaw gateway restart`. Profile changes apply to newly provisioned workers; running workers keep their admitted provisioning settings (see [hot reload](/gateway/configuration/hot-reload)).

To use the same profile with Codex, enable a trusted Codex plugin installation on the Gateway and explicitly add `codex.exec-server.stdio.v1` to `gateway.nodes.commands.allow`. Bootstrap includes and enables the required plugin in the cloud node's isolated state automatically. Installing the runtime does not grant execution authority: persistent command enablement does not replace the critical launch approval. **Allow once** covers one exec-server launch; **Allow always** covers later launches only while the exact placement, node pairing, environment owner, command approval scope, and workspace stay current.

After the change is applied, prove the profile is advertised and compare it with Crabbox's read-only lease inventory:

```bash
openclaw gateway call environments.list --params '{}'
crabbox list --provider aws --json
```

The `environments.list` response must include the configured id under `profiles`. `crabbox list` is non-mutating. By contrast, `crabbox warmup` provisions a lease, and `crabbox stop` or `crabbox release` tears one down; use those mutating commands only when you intend to create or destroy cloud resources.

Before relying on a new profile, authorize provider spend and test allocation, setup, node enrollment, a turn in the selected runtime, and a workspace edit reconciled back to the Gateway. Test cancellation and interrupted-dispatch replay against the same lease, then stop the session and verify teardown using Crabbox's provider-specific cleanup contract. Read-only readiness checks and mocked tests are not substitutes for this end-to-end verification.
