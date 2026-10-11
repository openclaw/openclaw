---
summary: "tools.agentToAgent, tools.sessions visibility, sessions_spawn attachments, and subagent defaults"
read_when:
  - Restricting which agents may reach each other
  - Narrowing which sessions the session tools can see
  - Allowing one agent to message another without reading its history
  - Setting subagent concurrency, timeouts, or attachment limits
title: "Configuration — cross-agent, session, and subagent tools"
---

How far the session and subagent tools reach: which agents may call each other, which sessions they can target, and the defaults applied to spawned sub-agents.

## `tools.agentToAgent`

```json5
{
  tools: {
    agentToAgent: {
      allow: ["home", "work"],
    },
  },
}
```

Cross-agent access is on by default. `enabled` (default `true`) gates cross-agent session tool calls: `sessions_send` to another agent, and cross-agent `sessions_list`, `sessions_history`, `sessions_search`, and status reads under the default `tools.sessions.visibility: "all"`. Set `enabled: false` to turn cross-agent access off. Same-agent access never consults this policy. Requester-owned native subagent and ACP child sessions are the one exception: under `tree` or `all` visibility they stay reachable across agent boundaries before this policy is consulted, including with `enabled: false`.

`allow` lists the agent ids or `*` patterns that may take part in a cross-agent call. Both the requesting agent and the target agent must match an entry. Exact ids are case-sensitive; wildcard patterns are case-insensitive.

<Note>
An omitted or empty `allow` counts as unset: with agent-to-agent access enabled by default, every agent can reach every other agent. List every participating agent, requester and target alike, to restrict cross-agent access, as in the example above. A list containing only blank entries denies all cross-agent calls. Deleting an agent (`openclaw agents delete`) prunes its id from `allow`; if that empties the list, the policy falls back to allow-all, so re-check `allow` after removing agents.
</Note>

### Per-agent send-only access

Use `agents.entries.<agentId>.tools.agentToAgent.send` to let one agent send
requests to selected agents without widening session visibility. It does not
remove existing read access: keep `tools.sessions.visibility` below `all` when
you want send-only access. For example, let `specialist` ask `ops` for help
without granting direct cross-agent history access:

```json5
{
  tools: {
    agentToAgent: { enabled: true, allow: ["specialist", "ops"] },
    sessions: { visibility: "agent" },
  },
  agents: {
    ownership: "explicit",
    entries: {
      specialist: {
        tools: { agentToAgent: { send: ["ops"] } },
      },
      ops: {
        tools: { agentToAgent: { send: [] } },
      },
    },
  },
}
```

`specialist` can use `sessions_send` to reach `ops` and receive the reply to
that sent turn, even though `ops` has `send: []`. `ops` cannot initiate ordinary
cross-agent sends. Neither agent gains direct access to the other agent's history.
The `sessions_send` tool must still be enabled by the caller's effective tool policy.
The specialist can address the configured agent directly; it does not need to
list the ops agent's sessions first. Call `sessions_send` with:

```json
{ "agentId": "ops", "message": "Please check the service status." }
```

`send` is an optional string array:

- **Omitted `send`:** preserves the global `tools.agentToAgent` policy and
  `tools.sessions.visibility` checks for sends.
- **`send: []`:** denies ordinary cross-agent sends from that agent, even under
  `visibility: "all"`. Unlike the global `allow`, an empty `send` is not allow-all.
- **Target IDs or `*` patterns:** only matching target agents can receive ordinary
  cross-agent sends from that requester. A match permits `sessions_send` even
  under `self`, `tree`, or `agent` visibility; it does not widen other tools.
  Use `["*"]` for any target agent. Deleting an agent prunes its exact ID from
  these lists; an emptied list remains `[]` (deny), and wildcard rules remain.
- **Global policy still applies:** `enabled: false` or an `allow` list excluding
  either requester or target denies the send. This is an outgoing policy, not a
  per-target receive policy.
- **Existing boundaries remain:** same-agent sends still obey visibility.
  Requester-owned native/ACP child access is unchanged. Incognito restrictions
  and the sandbox spawned-session clamp still apply, including to sandboxed
  subagents; `send` cannot reach outside that clamp.
- **Changes before delivery:** the Gateway rechecks the current send policy after
  asynchronous preparation and immediately before accepting the target input.
  Withdrawing a destination blocks sends that have not been accepted; it does
  not retract already accepted input or its owed reply.
- **Replies, not history:** the reply belongs to the authorized sent turn.
  `send` does not grant list, history, search, status, or session-control access.
  `watch: true` additionally requires normal status visibility; send-only access
  cannot subscribe to otherwise hidden session state.

<Warning>
Send-only access is permission to ask the target agent to act. It does not prevent
a privileged target from disclosing data in its reply or executing an untrusted
request. Keep target tools and instructions appropriate for incoming requests;
use separate Gateways for strong isolation. See [Security trust model](/gateway/security/trust-model).
</Warning>

## `tools.sessions`

Controls which sessions can be targeted by the session tools (`sessions_list`, `sessions_history`, `sessions_search`, `sessions_send`, `session_status`).

Default: `all` (every session on the Gateway, including other agents' and other
users' transcripts). Cross-agent access is governed by `tools.agentToAgent` and
is on by default. Use `agent`, `tree`, or `self` to narrow visibility.

```json5
{
  tools: {
    sessions: {
      // "self" | "tree" | "agent" | "all"
      visibility: "all",
      // Opt in to sessions_send targets in threads/topics (default false)
      allowThreadTargets: false,
    },
  },
}
```

<AccordionGroup>
  <Accordion title="Visibility scopes">
    - `self`: only the current session key.
    - `tree`: current session + sessions spawned by the current session (subagents). When the caller is the canonical main session, it includes every same-agent session for list, history, search, send, and status.
    - `agent`: any session belonging to the current agent id (can include other users if you run per-sender sessions under the same agent id).
    - `all`: any session. Cross-agent targeting is governed by `tools.agentToAgent`, which is on by default.
    - `self` has no main-session visibility exception. Incognito denial remains absolute. Narrowing visibility to `agent`, `tree`, or `self` blocks ordinary cross-agent access unless a per-agent `tools.agentToAgent.send` rule permits a send-only exception. `tree` also permits owned native/ACP children across agent boundaries. `agent` does not include that child exception, so keep explicit `tree` if your workflow relies on it.
    - Sandbox clamp: when the current session is sandboxed and `agents.defaults.sandbox.sessionToolsVisibility="spawned"` (the default), access stays limited to spawned sessions even if the caller is main or `tools.sessions.visibility="all"`.
    - When not `all`, `sessions_list` includes a compact `visibility` field
      describing the effective mode and a warning that some sessions may be
      omitted outside the current scope.

  </Accordion>
</AccordionGroup>

Ambient group watches still queue activity notices and tell the main session
where something happened. They do not grant access. The default `all` scope
already covers sessions across agents, including conversations with other users.
A per-peer `session.dmScope` separates DM context but does not restrict session
tools. For narrower access, explicitly choose `agent`, `tree`, or `self`, or
restrict agent pairs with `tools.agentToAgent.allow`. Set
`tools.agentToAgent.enabled: false` to block ordinary cross-agent access; requester-owned native subagent and ACP child sessions stay reachable under `tree` or `all`. `tree` retains the
canonical main-session exception; `self` restricts even main to its current session.

## `tools.sessions_spawn`

Controls inline attachment support for `sessions_spawn`.

```json5
{
  tools: {
    sessions_spawn: {
      attachments: {
        enabled: false, // opt-in: set true to allow inline file attachments
        maxTotalBytes: 5242880, // 5 MB total across all files
        maxFiles: 50,
        maxFileBytes: 1048576, // 1 MB per file
        retainOnSessionKeep: false, // keep attachments when cleanup="keep"
      },
    },
  },
}
```

<AccordionGroup>
  <Accordion title="Attachment notes">
    - Attachments require `enabled: true`.
    - Subagent attachments are staged in Gateway-owned state with a `.manifest.json`; they are never written through the child workspace.
    - Sandboxed children receive only their session-owned attachments read-only at `/openclaw/attachments/<uuid>/`. Attachment-bearing agent-scoped sessions use a dedicated runtime so sibling guests cannot inherit the projection. Shared-scope sandboxes and backends without read-only resource projection reject attachment-bearing spawns before staging.
    - Unsandboxed children receive the absolute Gateway-owned path and can read it through workspace-scoped file/media tools.
    - ACP attachments are image-only and forwarded inline to the ACP runtime after the same file count, per-file byte, and total byte limits pass.
    - Attachment content is automatically redacted from transcript persistence.
    - Base64 inputs are validated with strict alphabet/padding checks and a pre-decode size guard.
    - Subagent attachment file permissions are `0700` for directories and `0600` for files.
    - Subagent cleanup follows the `cleanup` policy: `delete` always removes attachments; `keep` retains them only when `retainOnSessionKeep: true`.
    - Upgrading from a pre-`readOnlyResourceMounts` release: previously staged attachments remain in their child workspaces at `.openclaw/attachments/<uuid>/`. Their registry records retire without deleting or traversing those files, so remove leftovers with your normal workspace cleanup. New spawns stage in Gateway-owned state; the child prompt path is the only usable filesystem location. The attachment receipt's `relDir` is a retained identifier, not a usable location, and must not be resolved.

  </Accordion>
</AccordionGroup>

## `agents.defaults.subagents`

```json5
{
  agents: {
    defaults: {
      subagents: {
        allowAgents: ["research"],
        model: "minimax/MiniMax-M2.7",
        maxConcurrent: 8,
        runTimeoutSeconds: 900,
        announceTimeoutMs: 120000,
        archiveAfterMinutes: 60,
      },
    },
  },
}
```

- `model`: default model for spawned sub-agents. If omitted, sub-agents inherit the caller's model.
- `allowAgents`: default allowlist of configured target agent ids for `sessions_spawn` when the requester agent does not set its own `subagents.allowAgents` (`["*"]` = any configured target; default: same agent only). Stale entries whose agent config was deleted are rejected by `sessions_spawn` and omitted from `agents_list`; run `openclaw doctor --fix` to clean them up.
- `maxConcurrent`: max concurrent ordinary sub-agent runs per immediate spawning/controller session. Default: `8`; independent sessions do not share this budget. Swarm collector children use `tools.swarm.maxConcurrent` instead. Codex-native subagents use Codex's separate scheduler and limits.
- `maxChildrenPerAgent`: separate admission limit on active children per session. Default: `5`; raising `maxConcurrent` does not raise this limit.
- `runTimeoutSeconds`: timeout (seconds) for `sessions_spawn` when the caller does not pass its own override. Default: `0` (no timeout); the `900` shown above is a common opt-in value, not the built-in default.
- `announceTimeoutMs`: per-call timeout (milliseconds) for gateway `agent` announce delivery attempts. Default: `120000`. Transient retries can make the total announce wait longer than one configured timeout.
- `archiveAfterMinutes`: minutes after a sub-agent session completes before it is auto-archived. Default: `60`; `0` disables auto-archive.
- Per-subagent tool policy: `tools.subagents.tools.allow` / `tools.subagents.tools.deny`.

## `tools.swarm`

Swarm is enabled by default. Collector children (`collect: true`) run in a
dedicated `subagent:swarm:<schedulerGroupKey>` lane, with the group's resolved
`maxConcurrent` cap. They leave the parent's ordinary sub-agent lane available.
Ordinary children spawned by a collector use that collector's own session lane.

```json5
{
  tools: {
    swarm: {
      maxConcurrent: 32,
      maxChildrenPerGroup: 50,
      maxTotalPerGroup: 200,
    },
  },
}
```

`maxConcurrent` defaults to `32` and accepts integers from `1` to `1000`.
Each running child costs one model stream and one Code Mode worker isolate.
The separate `maxChildrenPerGroup` and `maxTotalPerGroup` admission limits
remain `50` live children and `200` lifetime spawns per group by default.
See [Swarm configuration](/tools/swarm#enable-swarm) for all settings and
per-agent overrides.
