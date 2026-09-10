---
summary: "Enable worker session hosting on a paired node, choose a device, and isolate workers in containers"
read_when:
  - Enabling isolated OpenClaw session hosting on a paired node
  - Choosing a device or Auto placement in New Session
  - Isolating hosted worker sessions in containers
title: "Host OpenClaw sessions on a node"
sidebarTitle: "Session hosting"
---

## Host OpenClaw sessions

The macOS menu bar app and the headless node host can opt into full OpenClaw
session hosting with the same node-local setting:

```json5
{
  nodeHost: {
    workerRuns: { enabled: true },
  },
}
```

<Warning>
Only enable session hosting on a machine you trust as shared Gateway infrastructure. Hosting consent applies to the device, not to an individual person's ownership of it. Existing session authorization still controls who may dispatch work.
</Warning>

Restart the app or node host after enabling this setting. The macOS app owns
one paired node identity and uses the shared node runtime for session hosting;
do not start a second CLI node for the same Mac. Its native camera, screen, and
desktop capabilities remain on that identity. If the shared runtime cannot
start, native capabilities remain available, but session hosting is unavailable.

When a session first needs the current worker build, the Gateway sends its sealed
worker artifact to the paired host. The node verifies the exact content hash,
publishes the artifact atomically, and prewarms it when supported by the execution mode.
The artifact contains its complete JavaScript dependency closure; the node does
not install packages or execute lifecycle scripts. Installation belongs to the
session request and receives its cancellation signal. Reconnect maintenance does
not install or prewarm a worker build.

Once installed, persistent nodes retain one current worker artifact per Gateway
namespace, even with no sessions. Older builds remain only while a live or
recoverable placement needs them; normal maintenance removes unreferenced builds.
Each new dispatch still validates the installed artifact and reuses it when valid,
avoiding another download. Cloud-enrolled nodes keep their own execution-mode-specific
installation and retention lifecycle.

You can also enroll and enable a service host in one step with
`openclaw connect --service --session-host`. In Control UI New Session, a
write-scoped operator selects a Gateway project or folder and then either a
specific paired device or **Auto**. OpenClaw creates a
session-owned managed worktree on the Gateway, dispatches it with the exact
`deviceId` or `autoDevice: true`, and sends the first turn only after the chosen
device placement becomes active. New Session does not bind `execNode` or browse
the device filesystem.

The Devices page shows the validated Gateway-owned worker version in the node's
metadata. If the current artifact is missing or fails validation, Devices shows
a **worker missing** warning; an explicit new session installs the current bundle.
This status is observational and reconnect-scoped: launch still
requires the exact durable receipt and current node authority.

Node hosts must support the current private worker-supervisor dialect before
they can host sessions. An older connected host remains visible but disabled in
the session picker. Update OpenClaw on that device and reconnect it; for a
headless node, run `openclaw update` followed by `openclaw node restart`. The
Gateway does not fall back to the node's local OpenClaw package or an older
supervisor dialect.

This setting enables supervised session turns on the paired device, including
Gateway-owned workspace transfer and result reconciliation. By default, each
node has one worker slot per available CPU core. Configure the slot count with
`nodeHost.workerRuns.capacity`. Launches beyond capacity wait up to 10 seconds
for a durable slot; while all slots are occupied, the node remains available
for status and cancellation but is not selected for a new session turn.

The picker derives every device row from `environments.list`. Every selected
runtime requires an available, connected paired session host. OpenClaw worker
turns additionally require valid exact worker slots with at least one free
slot. Codex paired-device execution launches its exec-server directly, so it
does not consume or require a worker slot; instead, its required command must
appear in the node's effective `invocableCommands`, not merely its declared
capabilities. A declared command is usable only when the approved pairing and
Gateway command allowlist both authorize it. Connected non-hosts, ineligible
or saturated hosts, update-required devices, and unavailable hosts remain
visible but disabled with an actionable reason. Enable hosting with
`openclaw connect --service --session-host` or the `nodeHost.workerRuns`
setting, then restart the node host. Update-required hosts must be upgraded and
restarted before selection.

While node inventory refreshes, or if that refresh fails, the picker keeps known
devices visible but disables remote selection and Start until fresh inventory
arrives. Local remains selectable; cached worker slots never authorize a new
remote session.

Choose **Auto** to let the Gateway select an eligible paired,
connected session host. For OpenClaw worker turns, it selects the host with the
most available worker slots and breaks ties by device ID. Runtimes that do not
consume worker slots choose the eligible host with the lowest device ID instead.
If a selected host disconnects, reaches capacity, or otherwise becomes
ineligible before dispatch finishes, the Gateway tries the next ranked host, up
to three hosts total. Other dispatch failures are returned immediately. If no
host is eligible, the error explains whether no session hosts are paired, hosts
are disconnected or at capacity, a host needs an update, or the selected runtime
is unsupported. The dispatch response identifies the device that was selected.

When a known session host disconnects, its paired-device record preserves only
the last accepted current-v6 hosting consent. The offline row remains visible
and disabled with status unavailable. A current disabled or empty v6
publication records false; older v1-v5 and update-required dialects do not
overwrite the last current fact. Connected inventory always wins over stored
history, a missing stored value means false, and exact worker slots are never
persisted or shown as offline capacity.

If the device is offline, its active placement remains active: availability is
process-current, not a terminal placement state. `sessions.list` and
`sessions.describe` project `runner: { kind: "device", status: "offline" }`
until that exact current-v6 node runner reconnects. Gateway restart therefore
shows an active device placement as offline until reconnect; current inventory
then changes the projection to `available` and emits a session refresh. Exact
worker slots gate only new placements whose runtime consumes a worker slot;
they do not affect Codex remote execution or an existing session's availability.

Control UI shows **Device offline** and waits by default without giving up the
placement, workspace, or authority. Retry the next turn after the device
returns. **Continue on Gateway…** is a separate destructive choice: it fences
the device owner and continues from the last Gateway-synced workspace without
replaying the interrupted turn. Unsynced device files and in-flight work may be
lost. A paired node remains dormant for 14 days after its exact recorded
disconnect; at that boundary its old worker environment is treated as gone and
the session placement reconciles normally. Pairing itself remains, so a later
reconnect can provision a fresh environment. Legacy pairings without exact node
disconnect history are retained fail-safe rather than expired from unrelated
device activity. Removing the device pairing, silently pruning a superseded
pairing, or removing only its node role invalidates clients first, then runs
targeted environment and placement reconciliation; explicit removal waits for
the credential fence before returning success, and the periodic sweep retries
failed provider or placement cleanup.

See [Anthropic: Claude sessions across computers](/providers/anthropic#claude-sessions-across-computers)
for the Control UI behavior and storage sources.

### Isolate hosted worker sessions in containers

By default, hosted OpenClaw worker sessions run directly on the paired node.
Set `nodeHost.workerRuns.isolation` to `"container"` on that node to run each
worker inside its own container instead:

```json5
{
  nodeHost: {
    workerRuns: {
      enabled: true,
      isolation: "container",
      // Optional: use a digest-pinned, private-registry, or preloaded image.
      // containerImage: "registry.example.com/openclaw/node:24.19.0-slim",
    },
  },
}
```

Restart the node host after changing either setting. Isolation defaults to
`"none"`, preserving the existing direct-process behavior. This setting is
enforced locally on the node; the Gateway cannot silently disable it or fall
back to an unisolated worker.

Container isolation is supported on Linux and macOS node hosts; Windows is
unsupported because native Windows paths cannot be mounted at their original
paths inside the container. The node must have a working Docker-compatible
container engine. OpenClaw tries the `docker` CLI first, including Docker-backed
OrbStack installations, and then `podman`. The selected engine and daemon are
checked when the node host starts and again before each container is created.
If the platform is unsupported, neither engine works, or the daemon changes,
session hosting or the affected launch fails visibly instead of falling back to
an unisolated worker. Install or start the engine, verify `docker version` or
`podman version`, and restart the node host.

The default image is `node:24.19.0-slim`; the engine pulls it on first use when it
is not already present. Set `nodeHost.workerRuns.containerImage` to choose a
digest-pinned image, a private-registry image, or an image already available
to the engine. The image must provide a supported Node.js 24.16+ or 26.1+ runtime on
its standard executable search path. If the image cannot be pulled, is
inaccessible, or does not provide a suitable Node.js runtime, that session
launch fails visibly; it never retries as a bare host process. Preload the
image or configure registry access before hosting sessions on an offline or
restricted node. Existing explicit image settings are preserved; replace older Node
images with a supported release before upgrading OpenClaw. Worker startup requires
a supported runtime; older releases may fail before the runtime diagnostic can run.

Each worker container receives only two host bind mounts: its verified worker
bundle root is read-only, and its assigned session workspace is read-write.
Both are mounted at their original absolute host paths so the sealed bundle
and workspace descriptor remain valid; the session workspace is also the
container working directory. OpenClaw passes only the existing frozen,
non-secret worker environment allowlist and adds no other host mounts.
Container isolation protects the rest of the host filesystem and separates
the worker process, but the worker can still modify its assigned workspace
and connect to the Gateway.

The container uses the engine's normal outbound networking and must be able
to reach the Gateway worker WebSocket endpoint. A Gateway address such as
`127.0.0.1` or `localhost` that works on the node host points back into the
container when used by the worker; configure a Gateway address reachable from
the container network instead. If a Gateway requires a custom certificate
authority, `NODE_EXTRA_CA_CERTS` must point to a certificate already inside
the mounted bundle or session workspace; OpenClaw will not mount another host
path for it. Browser assignments that require access to host-only browser
state are not supported in container-isolated sessions.

Cancellation and fencing terminate the container itself rather than only the
container-engine client. The node host records the container's durable engine
and container identity, checks that identity during restart reconciliation,
and removes orphaned worker containers labeled for the same Gateway. If the
node-host process exits unexpectedly, a running container can survive until
the next node-host startup; keep the node host under a restarting service if
that cleanup window must remain short.
