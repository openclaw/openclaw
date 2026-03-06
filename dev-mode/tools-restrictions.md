# Tool Restrictions Breakdown (SEC-16)

This document breaks down every layer of tool restrictions in OpenClaw, explaining what each one does and what tools it blocks.

---

## 1. Tool Profiles (the starting gate)

**Source:** `src/agents/tool-catalog.ts` lines 248-259

A profile is the first filter. It defines a whitelist - only tools in the profile's `allow` list are available. If no profile is set, all tools pass through.

**Hardcoded default:** Since SEC-59 (v2026.3.2), the onboarding wizard sets `tools.profile` to `"messaging"` for new local installs (`src/commands/onboard-config.ts` line 6). Before SEC-59, there was NO default profile in code - all tools were available (equivalent to `"full"`).

There are 4 profiles:

### `minimal`

**Allowed tools:** `session_status` (1 tool only)
Everything else is blocked. This is the most locked-down profile.

### `coding`

**Allowed tools:** `read`, `write`, `edit`, `apply_patch`, `exec`, `process`, `memory_search`, `memory_get`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `subagents`, `session_status`, `cron`, `image` (16 tools)
Covers file ops, shell, memory, sessions, scheduling, and image. Does NOT include: `web_search`, `web_fetch`, `browser`, `canvas`, `message`, `gateway`, `nodes`, `agents_list`, `tts`.

### `messaging`

**Allowed tools:** `sessions_list`, `sessions_history`, `sessions_send`, `session_status`, `message` (5 tools)
Only session management and messaging. No file ops, no shell, no web.

### `full`

**Allowed tools:** everything (no allow/deny list = no filtering)

**How it's applied:** Set via `tools.profile` in config (global) or `agents.<id>.tools.profile` (per-agent). The agent-level profile overrides global.

---

## 2. Provider-Based Policies

**Source:** `src/agents/pi-tools.policy.ts` lines 159-197

You can restrict tools per AI model provider. Config key: `tools.byProvider.<provider>` or `agents.<id>.tools.byProvider.<provider>`.

The provider key can be:

- A provider name like `openai`, `anthropic`
- A full model ID like `openai/gpt-4`

Each entry can have its own `allow`, `deny`, `alsoAllow`, and `profile` fields. This means you could, for example, deny `exec` for all OpenAI models while allowing it for Anthropic.

Provider policies stack on top of profile policies in the pipeline.

**Hardcoded defaults:** NONE. There are no hardcoded per-provider restrictions in the code. This is purely config-driven. If nothing is set in `tools.byProvider`, no provider-based filtering happens.

---

## 3. Global Tool Policy (`tools.allow` / `tools.deny`)

**Source:** `src/agents/pi-tools.policy.ts` lines 231

Set in config as `tools.allow` and/or `tools.deny`. Applied to ALL agents and sessions.

- `tools.allow` = whitelist (only these tools available)
- `tools.deny` = blacklist (these tools removed)
- `tools.alsoAllow` = additive, extends the profile without replacing it

**Hardcoded defaults:** NONE. There are no hardcoded global allow/deny lists in the code. If nothing is set in `tools.allow` or `tools.deny`, no global filtering happens.

---

## 4. Per-Agent Tool Policy (`agents.<id>.tools.allow/deny`)

**Source:** `src/agents/pi-tools.policy.ts` lines 233

Same as global but scoped to a specific agent ID. Allows locking down specific agents to fewer tools.

**Hardcoded defaults:** NONE. Purely config-driven per agent.

---

## 5. Group/Channel Tool Policy

**Source:** `src/agents/pi-tools.policy.ts` lines 251-308

When a message comes from a group chat (WhatsApp group, Slack channel, etc.), additional restrictions can be applied per group. These are resolved from the channel's "dock" or from `resolveChannelGroupToolsPolicy()`.

This lets admins say "in this Slack channel, only allow `message` and `web_search`."

**Hardcoded defaults:** NONE. Purely config-driven per group/channel.

---

## 6. The Pipeline (how they stack)

**Source:** `src/agents/tool-policy-pipeline.ts` lines 32-62

All policies are applied sequentially. Each step can only REMOVE tools, never add them back. Order:

1. **Profile policy** (e.g., `coding` profile whitelist)
2. **Provider profile policy** (provider-specific profile)
3. **Global policy** (`tools.allow/deny`)
4. **Global provider policy** (`tools.byProvider.<x>.allow/deny`)
5. **Agent policy** (`agents.<id>.tools.allow/deny`)
6. **Agent provider policy** (`agents.<id>.tools.byProvider.<x>.allow/deny`)
7. **Group policy** (channel/group-specific restrictions)

A tool must survive ALL 7 steps. If any step removes it, it's gone.

---

## 7. Gateway HTTP Tool Deny List

**Introduced:** openclaw 2026.2.13 (OC-02 security fix), `cron` added in openclaw 2026.2.24, centralized to `dangerous-tools.ts` in openclaw 2026.2.15

**Source:** `src/security/dangerous-tools.ts` lines 9-20

When tools are invoked via the Gateway HTTP API (`POST /tools/invoke`), these tools are always blocked:

| Tool             | Why                                              |
| ---------------- | ------------------------------------------------ |
| `sessions_spawn` | Spawning agents remotely = remote code execution |
| `sessions_send`  | Cross-session message injection                  |
| `cron`           | Could create persistent scheduled tasks          |
| `gateway`        | Prevents gateway reconfiguration via HTTP        |
| `whatsapp_login` | Interactive (needs QR scan), hangs on HTTP       |

**Hardcoded defaults:** YES - this is a hardcoded deny list in `src/security/dangerous-tools.ts` lines 9-20. These 5 tools are ALWAYS blocked via HTTP unless explicitly overridden by `gateway.tools.allow` in config (see `src/gateway/tools-invoke-http.ts` lines 293-300). There is also a separate `gateway.tools.deny` config that adds MORE tools to the deny list on top of the hardcoded ones.

---

## 8. ACP (Automation Control Plane) Dangerous Tools

**Introduced:** openclaw 2026.2.13 (OC-02 security fix), centralized to `dangerous-tools.ts` in openclaw 2026.2.15

**Simplified-Description:** So it's basically: "when a remote AI agent wants to run exec on your machine through OpenClaw, you have to manually approve it." The DANGEROUS_ACP_TOOLS list forces that approval step. remote AI agent can be remote openclaw, cursor, claude code, ect.

**Source:** `src/security/dangerous-tools.ts` lines 26-37

ACP is an automation API surface. These tools always require explicit user approval when invoked through ACP:

| Tool             | Category                |
| ---------------- | ----------------------- |
| `exec`           | Shell execution         |
| `spawn`          | Process spawning        |
| `shell`          | Shell access            |
| `sessions_spawn` | Sub-agent spawning      |
| `sessions_send`  | Cross-session messaging |
| `gateway`        | Gateway control         |
| `fs_write`       | File writing            |
| `fs_delete`      | File deletion           |
| `fs_move`        | File moving             |
| `apply_patch`    | File patching           |

These aren't blocked outright - they require approval before each use.

**Hardcoded defaults:** YES - this is a hardcoded set in `src/security/dangerous-tools.ts` lines 26-37. These 10 tools always require explicit approval when invoked through the ACP automation surface. Not configurable.

---

## 9. Subagent Tool Deny Lists

**Introduced:** openclaw 2026.2.15 (#14447 - nested subagent orchestration controls)

**Source:** `src/agents/pi-tools.policy.ts` lines 46-66

When the main agent spawns sub-agents, those sub-agents get restricted tools.

### Always denied for ALL sub-agents:

| Tool             | Why                                            |
| ---------------- | ---------------------------------------------- |
| `gateway`        | System admin, dangerous from subagent          |
| `agents_list`    | System admin                                   |
| `whatsapp_login` | Interactive, not a task                        |
| `session_status` | Main agent coordinates this                    |
| `cron`           | Scheduling is main agent's job                 |
| `memory_search`  | Pass info in spawn prompt instead              |
| `memory_get`     | Pass info in spawn prompt instead              |
| `sessions_send`  | Subagents use announce chain, not direct sends |

### Additionally denied for LEAF sub-agents (max depth reached):

| Tool               | Why                   |
| ------------------ | --------------------- |
| `sessions_list`    | No children to manage |
| `sessions_history` | No children to manage |
| `sessions_spawn`   | Can't spawn deeper    |

Orchestrator sub-agents (not at max depth) CAN use `sessions_spawn`, `sessions_list`, `sessions_history` to manage their own children.

The subagent deny list can be partially overridden via `tools.subagents.tools.allow` or `tools.subagents.tools.alsoAllow` in config.

**Hardcoded defaults:** YES - both deny lists are hardcoded in `src/agents/pi-tools.policy.ts` lines 46-66. The 8 always-denied and 3 leaf-denied tools are built into the code. Config can partially override (via `tools.subagents.tools.allow`/`alsoAllow`) but the base lists are hardcoded.

---

## Summary: What SEC-16 dev-mode would disable if implemented all-in

With `--dev-mode`, ALL of the above restrictions could be bypassed:

1. **No profile filtering** - all tools available regardless of profile setting
2. **No provider-based restrictions** - all providers get all tools
3. **No global/agent allow/deny** - config-based restrictions ignored
4. **No group/channel restrictions** - all groups get all tools
5. **No gateway HTTP deny list** - all tools callable via HTTP API
6. **No ACP approval requirement** - dangerous tools auto-approved
7. **No subagent deny lists** - sub-agents get full tool access

This is the most impactful single item on the list because it touches every tool restriction in the system.
