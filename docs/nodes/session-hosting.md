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

The Gateway applies plugin `before_agent_run` policies to OpenClaw node turns
before persisting input or launching the worker. Blocked turns retain only the
redacted block message and leave the node available for the next turn. The hook
sees the Gateway input and history; node-local system context is assembled later
and is not included. See [hook boundaries](/plugins/hooks#choose-a-hook).

Restart the app or node host after enabling this setting. The macOS app owns
one paired node identity and uses the shared node runtime for session hosting;
do not start a second CLI node for the same Mac. Its native camera, screen, and
desktop capabilities remain on that identity. If the shared runtime cannot
start, native capabilities remain available, but session hosting is unavailable.

Approving an updated capability surface on a connected host automatically
refreshes its session-hosting declaration and current worker slots. The Gateway
waits for that fresh declaration before making the host available again; the
app or node-host process does not need to restart.

When a session first needs the current worker build, the Gateway sends its sealed
worker artifact to the paired host. The node verifies the exact content hash,
publishes the artifact atomically, and prewarms it when supported by the execution mode.
The artifact contains its complete JavaScript dependency closure; the node does
not install packages or execute lifecycle scripts. Runtime chunks are sealed and
verified with the artifact, and cold workers complete admission before loading
the turn runtime. Installation belongs to the
session request and receives its cancellation signal. Reconnect maintenance does
not install or prewarm a worker build.

Once installed, persistent nodes retain one current worker artifact per Gateway
namespace, even with no sessions. Older builds remain only while a live or
recoverable placement needs them; normal maintenance removes unreferenced builds.
Each new dispatch still validates the installed artifact and reuses it when valid,
avoiding another download. Cloud-enrolled nodes keep their own execution-mode-specific
installation and retention lifecycle.

The command printed by `openclaw devices join-code` enrolls and enables a
service host in one step with `openclaw connect <join-url> --service --session-host`.
Omit `--session-host` for a command-only node service.

To enable hosting on an already-paired headless node, run on that device:

```bash
openclaw config set nodeHost.workerRuns.enabled true
openclaw node install --force
```

For a process-scoped host, enroll in the foreground with
`openclaw connect <join-url> --session-host`. The join URL is single-use; after
that process stops, restart the host with `openclaw node run --session-host`,
which reuses the saved pairing. See
[Reconnect a paired node](/cli/connect#reconnect-a-paired-node).

In Control UI New Session, a
write-scoped operator chooses either a specific paired device or **Auto**.
Without an explicit project or folder selection, **New workspace** starts an
empty isolated workspace without requiring a user Git repository. A selected
GitHub repository or Gateway Git checkout remains an optional source. OpenClaw creates a
session-owned managed workspace, dispatches it with the exact
`deviceId` or `autoDevice: true`, and sends the first turn only after the chosen
device placement becomes active. New Session does not bind `execNode` or browse
the device filesystem.

The selected model's **harness** must also support the chosen device. OpenAI
models using the Codex harness require the official Codex plugin on that node;
installing it only on the Gateway is not enough. On the node, run:

```bash
openclaw plugins install @openclaw/codex
openclaw node restart
```

If the plugin is already installed but disabled, explicitly enable it with
`openclaw plugins enable codex` before restarting. Approve the node's updated
command surface on the Gateway. The picker keeps the device unavailable for
Codex until it advertises the command and approval is complete. Alternatively,
choose a model using the OpenClaw harness; OpenClaw does not switch harnesses
silently or install Codex when you enable session hosting.

On POSIX hosts, OpenClaw keeps its managed workspace directories private (`0700`),
including when the host uses umask `0002`. Existing node-owned workspace ancestry
is tightened when reopened, so transfers can recover after an update without
changing the host's umask. Files inside a transferred workspace retain their
manifest permissions.

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

OpenClaw worker turns also require a node that supports the Gateway's captured
exec policy. If you update the Gateway first, older nodes show **Update required**
for OpenClaw sessions until you update and reconnect them. Their Codex remote
execution and other approved node commands retain their existing requirements.
Updating a node first remains compatible with an older Gateway; the node
advertises this support only when the Gateway understands it.

When updating a node before a `2026.9.8` Gateway, the node preserves that
Gateway's Skill Workshop launch binding for its supplied worker bundle.
Ordinary attributed chat turns continue to work without updating both sides together.

Turn completion uses a bounded status wait when both the Gateway and node host
support `node-worker-status-wait-v1`. The node wakes the waiting request as soon
as the exact turn's terminal result is journaled; transcript settlement and
worker cleanup ownership remain unchanged. This optional capability supports
mixed Gateway/node versions: update either side first, and older node hosts
continue to use status polling. A newer node advertises `workerHost.statusWait: 1`
only to a Gateway that announces the capability. Reconnects renegotiate support.

Hosted turns use the same prepared tool surface and agent/session policy as
Gateway-local turns. Workspace file and process tools execute on the node;
Gateway-owned tools, including web search, memory, and session discovery, execute
on the Gateway with the turn's live authority and tool hooks. Tool definitions
carry their execution location, so new Gateway tools do not require a separate
node allowlist.

The model-facing tools use the same Code Mode or Tool Search presentation as
local turns, including the Gateway's resolved model settings and limits. Code
Mode runs on the node and calls each catalog tool at its declared execution
location. Its catalog and pending cells belong to the current turn; a retained
worker receives a fresh presentation on the next turn.
Node workers use `tool_call` for Tool Search, including when directory mode is configured.

Concurrent Gateway tool calls wait for the existing transport budget, so larger
model tool batches do not lose calls. Cancellation and heartbeats remain independent.

Placement-local tools are offered only when the node declares their capability.
Unavailable placement or transport capabilities are recorded in the Gateway log.
Update OpenClaw on the node and restart it to enable newer local tools. Gateway
operations use the matching downloaded worker bundle and do not depend on the
installed supervisor recognizing their tool names. Updated nodes continue
advertising the Gateway tools expected by older Gateways, preserving those
tools when the node is updated first.

This setting enables supervised session turns on the paired device, including
Gateway-owned workspace transfer and result reconciliation. The Gateway prepares
the tool definitions and filesystem policy before the worker starts using tools.
Hosted turns honor global and agent-specific `tools.fs.workspaceOnly`,
`tools.exec.applyPatch.enabled`, and `tools.exec.applyPatch.allowModels`, with the
same session permission-mode precedence as local turns. Workspace containment
uses the assigned node workspace. Model read budgets and image sanitization also
come from the Gateway; the worker does not reconstruct them from an empty config.
The Gateway includes this tool catalog and policy in each turn's worker admission
response, including when a warm worker process is reused. A retained process receives
the current turn's catalog and generation, so a turn does not need a separate
discovery request. This uses the existing
build-bound worker tool capability: the worker and Gateway must run the same
bundle. The authenticated admission response uses the same negotiated payload budget
as worker inference, so a complete tool catalog is not capped by the smaller
control-frame limit. Oversized catalogs fail explicitly instead of being truncated. The catalog grants
no execution authority; every Gateway tool call still checks the live turn claim.

Worker reply attachments inside the assigned workspace are copied through the
node transport before workspace reconciliation. Relative and absolute `MEDIA:`
paths use the worker's bytes, including completed live replies. Raw paths outside
that workspace produce a remote-file attachment error; allowed managed media
references and HTTP URLs retain their existing delivery policy. Final chat
completion still waits for reconciliation and includes any conflict summary.

By default, each node has one worker slot per available CPU core. Configure the slot count with
`nodeHost.workerRuns.capacity`. Launches beyond capacity wait up to 10 seconds
for a durable slot. A slot occupied only by an idle worker can be reclaimed for
new work; active turns and background commands keep their slots. When no free
or reclaimable slot remains, the node stays available for status and cancellation
but is not selected for a new session turn.

Capacity, host-stat, and skill-bin updates do not interrupt active node work or
change its pairing authority. This behavior requires an updated Gateway; node
configuration and stored pairings remain unchanged.

After a turn settles, OpenClaw can retain its worker process for up to two
minutes so an immediate follow-up avoids loading the runtime again. The timer
starts after the worker confirms that turn cleanup is complete. Each node keeps
at most two idle workers, bounded by its configured capacity; it retires the
least recently idle worker first when space is needed. Idle workers still use
memory: expect several hundred MiB per retained worker and its supervision
processes even for a small session, with larger heaps possible after substantial work.
Workers are started by turns, never just by activating a placement.

Idle reuse requires support from the Gateway, node, and installed worker bundle
through the `node-worker-idle-retention-v1` capability. Older combinations keep
their existing background-command retention behavior. Every reused turn still
gets fresh credentials, admission, history, execution policy, and a turn
profile. Entering idle closes the turn connection, joins its write-capable
cleanup, and removes the finished turn's temporary profile. Background commands
remain protected from idle eviction and timeouts; their existing environment
and credential lifetime applies until they finish.

Idle retention uses the same workspace-reconciliation contract as background
command retention, in both process and container mode. Neither contract suspends
the worker process. Capture, verification, renewal, and final verification of
the workspace manifest detect concurrent changes; a conflict or failed fence
uses the existing reconciliation and recovery flow. Retaining a settled runtime
does not grant it authority for another turn.

Disconnect, node shutdown, update pause, or placement teardown retires idle
workers through normal process-tree or container cleanup. Reconnect waits for
that cleanup before publishing fresh capacity. If idle cleanup fails, the running
supervisor keeps its slot reserved and retries after two minutes. Stop, Move, and reclaim retain
their exact placement ownership checks; idle workers are never restored after
a crash or restart. Chat **Stop** cancels active work and does not flush an idle
worker when no turn is running. Use placement Stop or reclaim to release it
immediately. There is no separate idle-retention setting.

Stopping an active hosted turn records the accepted cancellation even if the
worker encounters an error while stopping. Worker diagnostics retain the shutdown
failure separately. A worker slot becomes available only after its process tree
or container has finished cleanup.

Current Linux and macOS node hosts also retain that cleanup ownership when the
application worker or node host crashes, when the Gateway-provided worker bundle
supports process lineage. Update the Gateway and update and restart the node host
to receive this protection; installing a new worker bundle alone does not update
the node's supervisor. Recovery keeps capacity occupied while the previous owner
finishes stopping its commands. An upgraded node host preserves the released
startup message and detached process-group ownership for older worker bundles.

Installed node hosts package the POSIX launch helpers separately to reduce
per-turn startup work. Update and restart the node host to receive this
improvement. The worker still waits for its durable launch receipt before
starting a turn, and cleanup continues to hold its worker slot until the
process tree is gone.

The picker derives every device row from `environments.list`. Every selected
runtime requires an available, connected paired session host. OpenClaw worker
turns additionally require captured exec-policy support and valid exact worker
slots with at least one free or reclaimable idle slot. Codex paired-device execution launches its
exec-server directly, so it does not consume or require a worker slot. Its
required command must appear in the node's effective `invocableCommands`,
not merely its declared capabilities. A declared command is usable only when
the approved pairing and Gateway command allowlist both authorize it.
Connected non-hosts, ineligible or saturated hosts, update-required devices,
and unavailable hosts remain visible but disabled with an actionable reason.
For an already-paired headless node, enable `nodeHost.workerRuns.enabled` and
run `openclaw node install --force` as shown above. Update-required hosts must
be upgraded and restarted before selection.

While node inventory refreshes, or if that refresh fails, the picker keeps known
devices visible but disables remote selection and Start until fresh inventory
arrives. Local remains selectable; cached worker slots never authorize a new
remote session.

Choose **Auto** to let the Gateway select an eligible paired,
connected session host. For OpenClaw worker turns, it first prefers hosts with
less admitted work relative to their worker capacity. It then compares free
and reclaimable idle worker slots after accounting for dispatches still starting, and breaks
remaining ties by device ID. A session's placement alone does not reserve a
worker slot. Runtimes that do not consume worker slots choose the eligible host
with the lowest device ID instead.

If a selected host becomes ineligible before workspace preparation begins, the
Gateway tries the next ranked host, up to three hosts total, after confirming
that any failed allocation has been cleaned up. Other dispatch failures are
returned immediately; Auto never replays workspace preparation or work already
started. Once workspace preparation is admitted, another turn filling the host's
slots does not cancel it; the node checks physical capacity when the session
launches a turn.
Node identity and command authorization remain checked throughout preparation.

If no host is eligible, the error explains whether no devices have session hosting enabled,
hosts are disconnected or at capacity, a host needs an update, or the selected
runtime is unsupported. Current pairing, connection, and command errors take
precedence over previously advertised worker slots. The dispatch response
identifies the device that was selected.

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

While a device runner is unavailable, including after session hosting is disabled,
the Gateway pauses advisory disk-space checks and retains the last sample for
that placement. Checks resume on the next scheduled sweep after the current
runner reconnects. Disabling hosting does not discard the session's workspace.

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
      // containerImage: "registry.example.com/openclaw/node:24.21.0-slim",
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

Before each container launch, daemon identity revalidation allows up to 30 seconds.
If an engine command times out, the launch error names the engine and operation
(for example, `docker info`) and its deadline. It omits command arguments and
environment values. Check that operation against the selected daemon before retrying.

The default image is `node:24.21.0-slim`; the engine pulls it on first use when it
is not already present. Set `nodeHost.workerRuns.containerImage` to choose a
digest-pinned image, a private-registry image, or an image already available
to the engine. The image must provide a supported Node.js 24.16+ or 26.1+ runtime on
its standard executable search path. If the image cannot be pulled, is
inaccessible, or does not provide a suitable Node.js runtime, that session
launch fails visibly; it never retries as a bare host process. Preload the
image or configure registry access before hosting sessions on an offline or
restricted node. The default image can advance when OpenClaw updates its dependencies.
Before upgrading an offline node, preload the new default image or set
`nodeHost.workerRuns.containerImage` to a supported image already cached on that node.
For example, a cached `node:24.19.0-slim` remains supported and can be selected explicitly.
Existing explicit image settings are preserved; replace unsupported Node images before
upgrading OpenClaw. Worker startup requires a supported runtime; older releases may
fail before the runtime diagnostic can run.

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
