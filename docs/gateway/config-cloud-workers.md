---
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

### Crabbox profile

In **Settings → Connections → Cloud workers**, the profile editor's **Advanced** group edits warm images, setup environment names, ready workers, and suspend-after duration. The page also exposes the shared **Prepared pool** cap. Clearing optional values restores their defaults; selecting **Auto** for warm images restores automatic selection. These changes require a Gateway restart. After saving a profile, the restart notice points to **Snapshots → Build snapshot**. Saving does not start a build.

Snapshot retention is plugin-wide, separate from profile settings. Configure
`plugins.entries.crabbox.config.warmImages.refreshAfter` (default `24h`, minimum
`1h`), `retainUnused` (default `14d`, minimum `1d`), and `keepPrevious` (`0` or `1`,
default `0`) in the **Snapshots → Retention policy** card or config. Durations
accept whole minutes, hours, or days. Changes require a Gateway restart. See
[Retention policy](/gateway/cloud-workers/warm-images#retention-policy) for the
complete syntax, pinned exemptions, and previous-generation behavior.

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
          ttl: "24h",
          idleTimeout: "60m",
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
- `settings.ttl` and `settings.idleTimeout` (required): positive Go duration strings passed to `--ttl` and `--idle-timeout` as provider-side failsafes.
- `settings.warmImage`: prepares a project's committed checkout and node runtime for capture before enrollment, then starts later workers for that project and profile from the image. Without a prepared Git project, capture remains at eligible worker teardown. Pair with `suspendAfter` so suspended sessions can wake warm. Enabled by default when a configured or placement class is known and `setupEnv` is empty or omitted. Without an effective class, omission stays cold. A nonempty `setupEnv` keeps the default cold because forwarded host environment could leave setup-derived credentials in a shared image. Explicit `true` opts in but requires a known effective class before provider commands; explicit `false` always stays cold. The resolved class and original cold/checkpoint choice are recorded before allocation and remain fixed through retries and restart. Images incur provider snapshot storage charges and retain machine-level caches, including pristine Git seeds, alongside whatever `setup` wrote outside scrubbed worker state. Scrubbing has a three-minute timeout. Checkpoint creation waits within Crabbox's native-capture budget plus command, source-lifecycle, and child-settlement allowances; it does not extend the configured lease TTL or idle timeout. An uncertain project capture blocks enrollment on its source but still permits lease cleanup. See [Warm images](/gateway/cloud-workers#warm-images) for refresh, retention, and Doctor migration and recovery.
- `settings.binary`: optional absolute Crabbox executable path. Without it, OpenClaw checks the sibling Crabbox checkout, then executable entries on `PATH`. The plugin requires Crabbox 0.55.0 or newer for every target. If the selected binary is missing, outdated, or cannot report a supported version, the plugin downloads the supported release into its own versioned directory under `$OPENCLAW_STATE_DIR/tools/crabbox` (by default `~/.openclaw/tools/crabbox`). It verifies the official release checksum and executable version before using the copy. Existing binaries and profile settings are preserved. Later commands reuse the managed installation without another download. Damaged managed installations are replaced automatically; the previous directory is retained beside the replacement with a `.recovery-<id>` suffix for inspection. `openclaw doctor --fix` installs the managed copy ahead of the first worker operation. An installation failure stops the operation before allocation and reports the cause.
- `readyWorkers`: non-negative integer target per eligible local project or public repository and profile; defaults to `1`. Set `0` to disable this profile's reserves while keeping warm-image reuse.
- `cloudWorkers.preparedPool.maxTotal`: non-negative integer Gateway-wide reserve cap; defaults to `4`. Preparing workers and unconfirmed cleanup count toward both limits. Set `0` to drain unused reserves and stop refill. Reserves incur running-machine charges and expire from successful project demand using the provider's existing idle policy. See [Ready workers](/gateway/cloud-workers/warm-images#ready-workers).

The supported CLI is also required to inspect and stop existing leases. On hosts with restricted release-download access or managed-tool write permissions, provision the supported executable at the exact path used by existing profiles, or stage the managed distribution before rolling out an OpenClaw update. Supported executables and installed managed copies do not need release-download access. If neither is available, acquisition must succeed before lease inspection or teardown can continue; teardown stops heartbeats before attempting acquisition.

Unknown settings are rejected. Crabbox credentials and backend-specific account configuration remain owned by Crabbox; do not place them in `settings`. OpenClaw invokes only the local CLI and makes no provider network calls from this plugin. Provisioning passes one deterministic canonical lease ID through `--lease-id`, keeps `--slug` as display metadata only, and always passes `--keep=true`; OpenClaw owns the external lifecycle and destroys the lease with `crabbox stop --id <canonical-id>`. After an ambiguous result, Gateway reconciliation repeats the same fixed-ID operation. Crabbox must return the exactly attested lease or fail closed; OpenClaw never falls back to slug adoption or replacement allocation.

Provider support and backend-specific setup belong to [Crabbox](https://crabbox.sh/providers/index.html). Configure credentials, coordinator access, networking, and snapshots there rather than duplicating them in OpenClaw settings. The installed backend must satisfy OpenClaw's [cloud-worker lifecycle requirements](/gateway/cloud-workers#crabbox-provider-support).

Crabbox setup uses an environment-owned one-use pairing credential and the configured public Gateway URL. The provider returns the exact authenticated node id; the Gateway then installs its current bundle and transfers the workspace through authenticated node routes. For Codex remote execution, Crabbox prepares the bundled Codex plugin and pinned managed binary in the node's private state, and the Gateway requires the explicitly allowed `codex.exec-server.stdio.v1` command plus critical allow-once approval for each attempt. No OpenClaw worker child or worker slot is used in that mode. OpenClaw does not persist Crabbox SSH endpoint, key, host-key, or fallback-port output.

<Note>
  AWS admission requires `providerMetadata.instanceProfileAttached` to be false.
</Note>

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
- `suspendAfter`: optional profile-level duration such as `45m`, `90m`, or `2h`; minimum `1m`. The Gateway safely reclaims the worker after its session stays idle for this long. The next message provisions a replacement, warm when an image exists. Omit this field to keep workers running until explicitly stopped.
- Bundled provider plugins are selected automatically when configured, but explicit disables and `plugins.allow` still apply. Include the provider id (for example, `crabbox`) when an allowlist is configured. External provider plugins must also be installed and explicitly enabled.
- `settings`: provider-owned bounded JSON. The selected plugin defines and validates its keys; use [SecretRef objects](/gateway/secrets) for secret-bearing values. The static SSH provider requires `host`, `user`, `hostKey`, and `keyRef`; `port` defaults to `22`. `hostKey` must be one OpenSSH public host-key line (`algorithm base64`) obtained from the known host or another trusted channel, with no options prefix.

A supported Node runtime (24.16+ or 26.1+) with WAL-reset-safe SQLite must already be installed on the worker. The opt-in `"npm"` method also requires `npm` and outbound HTTPS access to the public npm registry. Networked toolchain setup is provider policy; bootstrap reports an actionable error instead of installing toolchains itself.

Node-backed `worker-turn` launches the self-contained worker loop and proxies model inference through the Gateway. Node-backed or SSH-backed `remote-exec` keeps the model loop on the Gateway and routes sandbox operations to the remote host. Node-backed Codex accepts process, filesystem, capability, and credential-free HTTP operations; authenticated HTTP is rejected before reaching the node. Both modes reconcile the session workspace and transcript through the durable placement lifecycle. A disconnected node-backed Codex attempt is terminal; reconnect permits only a fresh attempt, never process or stream resumption.

Each durable environment record retains its validated provider settings and resolved install method in a creation-time profile snapshot. Changing or removing a named profile affects new creates; existing records continue lifecycle reconciliation with that snapshot, provided the owning plugin remains available.

Profile changes require a Gateway restart. With the default `gateway.reload.mode: "hybrid"`, the config watcher performs the restart automatically; `"off"` mode requires a manual restart.

<Warning>
  The `static-ssh` provider is a source-tree QA Lab `remote-exec` harness and is excluded from packaged distributions. A worker running on its shared host can read unrelated host data, so do not use this provider as a production isolation boundary.
  Its operator must supply the expected `hostKey`; OpenClaw will not learn or accept a key from the first connection.
  Destroying its lease only releases OpenClaw's logical record; it does not stop or clean the host.
</Warning>

---
