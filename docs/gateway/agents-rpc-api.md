# Gateway Agent Management RPC API

The Gateway exposes a set of JSON-RPC methods over WebSocket for managing agents. These methods allow clients to list, create, update, and delete agents, as well as manage agent workspace files.

## Connection

- **Default URL**: `ws://127.0.0.1:18789`
- **Protocol**: JSON-RPC style request/response over WebSocket
- **Authentication**: Requires a valid session scope (see `method-scopes.ts`)

---

## Agent CRUD Methods

### `agents.list`

List all configured agents and the default agent.

**Params**:

```json
{}
```

**Result**:

```json
{
  "defaultId": "main",
  "mainKey": "main",
  "scope": "per-sender",
  "agents": [
    {
      "id": "main",
      "name": "Main Agent",
      "identity": {
        "name": "OpenClaw",
        "theme": "dark",
        "emoji": "🤖",
        "avatar": "avatar.png",
        "avatarUrl": "/api/avatar/main/avatar.png"
      }
    },
    {
      "id": "feishu",
      "name": "Feishu Bot"
    }
  ]
}
```

| Field               | Type                         | Description                                                        |
| ------------------- | ---------------------------- | ------------------------------------------------------------------ |
| `defaultId`         | string                       | The default agent ID (from `agents.list[].default` or first entry) |
| `mainKey`           | string                       | Normalized main session key                                        |
| `scope`             | `"per-sender"` \| `"global"` | Session scoping strategy                                           |
| `agents[].id`       | string                       | Normalized agent ID                                                |
| `agents[].name`     | string?                      | Human-readable agent name                                          |
| `agents[].identity` | object?                      | Agent identity (name, theme, emoji, avatar, avatarUrl)             |

---

### `agents.create`

Create a new agent with a name and workspace directory.

**Params**:

```json
{
  "name": "My Agent",
  "workspace": "~/agents/my-agent",
  "emoji": "🤖",
  "avatar": "avatar.png"
}
```

| Field       | Type   | Required | Description                                           |
| ----------- | ------ | -------- | ----------------------------------------------------- |
| `name`      | string | ✅       | Agent display name (also used to derive the agent ID) |
| `workspace` | string | ✅       | Workspace directory path (supports `~` expansion)     |
| `emoji`     | string | ❌       | Emoji for agent identity                              |
| `avatar`    | string | ❌       | Avatar filename for agent identity                    |

**Result** (on success):

```json
{
  "ok": true,
  "agentId": "my-agent",
  "name": "My Agent",
  "workspace": "/Users/user/agents/my-agent"
}
```

**Side Effects**:

1. Writes agent entry to `openclaw.json` via `applyAgentConfig`
2. Creates workspace directory with bootstrap files (AGENTS.md, SOUL.md, etc.) unless `agents.defaults.skipBootstrap` is set
3. Creates session transcripts directory (`~/.openclaw/agents/<id>/sessions/`)
4. Appends identity (Name, Emoji, Avatar) to `IDENTITY.md` in the workspace

**Errors**:

- `"main" is reserved` — Cannot create an agent with ID "main"
- `agent "<id>" already exists` — Duplicate agent ID

---

### `agents.update`

Update an existing agent's name, workspace, model, or avatar.

**Params**:

```json
{
  "agentId": "my-agent",
  "name": "Updated Name",
  "workspace": "~/new-workspace",
  "model": "claude-sonnet-4-20250514",
  "avatar": "new-avatar.png"
}
```

| Field       | Type   | Required | Description                  |
| ----------- | ------ | -------- | ---------------------------- |
| `agentId`   | string | ✅       | Target agent ID              |
| `name`      | string | ❌       | New display name             |
| `workspace` | string | ❌       | New workspace directory path |
| `model`     | string | ❌       | New default model ID         |
| `avatar`    | string | ❌       | New avatar filename          |

**Result**:

```json
{
  "ok": true,
  "agentId": "my-agent"
}
```

**Side Effects**:

1. Updates `openclaw.json` configuration
2. If workspace changed, ensures the new workspace exists with bootstrap files
3. If avatar provided, appends `- Avatar: <avatar>` to `IDENTITY.md`

---

### `agents.delete`

Delete an agent and optionally remove its files.

**Params**:

```json
{
  "agentId": "my-agent",
  "deleteFiles": true
}
```

| Field         | Type    | Required | Default | Description                                                 |
| ------------- | ------- | -------- | ------- | ----------------------------------------------------------- |
| `agentId`     | string  | ✅       | —       | Target agent ID                                             |
| `deleteFiles` | boolean | ❌       | `true`  | Whether to move workspace, agent dir, and sessions to trash |

**Result**:

```json
{
  "ok": true,
  "agentId": "my-agent",
  "removedBindings": 1
}
```

**Side Effects**:

1. Removes agent entry from `openclaw.json` via `pruneAgentConfig`
2. If `deleteFiles` is true (default), moves to trash:
   - Workspace directory
   - Agent state directory (`~/.openclaw/agents/<id>`)
   - Session transcripts directory

**Errors**:

- `"main" cannot be deleted` — The default "main" agent is protected
- `agent "<id>" not found` — Agent doesn't exist

---

## Agent File Management Methods

These methods manage files within an agent's workspace directory. Only a predefined set of filenames is allowed:

**Bootstrap files**: `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`
**Memory files**: `MEMORY.md`, `CLAUDE.md`

### `agents.files.list`

List all workspace files for an agent.

**Params**:

```json
{
  "agentId": "main"
}
```

**Result**:

```json
{
  "agentId": "main",
  "workspace": "/Users/user/.openclaw/workspace",
  "files": [
    {
      "name": "AGENTS.md",
      "path": "/Users/user/.openclaw/workspace/AGENTS.md",
      "missing": false,
      "size": 1234,
      "updatedAtMs": 1709901234567
    },
    {
      "name": "SOUL.md",
      "path": "/Users/user/.openclaw/workspace/SOUL.md",
      "missing": true
    }
  ]
}
```

> **Note**: After workspace onboarding is completed, `BOOTSTRAP.md` is hidden from the file list.

---

### `agents.files.get`

Read the content of a specific workspace file.

**Params**:

```json
{
  "agentId": "main",
  "name": "AGENTS.md"
}
```

**Result**:

```json
{
  "agentId": "main",
  "workspace": "/Users/user/.openclaw/workspace",
  "file": {
    "name": "AGENTS.md",
    "path": "/Users/user/.openclaw/workspace/AGENTS.md",
    "missing": false,
    "size": 1234,
    "updatedAtMs": 1709901234567,
    "content": "# My Agent Instructions\n..."
  }
}
```

---

### `agents.files.set`

Write content to a workspace file.

**Params**:

```json
{
  "agentId": "main",
  "name": "AGENTS.md",
  "content": "# Updated Instructions\n\nNew content here."
}
```

**Result**:

```json
{
  "ok": true,
  "agentId": "main",
  "workspace": "/Users/user/.openclaw/workspace",
  "file": {
    "name": "AGENTS.md",
    "path": "/Users/user/.openclaw/workspace/AGENTS.md",
    "missing": false,
    "size": 42,
    "updatedAtMs": 1709901234567,
    "content": "# Updated Instructions\n\nNew content here."
  }
}
```

---

## WebChat Integration

The webchat UI uses these RPC methods through the `GatewayBrowserClient` WebSocket client.

### Agent Loading Flow

```typescript
// ui/src/ui/controllers/agents.ts
async function loadAgents(state: AgentsState) {
  const res = await state.client.request<AgentsListResult>("agents.list", {});
  if (res) {
    state.agentsList = res;
    // Auto-select default agent if none selected
    if (!selected || !known) {
      state.agentsSelectedId = res.defaultId ?? res.agents[0]?.id ?? null;
    }
  }
}
```

### UI Display

The agent list is rendered in the webchat sidebar (`ui/src/ui/views/agents.ts`):

- Displays agent name, emoji, and avatar
- Allows switching between agents
- Supports creating new agents via the UI

### State Management

```typescript
// Key state properties
agentsList: AgentsListResult | null; // Cached agent list
agentsSelectedId: string | null; // Currently selected agent
agentsLoading: boolean; // Loading indicator
agentsError: string | null; // Error message
```

---

## Schema Definitions

All type schemas are defined in:
`src/gateway/protocol/schema/agents-models-skills.ts`

| Schema                        | Description                                       |
| ----------------------------- | ------------------------------------------------- |
| `AgentsListParamsSchema`      | Empty object `{}`                                 |
| `AgentsListResultSchema`      | `{ defaultId, mainKey, scope, agents[] }`         |
| `AgentsCreateParamsSchema`    | `{ name, workspace, emoji?, avatar? }`            |
| `AgentsCreateResultSchema`    | `{ ok, agentId, name, workspace }`                |
| `AgentsUpdateParamsSchema`    | `{ agentId, name?, workspace?, model?, avatar? }` |
| `AgentsUpdateResultSchema`    | `{ ok, agentId }`                                 |
| `AgentsDeleteParamsSchema`    | `{ agentId, deleteFiles? }`                       |
| `AgentsDeleteResultSchema`    | `{ ok, agentId, removedBindings }`                |
| `AgentsFilesListParamsSchema` | `{ agentId }`                                     |
| `AgentsFilesListResultSchema` | `{ agentId, workspace, files[] }`                 |
| `AgentsFilesGetParamsSchema`  | `{ agentId, name }`                               |
| `AgentsFilesGetResultSchema`  | `{ agentId, workspace, file }`                    |
| `AgentsFilesSetParamsSchema`  | `{ agentId, name, content }`                      |
| `AgentsFilesSetResultSchema`  | `{ ok, agentId, workspace, file }`                |

---

## Source Files Reference

| File                                                                                   | Description                    |
| -------------------------------------------------------------------------------------- | ------------------------------ |
| [agents.ts](file:///src/gateway/server-methods/agents.ts)                              | RPC handler implementations    |
| [agents-models-skills.ts](file:///src/gateway/protocol/schema/agents-models-skills.ts) | TypeBox schema definitions     |
| [session-utils.ts](file:///src/gateway/session-utils.ts)                               | `listAgentsForGateway()` logic |
| [server-methods-list.ts](file:///src/gateway/server-methods-list.ts)                   | All registered gateway methods |
| [method-scopes.ts](file:///src/gateway/method-scopes.ts)                               | Method permission scopes       |
| [agents.ts (UI)](file:///ui/src/ui/controllers/agents.ts)                              | Webchat agent controller       |
| [agents.ts (View)](file:///ui/src/ui/views/agents.ts)                                  | Webchat agent list view        |
