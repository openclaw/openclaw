---
summary: "Dispatch session work to throwaway cloud machines with OpenClaw worker turns or Codex remote execution"
title: "Cloud Workers"
sidebarTitle: "Cloud Workers"
read_when: "You want agent session work to run on ephemeral cloud machines, or you are configuring cloudWorkers profiles."
status: active
doc-schema-version: 1
---

Cloud workers move a session's coding work onto a throwaway cloud machine while the session stays visible in the sidebar and its transcript remains owned by the Gateway. The bundled Crabbox provider boots the box, runs profile setup, and starts `openclaw connect --ephemeral`. For Gateway-source projects with warm images enabled, it prepares the committed checkout and node runtime for capture before enrolling the node. One configured Crabbox profile supports both OpenClaw `worker-turn` and Codex `remote-exec` over the same enrolled outbound-node transport. OpenClaw launches a restricted `openclaw worker` child; Codex runs its managed exec-server on the node while keeping app-server and model authentication on the Gateway.

Enrollment is environment-owned and replay-safe. The Gateway persists one setup identity before node enrollment, binds the first authenticated device identity to that exact environment, and reuses the durable device token when provisioning resumes. Initial enrollment and replay both enable worker hosting only for that node process; they do not change durable worker-host configuration. Reclaim or destroy releases the cloud lease and removes the environment-owned node pairing. If provisioning fails before returning a lease, cleanup resolves the original operation’s handle without rerunning provisioning, setup, or enrollment. The handle may refer to an operation that never created a machine; cleanup completes only after the provider confirms release or absence. Teardown waits for in-flight provider operations and heartbeat processes to settle. Crabbox's release request and cleanup observation have separate deadlines; OpenClaw reserves both before terminating a stalled stop command.

When the work is done (or the box dies), the machine is discarded. The transcript, accepted workspace changes, and placement records remain with the Gateway.

A cloud session can start from a GitHub repository URL and optional ref without a Gateway checkout. The selected node fetches the repository, pins the resolved commit, and creates the session branch. The Gateway keeps source metadata and immutable checkpoints of accepted changes, not a checked-out copy. Both OpenClaw and Codex support this flow on managed cloud nodes and paired nodes; providers with only an SSH carrier cannot prepare repository-only sessions. The node-host runtime must be current as well as the worker bundle: an older host cannot complete the required workspace drain and remains fenced. Update the paired node host or reprovision the cloud worker, then retry.

Sessions created from an existing Gateway checkout still retain their session-owned [managed-worktree mirror](/concepts/managed-worktrees). That flow preserves local and unpublished source content. Its default count of 100 is a cleanup target, not an admission cap, and its Gateway disk-space checks still apply.

A missing setup environment value, a current Crabbox CLI/backend refusal, or changed provider metadata does not prove that an earlier attempt allocated nothing. These failures remain retryable with the original operation identity. Cleanup resolves that operation's handle and retries teardown until the provider confirms release or absence; it never reruns provisioning, setup, or enrollment to discover the lease. Malformed immutable profiles still fail permanently; policy and setup rejections become permanent only after confirmed cleanup.

<Note>
Cloud workers are opt-in. Until you configure a profile, clients hide the Cloud destination and profile dispatch is unavailable. `sessions.dispatch` may still be advertised for eligible paired-device targets. The `cloudWorkers` config schema and the read-only `environments.list` and `environments.status` methods remain available for configuration and environment discovery.
</Note>

## What each page covers

- [Cloud worker warm images](/gateway/cloud-workers/warm-images) — capture boundaries, image reuse and refresh, retention limits, and recovering a paused capture or legacy warm-image state.
- [Per-project default profiles](/gateway/cloud-workers/per-project-default-profiles) — `cloudWorkers.projectProfiles`, and how a fixed Crabbox lease ID makes an interrupted provision replayable.
- [Worker setup and bundle installation](/gateway/cloud-workers/setup-and-bundle-installation) — the idempotent `settings.setup` contract, the Gateway-prepared runtime archive, and building a complete custom node package.
- [Verify a cloud worker profile](/gateway/cloud-workers/verify-the-profile) — config validation, the Gateway restart, Codex command enablement, and the end-to-end check before you rely on a profile.
- [Dispatching a cloud session](/gateway/cloud-workers/dispatching-a-session) — the four eligibility gates, the Control UI **Place** picker, cloud child sessions, and which runtimes support cloud placement.
- [Placement and machine selection](/gateway/cloud-workers/placement-and-machine-selection) — Codex on a paired device, either harness on a Crabbox profile, and per-session operating-system and machine-class overrides.
- [Cloud session lifecycle and durability](/gateway/cloud-workers/session-lifecycle) — what `sessions.dispatch` does, workspace reconciliation and conflicts, moves, stop and reclaim, recovery, and what survives a dead machine.
- [Cloud Worker Desktop](/gateway/cloud-workers/desktop) — the desktop lab and `settings.desktop`, what Crabbox provisions, and how the viewer reaches it without public ingress.
- [Cloud worker security model](/gateway/cloud-workers/security-model) — closed worker ingress, Gateway-owned tool authority, minted credentials, enrollment binding, and credential boundaries.
- [Cloud worker troubleshooting](/gateway/cloud-workers/troubleshooting) — symptoms and fixes for advertisement, authorization, bootstrap, enrollment, reconciliation, publication, and teardown.

## What runs where

| Concern                            | OpenClaw `worker-turn` mode                          | Codex `remote-exec` mode                                |
| ---------------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| Agent runtime and turn loop        | Cloud box (`openclaw worker`)                        | Gateway (Codex app-server)                              |
| Command, filesystem, and HTTP work | Cloud box                                            | Cloud node, paired device, or SSH-backed provider       |
| Model inference and provider auth  | Gateway, proxied by `{provider, model}` reference    | Gateway, including ChatGPT subscription or API-key auth |
| Transcript and live session state  | Gateway, fed by the worker's replayable event stream | Gateway through the normal local harness path           |
| Workspace file state               | Changed on the box; reconciled by the Gateway        | Changed remotely; reconciled by the Gateway             |

The bundled Crabbox cloud provider advertises both `worker-turn` and `remote-exec` through its enrolled node transport, so the same cloud profile is available to both harnesses. Codex can also use an explicitly authorized paired device or a provider that retains an SSH-backed remote-execution carrier. A profile that advertises only one mode remains unavailable to the other runtime.

After Crabbox setup, the cloud node dials the Gateway's public TLS endpoint over outbound WebSocket. Worker control, Codex remote execution, and workspace transfer use authenticated node or worker channels, not a Gateway-created reverse tunnel or rsync. Crabbox itself may still require SSH reachability while its CLI runs the provider-owned setup command. Outbound internet access and setup reachability follow the selected backend's network policy; configure them in Crabbox.

OpenClaw `worker-turn` sessions can open [portals](/gateway/portals) on node-backed cloud workers, including the bundled Crabbox provider. For each proxied HTTP or WebSocket connection, the enrolled node redeems a single-use ticket over a TLS-pinned WebSocket to the Gateway and connects to the worker's selected loopback port. This preserves the existing **Control UI → Portals** experience, authentication, and live reload without opening inbound worker ports or creating an SSH tunnel. The tool is available only when the node advertises portal-stream support; older node bundles do not receive it. SSH-backed `remote-exec` placements, including Codex sessions, do not run the OpenClaw worker tool loop, so the `portal` tool does not apply there. Update an unsupported node or move the session back to the Gateway with `sessions.move` when a Gateway-hosted portal is needed.

For a loopback Gateway behind public HTTPS ingress, set `gateway.publicOrigin` to the proxy's bare origin. Node enrollment uses it as the default external pairing endpoint; `plugins.entries.device-pair.config.publicUrl` remains the pairing-specific override. Cloud dispatch refuses loopback, link-local, or unspecified Gateway addresses before allocating a machine. If either URL is behind a reverse proxy, including cloudflared, nginx, or externally managed Tailscale Serve, `gateway.trustedProxies` must include the proxy's source address (typically loopback for a same-host proxy). Otherwise, forwarded client headers cause node enrollment to fail with `proxy_attribution_required`.

The proxy must also forward `/__openclaw__/worker-bootstrap/artifacts/<sha256>` to the Gateway, alongside its public node and worker routes. A new cloud node downloads its runtime over this authenticated HTTP route before it can connect over WebSocket. Preserve the `Authorization` header; do not expose these archives through an unauthenticated static-file route.

Node and SSH workspace access and reconciliation outlive worker RPC credential expiry, so an idle session can still stop, move, or suspend safely. Both retain the existing revocation and owner-epoch checks; node transfers also retain their own ten-minute expiry and session-ownership checks.

## Requirements

- A worker provider plugin. The bundled `crabbox` plugin drives the [Crabbox](https://crabbox.sh/) CLI; Crabbox owns the supported cloud backends and their configuration. Install Crabbox 0.41.1 or newer for the operating-system user that runs the Gateway and put it on that user's `PATH`, or set `settings.binary` to its absolute path. Keeping placed workers alive also requires a release that includes `crabbox heartbeat` (added after v0.43.0). Versions through 0.43.0 can allocate fixed-ID worker leases but lack heartbeat support; OpenClaw continues operating with one warning, and the coordinator may reap a placed worker after its `idleTimeout`.
- For Crabbox AWS workers, the effective `aws.instanceProfile` must be empty. The provider checks `crabbox config show --json` before allocation, then requires `crabbox inspect --json` to report `providerMetadata.instanceProfileAttached: false` from EC2 `DescribeInstances`. Leases with an instance role or without authoritative metadata are stopped and rejected. Local CLI/configuration preparation failures finish before the allocation boundary and do not leave a cleanup request for a nonexistent lease. Failures after an allocation request still retain their exact cleanup owner until Stop proves release.
- A supported Node.js release and npm on the leased machine. Bare cloud images usually lack them — install them in the profile's `setup` command. The machine also needs registry access to install the runtime's dependencies for its operating system and CPU.
- GitHub CLI (`gh`) on the worker's `PATH` for GitHub commands and HTTPS pushes. The sealed worker bundle includes the credential-binding launcher, not GitHub CLI. Crabbox developer images include `gh`; install it in `settings.setup` for other images.
- A repository session created with `repository: { url, ref? }`, or a live, registry-owned session managed worktree created with `worktree: true`. Repository sources require a managed node and access to the upstream Git repository. Cloud dispatch does not accept arbitrary plain directories. Manifest mirroring after Git metadata becomes unavailable does not make plain directories dispatchable.

### Crabbox provider support

Select a Crabbox backend with `settings.provider`. Use the [Crabbox provider reference](https://crabbox.sh/providers/index.html) for supported providers, authentication, sizing, snapshots, networking, and provider-specific limitations. OpenClaw does not maintain a separate backend catalog; accepting a profile does not establish that the backend can host a cloud session.

The installed Crabbox version and selected backend must support fixed-ID `warmup --lease-id`, POSIX script execution through `run --script-stdin` for setup and enrollment, lease inspection, and teardown by canonical lease ID. Never remove `--lease-id` to bypass a backend capability rejection: it prevents duplicate allocations after an interrupted dispatch. OpenClaw preserves unsupported-backend diagnostics; upgrading the CLI alone does not establish backend support. Heartbeat support keeps placed workers alive under the configured idle policy. Optional desktop and warm-image features have additional requirements described in [Warm images](/gateway/cloud-workers/warm-images) and [Cloud Worker Desktop](/gateway/cloud-workers/desktop).

Configure Crabbox for the operating-system user that runs the Gateway. Follow its [authentication guide](https://crabbox.sh/features/auth-admin.html) for coordinator access or the selected provider's guide for direct credentials. Keep credentials out of OpenClaw profile settings and command arguments, and preserve Crabbox's state directory across Gateway restarts so allocation and cleanup can resume safely.

Inspect the installed provider contract and check readiness without allocating a machine:

```bash
crabbox providers --json
crabbox providers describe <backend> --json
crabbox doctor --provider <backend> --json
```

Read-only readiness does not prove allocation, setup, enrollment, or cleanup. Verify the complete session flow before relying on a new profile; see [Verify the profile](/gateway/cloud-workers/verify-the-profile).

## Configuration

Manage profiles in the Control UI under **Settings → Connections → Cloud workers**, or edit `cloudWorkers.profiles` directly in `openclaw.json` — both write the same config keys. The settings page lists each profile's backend, class, lifetime, and idle-stop in plain language, and shows whether it is advertised to `environments.list` or waiting on a Gateway restart. With no profiles configured it explains the feature, links back to this page, and starts the add flow.

**Machine class** is required in the class-based editor. Enter a class accepted by the selected Crabbox backend and binary; the provider determines its effective sizing. Changing the backend or binary leaves the class unchanged, so verify that it is accepted before saving. To configure a classless profile, use **Settings → Advanced** and omit `settings.class`; **Edit** on an existing classless profile opens Advanced. OpenClaw then omits `--class` unless the placement supplies a class, leaving resource selection to Crabbox without claiming a default size. Explicit `null`, empty or whitespace strings, and nonstring class values are invalid.

The **Operating system** select sets `settings.target` using the profile's advertised operating systems. It appears when at least two systems are advertised, or when a saved target is no longer advertised so you can clear it with **Provider default**. The bundled Crabbox provider defaults to Linux and also accepts Windows (WSL2) with a compatible Crabbox binary; see [operating-system selection](/gateway/cloud-workers/placement-and-machine-selection#choose-an-operating-system-and-machine-class-per-session). New profiles without an advertised catalog show no selector. Advanced JSON preserves the same setting.

Add a profile under `cloudWorkers.profiles` in `openclaw.json`. This Debian/Ubuntu setup example preserves supported Node.js installations, installs Node.js 24 when Node is missing or unsupported (including downgrading unsupported newer APT packages), and installs GitHub CLI when missing. It rechecks Node and npm before enrollment. The current runtime requires Node.js 24.16.0 or newer on the 24.x line, or 26.1.0 or newer; Node.js 22 and 25 are unsupported.

```json
{
  "cloudWorkers": {
    "profiles": {
      "aws": {
        "provider": "crabbox",
        "install": "bundle",
        "suspendAfter": "45m",
        "settings": {
          "provider": "aws",
          "class": "standard",
          "ttl": "8h",
          "idleTimeout": "45m",
          "warmImage": true,
          "setup": "#!/usr/bin/env bash\nset -euo pipefail\nnode_supported() { command -v node >/dev/null && node -e 'const [major, minor, patch] = process.versions.node.split(\".\").map(Number); process.exit([major, minor, patch].every(Number.isInteger) && ((major === 24 && minor >= 16) || (major === 26 && minor >= 1) || major > 26) ? 0 : 1)'; }\nif ! node_supported; then\n  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -\n  sudo apt-get install -y --allow-downgrades 'nodejs=24.*'\nfi\nnode_supported || { printf '%s\\n' 'Worker setup requires a supported Node.js version; inspect PATH and the package installation above.' >&2; exit 1; }\nnpm --version\ncommand -v gh >/dev/null || { sudo apt-get update && sudo apt-get install -y gh; }"
        }
      }
    }
  }
}
```

Profile fields:

| Key                  | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `provider`           | Worker provider id registered by a plugin (`crabbox` for the bundled plugin).                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `install`            | Installation preference for SSH-backed providers. The bundled Crabbox provider bootstraps the node from the current Gateway's runtime artifact, then installs the worker bundle when needed, reusing a matching prepared-image archive or downloading it through the authenticated node channel.                                                                                                                                                                                                                                           |
| `suspendAfter`       | Optional idle duration, such as `45m`, `90m`, or `2h`; minimum `1m`. Automatically suspend an idle worker using the same safe stop as manual reclaim. The next message provisions a replacement, warm when a snapshot exists. While suspended, only retained snapshot storage is billed; omit this field to keep workers running until explicitly stopped.                                                                                                                                                                                 |
| `settings`           | Provider-owned JSON. For crabbox: `provider` (backend), `class` (machine class), `target` (operating system), `ttl`, `idleTimeout` (Go durations), optional idempotent `setup`, optional `desktop`, and absolute `binary` path. While a session remains placed, OpenClaw heartbeats its lease at a safe fraction of `idleTimeout`; teardown stops the heartbeat before releasing the machine. `desktop: true` asks Crabbox to warm the lease with its browser and loopback RFB desktop before node enrollment.                             |
| `settings.target`    | Default operating system: `linux` when omitted, or `windows/wsl2` with Crabbox 0.53.1 or newer. A placement can supply `os`; unsupported values are rejected.                                                                                                                                                                                                                                                                                                                                                                              |
| `settings.warmImage` | Optional. Captures a prepared project and node runtime before enrollment, then starts later workers for that project and profile from the image. Linux only. Enabled by default when a configured or placement class is known and `setupEnv` is empty or omitted; set `true` or `false` explicitly to override. Pair it with `suspendAfter` so suspended sessions can wake warm. Images incur provider snapshot storage charges. See [Warm images](/gateway/cloud-workers/warm-images) for capture boundaries, refresh, and prerequisites. |

## Where each section moved

Every heading this page used to publish keeps its anchor here, so an existing
link such as `/gateway/cloud-workers#bundle-installation` still resolves. Each entry points at
the page that now holds the content.

- <a id="warm-images" />[Warm images](/gateway/cloud-workers/warm-images#warm-images)
- <a id="recover-a-paused-capture" />[Recover a paused capture](/gateway/cloud-workers/warm-images#recover-a-paused-capture)
- <a id="upgrade-warm-image-state" />[Upgrade warm-image state](/gateway/cloud-workers/warm-images#upgrade-warm-image-state)
- <a id="per-project-default-profiles" />[Per-project default profiles](/gateway/cloud-workers/per-project-default-profiles#per-project-default-profiles)
- <a id="the-setup-command" />[The setup command](/gateway/cloud-workers/setup-and-bundle-installation#the-setup-command)
- <a id="bundle-installation" />[Bundle installation](/gateway/cloud-workers/setup-and-bundle-installation#bundle-installation)
- <a id="build-a-complete-custom-node-package" />[Build a complete custom node package](/gateway/cloud-workers/setup-and-bundle-installation#build-a-complete-custom-node-package)
- <a id="verify-the-profile" />[Verify the profile](/gateway/cloud-workers/verify-the-profile#verify-the-profile)
- <a id="dispatching-a-session" />[Dispatching a session](/gateway/cloud-workers/dispatching-a-session#dispatching-a-session)
- <a id="cloud-child-sessions" />[Cloud child sessions](/gateway/cloud-workers/dispatching-a-session#cloud-child-sessions)
- <a id="runtime-support" />[Runtime support](/gateway/cloud-workers/dispatching-a-session#runtime-support)
- <a id="codex-on-a-paired-device" />[Codex on a paired device](/gateway/cloud-workers/placement-and-machine-selection#codex-on-a-paired-device)
- <a id="codex-or-openclaw-on-a-cloud-profile" />[Codex or OpenClaw on a cloud profile](/gateway/cloud-workers/placement-and-machine-selection#codex-or-openclaw-on-a-cloud-profile)
- <a id="choose-a-machine-class-per-session" />[Choose a machine class per session](/gateway/cloud-workers/placement-and-machine-selection#choose-a-machine-class-per-session)
- <a id="choose-an-operating-system-and-machine-class-per-session" />[Choose an operating system and machine class per session](/gateway/cloud-workers/placement-and-machine-selection#choose-an-operating-system-and-machine-class-per-session)
- <a id="what-survives-a-dead-machine" />[What survives a dead machine](/gateway/cloud-workers/session-lifecycle#what-survives-a-dead-machine)
- <a id="desktop-(interactive)" /><a id="desktop-interactive" />[Desktop (interactive)](/gateway/cloud-workers/desktop#desktop-interactive)
- <a id="security-model" />[Security model](/gateway/cloud-workers/security-model#security-model)
- <a id="troubleshooting" />[Troubleshooting](/gateway/cloud-workers/troubleshooting#troubleshooting)

## Related

- [Sandboxing](/gateway/sandboxing) — reducing blast radius for local tool execution
- [Sessions CLI](/cli/sessions) — inspecting stored sessions
- [Configuration reference](/gateway/configuration-reference)
