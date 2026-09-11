---
summary: "Gateway RPC families for system status, models, channels, plugins, messaging, and the operator terminal"
read_when:
  - Looking up a system, model, channel, or plugin RPC
  - Wiring operator terminal or messaging methods
  - Checking the scope a gateway method requires
title: "Gateway protocol system and channel methods"
sidebarTitle: "System and channels"
doc-schema-version: 1
---

RPC method families for gateway status and identity, models and usage, channels and login, plugin management, messaging and logs, and the operator terminal.

## System and identity

- `health` returns the cached or freshly probed gateway health snapshot.
- `diagnostics.stability` returns the recent bounded diagnostic stability recorder: event names, counts, byte sizes, memory readings, queue/session state, channel/plugin names, session ids. No chat text, webhook bodies, tool outputs, raw request/response bodies, tokens, cookies, or secrets. Requires `operator.read`.
- `status` returns the `/status`-style gateway summary; sensitive fields only for admin-scoped operator clients.
- `gateway.identity.get` returns the gateway device identity used by relay and pairing flows.
- `system-presence` returns the current presence snapshot for connected operator/node devices.
- `system-event` appends a system event and can update/broadcast presence context.
- `last-heartbeat` returns the latest persisted heartbeat event.
- `set-heartbeats` toggles heartbeat processing on the gateway.
- `gateway.restart.preflight` is a deprecated, read-only compatibility preview of restart-specific active work. It does not close admission, create a suspension lease, or provide the atomic full-work fence of `gateway.suspend.prepare`; new restart flows should call `gateway.restart.request`.
- `gateway.suspend.prepare` creates a short cooperative-suspension lease only when tracked Gateway work is idle. While prepared, authenticated WebSocket connects remain available, but only `gateway.suspend.*` and an exact targeted non-safe `gateway.restart.request` may run; safe and untargeted restarts remain fenced. `gateway.suspend.status` checks the lease, and `gateway.suspend.resume` releases it after thaw or an aborted host operation.

## Models and usage

- `models.list` returns the runtime-allowed model catalog. See [`models.list` views](/gateway/protocol/operator-methods#models-list-views).
- `usage.status` returns provider usage windows/remaining quota summaries. Clients advertising `usage-refreshing` receive an immediate `refreshing: true` placeholder on a cold cache and must refetch on a bounded schedule; other callers block for the cold provider read.
- `usage.cost` returns aggregated cost usage summaries for a date range. Pass `agentId` for one agent, or `agentScope: "all"` to aggregate configured agents.
- `doctor.memory.status` returns vector-memory / cached embedding readiness for the active default agent workspace. Pass `{ "probe": true }` or `{ "deep": true }` only for an explicit live embedding provider ping. Pass `{ "agentId": "agent-id" }` to scope Dreaming store stats to one agent workspace; omitting it aggregates configured Dreaming workspaces.
- `doctor.memory.dreamDiary`, `doctor.memory.backfillDreamDiary`, `doctor.memory.resetDreamDiary`, `doctor.memory.resetGroundedShortTerm`, `doctor.memory.repairDreamingArtifacts`, and `doctor.memory.dedupeDreamDiary` accept optional `{ "agentId": "agent-id" }`; omitted, they operate on the configured default agent workspace.
- `sessions.usage` returns per-session usage summaries. Pass `agentId` for one agent, or `agentScope: "all"` to list configured agents together.
  Both usage methods accept `mode: "specific"` with an IANA `timeZone` for DST-aware calendar-day boundaries and buckets. `utcOffset` remains supported for older clients and as a fallback when the Gateway runtime does not recognize the requested zone.
- `sessions.usage.timeseries` returns timeseries usage for one session.
- `sessions.usage.logs` returns usage log entries for one session.
  Both detail methods accept the selected row's `key` and optional `agentId`. Preserve both fields when opening details for an unqualified key such as `global`.

## Channels and login helpers

- `channels.status` returns built-in + bundled channel/plugin status summaries.
- `channels.start` (`operator.admin`) starts one channel account runtime without re-authenticating. Params `{ channel, accountId? }`; omitted `accountId` selects the default account. Responds `{ channel, accountId, started, outcome }`, with `started` true only when the resulting runtime snapshot reports `running: true`. `outcome` carries the account lifecycle decision: `{ status: "handed-off" }`, `{ status: "retry", reason }`, or `{ status: "skipped", reason }`. The RPC is a manual override of automatic-start suppression; no `manual` parameter is accepted. This is not a provider-connectivity check; see [Per-account recovery](/cli/channels#per-account-recovery-non-destructive) for reasons and recovery guidance.
- `channels.stop` (`operator.admin`) stops one channel account runtime without clearing auth state. Params `{ channel, accountId? }`; omitted `accountId` selects the default account. Responds `{ channel, accountId, stopped }`, with `stopped` true when the resulting runtime snapshot does not report `running: true`. Unlike `channels.logout`, it retains the account's credentials.
- `channels.logout` logs out a specific channel/account where the channel supports it.
- `web.login.start` starts a QR/web login flow. Params include optional `{ channel, accountId, force, timeoutMs, verbose }`. When `channel` is present, the Gateway normalizes its canonical id or alias and dispatches only to that installed channel plugin. Omitting `channel` preserves the legacy behavior of selecting the first loaded QR-capable provider. A provider may return an opaque `sessionKey` with its QR response.
- `web.login.wait` waits for that flow to complete and starts the channel on success. Params include optional `{ channel, accountId, sessionKey, timeoutMs, currentQrDataUrl }`. Use the same `channel` as `web.login.start` and pass its returned `sessionKey` through unchanged so the provider can correlate the wait request with the QR session. Omitting `channel` retains the same legacy provider fallback as `web.login.start`.
- `push.test` sends a test APNs push to a registered iOS node.
- `voicewake.get` returns the stored wake-word triggers.
- `voicewake.set` updates wake-word triggers and broadcasts the change.

## Plugin management

- `plugins.list` (`operator.read`) returns the installed plugin inventory plus locally curated official picks, diagnostics, and whether the current install mode allows mutations.
- `plugins.search` (`operator.read`) searches installable ClawHub code-plugin and bundle-plugin families. Pass non-empty `query` and optional `limit` from 1 to 100.
- `plugins.install` (`operator.admin`) installs either an official catalog entry with `{ source: "official", pluginId, acknowledgeInstallPolicyWarning? }` or a ClawHub package with `{ source: "clawhub", packageName, version?, acknowledgeInstallPolicyWarning? }`. When install policy returns `warn`, the error `details` include `installPolicyCode: "install_policy_warning_acknowledgement_required"`, the target, reason, and optional findings. After review, retrying the same action with `acknowledgeInstallPolicyWarning: true` approves every warning in that install invocation; each warning is freshly evaluated before installation continues. `block` and policy failures remain terminal. ClawHub installs preserve Gateway trust and integrity checks. Successful installs require a Gateway restart.
- `plugins.setEnabled` (`operator.admin`) changes one installed plugin's enabled policy with `{ pluginId, enabled }`. The response includes the updated catalog entry, restart metadata, and any slot-selection warnings.
- `plugins.uninstall` (`operator.admin`) removes one externally installed plugin with `{ pluginId }`: config references, the install record, and managed files. Bundled plugins cannot be uninstalled, only disabled. The response lists the removal actions and always requires a Gateway restart.

## Messaging and logs

- `send` is the direct outbound-delivery RPC for channel/account/thread-targeted sends outside the chat runner.
- `logs.tail` returns the configured gateway file-log tail with cursor/limit and max-byte controls.

## Operator terminal

- `terminal.open` starts a host PTY for an explicit `agentId` or the default agent and returns the resolved agent, working directory, shell, and confinement state. Passing `sessionKey` binds the PTY to that exact agent session and attaches the calling connection as its first viewer; omitting it creates a connection-owned operator terminal.
- `terminal.input` and `terminal.resize` operate on sessions owned by the calling connection and agent-owned sessions where that connection is an attached viewer. `terminal.close` kills a connection-owned session, but only detaches the calling viewer from an established agent-owned session. For a new session-bound Control UI terminal, the initiating viewer's close or disconnect discards the PTY until the browser or exact-session agent first adopts it through an authorized operation.
- `terminal.upload` accepts one base64 file up to 16 MiB, stages it in a private 24-hour temporary directory on the session's Gateway or paired-node host, and returns the absolute path. The caller must still paste or otherwise use that path; the RPC never writes terminal input or executes a command.
- `terminal.data` and `terminal.exit` events stream to the connection owner and attached viewers. Conversation-owned terminals remain persistent. The agent-facing `terminal` tool can list, read, resize, or close only terminals an operator opened for its exact session; it cannot open terminals. Agent input follows effective session and exec policy: `full` (YOLO) sends immediately, `guarded` and `workspace` (including accept-only or Guardian-reviewed flows) require explicit one-time approval of that exact input, and `read-only` or `deny` blocks it.
- Connection-owned sessions whose connection drops are detached, not killed: they stay reattachable for `gateway.terminal.detachedSessionTimeoutSeconds` (default 300; `0` restores kill-on-disconnect) while recent output accumulates in a bounded server-side buffer. Established agent-owned sessions likewise survive viewer disconnect.
- `terminal.list` returns attachable sessions. `terminal.attach` returns the replay buffer and either rebinds a connection-owned session (tmux-style take-over — a previous live owner receives `terminal.exit` with reason `detached`) or adds the connection as a viewer of an agent-owned session.
- Every terminal method requires `operator.admin`; `gateway.terminal.enabled` is on by default and refuses every method when set to `false`. Fully sandboxed agents are refused, and an agent policy change closes existing and in-flight PTYs, detached ones included.
