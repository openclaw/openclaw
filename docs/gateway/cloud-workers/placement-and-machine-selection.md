---
summary: "Codex on a paired device, either harness on a cloud profile, and per-session operating system and machine class"
title: "Placement and machine selection"
read_when: "You are choosing where a session runs, or overriding its operating system or machine size."
---

Choosing the machine a session runs on: an explicitly authorized paired device, a Crabbox cloud profile for either harness, and per-placement operating-system and machine-class overrides.

## Codex on a paired device

Paired-device Codex placement requires the `codex` plugin to be installed and
enabled in both the Gateway's configuration and the node's own local
configuration. Include `codex` in `plugins.allow` on either machine when that
machine uses a plugin allowlist. It also requires a connected session-capable
node that advertises `codex.exec-server`, and an explicit
`gateway.nodes.commands.allow` entry for `codex.exec-server.stdio.v1`. Approve
the node's updated pairing surface if needed. Before each exec-server launch,
OpenClaw also requires the normal node invocation approval; denying that
request does not start a process.

Codex launches its exec-server directly, so paired-device and cloud-node placement do not consume an OpenClaw worker slot and remain eligible when those slots are full. OpenClaw `worker-turn` placement still requires an available worker slot.

Approval permits process execution and filesystem access anywhere the node's
operating system account allows. The exact placement workspace controls the
starting directory and reconciled changes, not OS-level confinement. Trust the
paired device, and use a separate least-privilege OS account when isolation is
required.

Choose the device in the Control UI **Place** picker or dispatch a
managed-worktree session with an authorized operator connection:

```bash
openclaw gateway call sessions.dispatch \
  --params '{"key":"agent:main:device-work","deviceId":"<paired-device-id>"}'
```

The Codex app-server, model connection, provider credentials, and transcript
remain on the Gateway. The paired node runs the managed Codex exec-server in
the transferred workspace and receives only sanitized process, filesystem,
capability-discovery, and HTTP operations over the existing node channel. It
does not launch an OpenClaw worker child. Credential-bearing HTTP requests are
rejected before they reach the paired device; run authenticated requests on the
Gateway or use an intentionally credential-free endpoint. Normal Codex turns
are supported, but `/btw` side questions are not yet placement-bound and fail
visibly. Completed changes return through the same placement workspace
reconciliation as worker turns. See
[Run Codex on a paired device](/plugins/codex-harness/placement#run-codex-on-a-paired-device)
for the exact allowlist configuration and lifecycle.

## Codex or OpenClaw on a cloud profile

The same configured Crabbox profile can host either harness. Select its **Cloud · profile** row after choosing an OpenClaw or Codex model; the selected runtime determines whether provisioning prepares a worker child or the managed Codex exec-server. Codex cloud-node execution requires the same explicit Gateway command allowlist and placement-scoped approval as paired-device execution. It never falls back to Gateway-local or SSH execution if the node command is missing, denied, or disconnected.

For cloud-profile placement, the equivalent RPC flow is:

Create a repository session, dispatch it, then send its first message. Profile dispatch requires `operator.admin` and is available only while at least one worker profile is configured:

```bash
openclaw gateway call sessions.create \
  --params '{"key":"agent:main:big-refactor","repository":{"url":"https://github.com/example/project.git","ref":"main"}}'

openclaw gateway call sessions.dispatch \
  --timeout 1500000 \
  --params '{"key":"agent:main:big-refactor","profileId":"aws"}'
```

Omit `ref` to use the repository's remote default branch. A branch, tag, or commit must be fetchable from that repository. The first successful preparation pins the exact commit; later dispatches restore that commit and the accepted checkpoint even if the branch moves. Do not combine `repository` with `cwd`, `projectId`, `projectGitUrl`, `worktree`, or worktree naming options, and do not include an initial message in this create request. Sending before active placement is rejected with dispatch guidance.

To keep the existing Gateway-source flow, create with `{"worktree":true,"cwd":"/path/to/repo","worktreeName":"big-refactor"}` instead. `projectGitUrl` still means a Gateway-managed project clone.

Private repository fetches use the effective shared [`tools.github`](/gateway/config-tools#tools-github) identity. Access through the Control UI repository picker does not by itself authorize that worker identity, and personal publication credentials are never used for the checkout.

Repository setup uses the existing executable `.openclaw/worktree-setup.sh` contract on the node. It runs only when creation requested setup as an administrator and the current dispatch caller is also an administrator. An interrupted initial setup requires an administrator to retry dispatch; checkpoint restoration does not rerun setup. There is no local source from which to copy `.worktreeinclude` files.

<a id="choose-a-machine-class-per-session" />

## Choose an operating system and machine class per session

A worker profile's `settings.target` and `settings.class` remain its defaults; an omitted Crabbox target means Linux. In the Control UI, selecting a **Cloud · profile** destination in the Place picker reveals an **Operating system** section when the profile advertises at least two systems, followed by **Machine**. The machine list shows classes for the selected operating system, plus any classes that apply to every system, with reported vCPU and RAM when available and the default marked. Changing the operating system clears a selected class if it is unavailable for that system.

The place chip includes the operating system when it differs from the profile default, using `profile · OS · Machine`. To override the operating system or size for one new placement over RPC, pass `os` and/or `machineClass` with `profileId`:

```bash
openclaw gateway call sessions.dispatch \
  --timeout 1500000 \
  --params '{"key":"agent:main:big-refactor","profileId":"aws","os":"linux","machineClass":"tiny"}'
```

The bundled Crabbox provider supports Linux on every supported Crabbox version. It also advertises Windows (WSL2) when the selected backend reports `windows/wsl2` and the resolved Crabbox binary reports Crabbox 0.53.1 or newer. This gate compares the numeric major, minor, and patch components, ignoring prerelease and build metadata suffixes. For example, `0.53.1-dev`, `0.53.1`, and `0.54.0` qualify; `0.53.0` and unversioned `dev` builds do not. Older or unrecognized binaries advertise Linux only and reject WSL2 profile defaults, dispatches, and moves before allocation with an upgrade message. Restart the Gateway after upgrading the binary to refresh cached metadata. macOS and Windows normal mode are not advertised. Desktop and warm images remain Linux only. The **Operating system** section appears when a provider advertises more than one target; `environments.list` omits `operatingSystems` for a single target, and each Crabbox machine option identifies its `os`.

The provider reads `classCatalog.profiles` from `crabbox providers --json` when `classCatalog.disposition` is `mapped`. For each target it prefers amd64 entries when available; targets with only mixed or arm64 entries retain those entries. It marks the configured class as the default separately for each operating system. The catalog includes at most 64 machine options, ordered by enrollable operating system and then by catalog order. A classless profile has no invented default. Reported vCPU and RAM appear independently. RAM follows Crabbox's summary contract: positive integer GB/GiB values are shown; other units, fractional values, and missing dimensions stay unknown. Native type names are never used to guess dimensions. Unmapped, missing, unknown, failed, empty, or unusable catalog metadata produces no machine selector, even if legacy `classes` are present. The cloud profile remains selectable, and dispatch or Move without an override preserves its configuration.

Successful catalogs, including valid empty catalogs, are cached for the Gateway lifetime. Failed probes are retried by the next discovery request; a Gateway restart is not needed to recover.

Mapped Machine0 classes appear even when Crabbox omits the legacy `classes` summary. These static mappings describe class choices, not current capacity or availability. OpenClaw does not translate provider-native size catalogs into classes. Keep native size selection in Crabbox's configuration: an explicitly configured native size still takes precedence over a class, so the picker cannot override that pin or promise a resize. Acceptance of native server types through `machineClass` is backend-specific, not a universal Crabbox contract. An admitted machine choice remains fixed for that placement and is reused by provisioning retries; catalog changes do not rewrite it. `os` and `machineClass` are valid only with `profileId`, not `deviceId` or `autoDevice`. Omitting either field uses the corresponding profile default.
