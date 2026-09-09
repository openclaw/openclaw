---
summary: "tools.agentToAgent, tools.sessions visibility, sessions_spawn attachments, and subagent defaults"
read_when:
  - Restricting which agents may reach each other
  - Narrowing which sessions the session tools can see
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
    - `self` remains strict for main. Incognito denial remains absolute. Narrowing visibility to `agent`, `tree`, or `self` blocks ordinary cross-agent access; `tree` also permits owned native/ACP children across agent boundaries. `agent` does not include that exception, so keep explicit `tree` if your workflow relies on it.
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
    - Subagent attachments are materialized into the child workspace at `.openclaw/attachments/<uuid>/` with a `.manifest.json`.
    - ACP attachments are image-only and forwarded inline to the ACP runtime after the same file count, per-file byte, and total byte limits pass.
    - Attachment content is automatically redacted from transcript persistence.
    - Base64 inputs are validated with strict alphabet/padding checks and a pre-decode size guard.
    - Subagent attachment file permissions are `0700` for directories and `0600` for files.
    - Subagent cleanup follows the `cleanup` policy: `delete` always removes attachments; `keep` retains them only when `retainOnSessionKeep: true`.

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
- `maxConcurrent`: max concurrent sub-agent runs. Default: `8`.
- `runTimeoutSeconds`: timeout (seconds) for `sessions_spawn` when the caller does not pass its own override. Default: `0` (no timeout); the `900` shown above is a common opt-in value, not the built-in default.
- `announceTimeoutMs`: per-call timeout (milliseconds) for gateway `agent` announce delivery attempts. Default: `120000`. Transient retries can make the total announce wait longer than one configured timeout.
- `archiveAfterMinutes`: minutes after a sub-agent session completes before it is auto-archived. Default: `60`; `0` disables auto-archive.
- Per-subagent tool policy: `tools.subagents.tools.allow` / `tools.subagents.tools.deny`.
