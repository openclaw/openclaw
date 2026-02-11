# Saint.work — Architecture (OpenClaw Soft Fork)

## Overview

Saint runs on OpenClaw with a thin overlay: **one plugin + CLI Porter + a custom sandbox image + ~201 lines of core patches**. OpenClaw handles channels, sessions, memory, skills, cron, compaction, and sub-agents. The Saint plugin adds multi-tenancy, role-based permissions, and usage metering. CLI Porter provides credential isolation — the agent has full exec access but zero access to secrets.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SAINT PLATFORM                               │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    CONTROL PLANE                               │  │
│  │  Provisioning · Billing · Admin Dashboard · Health Monitoring  │  │
│  │  (Separate service — not part of the OpenClaw fork)            │  │
│  └───────────────────────────┬───────────────────────────────────┘  │
│                               │ REST API                            │
│          ┌────────────────────┼────────────────────┐               │
│          │                    │                    │               │
│   ┌──────┴──────┐     ┌──────┴──────┐     ┌──────┴──────┐       │
│   │  Bot: James  │     │  Bot: Emma   │     │  Bot: Oliver │  ... │
│   │  (OpenClaw)  │     │  (OpenClaw)  │     │  (OpenClaw)  │       │
│   │  + Saint     │     │  + Saint     │     │  + Saint     │       │
│   │    Plugin    │     │    Plugin    │     │    Plugin    │       │
│   │  + CLI Porter│     │  + CLI Porter│     │  + CLI Porter│       │
│   └─────────────┘     └─────────────┘     └─────────────┘       │
│                                                                     │
│   Each bot = OpenClaw instance + Saint plugin + CLI Porter          │
│   Own WhatsApp · Own Gmail · Own workspace · Own memory             │
└─────────────────────────────────────────────────────────────────────┘
```

**Codebase note:** The fork is the full TypeScript source (~476K lines, `src/`), not the npm-installed bundle. Patches are in readable, typed code with full IDE support and test coverage.

---

## 1. What OpenClaw Provides (Unchanged)

| Feature | Component | Notes |
|---|---|---|
| **WhatsApp** | whatsapp plugin (Baileys) | QR link, voice notes, media, groups |
| **Discord** | discord plugin (@buape/carbon + discord-api-types) | DMs, servers, threads, reactions |
| **Slack** | slack plugin (Bolt SDK) | Workspaces, channels, threads |
| **Telegram** | telegram plugin (grammy) | Bot token, groups, inline |
| **Sessions** | `dmScope: per-channel-peer` | Per-sender × channel isolation |
| **Identity links** | `session.identityLinks` | Cross-channel identity mapping (see §2.1) |
| **Memory** | SQLite + sqlite-vec embeddings | Hybrid vector + FTS5 keyword search |
| **Skills** | SKILL.md system | Installable knowledge packages |
| **Cron/Heartbeat** | Built-in scheduler | Proactive checks, reminders |
| **Sub-agents** | `sessions_spawn` | Background tasks, delegation |
| **Compaction** | `compaction.mode: safeguard` | Auto-summarise when context fills |
| **Docker sandbox** | Built-in per-agent sandbox | `--network=none`, `--cap-drop=ALL`, read-only root (see §3) |
| **Tool policy** | Multi-layer allow/deny with groups | Per-agent, per-channel, per-sender filtering (see §3) |
| **Browser** | Headless Playwright | Built-in tool with SSRF protection |
| **Media** | Built-in handlers | Images, voice, documents, video |
| **Web search** | Brave Search API (also supports Perplexity, Grok) | Built-in tool |
| **Gateway** | Configurable HTTP server | Bind modes, auth, control UI toggle |

---

## 2. What the Saint Plugin Adds

The `saint-orchestrator` plugin hooks into OpenClaw's lifecycle via its plugin API. It adds multi-tenancy on top of the existing single-tenant system.

### 2.1 Contact Registry

Maps sender identities to roles. Leverages OpenClaw's existing `session.identityLinks` for cross-channel identity resolution and adds role metadata on top.

```json
// /workspace/config/contacts.json
{
  "contacts": [
    {
      "slug": "ana",
      "name": "Ana",
      "role": "owner",
      "identifiers": {
        "phone": "+385991234567",
        "email": "ana@company.hr",
        "discord": "ana#1234"
      }
    },
    {
      "slug": "marko",
      "name": "Marko",
      "role": "manager",
      "identifiers": {
        "phone": "+385991234568",
        "discord": "marko#5678"
      }
    }
  ],
  "defaultRole": "external"
}
```

The corresponding `session.identityLinks` config entries are generated from contacts.json **during provisioning** (not at plugin startup) and written to the OpenClaw config file. This is necessary because OpenClaw reloads config from disk on every inbound message (`loadConfig()` with a 200ms cache), so runtime config mutations from plugin startup would not persist. The provisioning step (control plane or CLI script) generates both contacts.json and the matching identityLinks in the config YAML as a pair. The plugin then maps canonical slugs to roles using contacts.json at runtime.

### 2.2 Role Definitions

```yaml
# /workspace/config/roles.yaml
roles:
  owner:
    description: "Business owner — full access"
    tools: [exec, process, read, write, edit, apply_patch, web_search, web_fetch, browser,
            message, memory_search, memory_get, tts, image, sessions_spawn, sessions_list,
            sessions_history, cron]
    exec_blocklist: []
    memory_scope: [shared, private, daily, own_user, all_users]
    skills: "*"
    max_budget_usd: null
    system_prompt_includes:
      bootstrap: [SOUL.md, IDENTITY.md, AGENTS.md, TOOLS.md, USER.md, HEARTBEAT.md]  # filtered from fixed set
      inject: [COMPANY.md]  # read from workspace, injected via prependContext
    model: claude-sonnet-4-5

  manager:
    description: "Senior employee — broad access, limited destructive ops"
    tools: [exec, read, web_search, web_fetch, message, memory_search, memory_get,
            tts, sessions_spawn, cron]
    exec_blocklist:
      - "gog gmail delete *"
      - "gog drive delete *"
      - "rm -rf *"
    memory_scope: [shared, daily, own_user, all_users]
    skills: "*"
    max_budget_usd: 5.0
    system_prompt_includes:
      bootstrap: [SOUL.md, IDENTITY.md, USER.md]
      inject: []
    model: claude-sonnet-4-5

  employee:
    description: "Standard employee — read + limited exec"
    tools: [exec, read, web_search, web_fetch, message, memory_search]
    exec_blocklist:
      - "gog gmail send *"
      - "gog gmail delete *"
      - "gog calendar delete *"
      - "gog drive delete *"
      - "rm -rf *"
    memory_scope: [shared, own_user]
    skills: [google-workspace, scheduling]
    max_budget_usd: 2.0
    system_prompt_includes:
      bootstrap: [SOUL.md, IDENTITY.md, USER.md]
      inject: []
    model: claude-haiku-4-5

  external:
    description: "Unknown contacts — minimal access"
    tools: [web_search, web_fetch]
    exec_blocklist: null  # no exec at all
    memory_scope: [own_user]
    skills: []
    max_budget_usd: 0.5
    system_prompt_includes:
      bootstrap: [SOUL.md, IDENTITY.md]
      inject: []
    model: claude-haiku-4-5
```

### 2.3 Role Resolution Flow

```
Message arrives (any channel)
    │
    ▼
OpenClaw resolves session via identityLinks
  → Canonical slug (e.g., "ana") or raw sender ID
    │
    ▼
Saint plugin (before_agent_prepare hook, §4.4) resolves role:
  → Lookup slug in contacts.json → role
  → Unknown sender → role: "external"
    │
    ▼
Plugin returns model/tool overrides (before_agent_prepare result):
  → Return tool policy (allow/deny) from role definition
  → Set model override from role (e.g., haiku for external, sonnet for owner)
  → These are applied BEFORE session creation (model in run.ts, tools in attempt.ts)
    │
    ▼
Plugin injects prompt context (before_agent_start hook, fires later):
  → Build role-specific system prompt (filtered boot files via agent:bootstrap)
  → Inject role context via prependContext ("You are talking to Ana (owner)...")
  → Set exec blocklist for before_tool_call enforcement
  → Set memory pathFilter for role's memory_scope
  → Set budget cap
```

### 2.4 System Prompt Assembly

Each role gets a different system prompt. The plugin uses two hooks:

1. **`agent:bootstrap` (internal hook)** — Filters the **fixed** boot file set. The bootstrap loader (`workspace.ts:245-274`) seeds exactly 7-9 files: AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, HEARTBEAT.md, BOOTSTRAP.md, and optional MEMORY.md. `WorkspaceBootstrapFileName` is a TypeScript union type — only these filenames are valid. The hook can **filter down** (remove files) but **cannot add** files like COMPANY.md.
   ```
   Owner:    SOUL.md + IDENTITY.md + AGENTS.md + TOOLS.md + USER.md + HEARTBEAT.md (full set)
   Manager:  SOUL.md + IDENTITY.md + USER.md
   Employee: SOUL.md + IDENTITY.md + USER.md
   External: SOUL.md + IDENTITY.md only
   ```
   **Note on skills:** Skills are loaded separately via `resolveSkillsPromptForRun()`, not through the bootstrap hook — `agent:bootstrap` cannot filter them. This is not a security gap: tool policy (§3.2) hides tools the role can't use, so skill knowledge about hidden tools is inert (the agent can't act on it). The `skills` field in role definitions (§2.2) documents intended skill exposure, enforced indirectly through tool visibility.

2. **`before_agent_start` (plugin hook)** — Injects role-specific context via `prependContext`:
   - "You are talking to Ana (owner). Full access."
   - "You are talking to an unknown contact. Do not reveal internal details."
   - **COMPANY.md content** (for owner/manager roles) — COMPANY.md is NOT in the fixed bootstrap file set, so it's injected here by reading from the workspace at hook time
   - Per-user preferences from `memory/users/<slug>/preferences.md`
   - Blocked commands list
   - Memory write guidance (which directories to use)

   **Note:** `PluginHookBeforeAgentStartResult` defines both `systemPrompt` and `prependContext`, but only `prependContext` is read in `attempt.ts` — `systemPrompt` is dead code in the current codebase. All prompt injection uses `prependContext`.

### 2.5 Usage Metering

The plugin hooks into `after_tool_call` (see §4.3 core patch) to log every tool call:

```json
// /workspace/logs/usage.jsonl
{"ts":"2026-02-10T14:00:00Z","user":"ana","role":"owner","tool":"web_search","params":{"query":"client deadline"},"durationMs":340}
{"ts":"2026-02-10T14:00:01Z","user":"ana","role":"owner","tool":"exec","params":{"command":"gog gmail send ..."},"durationMs":1200,"porter":true}
```

The `after_tool_call` event provides `toolName`, `params`, `result`, `error`, and `durationMs` per call. This enables per-tool metering: counting Brave API hits (`web_search`), Porter CLI calls (`exec` with proxied CLIs), TTS invocations, browser sessions, etc. LLM token costs are tracked separately at session level (from API response metadata, not per tool call). Combined with CLI Porter's audit log for complete billing trails.

---

## 3. Leveraging Existing OpenClaw Infrastructure

Three capabilities in OpenClaw eliminate significant work from the original plan.

### 3.1 Built-in Docker Sandbox (Replaces Shadow Exec Orchestration)

OpenClaw's sandbox system (`src/agents/sandbox/`) provides complete Docker isolation per-agent. Default security:

- `--network=none` — zero network access
- `--cap-drop=ALL` — no privileged operations
- `--read-only` root filesystem
- `--security-opt no-new-privileges`
- Configurable memory/CPU limits, seccomp, AppArmor
- `workspaceAccess: "ro" | "rw" | "none"` — per-agent workspace mount mode
- Container lifecycle management (create, reuse, cleanup, config hash tracking)
- Existing `Dockerfile.sandbox` (Debian bookworm-slim base)

**What Saint adds:** A custom sandbox image with CLI Porter proxy shims, and the Porter unix socket as an extra bind mount. The sandbox orchestration itself is zero new code:

```yaml
# Per-bot OpenClaw config
hooks:
  internal:
    enabled: true              # Required for agent:bootstrap hook to fire

agents:
  defaults:
    sandbox:
      mode: "all"              # "off" | "non-main" | "all"
      workspaceAccess: "ro"    # Real workspace read-only at /agent; sandbox copy writable at /workspace
      docker:
        image: "saint-sandbox:latest"   # Custom image with proxy shims
        network: "none"                 # Already the default
        binds:
          - "/var/run/cliport.sock:/var/run/cliport.sock:ro"
        env: {}                         # No credential env vars (sandbox defaults to LANG=C.UTF-8; PATH/HOME from Docker image)
    tools:
      elevated:
        enabled: false             # CRITICAL: elevated mode lets exec escape sandbox to host. Must be disabled.
      agentToAgent:
        enabled: false             # No inter-agent messaging (each bot is an isolated instance)
```

**Elevated mode must be disabled:** OpenClaw has an "elevated mode" (`tools.elevated`) that allows exec to escape the sandbox and run directly on the host. Default is `elevatedDefault: "on"`. If not explicitly disabled, an agent could bypass all sandbox isolation, access host environment variables (credentials), and execute commands outside the container. This completely undermines the security model. The config above sets `tools.elevated.enabled: false`. The `process` tool (bash alias for exec, part of `group:runtime`) is also implicitly covered — non-owner roles don't include it in their allow list, and the owner has no blocklist. If per-owner restrictions are ever needed, `process` would need its own shadow.

**Sandbox tool policy override:** OpenClaw's sandbox has a `DEFAULT_TOOL_DENY` list (`src/agents/sandbox/constants.ts:28-36`) that blocks `browser`, `cron`, `canvas`, `nodes`, `gateway`, and all channel IDs by default. **Deny always wins over allow** in the policy evaluator (`isToolAllowed()` checks deny first, returns false immediately) — you cannot override this with `tools.allow` alone. To enable browser and cron for Saint bots, the agent config must explicitly override the deny list:

```yaml
agents:
  defaults:
    tools:
      sandbox:
        tools:
          deny: ["canvas", "nodes", "gateway"]  # Removes browser + cron from default deny
```

This replaces `DEFAULT_TOOL_DENY` entirely for this agent (resolution at `tool-policy.ts:111-115` uses agent-level deny if set, otherwise falls back to defaults). No core patch needed — config only.

`workspaceAccess` is set to `"ro"` in static config for all roles (default is `"none"`, so this must be set explicitly). This is simpler and more secure than trying to set mount modes dynamically per-session.

**How `workspaceAccess: "ro"` actually works — two mounts:**

With `"ro"`, OpenClaw creates a **sandbox workspace copy** (seeded with bootstrap .md files + skills only — NOT memory/, config/, or data/) and mounts it as:

| Mount path in sandbox | Content | Access | Lifetime |
|---|---|---|---|
| `/workspace` (workdir) | Sandbox copy (bootstrap files + skills) | **Read-write** | Persists for sandbox scope (`session` / `agent` / `shared`) |
| `/agent` | Real agent workspace (all files) | **Read-only** | Same as above |

- The **real workspace** at `/agent` is always `:ro` — exec cannot write to it.
- The **sandbox copy** at `/workspace` is writable — exec can create/modify files there, but this only affects the copy, not the real workspace.
- **Shadow write/edit tools** operate on the **host filesystem** (the real workspace), enforcing role-based path restrictions (§5.2). Writes via shadow tools are the only way to modify the real workspace.
- **Built-in write/edit tools are removed** in sandbox mode. The mechanism: when sandbox is enabled (any mode), original write/edit are removed (`pi-tools.ts:256-270`). Sandboxed replacements are conditionally added back only if `workspaceAccess !== "ro"` (`pi-tools.ts:316-320`, gated by `allowWorkspaceWrites`). In `"ro"` mode, neither original nor sandboxed write/edit exist — the shadow tools registered by the Saint plugin are the only write path. Exec remains available.
- Exec has **full read access** to the real workspace at `/agent`. This bypasses shadow read path restrictions — see §9.1 for mitigations.
- Writes via exec to the sandbox copy persist for the sandbox scope lifetime (not ephemeral per command). With `scope: "session"`, they last for the session; with `scope: "shared"`, they persist across all sessions.

### 3.2 Tool Policy System (Replaces Shadow Tools for Visibility)

OpenClaw's tool policy (`src/agents/tool-policy.ts`) supports multi-layer allow/deny with glob patterns:

- **Per-agent**: `agents.list[].tools.allow/deny`
- **Per-provider**: `tools.byProvider["anthropic/claude-opus"].allow/deny`
- **Per-channel group**: Channel group-level policies
- **Per-sender within groups**: `toolsBySender` resolves by senderId, senderE164, senderUsername

Tool groups: `group:fs`, `group:runtime`, `group:sessions`, `group:web`, `group:memory`, `group:ui`, `group:automation`, `group:messaging`, `group:nodes`.

Policy is evaluated **dynamically per-session**. Denied tools are removed entirely — the agent can't see them.

**Limitation:** The existing per-sender tool filtering (`toolsBySender`) only works in group chats — it requires a `groupId` and returns nothing for DMs. Since Saint's primary use case is DM sessions, we can't use the built-in per-sender policy for role-based tool filtering.

**What Saint uses:** A new `before_agent_prepare` hook (§4.4 core patch) fires early in `run.ts` — before model resolution and tool creation. The plugin resolves the sender's role and returns a tool allow/deny policy. OpenClaw applies this filter in `attempt.ts` before `createAgentSession()`, so denied tools never enter the session. External users get `tools.allow: ["web_search", "web_fetch"]` — everything else is invisible. No shadow tools needed for visibility.

**What shadow tools are still needed for:** Adding restrictions *within* visible tools — path scoping on read/write/edit, URL restrictions on web_fetch/browser, exec blocklist enforcement, and CLI Porter routing (see §5).

### 3.3 Identity Links (Replaces Cross-Channel Identity Resolution)

OpenClaw's `session.identityLinks` (`src/routing/session-key.ts`) maps canonical user IDs to channel-specific sender IDs:

```yaml
session:
  dmScope: "per-channel-peer"
  identityLinks:
    ana:
      - "whatsapp:+385991234567"
      - "email:ana@company.hr"
    marko:
      - "telegram:222222222"
      - "whatsapp:+385991234568"
```

When `whatsapp:+385991234567` messages the bot, OpenClaw resolves it to canonical ID `ana` and routes to Ana's session.

**What Saint adds:** The `identityLinks` config entries are generated from contacts.json **during provisioning** and written to the config file. OpenClaw reloads config from disk per message (`loadConfig()`, 200ms cache), so identityLinks must be persisted in the config YAML — runtime mutations from plugin startup would not stick. When contacts change, the provisioning step regenerates both contacts.json and identityLinks as a pair. The plugin reads contacts.json at startup for role resolution (canonical slug → role lookup table).

### 3.4 Gateway Dashboard Control (Zero Patches Needed)

The gateway already supports:
- `gateway.controlUi.enabled: false` — disables the web dashboard
- `gateway.bind: "loopback"` — binds to 127.0.0.1 only (default)

For Saint: disable the control UI, bind to loopback only. No core patch needed.

---

## 4. Core Patches (~201 lines, 16-17 files)

Only these require modifying OpenClaw source. Everything else uses existing hooks, config, or new plugin files.

### 4.1 Tool Override with Injected Original (~45 lines, 5 files)

**Files:** `src/plugins/types.ts` (add `override` to `OpenClawPluginToolOptions`), `src/plugins/registry.ts` (propagate to `PluginToolRegistration`), `src/plugins/tools.ts` (track overrides + capture originals in `resolvePluginTools()`), `src/agents/openclaw-tools.ts` (accept pre-existing coding tools, pass to plugin resolution, filter own built-ins at merge), `src/agents/pi-tools.ts` (build coding tools first, pass downstream, filter overridden coding tools before concat)

Currently, plugins that register a tool with the same name as a built-in are silently rejected (the tool is skipped with an error log, and a diagnostic is pushed). This patch adds an `override: true` option that captures the original built-in and passes it to the plugin's tool factory, enabling the decorator/middleware pattern.

**Why this design:** Shadow tools need to add security checks (path scoping, URL blocklists, exec blocklists) and then call through to the original implementation. Injecting the original at registration time means the plugin never imports internal tool modules — zero coupling to OpenClaw's file layout, function signatures, or module structure. Upstream can refactor tool internals freely; as long as the tool's `execute` signature stays the same (which it must, since it's the agent-facing contract), shadows keep working. For tools where no built-in exists (write/edit in `"ro"` sandbox mode — see §3.1), the factory receives `null` and provides its own implementation.

**Why three files matter:** Tools are assembled in two stages. Non-coding built-ins (browser, cron, web_search, etc.) are created in `createOpenClawTools()` (`openclaw-tools.ts`), which calls `resolvePluginTools()` to merge in plugin tools. Coding tools (read, write, edit, exec) are created separately in `createOpenClawCodingTools()` (`pi-tools.ts`) and concatenated later. Without passing the coding tools downstream, `resolvePluginTools()` never sees them in `existingToolNames` — so a plugin overriding `read` or `exec` can't capture the original (the conflict check doesn't fire, the factory gets `undefined` instead of the real tool). The fix: pi-tools.ts builds coding tools first, passes them into `createOpenClawTools()`, which forwards them to `resolvePluginTools()` as pre-existing tools. The override conflict check now works uniformly for all tools. Both merge points (openclaw-tools.ts for non-coding, pi-tools.ts for coding) filter their respective arrays against the override set.

**Note on plugin-ID conflict check:** `resolvePluginTools()` has an additional check (`tools.ts:70-80`) that blocks an entire plugin if its normalized ID matches a built-in tool name. This fires before the per-tool conflict check. Not a concern for `saint-orchestrator` (doesn't match any tool name), but worth knowing when naming plugins.

**Part A — Allow override + capture original in conflict check** (`tools.ts`, line ~107):
```typescript
// Current:
if (nameSet.has(tool.name) || existing.has(tool.name)) {
    log.error(`plugin tool name conflict (${entry.pluginId}): ${tool.name}`);
    continue;
}

// Patched — capture original, track override:
if (nameSet.has(tool.name) || existing.has(tool.name)) {
    if (entry.override === true) {
        const original = existingToolsList.find(t => t.name === tool.name) ?? null;
        registry.overriddenTools.set(tool.name, original);  // Map<string, AgentTool | null>
        existing.delete(tool.name);
    } else {
        log.error(`plugin tool name conflict (${entry.pluginId}): ${tool.name}`);
        continue;
    }
}
```

The `existingToolsList` (built-in tools array — including coding tools passed from pi-tools.ts) is passed into `resolvePluginTools()` alongside the existing `existingToolNames` Set. The captured original is stored in a `Map` (not a `Set`) so it can be retrieved and passed to the plugin factory. Because coding tools are now in this list, overrides on `read`, `exec`, etc. work identically to overrides on `web_search` or `browser`.

**Part A.2 — Pass original to plugin factory** (`tools.ts`, after tool creation ~line 84):
```typescript
// Current:
const toolResult = entry.factory(toolContext);

// Patched — inject original if override:
const original = entry.override ? (registry.overriddenTools.get(tool.name) ?? null) : undefined;
const toolResult = entry.factory(toolContext, original);
```

Plugin factory signature: `(ctx: ToolContext, original?: AgentTool | null) => AgentTool`

**Part B — Accept coding tools + filter non-coding built-ins** (`openclaw-tools.ts`):
```typescript
// Signature change — accept pre-existing coding tools:
export function createOpenClawTools(
    ...,
    preExistingTools?: AgentTool[]   // coding tools from pi-tools.ts
): AgentTool[] {
    // Pass coding tools into resolvePluginTools so overrides see them:
    const allExistingNames = new Set([...existingToolNames, ...(preExistingTools ?? []).map(t => t.name)]);
    const allExistingTools = [...existingToolsList, ...(preExistingTools ?? [])];
    const pluginTools = resolvePluginTools(allExistingNames, allExistingTools, ...);

    // Filter own (non-coding) built-ins:
    const overridden = getOverriddenToolNames();
    const builtins = overridden.size > 0
        ? tools.filter(t => !overridden.has(t.name))
        : tools;
    return [...builtins, ...pluginTools];
}
```

**Part C — Build coding tools first, pass downstream, filter** (`pi-tools.ts`):
```typescript
// Current flow:
//   codingTools = createCodingTools(...)
//   openclawTools = createOpenClawTools(...)   // plugin tools resolved inside, can't see codingTools
//   return [...codingTools, ...openclawTools]

// Patched — pass coding tools downstream so overrides capture originals:
const codingTools = createCodingTools(...);
const openclawTools = createOpenClawTools(..., codingTools);  // coding tools visible to resolvePluginTools()
const overridden = getOverriddenToolNames();
const filteredCoding = overridden.size > 0
    ? codingTools.filter(t => !overridden.has(t.name))
    : codingTools;
return [...filteredCoding, ...openclawTools];
```

Both merge points (Part B for non-coding, Part C for coding) filter against the same override set. A plugin overriding `read` triggers the conflict check in tools.ts (Part A), captures the real `read` tool object, and the duplicates are removed at both merge points. Override-scoped: only tools with `override: true` participate — no accidental hijacking.

**Plugin usage:**
```typescript
// Wrapping an existing tool (read, exec, web_fetch, browser, sessions_list/history):
api.registerTool(
  (ctx, original) => createShadowRead(original!),
  { name: "read", override: true }
)

// Providing a tool where built-in is removed (write, edit, apply_patch in "ro" mode):
api.registerTool(
  (ctx, original) => createShadowWrite(original),  // original is null
  { name: "write", override: true }
)
```

This is the foundation of the shadow tool pattern (§5). One mechanism handles all three shadow patterns (pre-check + call-through, post-filter + call-through, full replacement) across all tool types (coding and non-coding).

### 4.2 Memory Search Path Filter (~15 lines, 2-3 files)

**Files:** `src/memory/manager-search.ts` (SQL WHERE clause), `src/memory/manager.ts` (thread param through search method), `src/agents/tools/memory-tool.ts` (accept param in tool schema)

Add an optional `pathFilter` parameter to `memory_search`. Implemented as a `WHERE c.path GLOB ?` clause in the SQL query. Existing calls without it work unchanged.

```typescript
// Tool schema addition (memory-tool.ts):
pathFilter: Type.Optional(Type.Array(Type.String()))

// Thread through manager.ts search() → searchVector()/searchKeyword()

// SQL addition in vector/keyword search queries (manager-search.ts):
const pathClauses = pathFilter?.map(() => "c.path GLOB ?").join(" OR ");
const pathWhere = pathClauses ? ` AND (${pathClauses})` : "";
```

The saint plugin injects the pathFilter for every search based on the sender's role and memory_scope.

### 4.3 Wire `after_tool_call` Hook (~50 lines, 5 files)

**Files:** `src/agents/pi-embedded-subscribe.handlers.types.ts` (state fields), `src/agents/pi-embedded-subscribe.types.ts` (subscription params), `src/agents/pi-embedded-runner/run/attempt.ts` (pass context), `src/agents/pi-embedded-subscribe.ts` (initialize state), `src/agents/pi-embedded-subscribe.handlers.tools.ts` (record timing + fire hook)

The `after_tool_call` hook is defined in the plugin system (`src/plugins/hooks.ts:308-313`, `runAfterToolCall()`) and its types exist (`PluginHookAfterToolCallEvent` expects `{ toolName, params, result, error, durationMs }`), but the hook is **never actually called anywhere**. The call site is `handleToolExecutionEnd()` in the tool handlers, but it's missing the data the hook needs: tool params, duration, agentId, and sessionKey are not available in the handler's current context.

**What needs threading:**

| File | Change |
|---|---|
| `pi-embedded-subscribe.handlers.types.ts` | Add `toolStartTimes: Map<string, number>` and `toolParamsById: Map<string, Record<string, unknown>>` to `EmbeddedPiSubscribeState`. |
| `pi-embedded-subscribe.types.ts` | Add optional `agentId?: string`, `sessionKey?: string` to `SubscribeEmbeddedPiSessionParams`. |
| `pi-embedded-runner/run/attempt.ts` | Pass `agentId` and `sessionKey` into `subscribeEmbeddedPiSession()` call (~line 624-642). |
| `pi-embedded-subscribe.ts` | Initialize both Maps in state. Pass `agentId`/`sessionKey` from params into state. |
| `pi-embedded-subscribe.handlers.tools.ts` | In `handleToolExecutionStart`: store `Date.now()` and normalized params by `toolCallId`. In `handleToolExecutionEnd`: compute `durationMs`, recover params from map, derive error string via `extractToolErrorMessage(result)` when `isError` is true, fire `runAfterToolCall()` as fire-and-forget with `.catch()`. Clean up both maps. |

**Hook call in `handleToolExecutionEnd`:**
```typescript
const hookRunner = getGlobalHookRunner();
if (hookRunner?.hasHooks("after_tool_call")) {
    const startTime = ctx.state.toolStartTimes.get(toolCallId);
    const durationMs = startTime ? Date.now() - startTime : undefined;
    const toolParams = ctx.state.toolParamsById.get(toolCallId) ?? {};
    const errorString = isToolError ? extractToolErrorMessage(sanitizedResult) : undefined;

    ctx.state.toolStartTimes.delete(toolCallId);
    ctx.state.toolParamsById.delete(toolCallId);

    hookRunner.runAfterToolCall(
        { toolName, params: toolParams, result: sanitizedResult, error: errorString, durationMs },
        { agentId: ctx.params.agentId, sessionKey: ctx.params.sessionKey, toolName },
    ).catch(err => ctx.log.warn(`after_tool_call hook failed: ${String(err)}`));
}
```

This enables the saint plugin to do usage metering and audit logging on every tool call.

### 4.4 Early Hook for Model/Tool Policy + Sender Identity (~85 lines, 8 files)

**Files:** `src/plugins/types.ts` (hook types + sender fields), `src/plugins/hooks.ts` (runner method), `src/agents/pi-embedded-runner/run.ts` (call hook + apply model override + **thread sender fields to attempt**), `src/agents/pi-embedded-runner/run/params.ts` (extend params), `src/agents/pi-embedded-runner/run/types.ts` (extend attempt params), `src/agents/pi-embedded-runner/run/attempt.ts` (apply tool policy + pass sender to hooks), `src/agents/pi-tools.ts` (pass sender fields to before_tool_call hook wrapper), `src/agents/pi-tools.before-tool-call.ts` (extend HookContext type with sender fields)

Two changes in one patch:

**A. New `before_agent_prepare` hook.** The existing `before_agent_start` hook fires at `attempt.ts:724` — AFTER `createAgentSession()` at line 478 locks in model and tools. Tool filtering and model swapping at that point have no effect; the session is already constructed. A new early hook fires in `run.ts` BEFORE `resolveModel()` (line 183), giving the plugin control over model and tool selection before anything is locked in.

```typescript
// New types (types.ts):
export type PluginHookBeforeAgentPrepareResult = {
  model?: string;       // e.g., "claude-haiku-4-5"
  provider?: string;    // e.g., "anthropic"
  tools?: { allow?: string[]; deny?: string[] };
};
```

**Hook execution flow:**

```
run.ts (BEFORE resolveModel):
  │
  ├── Fire before_agent_prepare hook
  │   → Plugin receives sender identity (peerId, senderE164)
  │   → Plugin resolves role from contacts.json
  │   → Plugin returns { model, provider, tools } for this role
  │
  ├── Apply model/provider override BEFORE resolveModel()
  │   → resolveModel() uses overridden modelId/provider
  │   → Produces correct auth, capabilities, context window
  │
  └── Pass tools override into attempt params
      │
      ▼
attempt.ts (BEFORE createAgentSession):
  │
  ├── Tools created (line 209-246)
  ├── Apply filterToolsByPolicy() with hook's tools override  ← NEW
  │   → External users: only web_search, web_fetch survive
  │   → Owner: all tools survive
  │
  └── createAgentSession() called with filtered tools + correct model
```

**Why a new hook instead of moving `before_agent_start`:** The existing hook receives `activeSession.messages` (line 731) — plugins expect message history to be available. Moving it before session creation would break that contract. The new hook handles "what model and tools" while `before_agent_start` continues handling "what prompt context." Clean separation of concerns, full backward compatibility.

**B. Sender identity in hook contexts.** Currently, `before_agent_start`, `before_tool_call`, and the new `before_agent_prepare` hook contexts only include `sessionKey` and `agentId`. The plugin needs sender identity for role resolution but would have to parse the session key (fragile, format varies by dmScope). Sender data exists at the `run.ts` level (`RunEmbeddedPiAgentParams` has `senderId`, `senderName`, `senderUsername`, `senderE164`) but is **dropped at the run→attempt handoff** — `run.ts:399-454` only passes `senderIsOwner` to `runEmbeddedAttempt`, not the other sender fields, despite `EmbeddedRunAttemptParams` defining them. Separately, hook contexts (`PluginHookAgentContext`, `PluginHookToolContext`, and the `HookContext` in `pi-tools.before-tool-call.ts`) lack sender fields entirely.

```typescript
// Add to PluginHookAgentContext and PluginHookToolContext:
peerId?: string;       // Canonical peer ID (resolved via identityLinks)
senderE164?: string;   // Phone number (if WhatsApp)
```

**Threading path:** `run.ts` must thread sender fields into `runEmbeddedAttempt()` (fix the dropped fields). `attempt.ts` passes them to `before_agent_start` hook context. `pi-tools.ts` passes them into the `before_tool_call` hook wrapper. `pi-tools.before-tool-call.ts` extends its `HookContext` type to include them. This ensures all three hooks (`before_agent_prepare` in run.ts, `before_agent_start` in attempt.ts, `before_tool_call` in pi-tools.ts) receive sender identity.

This lets the plugin do `contacts.findBySlug(ctx.peerId)` instead of parsing session keys. The plugin resolves the role once in `before_agent_prepare` (for model/tools), caches it, and reuses it in `before_agent_start` (for prompt injection) and `before_tool_call` (for exec blocklist, budget caps).

**Runtime touch set:**

| File | Change |
|---|---|
| `src/plugins/types.ts` | Add `before_agent_prepare` to `PluginHookName`, event/result types, handler signature. Add `peerId`/`senderE164` to `PluginHookAgentContext` and `PluginHookToolContext`. |
| `src/plugins/hooks.ts` | Add `runBeforeAgentPrepare()` runner method, export from `createHookRunner()`. |
| `src/agents/pi-embedded-runner/run.ts` | Call hook before `resolveModel()` (~line 183). Apply model/provider override. Pass tool policy override into attempt params. **Thread sender fields** (`senderId`, `senderName`, `senderUsername`, `senderE164`) into `runEmbeddedAttempt()` call (currently only `senderIsOwner` is passed). |
| `src/agents/pi-embedded-runner/run/params.ts` | Extend `RunEmbeddedPiAgentParams` with tool policy override + early prompt prepend fields. |
| `src/agents/pi-embedded-runner/run/types.ts` | Extend `EmbeddedRunAttemptParams` with same override fields. |
| `src/agents/pi-embedded-runner/run/attempt.ts` | Apply `filterToolsByPolicy()` on tools array BEFORE `createAgentSession()` (~line 478). Pass sender identity to existing `before_agent_start` hook context (~line 733). |
| `src/agents/pi-tools.ts` | Pass sender fields from tool creation options into `before_tool_call` hook wrapper (~line 440). |
| `src/agents/pi-tools.before-tool-call.ts` | Extend `HookContext` type (lines 7-10) to include `peerId`/`senderE164`. Propagate in `runBeforeToolCallHook`. |

This lets the plugin assign claude-haiku-4-5 to external users and claude-sonnet-4-5 to owners from the same bot config, and control tool visibility per role — all applied before the session is created.

### 4.5 Plugin Tool Workspace Context (~6 lines, 4 files)

**Files:** `src/plugins/types.ts` (add field), `src/agents/pi-embedded-runner/run/attempt.ts` (pass param), `src/agents/pi-tools.ts` (accept + forward), `src/agents/openclaw-tools.ts` (accept + include in context)

In `"ro"` sandbox mode, `effectiveWorkspace` is set to the sandbox copy path (`attempt.ts:159-163`). The real workspace path (`resolvedWorkspace`) is discarded and never forwarded to plugin tools. `OpenClawPluginToolContext.workspaceDir` receives the sandbox copy — plugin tools that need the real workspace (e.g., shadow write/edit operating on the host) have no way to find it.

**Fix:** Add `agentWorkspaceDir?: string` to `OpenClawPluginToolContext` (`types.ts`), thread `resolvedWorkspace` from `attempt.ts` through `pi-tools.ts` and `openclaw-tools.ts` into the plugin tool context. When sandbox is active, `workspaceDir` = sandbox copy, `agentWorkspaceDir` = real workspace. When sandbox is off, both are the same. All 4 files are already touched by other patches (§4.1, §4.3, §4.4) — no new files added to the fork surface.

### Summary: Core vs Plugin

```
CORE PATCHES (~201 lines, 16-17 files):
  ├── Tool override + injected original     ~45 lines   (types.ts, registry.ts, tools.ts, openclaw-tools.ts, pi-tools.ts: override + capture original + pass coding tools downstream + merge filter at both levels)
  ├── Memory path filter                    ~15 lines   (manager-search.ts, manager.ts, memory-tool.ts: additive param)
  ├── Wire after_tool_call                  ~50 lines   (handlers.types.ts, subscribe.types.ts, attempt.ts, subscribe.ts, handlers.tools.ts: state + context threading + timing + hook call)
  ├── Early hook + sender identity          ~85 lines   (types.ts, hooks.ts, run.ts, params.ts, types.ts, attempt.ts, pi-tools.ts, pi-tools.before-tool-call.ts: before_agent_prepare + sender threading + hook context fields)
  └── Plugin workspace context              ~6 lines    (types.ts, attempt.ts, pi-tools.ts, openclaw-tools.ts: agentWorkspaceDir in plugin tool context)

EXISTING FEATURES USED (zero core changes):
  ├── Docker sandbox             → per-agent config, network=none, cap-drop=ALL
  ├── Tool policy                → per-role allow/deny via hook return value
  ├── Identity links             → cross-channel sender resolution
  ├── Gateway control            → controlUi.enabled, bind mode
  ├── before_tool_call hook      → exec blocklist, memory_get path scoping, budget caps
  ├── before_agent_start hook    → per-role prompt injection (prependContext)
  └── agent:bootstrap hook       → per-role boot file filtering (SOUL.md, COMPANY.md etc)

HOOKS DEFINED BUT UNWIRED (need wiring patches if used — not MVP-blocking):
  ├── message_sending            → content filtering (nice-to-have)
  ├── message_sent               → delivery confirmation logging
  ├── session_start / session_end → session lifecycle events
  └── gateway_start / gateway_stop → process lifecycle events
  Note: Wired plugin hooks: before_agent_start, before_tool_call, agent_end.
  Also wired (internal, fire-and-forget): message_received, tool_result_persist.

PLUGIN (saint-orchestrator, ~1000-1500 lines, ALL NEW FILES):
  ├── Shadow tools (6-7)         → read/write/edit/apply_patch, web_fetch, browser, memory_get
  ├── Exec shadow tool           → Porter routing + exec blocklist
  ├── Role resolver              → contacts.json → role lookup
  ├── Prompt builder             → before_agent_start hook
  ├── Boot file filter           → agent:bootstrap hook
  ├── Tool policy generator      → role → allow/deny config
  ├── Budget enforcement         → before_tool_call + after_tool_call
  ├── Usage metering             → after_tool_call hook
  ├── Cron role injection        → before_tool_call hook
  └── Sub-agent role injection   → before_tool_call hook
```

---

## 5. Shadow Tools (Plugin — via `override: true` with Injected Original)

Shadow tools use the override mechanism (§4.1) to wrap or replace built-in tools. Each shadow tool factory receives the original built-in (or `null` if removed) and returns a tool that adds security checks. Three patterns emerge:

- **Pre-check + call-through** (read, exec, web_fetch, browser) — validate params against role permissions, then delegate to `original.execute()`. The original's built-in guards (`assertSandboxPath()`, `fetchWithSsrfGuard()`, etc.) are preserved — the shadow adds restrictions on top, not instead of.
- **Post-filter + call-through** (sessions_list, sessions_history) — call `original.execute()`, then filter results by role.
- **Full replacement** (write, edit, apply_patch) — original is `null` (removed in `"ro"` sandbox mode). Shadow provides the entire implementation: path validation + `fs` operations on the host workspace.

Only needed where the tool policy system (binary allow/deny) is insufficient — i.e., where a role CAN use a tool but with restrictions.

### 5.1 Shadow Exec (Porter Routing + Blocklist)

Wraps the built-in exec (pre-check pattern) to:
1. Check command against role's `exec_blocklist` (deterministic regex match)
2. Block if denied, otherwise call `original.execute()`
3. Log the command for audit

The sandbox itself (network isolation, cap-drop, read-only root) is handled by OpenClaw's built-in sandbox config. Porter routing happens automatically via proxy shims in the sandbox image — the shadow exec adds the blocklist layer on top.

### 5.2 Shadow Read/Write/Edit/Apply_Patch (Path Scoping)

The built-in file tools (read, write, edit, apply_patch) run on the **host process** (not the sandbox), so they have full host filesystem access. Shadow versions add role-based path restrictions.

**Two different patterns for file tools:**
- **Shadow read** uses the **pre-check + call-through** pattern. The built-in read exists in `"ro"` mode. The shadow wraps it: validate path against role's allowed read paths, then call `original.execute()`. The original's `assertSandboxPath()` guard is preserved — the shadow adds role restrictions on top.
- **Shadow write/edit/apply_patch** use the **full replacement** pattern. The built-ins are removed in `"ro"` sandbox mode (§3.1). The factory receives `original: null` and provides the full implementation: role-based path validation + direct `fs` operations on the host workspace.

**Note on sandbox mount behavior (see §3.1):** With `workspaceAccess: "ro"`, the sandbox has two mounts: a writable **copy** at `/workspace` (bootstrap files + skills only) and the **real workspace** at `/agent` (read-only). Shadow write/edit tools operate on the **host** (real workspace) and enforce role-based permissions. The exec tool runs in the sandbox and can:
- **Write** to `/workspace` (sandbox copy only) — these writes don't affect the real workspace but persist for the sandbox scope lifetime.
- **Read** from `/agent` (real workspace) — this bypasses shadow read path restrictions. Mitigation: exec blocklist can restrict reads of sensitive paths; tool policy hides exec from external users entirely.
- **Not write** to `/agent` — the real workspace mount is `:ro`.

**Layer 1: Workspace boundary** — no path escapes `/workspace`. For shadow read, the original's `assertSandboxPath()` handles this. For shadow write/edit/apply_patch (full replacements), the shadow must implement workspace boundary enforcement directly.

**Layer 2: Role-based path restrictions:**
```yaml
file_access:
  # Tier 1: Platform-managed (deny-write for ALL roles, only Saint edits)
  platform_protected: [SOUL.md, IDENTITY.md, AGENTS.md, config/roles.yaml, config/contacts.json]

  # Tier 2 & 3: Per-role access
  owner:
    read:  ["*"]
    write: ["*"]
    deny_write: [SOUL.md, IDENTITY.md, AGENTS.md, config/roles.yaml, config/contacts.json]
    # Can write COMPANY.md, TOOLS.md, memory/*, data/* — full access minus platform files

  manager:
    read:  ["memory/shared/*", "memory/daily/*", "memory/users/<self>/*",
            "skills/*", "data/*", "SOUL.md", "IDENTITY.md"]
    write: ["memory/shared/*", "memory/daily/*", "memory/users/<self>/*", "data/*"]
    # Can update own preferences + shared business memory

  employee:
    read:  ["memory/shared/*", "memory/users/<self>/*",
            "skills/*", "data/*", "SOUL.md", "IDENTITY.md"]
    write: ["memory/users/<self>/*", "data/*"]
    # Can update own preferences only

  external:
    read:  []    # tool hidden via policy — shadow never called
    write: []
    # Per-user memory written by bot via before_agent_start context, not by external user directly
```

**Three protection tiers:**
- **Platform files** (SOUL.md, IDENTITY.md, AGENTS.md, config/) — no role can write. Only Saint edits during provisioning.
- **Owner-writable files** (COMPANY.md, TOOLS.md) — bot can update at owner's request ("update our office hours in company notes").
- **Self-writable memory** (`memory/users/<self>/*`) — any internal role can ask the bot to remember their preferences. The `<self>` placeholder resolves to the current user's slug at runtime.

### 5.3 Shadow web_fetch / browser (URL Restriction)

Both run on the host process. Shadow versions use the **pre-check + call-through** pattern: validate URL against blocklist, then call `original.execute()`. The original's built-in guards are preserved (web_fetch has `fetchWithSsrfGuard()`).

```
Blocked: file://, data://, localhost*, 127.0.0.1*, 10.*, 172.16-31.*,
         192.168.*, 169.254.*, admin.saint.work
```

The browser tool and some web_fetch edge cases need the additional blocklist beyond the built-in SSRF protection.

### 5.4 memory_get Path Scoping (via `before_tool_call`, not override)

`memory_get` is a **plugin tool** registered by the `memory-core` extension — not a built-in. The override mechanism (§4.1) handles plugin-vs-builtin; it doesn't apply here (plugin-vs-plugin override would require load-order-dependent conflict resolution, which is fragile). Instead, path scoping uses the already-wired `before_tool_call` hook:

- **Internal roles (employee/manager):** `before_tool_call` validates the `path` param against the role's allowed memory paths. If outside scope, returns `{ block: true }` with an error message. If allowed, the call proceeds to the original `memory_get` unmodified. This is just another case in the same handler that enforces exec blocklist and budget caps — no new hook, no new patch.
- **External role:** `memory_get` is hidden entirely via tool policy (`before_agent_prepare` deny list). It never enters the session.
- **Owner:** unrestricted.

**Complementary to §4.2:** `memory_search` is scoped via the `pathFilter` core patch (SQL-level filtering). `memory_get` is scoped via `before_tool_call` (param validation). Both are needed — `pathFilter` doesn't cover `memory_get` (direct file read by path), and `before_tool_call` doesn't cover `memory_search` (returns matching results from the index, not a single path to validate).

### 5.5 Shadow sessions_list / sessions_history (Access Scoping)

Uses the **post-filter + call-through** pattern. Calls `original.execute()`, then filters results by role:

| Role | Scope |
|---|---|
| owner | All sessions |
| manager | Own + employee sessions (not owner's private) |
| employee | Only their own |
| external | Tool hidden via policy |

---

## 6. CLI Porter — Credential Isolation

CLI Porter is a companion daemon that runs alongside OpenClaw on the host. Not an OpenClaw modification.

### 6.1 The Problem

CLIs need credentials (env vars, OAuth tokens). In Saint, ALL credentials belong to the platform. The agent must never see them. But the agent needs full exec access and CLIs should work naturally.

### 6.2 Architecture

```
HOST PROCESS (trusted)
├── CLI Porter daemon
│   ├── Listens on /var/run/cliport.sock (unix socket)
│   ├── Registry of installed CLIs + their credentials
│   ├── Receives proxied commands from sandbox
│   ├── Runs REAL CLI with REAL env vars via execvp (not shell)
│   ├── Streams stdout/stderr back to proxy (length-prefixed frames)
│   └── Logs every call (audit + metering)
│
│         ┌──── unix socket ────┐
│         │                     │
│ ┌───────┴─────────────────────┴────────┐
│ │ SANDBOX (OpenClaw's built-in Docker)  │
│ │                                       │
│ │ Proxy shims (same names as real CLIs):│
│ │ ├── /usr/local/bin/gog  → cliport-proxy│
│ │ ├── /usr/local/bin/gh   → cliport-proxy│
│ │ └── ... (symlinks, argv[0] detection) │
│ │                                       │
│ │ Real tools (no secrets needed):       │
│ │ ├── python, node, bun, ffmpeg, jq     │
│ │                                       │
│ │ Env vars: NONE · Network: NONE        │
│ └───────────────────────────────────────┘
```

### 6.3 How It Works

1. Agent calls `exec("gog gmail search 'from:client@co.hr'")`
2. OpenClaw's sandbox runs it in Docker container
3. Inside sandbox, `gog` is a symlink to `cliport-proxy`
4. `cliport-proxy` sends `{ cli: "gog", args: [...] }` over unix socket
5. Porter daemon runs real `gog` with real credentials via `execvp` (array, not shell)
6. stdout/stderr streamed through socket (length-prefixed frames)
7. Agent sees normal output, never sees credentials

### 6.4 The Proxy Binary

One compiled binary (Go or Rust), ~200 lines. Uses symlinks + `argv[0]` detection:
```
/usr/local/bin/cliport-proxy  → the actual binary
/usr/local/bin/gog            → symlink to cliport-proxy
/usr/local/bin/gh             → symlink to cliport-proxy
```

### 6.5 Skills Stay Unchanged

Skills teach the agent to use CLIs by name. `gog gmail send` in a SKILL.md works because `gog` in the sandbox is the proxy shim. Zero changes to any skill.

### 6.6 Security Requirements

1. **Exact CLI name match** against registry — no wildcards, no path traversal
2. **Never concatenate args into shell string** — `execvp` with array, not `bash -c`
3. **CWD validation** — proxy sends sandbox CWD (e.g., `/workspace/subdir`). Porter translates to the real host workspace path (strip sandbox prefix, prepend real workspace root). Must resolve within the agent's workspace after translation.
4. **Rate limiting** — per-CLI and global
5. **Per-session auth token** — set as an env var at container creation time (`docker create --env CLIPORT_TOKEN=<random>`), validated by Porter on every request. Sandbox containers are persistent (reused across exec calls), so per-request tokens via env vars aren't feasible. A per-session token bound to the agent/container ID is sufficient — the threat model is raw socket access from a rogue process inside the sandbox, and the token blocks that. Porter rejects requests with an invalid or missing token.
6. **Subcommand filtering is NOT Porter's job** — Porter is a dumb pipe that validates CLI name, token, CWD, and rate limits. Subcommand restrictions (e.g., allow `gog gmail search` but deny `gog gmail delete`) are handled upstream by the exec blocklist in the shadow exec tool (§5.1). This keeps Porter simple and stateless.

### 6.7 Porter Management

```bash
cliport install gog --env GOG_KEYRING_PASSWORD=xxx --env GOG_ACCOUNT=james@saint.work
cliport list
cliport remove gifgrep
cliport env gog GOG_KEYRING_PASSWORD=new_value
cliport log --last 100
```

### 6.8 Runtime Behavior

**Streaming:** Porter streams stdout/stderr back to the proxy over the unix socket as the CLI produces output (not buffered until exit). This is required for long-running commands (`gh run watch`, `gog drive upload large-file.zip`). The proxy writes the stream to its own stdout/stderr, which the sandbox exec captures normally. Protocol: length-prefixed frames (`[fd:1|2][len:u32][data]`) over the socket, terminated by an exit-code frame.

**Timeouts:** Porter enforces a per-CLI max execution time (configurable in registry, default 120s). On timeout, Porter sends SIGTERM to the child process, waits 5s grace, then SIGKILL. The proxy receives a timeout error frame and exits with a non-zero status.

**Signal forwarding:** If the proxy is killed (e.g., sandbox exec timeout from OpenClaw's side), the socket closes. Porter detects the closed connection and sends SIGTERM → SIGKILL to the child process. No orphaned CLI processes.

---

## 7. Memory System

### 7.1 File Structure

```
/workspace/
├── SOUL.md, IDENTITY.md, COMPANY.md, AGENTS.md, TOOLS.md, HEARTBEAT.md, MEMORY.md
├── config/
│   ├── roles.yaml
│   └── contacts.json
├── memory/
│   ├── shared/         business knowledge (all internal roles)
│   ├── private/        owner-only (finances, strategy)
│   ├── daily/          operational logs
│   └── users/          per-user personal memory
│       ├── ana/
│       │   ├── preferences.md  user-set ("reply in Croatian, bullet points")
│       │   ├── context.md      bot-learned (ongoing projects, recent asks)
│       │   └── notes.md        bot-learned (facts, patterns, history)
│       ├── marko/
│       └── client-xyz/
├── skills/
├── sessions/
├── logs/
│   ├── usage.jsonl     metered actions for billing
│   └── porter.jsonl    CLI Porter audit log
└── data/               working files, exports, uploads
```

### 7.2 Memory Scoping by Role

| Scope | Files | Owner | Manager | Employee | External |
|---|---|---|---|---|---|
| shared | `memory/shared/*`, `MEMORY.md` | yes | yes | yes | no |
| private | `memory/private/*`, `COMPANY.md`, `TOOLS.md` | yes | no | no | no |
| daily | `memory/daily/*` | yes | yes | no | no |
| own user | `memory/users/<self>/*` | yes | yes | yes | yes |
| all users | `memory/users/*/*` | yes | yes | no | no |

Enforced at two points:
- **memory_search**: pathFilter injected by plugin (§4.2 core patch)
- **memory_get / read**: Shadow tools enforce same paths (§5.2, §5.4)

### 7.3 Implementation

One SQLite + sqlite-vec embedding index per bot. Hybrid search: 70% vector (cosine similarity), 30% FTS5 keyword. The pathFilter adds `WHERE c.path GLOB ?` clauses — filtering happens at DB level, not post-query.

---

## 8. Channels

All channels are standard OpenClaw plugins except Email.

| Channel | Plugin | Auth | Bot Gets |
|---|---|---|---|
| **WhatsApp** | whatsapp (Baileys) — OpenClaw | QR code link | Own number per bot |
| **Email (Gmail)** | saint-email — new plugin | OAuth2 service account | name@saint.work |
| **Discord** | discord (@buape/carbon) — OpenClaw | Bot token | Server presence |
| **Slack** | slack (Bolt SDK) — OpenClaw | Bot + App tokens | Workspace access |
| **Telegram** | telegram (grammy) — OpenClaw | BotFather token | Bot account |

### 8.1 Email Plugin (~300-500 lines, new)

Email as a first-class channel:
- Inbound: Gmail push notifications (or polling fallback) → session per sender → role resolution
- Outbound: Agent calls `message(channel: "email", to: "client@co.hr", ...)`
- Threading, CC/BCC, attachments supported
- Google Workspace (Calendar, Drive, Docs) remain via gog CLI through Porter

---

## 9. Security Model

### 9.1 Defence Layers

```
Layer 1: Tool policy (OpenClaw built-in + §4.4 patch)
  → Tools not in role's allow list are invisible to the agent
  → Dynamic per-session via before_agent_prepare tool policy override

Layer 2: Shadow tool restrictions (plugin, override: true)
  → Path scoping on read/write/edit/apply_patch/memory_get
  → URL blocking on web_fetch/browser
  → Exec blocklist (deterministic regex, not LLM judgment)

Layer 3: Docker sandbox (OpenClaw built-in, elevated mode DISABLED)
  → tools.elevated.enabled: false — prevents exec from escaping sandbox to host
  → --network=none, --cap-drop=ALL, --read-only root
  → workspaceAccess: "ro" — two-mount model:
      /workspace  = sandbox copy (writable, bootstrap files only)
      /agent      = real workspace (read-only bind mount)
  → Built-in write/edit tools removed; writes only via shadow tools on host
  → Exec CAN read real workspace via /agent (bypasses shadow read restrictions)
  → Exec writes to /workspace persist for sandbox scope lifetime (session/agent/shared)
  → Zero credential env vars in sandbox (only system vars: LANG/PATH/HOME)

Layer 4: CLI Porter (separate daemon)
  → CLIs needing credentials are proxy shims in sandbox
  → Real CLIs + credentials only on host
  → execvp (array), not shell — no injection
  → Per-session auth token (validated per-request)

Layer 5: Memory scoping (core patch + plugin)
  → pathFilter on memory_search (SQL WHERE clause)
  → Path enforcement on memory_get (shadow tool)
  → Per-user memory isolation

Layer 6: Session access scoping (shadow tools)
  → sessions_list/history filtered by role

Layer 7: Boot file filtering (plugin, agent:bootstrap hook)
  → Per-role workspace file injection

Layer 8: Budget caps (plugin, before/after_tool_call hooks)
  → Per-role max_budget_usd

Layer 9: Three-tier write protection (shadow write tool)
  → Platform files (SOUL.md, IDENTITY.md, AGENTS.md, config/) — no role can write, only Saint
  → Owner files (COMPANY.md, TOOLS.md) — owner can ask bot to update
  → Per-user memory (memory/users/<self>/) — each user can ask bot to remember preferences

Layer 10: Rebranding (fork-time)
  → No OpenClaw references in agent-visible output
```

### 9.2 Agent Containment — "Brain in a Jar"

**Cannot know:** Its model, its config, what plugins are installed, that it runs on OpenClaw, token costs.

**Cannot do:** Access gateway tool, config tools, update tools, session_status (reveals model), install skills, read outside `/workspace`, modify personality files, self-modify, run elevated exec (disabled in config).

**Can do:** Use curated tools (per role), read/write within workspace (per role), run sandboxed exec, use memory (scoped to role).

### 9.3 Credential Flow

```
HOST PROCESS (all secrets live here):
  ANTHROPIC_API_KEY    → OpenClaw LLM calls
  DISCORD_TOKEN        → Discord plugin
  GMAIL_OAUTH          → saint-email plugin
  BRAVE_API_KEY        → web_search tool
  GOG_KEYRING_PASSWORD → CLI Porter → runs real gog
  GITHUB_TOKEN         → CLI Porter → runs real gh

SANDBOX (zero secrets):
  /usr/local/bin/gog    → proxy shim → Porter socket
  /usr/local/bin/python → real python (no secrets needed)
  /workspace/           → sandbox copy (bootstrap files + skills, writable)
  /agent/               → real workspace (all files, read-only)
  $ printenv            → LANG (from OpenClaw sandbox config), PATH/HOME (from Docker image defaults) — no credentials
```

---

## 10. Hook System Details

OpenClaw has **two separate hook systems**. The plugin needs both.

### Plugin Hooks (registered via `api.on()`)

| Hook | Wired | Mutable | Blockable | Execution | Saint uses for |
|---|---|---|---|---|---|
| `before_agent_prepare` | **no** (§4.4) | model, provider, tool policy | no | sequential | Per-role model + tool visibility (fires early, before session creation) |
| `before_agent_start` | **yes** | prompt, context | no | sequential | Per-role prompt injection (prependContext) |
| `before_tool_call` | **yes** | params | yes (`block: true`) | sequential | Exec blocklist, memory_get path scoping, budget caps, cron/subagent role injection |
| `agent_end` | **yes** | no | no | parallel | (available but not currently planned) |
| `after_tool_call` | **no** (§4.3) | no | no | parallel | Usage metering, audit logging |
| `message_sending` | **no** | content | yes (`cancel: true`) | sequential | Content filtering (future) |
| `session_start` | **no** | no | no | parallel | Not needed — role resolution via `before_agent_start` |

### Internal Hooks — Additional Wired Hooks

Beyond `agent:bootstrap`, two more internal hooks are wired (fire-and-forget, not blocking):

| Hook | Wired at | Mutable | Saint uses for |
|---|---|---|---|
| `message_received` | `dispatch-from-config.ts` | no | (not planned — role resolution uses `before_agent_start`) |
| `tool_result_persist` | `session-tool-result-guard-wrapper.ts` | no | (not planned — metering uses `after_tool_call`) |

### Internal Hooks (registered via `api.registerHook()`)

| Hook | Mutable | Saint uses for |
|---|---|---|
| `agent:bootstrap` | yes (bootstrapFiles array) | Per-role boot file filtering |

**Concurrent safety:** Both hook types receive `sessionKey` and `agentId` per-invocation. The plugin must be stateless (session key in → role out) to handle simultaneous sessions safely.

---

## 11. Infrastructure

### 11.1 Per-Bot Deployment

```
HOST PROCESS (per bot)
├── OpenClaw (forked, ~201 lines changed)
│   + saint-orchestrator plugin
│   + saint-email plugin
│   ├── All channel connections
│   ├── Cron, memory, sessions, compaction
│   └── Gateway (controlUi disabled, loopback only)
│
├── CLI Porter daemon
│   ├── Registered CLIs with credentials
│   └── Listens on /var/run/cliport.sock
│
└── SANDBOX (OpenClaw built-in Docker, per exec call)
    ├── Proxy shims + real tools · No env · No network
    └── /workspace mount · Porter socket mount
```

### 11.2 Hardware

Phase 1: Minisforum UM780 XTX (8C/16T, 64GB DDR5, 1TB NVMe, ~€500-600)
- ~256MB per bot → 80-120 bots comfortable capacity
- CPU overkill — bots are 99% idle (inference is API calls)
- UPS required (~€80-100)

### 11.3 Scaling Path

- **Phase 1:** Single UM780 (80-120 bots, office-hosted)
- **Phase 2:** Second unit (active-active, 160-240 bots)
- **Phase 3:** k3s cluster (same hardware or cloud migration)

### 11.4 Control Plane (Separate Service)

Not part of the fork. Manages bot lifecycle:
- Provision bots (create instance + workspace + channels + Porter CLIs)
- Admin dashboard (`admin.saint.work`) — fleet view, debugging
- Customer dashboard (`app.saint.work`) — personality, team, channels, billing
- Bot-to-bot communication via Tailscale mesh + gateway API

---

## 12. Component Summary

| Component | Type | Size | Upstream Conflict |
|---|---|---|---|
| Tool override + injected original | Core patch | ~45 lines, 5 files | Low — override tracking + original capture in tools.ts, coding tools passed downstream from pi-tools.ts to openclaw-tools.ts to resolvePluginTools(), merge filter at both levels (openclaw-tools.ts for non-coding, pi-tools.ts for coding), type additions. Override-scoped: only `override: true` tools participate. Upstream would only conflict if they restructure how tools are assembled or change the plugin factory signature. |
| Memory path filter | Core patch | ~15 lines, 2-3 files | Low — additive param threaded through manager to SQL |
| Wire after_tool_call | Core patch | ~50 lines, 5 files | Low — state fields for timing/params maps, context threading (agentId/sessionKey) from attempt.ts through subscription params to handler, hook call in handleToolExecutionEnd. All additive. If upstream wires it themselves, we delete our patch. |
| Early hook (`before_agent_prepare`) + sender identity | Core patch | ~85 lines, 8 files | Low — new hook type + runner, call in run.ts before resolveModel(), thread sender fields from run.ts→attempt.ts (currently dropped), tool filter in attempt.ts before createAgentSession(), sender fields in hook context types + pi-tools.ts + pi-tools.before-tool-call.ts. Additive — no reordering of existing code. |
| Plugin workspace context (`agentWorkspaceDir`) | Core patch | ~6 lines, 4 files | **Minimal** — one field addition to `OpenClawPluginToolContext`, three lines threading `resolvedWorkspace` through existing param paths. All 4 files already touched by other patches. |
| Shadow exec (Porter + blocklist) | Plugin | In plugin | **Zero** |
| Shadow read/write/edit/apply_patch | Plugin | In plugin | **Zero** |
| Shadow web_fetch/browser | Plugin | In plugin | **Zero** |
| memory_get path scoping (via `before_tool_call`) | Plugin | In plugin | **Zero** — uses existing wired hook, no override needed (memory_get is a plugin tool from memory-core, not a built-in) |
| Shadow sessions_list/history | Plugin | In plugin | **Zero** |
| saint-orchestrator plugin | New plugin | ~1000-1500 lines | **Zero** |
| saint-email plugin | New plugin | ~300-500 lines | **Zero** |
| CLI Porter daemon | New service | ~500-1000 lines | **Zero** |
| cliport-proxy binary | New binary | ~200 lines (Go/Rust) | **Zero** |
| Sandbox image | New Dockerfile | ~50 lines | **Zero** |
| Rebranding | Fork-time | Find-and-replace | N/A |
| Control plane | Separate service | TBD | **Zero** |

**Total core diff: ~201 lines across 16-17 files.**
**Total new code: ~2000-3500 lines across plugin + Porter + proxy + email.**
**Conflict surface: 14-15 files, ~196 lines. Everything else is new files or uses existing hooks/config.**

---

## 13. Development Roadmap

### Phase 1: Core (MVP) — ~2-4 weeks

- [ ] Fork OpenClaw, apply 5 core patches
- [ ] Build saint-orchestrator plugin (roles, contacts, shadow tools, prompt builder, metering)
- [ ] Build CLI Porter daemon + cliport-proxy binary
- [ ] Build custom sandbox image with proxy shims
- [ ] Build saint-email channel plugin
- [ ] Register initial CLIs via Porter (gog, gh)
- [ ] WhatsApp + Email channels configured
- [ ] Single-server deployment, first bot operational

### Phase 2: Platform — ~4-6 weeks

- [ ] Control plane API + admin dashboard
- [ ] Bot provisioning automation
- [ ] Usage aggregation + billing (Stripe)
- [ ] Discord + Slack channels
- [ ] Skill catalogue + custom skill creation

### Phase 3: Scale — ongoing

- [ ] Kubernetes deployment
- [ ] WhatsApp Business API migration
- [ ] Advanced model routing
- [ ] Multi-language support
- [ ] Customer self-service portal

---

## 14. Fork Maintenance

### Conflict Risk

| Patch | Risk | Notes |
|---|---|---|
| Tool override + injected original | Low | Override tracking + original capture in resolvePluginTools(), coding tools passed from pi-tools.ts → openclaw-tools.ts → resolvePluginTools() so overrides see all tool types, merge filter at both levels (openclaw-tools.ts for non-coding, pi-tools.ts for coding), type additions, factory signature extension. Override-scoped (only `override: true` participates). Upstream would only conflict if they restructure how tools are assembled across pi-tools.ts/openclaw-tools.ts or change the plugin factory signature. |
| Memory path filter | Low | Additive optional parameter threaded through 2-3 files |
| Wire after_tool_call | Low | State fields for timing/params tracking (additive to handler types), context threading of agentId/sessionKey through subscription params (additive), hook call in handleToolExecutionEnd (additive). All changes are additive — no reordering of existing code. If upstream wires after_tool_call themselves, we delete our patch entirely. |
| Early hook (`before_agent_prepare`) + sender identity | Low | New hook type/runner (additive to types.ts, hooks.ts). Call in run.ts before resolveModel() (additive). Thread sender fields from run.ts into runEmbeddedAttempt (currently dropped — fix is additive). Tool filter in attempt.ts before createAgentSession() (additive). Param threading through params.ts/types.ts (additive). Sender fields in hook context types, pi-tools.ts wrapper, pi-tools.before-tool-call.ts HookContext (additive). No reordering of existing code. Upstream would only conflict if they restructure the run.ts → attempt.ts param handoff or add their own early hook. |
| Plugin workspace context (`agentWorkspaceDir`) | **Minimal** | One optional field in `OpenClawPluginToolContext`, three lines threading an existing variable through already-patched files. Zero risk of standalone conflict — if any other patch in this table merges cleanly, this one does too. |
| Shadow tools | **Zero** | All in plugin, registered via override |
| Everything else | **Zero** | New files or existing hooks/config |

### Upstream PR Strategy

All 5 patches are useful to any OpenClaw user:
1. Tool override with injected original → lets any plugin wrap or replace built-ins with proper decorator pattern (extensibility)
2. Memory pathFilter → multi-user memory scoping (privacy)
3. Wire after_tool_call → complete the documented hook API (correctness)
4. Hook context + tool/model policy override → richer plugin integration, per-session tool + model control (extensibility)
5. Plugin workspace context (`agentWorkspaceDir`) → lets plugin tools access the real workspace path when sandboxed (correctness — sandbox copy ≠ real workspace)

If upstream accepts any of these natively, we delete the corresponding patch lines.

---

## 15. Key Risks

### Must Resolve Before Build

**C1: Tool override with injected original** — Validated against source. Tools are assembled in two stages: coding tools (read, write, edit, exec) in `pi-tools.ts`, non-coding built-ins in `openclaw-tools.ts`. Plugin tools are resolved inside `createOpenClawTools()` via `resolvePluginTools()`. The override must span the conflict check (`tools.ts`) and both merge points (`openclaw-tools.ts` for non-coding, `pi-tools.ts` for coding). Coding tools are passed downstream from pi-tools.ts → openclaw-tools.ts → resolvePluginTools() so the conflict check sees all tool types and captures originals correctly. Override-scoped: only `override: true` tools participate — no accidental hijacking. Note: `resolvePluginTools()` has an additional plugin-ID conflict check (`tools.ts:70-80`) that fires before per-tool checks — not a concern for `saint-orchestrator` but must be aware of when naming plugins. Patch is ~45 lines across 5 files (`types.ts`, `registry.ts`, `tools.ts`, `openclaw-tools.ts`, `pi-tools.ts`).

**C2: Boot file filtering** — Validated. `agent:bootstrap` internal hook receives mutable `bootstrapFiles` array.

**C3: after_tool_call gap** — Confirmed unwired. `runAfterToolCall()` is defined in hooks.ts but never called. The call site (`handleToolExecutionEnd` in `pi-embedded-subscribe.handlers.tools.ts`) lacks tool params, timing, agentId, and sessionKey. Patch threads context from attempt.ts through subscription params, adds timing maps to handler state, and fires the hook as fire-and-forget. Error strings derived from existing `extractToolErrorMessage()`. ~50 lines across 5 files. Must land before metering works.

**C4: Tool + model policy override + sender identity threading** — The existing `before_agent_start` hook fires at `attempt.ts:724`, after `createAgentSession()` (line 478) has already locked in model and tools — too late for overrides. The existing per-sender tool policy (`toolsBySender`) only works for group chats (requires `groupId`, skipped for DMs). Patch §4.4 adds a new `before_agent_prepare` hook that fires in `run.ts` before `resolveModel()`, returning model/provider/tools overrides. Tools are filtered in `attempt.ts` before `createAgentSession()`. `before_agent_start` remains for prompt injection only (`prependContext`; `systemPrompt` is dead code). **Additional gap:** sender identity fields exist in `RunEmbeddedPiAgentParams` but `run.ts` only passes `senderIsOwner` to `runEmbeddedAttempt` — the other fields (`senderId`, `senderName`, `senderUsername`, `senderE164`) are dropped. Hook contexts (`PluginHookAgentContext`, `PluginHookToolContext`, `HookContext` in `pi-tools.before-tool-call.ts`) lack sender fields entirely. Patch must thread sender fields across the full run→attempt→hooks chain. ~85 lines across 8 files.

**C5: Plugin workspace context** — In `"ro"` sandbox mode, `effectiveWorkspace` = sandbox copy, `resolvedWorkspace` (real path) is discarded (`attempt.ts:159-163`). Plugin tools receive only `workspaceDir` = sandbox copy via `OpenClawPluginToolContext`. Shadow write/edit tools (full replacement pattern, §5.2) need the real workspace to operate on the host filesystem. Patch §4.5 adds `agentWorkspaceDir` to the context. ~6 lines across 4 already-patched files — minimal risk.

### Resolve During Phase 1

**I1: Porter socket authentication** — Per-session token (set at container creation, validated per-request) prevents raw socket abuse from sandbox. Design settled in §6.6 — implementation is straightforward.

**I2: Porter streaming + signals** — Length-prefixed frame protocol for stdout/stderr streaming, plus SIGTERM/SIGKILL on socket close. Design settled in §6.8 — main implementation effort is the frame protocol in both Porter daemon and proxy binary.

**I4: Email inbound connectivity** — Gmail push needs public URL. Options: Cloudflare Tunnel, Tailscale Funnel, or polling fallback.

### Phase 2+

**M1: WhatsApp number management** — Phones need periodic check-in. Manageable for few bots, painful at scale. Phase 3 migration to Business API.

**M2: Exec blocklist limitations** — Regex deny list can't enumerate all destructive commands. Defense-in-depth only — sandbox + Porter are the real security boundaries.

**M3: Memory classification accuracy** — Agent decides what goes where. Prompt engineering + dashboard review handles this.

### Noted Risks (Acceptable with Mitigations)

**N1: Sandbox exec read bypass** — With `workspaceAccess: "ro"`, exec can read the full real workspace via the `/agent` mount. This bypasses shadow read-tool path restrictions (e.g. a restricted role could `cat /agent/config.yaml` even if the shadow read tool blocks that path). Mitigations: (1) exec blocklist regex can deny reads of sensitive paths, (2) the sandbox has no credentials so reading config files yields no secrets, (3) CLI Porter ensures credential-bearing operations are proxy-only. Residual risk is low but should be monitored if roles have genuinely confidential workspace files.

**N2: Sandbox write persistence** — Exec writes to `/workspace` (the sandbox copy) persist for the sandbox scope lifetime, not just the current command. With `scope: "shared"`, writes survive across sessions. This is by design (enables scratch work), but means a misbehaving agent could accumulate state. Mitigation: periodic sandbox workspace cleanup via provisioning/cron.
