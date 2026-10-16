---
summary: "Dispatch session work to throwaway cloud machines with OpenClaw worker turns or Codex remote execution"
title: "Cloud Workers"
sidebarTitle: "Cloud Workers"
read_when: "You want agent session work to run on ephemeral cloud machines, or you are configuring cloudWorkers profiles."
status: active
doc-schema-version: 1
---

Cloud workers run a session's coding work on a disposable machine while its transcript and accepted workspace changes stay with the Gateway. With Crabbox configured on the Gateway host, OpenClaw can select a machine, prepare the repository, and save a snapshot without a custom setup script.

## Quick start

Open **New Session**, select a repository or **New workspace**, and choose **Cloud**. If no cloud profile exists, OpenClaw can suggest one from your configured Crabbox backend and save it when you select it. Viewing the suggestion does not install a CLI, save configuration, or allocate a machine. Saving requires administrator access; existing profiles take precedence.

The suggested `cloud` profile uses Linux, the smallest advertised standard class, a 4-hour total lifetime, and 45-minute idle timeout and suspend. Warm images are enabled. Edit it later in **Settings → Connections → Cloud environments**. If config reload is disabled, saving schedules a Gateway restart; wait for the profile to become active and retry selection.

### First session

For an eligible Linux repository, the first session provisions its own machine, prepares the selected commit and dependencies, installs the OpenClaw runtime, and starts snapshot capture before enrolling the node. The startup line shows **Preparing cloud environment…**, then **Saving snapshot…**. On supported AWS workers, upload can finish while the session runs; later sessions reuse the snapshot once available. See [first-capture requirements](/gateway/cloud-workers/warm-images#first-session-for-a-repository).

A repository-only GitHub session needs no Gateway checkout. A session started from a Gateway checkout preserves local and unpublished content through its [managed worktree](/concepts/managed-worktrees), applying session changes after capture. **New workspace** starts empty and uses shared runtime images instead of a repository snapshot.

### Later sessions

A later session adopts a matching ready worker or forks a compatible snapshot. Forks refresh the checkout and top up the current runtime before enrollment. Runtime updates alone do not invalidate repository snapshots; changed setup recipes or machine settings can require a cold build. [Warm images](/gateway/cloud-workers/warm-images) explains reuse, refresh, reserves, storage charges, and recovery.

### Customize preparation and startup

Commit [`.devcontainer/devcontainer.json`](/gateway/cloud-workers/environment-file) for repository setup and per-start commands. OpenClaw runs a host-mode subset: `onCreateCommand` and `updateContentCommand` prepare the snapshot; `postCreateCommand` and `postStartCommand` run after session binding. Without a devcontainer file, it uses an executable `.openclaw/worktree-setup.sh`, then JavaScript lockfile detection.

Linux x64 and arm64 workers receive a verified Node toolchain when needed, and the runtime comes from the running Gateway. No global OpenClaw installation or package URL is needed in your profile. Use optional `settings.setup` for additional machine prerequisites; see [Setup and bundle installation](/gateway/cloud-workers/setup-and-bundle-installation).

For private dependencies, configure [setup secrets](/gateway/config-cloud-workers#setup-secrets). Commands receive opaque placeholders; protected egress substitutes credentials at approved HTTPS destinations. Secrets do not disable snapshots.

## Configuration

**Settings → Connections → Cloud environments** groups snapshots, setup results, and prepared workers by repository. Select a repository to inspect it or use **Machine → Change** to choose its default profile. The page updates after the worker plugin activates, including after saving the first suggested profile.

Expand **Advanced** to manage **Machines**, inspect the **Pool**, change **Snapshot retention**, or inspect **Machine images** without a repository. See [the page's actions](/gateway/cloud-workers/warm-images#inspect-snapshots-in-the-control-ui), [per-repository defaults](/gateway/cloud-workers/per-project-default-profiles), and the [cloud worker configuration reference](/gateway/config-cloud-workers) for profile fields and examples.

Saved settings apply without restarting the Gateway under the default reload policy. With `gateway.reload.mode: "off"`, saving from this page restarts the Gateway; direct config edits require a manual restart. Saving machine settings does not start a build; **Rebuild** prepares an eligible recorded local project.

## What each page covers

- [Cloud worker warm images](/gateway/cloud-workers/warm-images) — capture boundaries, image reuse and refresh, snapshot pinning, deletion and rollback, retention policy, and recovering a paused capture or legacy warm-image state.
- [Per-project default profiles](/gateway/cloud-workers/per-project-default-profiles) — `cloudWorkers.projectProfiles`, and how a fixed Crabbox lease ID makes an interrupted provision replayable.
- [Worker setup and bundle installation](/gateway/cloud-workers/setup-and-bundle-installation) — the `settings.setup` contract for commands safe to repeat, the Gateway-prepared runtime archive, and building a complete custom node package.
- [Verify a cloud worker profile](/gateway/cloud-workers/verify-the-profile) — config validation, applying the change, Codex command enablement, and the end-to-end check before you rely on a profile.
- [Dispatching a cloud session](/gateway/cloud-workers/dispatching-a-session) — eligibility gates, fresh workspaces and repository selection, cloud child sessions, and which runtimes support cloud placement.
- [Placement and machine selection](/gateway/cloud-workers/placement-and-machine-selection) — Codex on a paired device, either harness on a Crabbox profile, and per-session operating-system and machine-class overrides.
- [Cloud session lifecycle and durability](/gateway/cloud-workers/session-lifecycle) — what `sessions.dispatch` does, workspace reconciliation and conflicts, moves, stop and reclaim, recovery, and what survives a dead machine.
- [Cloud Worker Desktop](/gateway/cloud-workers/desktop) — the desktop lab and `settings.desktop`, what Crabbox provisions, and how the viewer reaches it without public ingress.
- [Cloud worker security model](/gateway/cloud-workers/security-model) — closed worker ingress, Gateway-owned tool authority, minted credentials, enrollment binding, and credential boundaries.
- [Cloud worker troubleshooting](/gateway/cloud-workers/troubleshooting) — symptoms and fixes for advertisement, authorization, bootstrap, enrollment, reconciliation, publication, and teardown.

## What runs where

| Concern                            | OpenClaw `worker-turn` mode                          | Codex `remote-exec` mode                                |
| ---------------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| Agent runtime and turn loop        | Cloud box (`openclaw worker`)                        | Gateway (Codex app-server)                              |
| Shell commands and workspace files | Cloud box                                            | Cloud node, paired device, or SSH-backed provider       |
| Model inference and provider auth  | Gateway, proxied by `{provider, model}` reference    | Gateway, including ChatGPT subscription or API-key auth |
| Transcript and live session state  | Gateway, fed by the worker's replayable event stream | Gateway through the normal local harness path           |
| Workspace file state               | Changed on the box; reconciled by the Gateway        | Changed remotely; reconciled by the Gateway             |

OpenClaw tools for web search, web fetch, memory, and messaging execute on the
Gateway under the session's prepared policy and live authority. HTTP requests
made by commands or applications still execute at their placement.

Applications that make their own model API calls need a separate credential
route. For an exclusively owned coordinator-backed Linux lease, use
[`openclaw crabbox run`](/gateway/secrets/secret-store-and-egress#model-credentials-for-crabbox-commands)
to keep the configured API key on the host while the application uses a protected
egress bridge.

The bundled Crabbox cloud provider advertises both `worker-turn` and `remote-exec` through its enrolled node transport, so the same cloud profile is available to both harnesses. Codex can also use an explicitly authorized paired device or a provider that retains an SSH-backed remote-execution carrier. A profile that advertises only one mode remains unavailable to the other runtime.

After Crabbox setup, the cloud node dials the Gateway's public TLS endpoint over outbound WebSocket. Worker control, Codex remote execution, and workspace transfer use authenticated node or worker channels, not a Gateway-created reverse tunnel or rsync. Crabbox itself may still require SSH reachability while its CLI runs the provider-owned setup command. Outbound internet access and setup reachability follow the selected backend's network policy; configure them in Crabbox.

OpenClaw `worker-turn` sessions can open [portals](/gateway/portals) on node-backed cloud workers, including the bundled Crabbox provider. For each proxied HTTP or WebSocket connection, the enrolled node redeems a single-use ticket over a TLS-pinned WebSocket to the Gateway and connects to the worker's selected loopback port. This preserves the existing **Control UI → Portals** experience, authentication, and live reload without opening inbound worker ports or creating an SSH tunnel. The tool is available only when the node advertises portal-stream support; older node bundles do not receive it. SSH-backed `remote-exec` placements, including Codex sessions, do not run the OpenClaw worker tool loop, so the `portal` tool does not apply there. Update an unsupported node or move the session back to the Gateway with `sessions.move` when a Gateway-hosted portal is needed.

For a loopback Gateway behind public HTTPS ingress, set `gateway.publicOrigin` to the proxy's bare origin. Cloud node enrollment explicitly asks the shared pairing resolver to prefer public ingress: `plugins.entries.device-pair.config.publicUrl` wins, then `gateway.publicOrigin`, then the existing remote/Tailscale/bind discovery. This preserves cloud enrollment behavior and avoids directing a fresh worker to a private LAN or tailnet address when a public origin is configured. Callers targeting the local Gateway omit the remote URL. HTTP(S) URLs become matching `ws:`/`wss:` pairing endpoints.

Device join codes, `/pair`, and `openclaw qr` use the same resolver's default intent, preserving their advertised addresses: pairing override, preferred remote URL, Tailscale Serve/Funnel, non-preferred remote URL, then bind-derived addresses. They use `gateway.publicOrigin` only as the final fallback before the loopback-only error, so adding a public origin does not change an existing device pairing route.

Cloud dispatch refuses loopback, link-local, or unspecified Gateway addresses before allocating a machine. If either public URL is behind a reverse proxy, including cloudflared, nginx, or externally managed Tailscale Serve, `gateway.trustedProxies` must include the proxy's source address (typically loopback for a same-host proxy). Otherwise, forwarded client headers cause node enrollment to fail with `proxy_attribution_required`.

The proxy must also forward `/__openclaw__/worker-bootstrap/artifacts/<sha256>` to the Gateway, alongside its public node and worker routes. A new cloud node downloads its runtime over this authenticated HTTP route before it can connect over WebSocket. Preserve the `Authorization` header; do not expose these archives through an unauthenticated static-file route.

Node and SSH workspace access and reconciliation outlive worker RPC credential expiry, so an idle session can still stop, move, or suspend safely. Both retain the existing revocation and owner-epoch checks; node transfers also retain their own ten-minute expiry and session-ownership checks.

## Requirements

- A worker provider plugin. The bundled `crabbox` plugin drives the [Crabbox](https://crabbox.sh/) CLI; Crabbox owns the supported cloud backends and their configuration. The plugin automatically prepares its supported CLI for the Gateway user, keeping the managed distribution separate from operator-installed binaries. It can also use a supported executable from `PATH` or `settings.binary`. Crabbox 0.77.0 or newer is required. See [Crabbox configuration](/gateway/config-cloud-workers#crabbox-profile) for managed CLI installation and restricted-host upgrades.
- For Crabbox AWS workers, the effective `aws.instanceProfile` must be empty. The provider checks `crabbox config show --json` before allocation, then requires `crabbox inspect --json` to report `providerMetadata.instanceProfileAttached: false` from EC2 `DescribeInstances`. Leases with an instance role or without authoritative metadata are stopped and rejected. Local CLI/configuration preparation failures finish before the allocation boundary and do not leave a cleanup request for a nonexistent lease. Failures after an allocation request still retain their exact cleanup owner until Stop proves release.
- On Linux x64/arm64, OpenClaw installs a verified official Node.js toolchain automatically when needed; the image must provide compatible glibc, `curl`, `tar`, and `sha256sum`, with HTTPS access to nodejs.org. macOS and Windows require supported Node.js and npm supplied by the image or optional profile `setup`. Native Windows requires them on the machine `PATH`. Headless Windows workers also require Crabbox's managed detached-process launcher; see [Windows prerequisites](/gateway/cloud-workers/setup-and-bundle-installation#native-windows-prerequisites). The machine also needs registry access to install the runtime's dependencies for its operating system and CPU.
- GitHub CLI (`gh`) on the worker's `PATH` for GitHub commands and HTTPS pushes. The sealed worker bundle includes the credential-binding launcher, not GitHub CLI. Crabbox developer images include `gh`; install it in `settings.setup` for other images.
- A repository session created with `repository: { url, ref? }`, or a live, registry-owned session managed worktree created with `worktree: true`. Add `worktreeSource: "empty"` to create a fresh workspace without a user repository. Repository sources require a managed node and access to the upstream Git repository. Arbitrary plain Gateway folders are not copied or dispatched; choose a fresh workspace instead.

<a id="coordinator-backed-crabbox" />

### Crabbox provider support

A fresh allocation that exits with the exact `provider=<backend> does not support fixed idempotent lease IDs` capability refusal fails permanently without scheduling cleanup for a nonexistent lease. Choose a backend with fixed lease ID support. The same refusal during replay cannot disprove an earlier allocation, so its cleanup responsibility remains until release or absence is confirmed.

Select a Crabbox backend with `settings.provider`. Use the [Crabbox provider reference](https://crabbox.sh/providers/index.html) for supported providers, authentication, sizing, snapshots, networking, and provider-specific limitations. OpenClaw does not maintain a separate backend catalog; accepting a profile does not establish that the backend can host a cloud session.

The installed Crabbox version and selected backend must support fixed-ID `warmup --lease-id`, target-native script execution through `run --script-stdin` for setup and enrollment, lease inspection, and teardown by the assigned lease ID. Scripts use PowerShell on native Windows and a POSIX shell on Linux, macOS, and Windows (WSL2). Never remove `--lease-id` to bypass a backend capability rejection: it prevents duplicate allocations after an interrupted dispatch. OpenClaw preserves unsupported-backend diagnostics; upgrading the CLI alone does not establish backend support. Heartbeat support refreshes the effective idle window; it does not extend total lifetime. Optional desktop and warm-image features have additional requirements described in [Warm images](/gateway/cloud-workers/warm-images) and [Cloud Worker Desktop](/gateway/cloud-workers/desktop).

Crabbox advertises Linux, Windows (WSL2), Windows, and macOS when the selected backend supports them. The plugin prepares the supported CLI before reading the backend catalog. Windows means native Windows (`windows/normal`), with PowerShell setup commands. Desktop supports Linux, native Windows, and prepared macOS images; WSL2 desktops are unsupported. Warm images remain Linux only. See [desktop prerequisites](/gateway/cloud-workers/desktop). AWS macOS workers require an available EC2 Mac Dedicated Host and use On-Demand allocation. For a pinned Dedicated Host, provide the host pin and required coordinator admin authentication through Crabbox environment or configuration on the Gateway host. Never put broker credentials in OpenClaw profile settings. See [operating-system selection](/gateway/cloud-workers/placement-and-machine-selection#choose-an-operating-system-and-machine-class-per-session) for per-session overrides.

Configure Crabbox for the operating-system user that runs the Gateway. Follow its [authentication guide](https://crabbox.sh/features/auth-admin.html) for coordinator access or the selected provider's guide for direct credentials. Keep credentials out of OpenClaw profile settings and command arguments, and preserve Crabbox's state directory across Gateway restarts so allocation and cleanup can resume safely.

Inspect the installed provider contract and check readiness without allocating a machine:

```bash
crabbox providers --json
crabbox providers describe <backend> --json
crabbox doctor --provider <backend> --json
```

Read-only readiness does not prove allocation, setup, enrollment, or cleanup. Verify the complete session flow before relying on a new profile; see [Verify the profile](/gateway/cloud-workers/verify-the-profile).

### Lease lifetime

A worker's TTL counts from creation, including provisioning. Its idle timeout counts inactivity, and the earlier deadline ends the lease. The suggested `4h` / `45m` profile fits Crabbox's default four-hour maximum. Owner or organization policy can allow a longer TTL (up to 24 hours), deny extensions, or clamp a requested duration; policy tightening also applies to live leases. OpenClaw uses the effective policy and surfaces sanitized clamp notices. See [Crabbox configuration](/gateway/config-cloud-workers#crabbox-profile).

`keep` preserves a machine after a command; it does not prevent expiry. Plain heartbeats and desktop activity do not renew total TTL. Crabbox `run` can request bounded automatic extension only while a command executes and only within policy and budget. Long sessions must save and reconcile work before expiry and use the normal stop or suspend lifecycle. Creation-fixed providers such as Daytona require sufficient TTL at allocation. [Warm-image capture](/gateway/cloud-workers/warm-images#capture-lifetime) checks its source's remaining lifetime separately.

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

- [Sandboxing](/gateway/sandboxing) — limiting the damage local tools can cause
- [Sessions CLI](/cli/sessions) — inspecting stored sessions
- [Configuration reference](/gateway/configuration-reference)
- [`openclaw worker`](/cli/worker) — the restricted runtime entry point a Gateway-owned launcher starts inside a prepared worker environment
- [Gateway RPC methods](/gateway/protocol/rpc-methods) — RPC method families, discovery, and event families
- [Operator scopes](/gateway/operator-scopes) — the scopes these worker calls are authorized against
