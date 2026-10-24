---
doc-schema-version: 1
summary: "Cloud worker profiles under cloudWorkers, including Crabbox and static SSH development"
read_when:
  - Defining a cloud worker environment
  - Configuring the Crabbox profile
  - Setting up a static SSH development worker
title: "Configuration — cloud worker environments"
---

Cloud worker environment keys under `cloudWorkers.*`.

For the full key index and the other top-level config domains, see [Configuration reference](/gateway/configuration-reference).

## Cloud worker environments

Cloud workers are opt-in. If `cloudWorkers` is absent, or `profiles` is empty, OpenClaw accepts no new cloud-worker creation and does not advertise a Cloud destination. `sessions.dispatch` may remain available for eligible paired-device targets. The config schema and read-only `environments.list` and `environments.status` methods remain available. Durable records created earlier still reconcile and remain visible; the existing gateway/node projection is unchanged.

SSH-backed `remote-exec` providers must return a trusted `hostKey` as exactly `algorithm base64`, without a hostname or comment. Bootstrap writes that key to an isolated `known_hosts` file, uses `StrictHostKeyChecking=yes`, and fails before opening a connection when the provider omits it. There is no trust-on-first-use fallback. These providers also carry workspace traffic over separate pinned SSH connections so rsync cannot block control traffic.

Node-backed providers return an authenticated node device id for either `worker-turn` or `remote-exec`. The Gateway installs the current pinned bundle and transfers the workspace through the node transport; these leases do not return or resolve OpenClaw SSH endpoint credentials. `worker-turn` requires a node lease and launches a restricted OpenClaw worker child. `remote-exec` can use either an enrolled node or an existing SSH-backed provider and keeps the harness plus model authentication on the Gateway.

### Required worker profile

Set `cloudWorkers.requiredProfile` to a configured profile ID when a Gateway
must run every agent session on that OpenClaw worker profile. This is a server
policy, not a suggested value for the placement picker. Leave it unset to retain
optional per-session placement and Gateway-local execution.

```json5
{
  cloudWorkers: {
    requiredProfile: "dedicated-native",
    profiles: {
      "dedicated-native": {
        provider: "device",
        settings: { device: "PAIRED_DEVICE_ID", inference: "worker" },
      },
    },
  },
}
```

New Session and required first-turn recovery read the destination directive through
`agents.list` with `includeSessionPlacement: true`. That projection is available to
session-scoped writers and contains only the required profile's identity, inference
placement, and supported required execution mode—not worker inventory, machine
options, endpoint settings, or command grants. Ordinary `agents.list` replies are
unchanged. Control UI shows the required destination without a placement,
operating-system, or machine selector. Required placement uses the OpenClaw
worker-turn runtime; a provider that supports only remote-exec cannot satisfy
this policy. Ordinary session creation uses the server-owned placement
flow; users do not need permission to choose or administer cloud workers. Manual
placement administration retains its existing permissions.

The Gateway enforces the policy for API and channel turns too. It prepares a
session-owned empty workspace when no repository was selected, uses the existing
durable dispatch/recovery flow, and does not run the turn locally if placement
fails. A missing profile or disconnected worker is an actionable error, not a
fallback to Gateway inference. The Gateway can still start when the required
profile is not yet available so that an operator can enroll or repair the node.

Existing placements keep their recorded workspace and worker identity. Changing
the required profile does not silently move them. If a failed placement references
a missing environment record, repair that record before retrying: the Gateway
cannot prove its original profile and will not choose a new one automatically.
Stop and recovery retain the normal placement lifecycle; stopping a worker does not authorize local turns.
Sessionless model helpers and local CLI execution cannot bypass the policy.

This setting selects execution, not provider credentials or an OS sandbox. For
node-only credentials, configure the required profile and node as described in
[Worker-local inference](/gateway/cloud-workers/native-inference).

### Crabbox profile

Manage profiles under **Settings → Connections → Cloud environments → Advanced → Machines**. Repository defaults, snapshot actions, pool limits, and retention are described in [Cloud environments](/gateway/cloud-workers/warm-images#inspect-snapshots-in-the-control-ui). Saving settings does not start a build.

The bundled `crabbox` provider provisions a disposable machine through the local Crabbox CLI, enrolls it as an ephemeral outbound node, and returns the same node transport for OpenClaw `worker-turn` or Codex `remote-exec`. One configured profile can therefore be selected by both harnesses; the selected session runtime determines its execution semantics. The inner `settings.provider` selects the Crabbox backend; it is separate from the outer OpenClaw provider id.

```json5
{
  gateway: {
    nodes: {
      commands: {
        // Required only when this profile also runs Codex remote-exec sessions.
        allow: ["codex.exec-server.stdio.v1"],
      },
    },
  },
  cloudWorkers: {
    preparedPool: { maxTotal: 4 },
    profiles: {
      production: {
        provider: "crabbox",
        suspendAfter: "45m",
        readyWorkers: 1,
        settings: {
          provider: "aws",
          class: "standard",
          ttl: "4h",
          idleTimeout: "45m",
          // Optional preferred executable. OpenClaw manages a current copy when needed.
          binary: "/usr/local/bin/crabbox",
        },
      },
    },
  },
}
```

- `settings.provider` (required): backend from the [Crabbox provider reference](https://crabbox.sh/providers/index.html), passed through `--provider`. Direct or coordinator-backed operation follows Crabbox's configuration.
- `settings.class`: optional Crabbox machine class passed to `--class`. Omission leaves selection to Crabbox unless the placement supplies `machineClass`; OpenClaw does not invent a default or hardware size. Explicit `null`, empty or whitespace strings, and nonstring values are invalid. Edit classless profiles through **Settings → Advanced**.
- `settings.ttl` and `settings.idleTimeout` (required): positive Go duration strings passed to `--ttl` and `--idle-timeout`. TTL is total lifetime from creation, including provisioning; idle timeout is the inactivity window. The earlier deadline wins. Crabbox may clamp either request to effective policy; idle never exceeds TTL. The default maximum is `4h`, while explicit owner or organization overrides can permit longer requests, up to `24h`. OpenClaw accepts those longer configured values and uses the effective policy returned by Crabbox.
- `settings.warmImage`: Linux snapshot capture and reuse. Enabled by default when the profile or session selects a machine class, including profiles with setup secrets. Without a class, omission stays cold; explicit `true` requires a class. `false` disables capture and reuse. Repository snapshots fix their capture point before enrollment; supported nonblocking AWS uploads can finish while the session runs. Empty workspaces share runtime images captured at eligible teardown. See [Warm images](/gateway/cloud-workers/warm-images) for compatibility, refresh, storage charges, and recovery.
- `settings.setup`: optional, repeatable machine setup command for the profile's `settings.target` (Linux when omitted). Profiles with setup cannot override the OS between native Windows (PowerShell) and POSIX targets; incompatible OS and machine choices are omitted. Configure a separate profile with compatible setup for the other interpreter. Snapshot forks reuse its filesystem results. Repository lifecycle commands belong in the [environment file](/gateway/cloud-workers/environment-file).
- `settings.setupSecrets`: operator-approved environment-name to protected store SecretRef map; see [Setup secrets](/gateway/config-cloud-workers#setup-secrets).
- `settings.binary`: optional absolute Crabbox executable path. OpenClaw requires Crabbox 0.77.0 or newer for every target and checks the sibling Crabbox checkout and `PATH` when the path is omitted. If the selected binary is missing or unsupported, it installs a checksum- and version-verified managed release under `$OPENCLAW_STATE_DIR/tools/crabbox` (default `~/.openclaw/tools/crabbox`), preserving existing binaries and settings. Later operations reuse it; damaged managed copies are replaced with the old directory retained for recovery. `openclaw doctor --fix` can install it before the first worker or configured sandbox operation. Read-only profile suggestions never install a CLI. Installation failure stops before allocation and reports the cause.
- `readyWorkers`: non-negative integer target per eligible local project or repository and profile; defaults to `1`. Empty committed workspaces share a separate runtime-only target per provider and profile, replenished after successful activation. The first empty session provisions normally; browser presence alone does not warm empty workspaces. Set `0` to disable this profile's reserves while keeping warm-image reuse.
- `cloudWorkers.preparedPool.maxTotal`: non-negative integer Gateway-wide reserve cap; defaults to `4`. Preparing workers and unconfirmed cleanup count toward both limits. Set `0` to drain unused reserves and stop refill. Reserves incur running-machine charges and expire from successful session activation or explicit build demand using the provider's existing idle policy. See [Ready workers](/gateway/cloud-workers/warm-images#ready-workers).

When a cloud-worker profile explicitly sets `settings.binary` and its version probe is rejected, OpenClaw warns once per configured path during the provider's lifetime. The warning names the configured path, the outdated version and required minimum or a bounded probe-failure reason, and the managed executable used instead. Implicit binary discovery and supported configured executables do not produce this warning.

Errors inspecting an installed managed executable stop acquisition rather than treating it as missing. Fix the reported filesystem error and retry; no replacement is downloaded for that inspection failure.

Managed release archives stream into private staging files, bounded to 128 MiB, before checksum verification and extraction. The managed installation retains the complete extracted distribution, including companion runtime files used by commands such as egress. Download progress has a 30-second idle limit and a separate ten-minute total limit; failed downloads are cleaned up before acquisition returns.

The supported CLI is also required to inspect and stop existing leases. On hosts with restricted release-download access or managed-tool write permissions, provision the supported executable at the exact path used by existing profiles, or stage the managed distribution before rolling out an OpenClaw update. Supported executables and installed managed copies do not need release-download access. If neither is available, acquisition must succeed before lease inspection or teardown can continue; actual release stops heartbeats before attempting acquisition. An admitted source-dependent capture retains its heartbeat while the provider still requires the source.

Unknown settings are rejected. Backend credentials, coordinator access, networking, and provider-specific snapshot support remain configured in [Crabbox](https://crabbox.sh/providers/index.html), rather than OpenClaw settings. Keep Crabbox's state across Gateway restarts. Provisioning retries use one fixed lease ID; never bypass a fixed-ID capability error by allocating a replacement manually. See [provider requirements](/gateway/cloud-workers#crabbox-provider-support).

Cloud-worker discovery and lifecycle commands run from the Gateway user's home directory, so a `crabbox.yaml` in the Gateway's repository working directory does not override Crabbox's global configuration. Project-scoped sandbox commands retain their explicit workspace directory.

`--keep=true` delegates normal end-of-command cleanup to OpenClaw; it does not make a lease persistent or exempt it from expiry or direct cleanup. Plain heartbeats refresh idle time only. OpenClaw schedules them from the effective idle timeout and reports sanitized policy notices, including notices on successful commands. Total TTL still ends the session: save and reconcile work before that deadline, then use the normal stop, suspend, and new-allocation lifecycle. OpenClaw does not silently create an endless chain of replacement leases.

The coordinator defaults to a 30-minute TTL and idle timeout when no values are requested. Its effective owner or organization policy can shorten live leases on inspection or heartbeat. Extensions require owner authority, policy permission, and budget. Before source-dependent image capture, OpenClaw requests a bounded total TTL only when the remaining lifetime is insufficient and the provider supports runtime extension; a denied extension skips optional capture visibly or fails required preparation. Creation-fixed providers such as Daytona need enough TTL at creation. See [capture lifetime](/gateway/cloud-workers/warm-images#capture-lifetime).

Crabbox also owns whether direct leases are permitted. Its trusted `directLeases: deny` configuration blocks remote direct allocation unless the selected provider is explicitly permitted by `directLeaseAllow`. Repository configuration cannot relax that policy. Use the configured coordinator path when direct allocation is denied; do not switch credentials to bypass it.

Codex remote-exec requires `codex.exec-server.stdio.v1` in the node-command allowlist and critical invocation approval. AWS admission requires authoritative `providerMetadata.instanceProfileAttached: false`; workers with an instance role are rejected.

#### Crabbox machine catalog

Per-session machine options come from Crabbox's mapped catalog, with CPU and RAM shown when known. A missing or unusable catalog hides the machine selector while leaving the profile selectable. A classless profile has no invented default. See [machine selection](/gateway/cloud-workers/placement-and-machine-selection#choose-an-operating-system-and-machine-class-per-session).

### Setup secrets

Map up to 16 POSIX environment names to protected shared-store SecretRefs:

```json5
{
  cloudWorkers: {
    profiles: {
      cloud: {
        provider: "crabbox",
        settings: {
          provider: "aws",
          class: "standard",
          ttl: "4h",
          idleTimeout: "45m",
          setupSecrets: {
            NPM_TOKEN: { source: "store", provider: "default", id: "NPM_TOKEN" },
          },
        },
      },
    },
  },
}
```

Each selected entry must exist in the protected shared store with explicit `allowed_hosts`. Inline values and `env`, `file`, or `exec` references are rejected. Runner variables, proxy/CA variables, and `OPENCLAW_*` names are reserved. The repository's [devcontainer `secrets` requests](/gateway/cloud-workers/environment-file#setup-secrets) must map to these approved names; repository metadata does not grant access.

Profile setup and repository lifecycle commands run through Crabbox native egress on a coordinator-owned Linux lease. Ordinary public downloads remain available. Commands receive opaque placeholders and temporary CA trust; the Gateway substitutes each secret only at its bound HTTPS hosts. HTTPS clients must honor the supplied proxy and CA settings; plain HTTP downloads go directly and cannot receive substituted secrets. Secret values stay on the Gateway, but a service can reflect credentials in its response, so bind only trusted hosts. Access ends when the command settles or is canceled; detached processes cannot keep it. Missing entries, bindings, or egress support fail visibly with a repair instruction and no plaintext fallback. Protected repository preparation also requires a known machine class, even with snapshots disabled.

Setup secrets do not disable snapshots. Names and store references affect compatibility; values and temporary placeholders do not. For storing credentials and binding destinations, see [job-scoped setup grants](/gateway/secrets/secret-store-and-egress#job-scoped-setup-grants).

`settings.setupEnv` is retired. Run `openclaw doctor --fix` to migrate existing profiles to same-name protected store entries. Doctor requires explicit destination bindings and compatible existing mappings; missing entries or conflicts leave the profile unchanged with repair guidance. It never creates secret values or infers destinations. Complete the repair before provisioning.

### Static SSH development profile

```json5
{
  cloudWorkers: {
    profiles: {
      development: {
        provider: "static-ssh",
        settings: {
          host: "worker.example.test",
          port: 22,
          user: "openclaw",
          hostKey: "ssh-ed25519 <base64-public-host-key>",
          keyRef: {
            source: "env",
            provider: "default",
            id: "OPENCLAW_WORKER_SSH_KEY",
          },
        },
      },
    },
  },
}
```

- `profiles`: named worker profiles with non-empty, whitespace-trimmed ids. Each profile selects a provider registered by a plugin.
- `provider`: non-empty worker provider id. The examples use the bundled `crabbox` provider and the QA Lab `static-ssh` provider.
- `install`: SSH-backed `remote-exec` worker installation method. `"bundle"` (default) transfers a content-hashed bundle of the gateway's installed build and supports released, development, and unreleased versions. `"npm"` is an opt-in optimization for an unmodified packaged release; it installs `openclaw@<exact gateway version>` from the public npm registry and never installs `latest`. Node-backed `worker-turn` and `remote-exec` providers install the pinned Gateway bundle through node transport instead.
- `suspendAfter`: optional profile-level duration such as `45m`, `90m`, or `2h`; minimum `1m`. The Gateway safely reclaims the worker after its session stays idle for this long. The next message provisions a replacement, warm when an image exists. Omit this field to disable automatic idle suspension; Crabbox lifetime limits still apply.
- Bundled provider plugins are selected automatically when configured, but explicit disables and `plugins.allow` still apply. Include the provider id (for example, `crabbox`) when an allowlist is configured. External provider plugins must also be installed and explicitly enabled.
- `settings`: provider-owned bounded JSON. The selected plugin defines and validates its keys; use [SecretRef objects](/gateway/secrets) for secret-bearing values. The static SSH provider requires `host`, `user`, `hostKey`, and `keyRef`; `port` defaults to `22`. `hostKey` must be one OpenSSH public host-key line (`algorithm base64`) obtained from the known host or another trusted channel, with no options prefix.

A supported Node runtime (24.16+ or 26.1+) with WAL-reset-safe SQLite must already be installed on the worker. The opt-in `"npm"` method also requires `npm` and outbound HTTPS access to the public npm registry. Networked toolchain setup is provider policy; bootstrap reports an actionable error instead of installing toolchains itself.

Node-backed `worker-turn` launches the self-contained worker loop and proxies model inference through the Gateway by default. A device-provider profile with `settings.inference: "worker"` instead uses [worker-local native inference](/gateway/cloud-workers/native-inference) and node-local provider credentials. Node-backed or SSH-backed `remote-exec` keeps the model loop on the Gateway and routes sandbox operations to the remote host. Node-backed Codex accepts process, filesystem, capability, and credential-free HTTP operations; authenticated HTTP is rejected before reaching the node. Both modes reconcile the session workspace and transcript through the durable placement lifecycle. A disconnected node-backed Codex attempt is terminal; reconnect permits only a fresh attempt, never process or stream resumption.

Each durable environment record retains its validated provider settings and resolved install method in a creation-time profile snapshot. Changing or removing a named profile affects new creates; existing records continue lifecycle reconciliation with that snapshot, provided the owning plugin remains available.

With the default `gateway.reload.mode: "hybrid"`, profile and pool changes apply
without restarting the Gateway. New allocations use the updated profile; existing
allocations keep their admitted provider settings. Unused reserves are checked
against the current profile and pool limits, and incompatible or excess workers
retire after their provider work settles. Suspend-after changes apply to existing
idle sessions before their next automatic drain. With reload mode `"off"`, restart
the Gateway to load configuration changes.

<Warning>
  The `static-ssh` provider is a source-tree QA Lab `remote-exec` harness and is excluded from packaged distributions. A worker running on its shared host can read unrelated host data, so do not use this provider as a production isolation boundary.
  Its operator must supply the expected `hostKey`; OpenClaw will not learn or accept a key from the first connection.
  Destroying its lease only releases OpenClaw's logical record; it does not stop or clean the host.
</Warning>

---
