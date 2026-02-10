---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Agent session tools for listing sessions, fetching history, and sending cross-session messages"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding or modifying session tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Session Tools"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Session Tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Goal: small, hard-to-misuse tool set so agents can list sessions, fetch history, and send to another session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool Names（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessions_list`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessions_history`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessions_send`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessions_spawn`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Key Model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Main direct chat bucket is always the literal key `"main"` (resolved to the current agent’s main key).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group chats use `agent:<agentId>:<channel>:group:<id>` or `agent:<agentId>:<channel>:channel:<id>` (pass the full key).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron jobs use `cron:<job.id>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Hooks use `hook:<uuid>` unless explicitly set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node sessions use `node-<nodeId>` unless explicitly set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`global` and `unknown` are reserved values and are never listed. If `session.scope = "global"`, we alias it to `main` for all tools so callers never see `global`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## sessions_list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
List sessions as an array of rows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Parameters:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `kinds?: string[]` filter: any of `"main" | "group" | "cron" | "hook" | "node" | "other"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `limit?: number` max rows (default: server default, clamp e.g. 200)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `activeMinutes?: number` only sessions updated within N minutes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `messageLimit?: number` 0 = no messages (default 0); >0 = include last N messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `messageLimit > 0` fetches `chat.history` per session and includes the last N messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool results are filtered out in list output; use `sessions_history` for tool messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When running in a **sandboxed** agent session, session tools default to **spawned-only visibility** (see below).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Row shape (JSON):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `key`: session key (string)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `kind`: `main | group | cron | hook | node | other`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `displayName` (group display label if available)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `updatedAt` (ms)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessionId`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `model`, `contextTokens`, `totalTokens`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sendPolicy` (session override if set)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `lastChannel`, `lastTo`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `deliveryContext` (normalized `{ channel, to, accountId }` when available)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `transcriptPath` (best-effort path derived from store dir + sessionId)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `messages?` (only when `messageLimit > 0`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## sessions_history（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fetch transcript for one session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Parameters:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessionKey` (required; accepts session key or `sessionId` from `sessions_list`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `limit?: number` max messages (server clamps)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `includeTools?: boolean` (default false)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `includeTools=false` filters `role: "toolResult"` messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Returns messages array in the raw transcript format.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When given a `sessionId`, OpenClaw resolves it to the corresponding session key (missing ids error).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## sessions_send（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Send a message into another session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Parameters:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessionKey` (required; accepts session key or `sessionId` from `sessions_list`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message` (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timeoutSeconds?: number` (default >0; 0 = fire-and-forget)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timeoutSeconds = 0`: enqueue and return `{ runId, status: "accepted" }`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timeoutSeconds > 0`: wait up to N seconds for completion, then return `{ runId, status: "ok", reply }`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If wait times out: `{ runId, status: "timeout", error }`. Run continues; call `sessions_history` later.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the run fails: `{ runId, status: "error", error }`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Announce delivery runs after the primary run completes and is best-effort; `status: "ok"` does not guarantee the announce was delivered.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Waits via gateway `agent.wait` (server-side) so reconnects don't drop the wait.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent-to-agent message context is injected for the primary run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- After the primary run completes, OpenClaw runs a **reply-back loop**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Round 2+ alternates between requester and target agents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Reply exactly `REPLY_SKIP` to stop the ping‑pong.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Max turns is `session.agentToAgent.maxPingPongTurns` (0–5, default 5).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Once the loop ends, OpenClaw runs the **agent‑to‑agent announce step** (target agent only):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Reply exactly `ANNOUNCE_SKIP` to stay silent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Any other reply is sent to the target channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Announce step includes the original request + round‑1 reply + latest ping‑pong reply.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Channel Field（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For groups, `channel` is the channel recorded on the session entry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For direct chats, `channel` maps from `lastChannel`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For cron/hook/node, `channel` is `internal`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If missing, `channel` is `unknown`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security / Send Policy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Policy-based blocking by channel/chat type (not per session id).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "session": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "sendPolicy": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "rules": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "match": { "channel": "discord", "chatType": "group" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "action": "deny"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "default": "allow"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Runtime override (per session entry):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sendPolicy: "allow" | "deny"` (unset = inherit config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Settable via `sessions.patch` or owner-only `/send on|off|inherit` (standalone message).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enforcement points:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `chat.send` / `agent` (gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- auto-reply delivery logic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## sessions_spawn（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Spawn a sub-agent run in an isolated session and announce the result back to the requester chat channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Parameters:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `task` (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `label?` (optional; used for logs/UI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agentId?` (optional; spawn under another agent id if allowed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `model?` (optional; overrides the sub-agent model; invalid values error)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `runTimeoutSeconds?` (default 0; when set, aborts the sub-agent run after N seconds)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cleanup?` (`delete|keep`, default `keep`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Allowlist:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list[].subagents.allowAgents`: list of agent ids allowed via `agentId` (`["*"]` to allow any). Default: only the requester agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Discovery:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `agents_list` to discover which agent ids are allowed for `sessions_spawn`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Starts a new `agent:<agentId>:subagent:<uuid>` session with `deliver: false`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sub-agents default to the full tool set **minus session tools** (configurable via `tools.subagents.tools`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sub-agents are not allowed to call `sessions_spawn` (no sub-agent → sub-agent spawning).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Always non-blocking: returns `{ status: "accepted", runId, childSessionKey }` immediately.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- After completion, OpenClaw runs a sub-agent **announce step** and posts the result to the requester chat channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reply exactly `ANNOUNCE_SKIP` during the announce step to stay silent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Announce replies are normalized to `Status`/`Result`/`Notes`; `Status` comes from runtime outcome (not model text).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sub-agent sessions are auto-archived after `agents.defaults.subagents.archiveAfterMinutes` (default: 60).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Announce replies include a stats line (runtime, tokens, sessionKey/sessionId, transcript path, and optional cost).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Sandbox Session Visibility（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sandboxed sessions can use session tools, but by default they only see sessions they spawned via `sessions_spawn`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sandbox: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        // default: "spawned"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        sessionToolsVisibility: "spawned", // or "all"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
