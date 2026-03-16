---
summary: "Complete gateway RPC reference for Operator1 — all ~160 methods, scopes, and params."
updated: "2026-03-16"
title: "RPC Reference"
---

# RPC Reference

The gateway uses WebSocket JSON-RPC for communication (default `ws://127.0.0.1:18789`). Each method requires a specific permission scope.

## Scopes

Every method requires one of the following scopes (or `operator.admin` which supersedes all):

| Scope                | Token constant | Description                                |
| -------------------- | -------------- | ------------------------------------------ |
| `operator.read`      | READ           | Read-only state queries                    |
| `operator.write`     | WRITE          | Mutations and agent invocations            |
| `operator.admin`     | ADMIN          | Privileged ops — config, sessions, plugins |
| `operator.approvals` | APPROVALS      | Exec approval flow                         |
| `operator.pairing`   | PAIRING        | Node/device pairing                        |
| _(node role)_        | NODE           | Internal — node clients only               |

---

## Health and System

| Method                 | Scope | Description                     | Key Params                               |
| ---------------------- | ----- | ------------------------------- | ---------------------------------------- |
| `health`               | READ  | Gateway health snapshot         | `{}`                                     |
| `status`               | READ  | Combined gateway status         | `{}`                                     |
| `doctor.memory.status` | READ  | Memory doctor diagnostics       | `{}`                                     |
| `logs.tail`            | READ  | Tail recent gateway log lines   | `{ lines?: number, subsystem?: string }` |
| `update.run`           | ADMIN | Trigger a gateway self-update   | `{}`                                     |
| `system-presence`      | READ  | List active presence beacons    | `{}`                                     |
| `system-event`         | ADMIN | Inject a synthetic system event | `{ kind: string, text?: string }`        |
| `last-heartbeat`       | READ  | Get last heartbeat timestamp    | `{}`                                     |
| `set-heartbeats`       | ADMIN | Configure heartbeat schedule    | `{ intervalSeconds: number }`            |
| `wake`                 | WRITE | Wake the gateway from idle      | `{}`                                     |

---

## Config

| Method                 | Scope | Description                   | Key Params                         |
| ---------------------- | ----- | ----------------------------- | ---------------------------------- |
| `config.get`           | READ  | Read config values            | `{ path?: string }`                |
| `config.set`           | ADMIN | Set a config value            | `{ path: string, value: unknown }` |
| `config.patch`         | ADMIN | Patch multiple config values  | `{ ops: PatchOp[] }`               |
| `config.apply`         | ADMIN | Apply pending config changes  | `{}`                               |
| `config.schema`        | ADMIN | Get full config JSON schema   | `{}`                               |
| `config.schema.lookup` | READ  | Lookup a specific schema path | `{ path: string }`                 |

---

## Channels

| Method            | Scope | Description                      | Key Params            |
| ----------------- | ----- | -------------------------------- | --------------------- |
| `channels.status` | READ  | Status of all connected channels | `{ probe?: boolean }` |
| `channels.logout` | ADMIN | Disconnect and logout a channel  | `{ channel: string }` |

---

## Models

| Method        | Scope | Description              | Key Params            |
| ------------- | ----- | ------------------------ | --------------------- |
| `models.list` | READ  | List available AI models | `{ probe?: boolean }` |

---

## Tools

| Method          | Scope | Description               | Key Params |
| --------------- | ----- | ------------------------- | ---------- |
| `tools.catalog` | READ  | Get the full tool catalog | `{}`       |

---

## Sessions

| Method                      | Scope | Description                                     | Key Params                               |
| --------------------------- | ----- | ----------------------------------------------- | ---------------------------------------- |
| `sessions.list`             | READ  | List sessions                                   | `{ agentId?: string, limit?: number }`   |
| `sessions.get`              | READ  | Get a session by key                            | `{ sessionKey: string }`                 |
| `sessions.preview`          | READ  | Preview session message history                 | `{ sessionKey: string, limit?: number }` |
| `sessions.resolve`          | READ  | Resolve a session key alias                     | `{ sessionKey: string }`                 |
| `sessions.usage`            | READ  | Token/cost usage for a session                  | `{ sessionKey: string }`                 |
| `sessions.usage.timeseries` | READ  | Usage over time for a session                   | `{ sessionKey: string }`                 |
| `sessions.usage.logs`       | READ  | Per-turn usage log entries                      | `{ sessionKey: string }`                 |
| `sessions.patch`            | ADMIN | Patch session metadata (including `project_id`) | `{ sessionKey: string, patch: object }`  |
| `sessions.reset`            | ADMIN | Clear session message history                   | `{ sessionKey: string }`                 |
| `sessions.delete`           | ADMIN | Delete a session                                | `{ sessionKey: string }`                 |
| `sessions.compact`          | ADMIN | Compact session history                         | `{ sessionKey: string }`                 |
| `sessions.archive`          | ADMIN | Archive a session                               | `{ sessionKey: string }`                 |

---

## Agents

| Method               | Scope | Description                                  | Key Params                                                 |
| -------------------- | ----- | -------------------------------------------- | ---------------------------------------------------------- |
| `agents.list`        | READ  | List registered agents                       | `{}`                                                       |
| `agents.files.list`  | READ  | List files in an agent's workspace           | `{ agentId: string }`                                      |
| `agents.files.get`   | READ  | Read an agent workspace file                 | `{ agentId: string, file: string }`                        |
| `agents.files.set`   | ADMIN | Write an agent workspace file                | `{ agentId: string, file: string, content: string }`       |
| `agent`              | WRITE | Send a message to an agent                   | `{ message: string, sessionKey?: string, model?: string }` |
| `agent.identity.get` | READ  | Get the calling agent's identity             | `{}`                                                       |
| `agent.wait`         | WRITE | Wait for an in-progress agent turn to finish | `{ sessionKey: string, timeoutMs?: number }`               |
| `send`               | WRITE | Send a message via a channel                 | `{ channel: string, to: string, message: string }`         |

---

## Chat (WebChat)

| Method         | Scope | Description                    | Key Params                                 |
| -------------- | ----- | ------------------------------ | ------------------------------------------ |
| `chat.send`    | WRITE | Send a chat message            | `{ message: string, sessionKey?: string }` |
| `chat.history` | READ  | Get chat message history       | `{ sessionKey?: string, limit?: number }`  |
| `chat.abort`   | WRITE | Abort an in-progress chat turn | `{ sessionKey?: string }`                  |

---

## Memory

| Method            | Scope | Description                      | Key Params                                            |
| ----------------- | ----- | -------------------------------- | ----------------------------------------------------- |
| `memory.status`   | READ  | Memory provider status           | `{ agentId?: string }`                                |
| `memory.search`   | READ  | Search agent memory              | `{ agentId?: string, query: string, limit?: number }` |
| `memory.activity` | READ  | Scan raw memory activity (JSONL) | `{ agentId?: string, limit?: number }`                |
| `memory.reindex`  | ADMIN | Trigger full memory reindex      | `{ agentId?: string }`                                |

---

## Cron

| Method        | Scope | Description                      | Key Params                              |
| ------------- | ----- | -------------------------------- | --------------------------------------- |
| `cron.list`   | READ  | List cron jobs                   | `{}`                                    |
| `cron.status` | READ  | Cron system status and next wake | `{}`                                    |
| `cron.runs`   | READ  | Recent cron run history          | `{ limit?: number }`                    |
| `cron.add`    | ADMIN | Add a cron job                   | `{ schedule: string, payload: object }` |
| `cron.update` | ADMIN | Update a cron job                | `{ id: string, patch: object }`         |
| `cron.remove` | ADMIN | Remove a cron job                | `{ id: string }`                        |
| `cron.run`    | ADMIN | Manually trigger a cron job      | `{ id: string }`                        |

---

## Skills

| Method           | Scope | Description                     | Key Params                          |
| ---------------- | ----- | ------------------------------- | ----------------------------------- |
| `skills.status`  | READ  | Skills system status            | `{}`                                |
| `skills.list`    | READ  | List installed skills           | `{}`                                |
| `skills.bins`    | NODE  | List skill binaries (node role) | `{}`                                |
| `skills.install` | ADMIN | Install a skill                 | `{ name: string, source?: string }` |
| `skills.update`  | ADMIN | Update installed skills         | `{ name?: string }`                 |

---

## TTS / STT

| Method            | Scope | Description                  | Key Params                             |
| ----------------- | ----- | ---------------------------- | -------------------------------------- |
| `tts.status`      | READ  | TTS provider status          | `{}`                                   |
| `tts.providers`   | READ  | List available TTS providers | `{}`                                   |
| `tts.enable`      | WRITE | Enable TTS                   | `{}`                                   |
| `tts.disable`     | WRITE | Disable TTS                  | `{}`                                   |
| `tts.convert`     | WRITE | Convert text to speech       | `{ text: string, voice?: string }`     |
| `tts.setProvider` | WRITE | Set active TTS provider      | `{ provider: string }`                 |
| `stt.status`      | READ  | STT provider status          | `{}`                                   |
| `stt.transcribe`  | WRITE | Transcribe audio to text     | `{ audio: string, mimeType?: string }` |

---

## Voice Wake

| Method          | Scope | Description                   | Key Params                |
| --------------- | ----- | ----------------------------- | ------------------------- |
| `voicewake.get` | READ  | Get voice wake trigger config | `{}`                      |
| `voicewake.set` | WRITE | Set voice wake triggers       | `{ triggers: Trigger[] }` |

---

## Talk

| Method        | Scope | Description                        | Key Params         |
| ------------- | ----- | ---------------------------------- | ------------------ |
| `talk.config` | READ  | Get talk mode configuration        | `{}`               |
| `talk.mode`   | WRITE | Set talk mode (push-to-talk, etc.) | `{ mode: string }` |

---

## Usage

| Method         | Scope | Description              | Key Params           |
| -------------- | ----- | ------------------------ | -------------------- |
| `usage.status` | READ  | Overall token/cost usage | `{}`                 |
| `usage.cost`   | READ  | Cost breakdown by model  | `{ since?: number }` |

---

## Secrets

| Method            | Scope | Description                  | Key Params         |
| ----------------- | ----- | ---------------------------- | ------------------ |
| `secrets.reload`  | ADMIN | Reload secrets from disk     | `{}`               |
| `secrets.resolve` | ADMIN | Resolve a named secret value | `{ name: string }` |

---

## Exec Approvals

| Method                       | Scope     | Description                   | Key Params                                  |
| ---------------------------- | --------- | ----------------------------- | ------------------------------------------- |
| `exec.approvals.get`         | ADMIN     | Get exec approval policy      | `{}`                                        |
| `exec.approvals.set`         | ADMIN     | Set exec approval policy      | `{ policy: object }`                        |
| `exec.approvals.node.get`    | ADMIN     | Get per-node approval policy  | `{ nodeId: string }`                        |
| `exec.approvals.node.set`    | ADMIN     | Set per-node approval policy  | `{ nodeId: string, policy: object }`        |
| `exec.approval.request`      | APPROVALS | Request exec approval         | `{ command: string, context?: string }`     |
| `exec.approval.waitDecision` | APPROVALS | Wait for an approval decision | `{ requestId: string, timeoutMs?: number }` |
| `exec.approval.resolve`      | APPROVALS | Resolve an approval request   | `{ requestId: string, approved: boolean }`  |

---

## Browser

| Method            | Scope | Description                          | Key Params                                         |
| ----------------- | ----- | ------------------------------------ | -------------------------------------------------- |
| `browser.request` | WRITE | Execute a browser automation request | `{ url: string, method?: string, body?: unknown }` |

---

## Nodes

| Method                           | Scope   | Description                                  | Key Params                                           |
| -------------------------------- | ------- | -------------------------------------------- | ---------------------------------------------------- |
| `node.list`                      | READ    | List connected nodes                         | `{}`                                                 |
| `node.describe`                  | READ    | Describe a node                              | `{ nodeId: string }`                                 |
| `node.rename`                    | PAIRING | Rename a node                                | `{ nodeId: string, displayName: string }`            |
| `node.invoke`                    | WRITE   | Invoke a command on a node                   | `{ nodeId: string, command: string, args?: object }` |
| `node.pending.pull`              | NODE    | Pull pending invocations (node role)         | `{}`                                                 |
| `node.pending.ack`               | NODE    | Acknowledge a pending invocation (node role) | `{ invocationId: string }`                           |
| `node.invoke.result`             | NODE    | Report invocation result (node role)         | `{ invocationId: string, result: unknown }`          |
| `node.event`                     | NODE    | Emit a node event (node role)                | `{ event: string, payload?: unknown }`               |
| `node.canvas.capability.refresh` | NODE    | Refresh canvas capability token (node role)  | `{}`                                                 |
| `node.pair.request`              | PAIRING | Initiate node pairing                        | `{ instanceId?: string }`                            |
| `node.pair.list`                 | PAIRING | List pending/active pairings                 | `{}`                                                 |
| `node.pair.approve`              | PAIRING | Approve a pairing request                    | `{ nodeId: string }`                                 |
| `node.pair.reject`               | PAIRING | Reject a pairing request                     | `{ nodeId: string }`                                 |
| `node.pair.verify`               | PAIRING | Verify node pairing status                   | `{ nodeId: string }`                                 |

---

## Devices

| Method                | Scope   | Description              | Key Params             |
| --------------------- | ------- | ------------------------ | ---------------------- |
| `device.pair.list`    | PAIRING | List paired devices      | `{}`                   |
| `device.pair.approve` | PAIRING | Approve a device pairing | `{ deviceId: string }` |
| `device.pair.reject`  | PAIRING | Reject a device pairing  | `{ deviceId: string }` |
| `device.pair.remove`  | PAIRING | Remove a paired device   | `{ deviceId: string }` |
| `device.token.rotate` | PAIRING | Rotate a device token    | `{ deviceId: string }` |
| `device.token.revoke` | PAIRING | Revoke a device token    | `{ deviceId: string }` |

---

## ClawHub

| Method              | Scope | Description                       | Key Params                           |
| ------------------- | ----- | --------------------------------- | ------------------------------------ |
| `clawhub.catalog`   | READ  | Browse the ClawHub plugin catalog | `{ query?: string }`                 |
| `clawhub.installed` | READ  | List installed ClawHub plugins    | `{}`                                 |
| `clawhub.inspect`   | WRITE | Inspect a plugin before install   | `{ name: string, version?: string }` |
| `clawhub.sync`      | WRITE | Sync catalog from remote          | `{}`                                 |
| `clawhub.download`  | ADMIN | Download a plugin package         | `{ name: string, version?: string }` |
| `clawhub.uninstall` | ADMIN | Uninstall a ClawHub plugin        | `{ name: string }`                   |

---

## Projects

| Method                   | Scope | Description                       | Key Params                           |
| ------------------------ | ----- | --------------------------------- | ------------------------------------ |
| `projects.list`          | READ  | List all projects                 | `{}`                                 |
| `projects.get`           | READ  | Get a project by id               | `{ id: string }`                     |
| `projects.getContext`    | READ  | Get project context for agent use | `{ id: string }`                     |
| `projects.add`           | ADMIN | Create a new project              | `{ name: string, context?: string }` |
| `projects.update`        | ADMIN | Update project metadata           | `{ id: string, patch: object }`      |
| `projects.archive`       | ADMIN | Archive a project                 | `{ id: string }`                     |
| `projects.bindSession`   | ADMIN | Bind a session key to a project   | `{ id: string, sessionKey: string }` |
| `projects.unbindSession` | ADMIN | Unbind a session from a project   | `{ id: string, sessionKey: string }` |

---

## Agent Marketplace

| Method                               | Scope | Description                       | Key Params                              |
| ------------------------------------ | ----- | --------------------------------- | --------------------------------------- |
| `agents.marketplace.browse`          | READ  | Browse marketplace agents         | `{ query?: string, registry?: string }` |
| `agents.marketplace.installed`       | READ  | List installed marketplace agents | `{}`                                    |
| `agents.marketplace.get`             | READ  | Get marketplace agent details     | `{ id: string }`                        |
| `agents.marketplace.registries`      | READ  | List configured registries        | `{}`                                    |
| `agents.marketplace.bundles`         | READ  | List agent bundles                | `{}`                                    |
| `agents.marketplace.health`          | READ  | Check health of installed agents  | `{}`                                    |
| `agents.marketplace.health.fix`      | WRITE | Auto-fix agent health issues      | `{ id: string }`                        |
| `agents.marketplace.update`          | WRITE | Update a marketplace agent        | `{ id: string }`                        |
| `agents.marketplace.enable`          | WRITE | Enable a marketplace agent        | `{ id: string }`                        |
| `agents.marketplace.disable`         | WRITE | Disable a marketplace agent       | `{ id: string }`                        |
| `agents.marketplace.generate`        | WRITE | Generate an agent from a prompt   | `{ prompt: string }`                    |
| `agents.marketplace.create`          | ADMIN | Create and register a new agent   | `{ definition: object }`                |
| `agents.marketplace.remove`          | ADMIN | Remove a marketplace agent        | `{ id: string }`                        |
| `agents.marketplace.sync`            | ADMIN | Sync all registries               | `{}`                                    |
| `agents.marketplace.bundle.install`  | ADMIN | Install an agent bundle           | `{ id: string }`                        |
| `agents.marketplace.bundle.create`   | ADMIN | Create a new bundle               | `{ name: string, agentIds: string[] }`  |
| `agents.marketplace.bundle.update`   | ADMIN | Update a bundle                   | `{ id: string, patch: object }`         |
| `agents.marketplace.bundle.delete`   | ADMIN | Delete a bundle                   | `{ id: string }`                        |
| `agents.marketplace.registry.add`    | ADMIN | Add a registry source             | `{ url: string, name?: string }`        |
| `agents.marketplace.registry.remove` | ADMIN | Remove a registry source          | `{ name: string }`                      |

---

## Teams

| Method                  | Scope | Description                  | Key Params                                            |
| ----------------------- | ----- | ---------------------------- | ----------------------------------------------------- |
| `teamRuns.create`       | WRITE | Create a team run            | `{ name: string, members?: string[] }`                |
| `teamRuns.list`         | READ  | List team runs               | `{ limit?: number }`                                  |
| `teamRuns.get`          | READ  | Get a team run               | `{ id: string }`                                      |
| `teamRuns.complete`     | WRITE | Mark a team run as complete  | `{ id: string, result?: unknown }`                    |
| `teamRuns.addMember`    | WRITE | Add a member to a team run   | `{ id: string, agentId: string, role?: string }`      |
| `teamRuns.updateMember` | WRITE | Update a team run member     | `{ id: string, agentId: string, patch: object }`      |
| `teamRuns.delete`       | ADMIN | Delete a team run            | `{ id: string }`                                      |
| `teamRuns.sweep`        | ADMIN | Sweep stale team runs        | `{}`                                                  |
| `teamTasks.create`      | WRITE | Create a task in a team run  | `{ runId: string, title: string, assignee?: string }` |
| `teamTasks.list`        | READ  | List tasks for a team run    | `{ runId: string }`                                   |
| `teamTasks.update`      | WRITE | Update a task                | `{ id: string, patch: object }`                       |
| `teamTasks.delete`      | ADMIN | Delete a task                | `{ id: string }`                                      |
| `teamMessages.send`     | WRITE | Send a message in a team run | `{ runId: string, content: string }`                  |
| `teamMessages.list`     | READ  | List messages for a team run | `{ runId: string, limit?: number }`                   |
| `teamMessages.markRead` | WRITE | Mark messages as read        | `{ runId: string, upToId?: string }`                  |

---

## Slash Commands

| Method             | Scope | Description                      | Key Params                               |
| ------------------ | ----- | -------------------------------- | ---------------------------------------- |
| `commands.list`    | READ  | List registered slash commands   | `{ scope?: "user" \| "agent" \| "all" }` |
| `commands.get`     | READ  | Get a command by name            | `{ name: string }`                       |
| `commands.getBody` | READ  | Get full command body (markdown) | `{ name: string }`                       |
| `commands.create`  | ADMIN | Create a new user command        | `{ name: string, body: string, ... }`    |
| `commands.update`  | ADMIN | Update a user command            | `{ name: string, patch: object }`        |
| `commands.delete`  | ADMIN | Delete a user command            | `{ name: string }`                       |
| `commands.invoke`  | WRITE | Execute a slash command          | `{ name: string, args?: string }`        |

---

## State DB

Direct read/write access to the SQLite state database (`operator1.db`). These methods let agents and tools introspect live state without spawning a CLI subprocess.

| Method                | Scope | Description                                          | Key Params                                                                                  |
| --------------------- | ----- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `state.info`          | READ  | DB path, file size, schema version, integrity status | `{}`                                                                                        |
| `state.tables`        | READ  | All tables with row counts and sensitivity flags     | `{}`                                                                                        |
| `state.schema`        | READ  | CREATE TABLE DDL for a specific table                | `{ table: string }`                                                                         |
| `state.inspect`       | READ  | Paginated row browser for a table                    | `{ table: string, limit?: number, offset?: number, columns?: string[] }`                    |
| `state.query`         | READ  | Execute a read-only SQL SELECT statement             | `{ sql: string, limit?: number }`                                                           |
| `state.settings.list` | READ  | List all settings in a store/scope                   | `{ store: "core" \| "op1", scope?: string }`                                                |
| `state.settings.get`  | READ  | Read a single setting by scope + key                 | `{ store: "core" \| "op1", scope: string, key: string }`                                    |
| `state.settings.set`  | ADMIN | Write/upsert a setting                               | `{ store: "core" \| "op1", scope: string, key: string, value: unknown }`                    |
| `state.audit`         | READ  | Query the audit_state trail                          | `{ table?: string, action?: "INSERT"\|"UPDATE"\|"DELETE", since?: number, limit?: number }` |
| `state.export`        | READ  | Export one or all tables as JSON                     | `{ table?: string }`                                                                        |

### Notes

- `state.query` only accepts `SELECT` (or `WITH … SELECT`) statements. Multi-statement queries (semicolons), `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, and `ATTACH` are rejected.
- Row results are capped at 1000 rows; default is 100. Use `limit` to control.
- `auth_credentials` is flagged as `sensitive: true` in `state.tables` responses. Use `state.inspect` on it only when you have explicit admin intent.
- Settings stores: `"core"` = `core_settings` table (device, voicewake, TTS, etc.); `"op1"` = `op1_settings` table (heartbeat state, generic KV).

---

## Wizard

| Method          | Scope | Description             | Key Params            |
| --------------- | ----- | ----------------------- | --------------------- |
| `wizard.start`  | ADMIN | Start onboarding wizard | `{}`                  |
| `wizard.next`   | ADMIN | Advance wizard step     | `{ answer?: string }` |
| `wizard.cancel` | ADMIN | Cancel active wizard    | `{}`                  |
| `wizard.status` | ADMIN | Get wizard state        | `{}`                  |

---

## Web Login

| Method            | Scope | Description                   | Key Params                                 |
| ----------------- | ----- | ----------------------------- | ------------------------------------------ |
| `web.login.start` | ADMIN | Start web provider login flow | `{ provider: string }`                     |
| `web.login.wait`  | ADMIN | Wait for web login completion | `{ provider: string, timeoutMs?: number }` |

---

## Gateway Events

These are server-push events (not RPC calls) the gateway broadcasts to connected clients:

| Event                     | Description                     |
| ------------------------- | ------------------------------- |
| `agent`                   | Agent turn output stream        |
| `chat`                    | WebChat message stream          |
| `presence`                | Presence beacon update          |
| `tick`                    | Gateway heartbeat tick          |
| `health`                  | Health state change             |
| `heartbeat`               | Heartbeat signal                |
| `cron`                    | Cron job fired                  |
| `talk.mode`               | Talk mode changed               |
| `shutdown`                | Gateway shutting down           |
| `connect.challenge`       | Device auth challenge           |
| `node.pair.requested`     | Node pairing request received   |
| `node.pair.resolved`      | Node pairing approved/rejected  |
| `node.invoke.request`     | Node invocation dispatched      |
| `device.pair.requested`   | Device pairing request received |
| `device.pair.resolved`    | Device pairing resolved         |
| `voicewake.changed`       | Voice wake config updated       |
| `exec.approval.requested` | Exec approval requested         |
| `exec.approval.resolved`  | Exec approval resolved          |
| `update.available`        | Gateway update available        |

---

## RPC vs script boundaries

| Use RPC when                | Use a script when         |
| --------------------------- | ------------------------- |
| Real-time response needed   | Batch or async processing |
| UI integration required     | File system operations    |
| Gateway state access needed | External tool invocation  |
| Low latency is critical     | Long-running operations   |
| Multi-agent coordination    | Local validation only     |

---

## Related

- [Architecture](/operator1/architecture) — system design overview
- [Sub-Agent Spawning](/operator1/spawning) — how `agent` and `sessions` are used in practice
- [Configuration](/operator1/configuration) — config RPC usage and hot reload
