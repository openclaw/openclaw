# MABOS Extension — API Contracts

Documents the actual backend response shapes vs. frontend types. Derived from `index.ts` endpoint registrations.

## GET /mabos/api/status

**Backend** (`index.ts:380-389`):

```json
{
  "product": "MABOS",
  "version": "2026.2.17",
  "bdiHeartbeat": "active",
  "bdiIntervalMinutes": 30,
  "agents": [
    { "agentId": "ceo", "beliefCount": 5, "goalCount": 3, "intentionCount": 1, "desireCount": 4 }
  ],
  "businessCount": 2,
  "workspaceDir": "/path/to/workspace",
  "reasoningToolCount": 20
}
```

**Frontend type** (`SystemStatus`):

```typescript
{
  product: string;
  version: string;
  bdiHeartbeat: string;
  bdiIntervalMinutes: number;
  agents: Array<{
    agentId: string;
    beliefCount: number;
    goalCount: number;
    intentionCount: number;
    desireCount: number;
  }>;
  businessCount: number;
  workspaceDir: string;
  reasoningToolCount: number;
}
```

## GET /mabos/api/decisions

**Backend** (`index.ts:431`):

```json
{ "decisions": [ { "id": "...", "title": "...", ... } ] }
```

**Frontend type**: `{ decisions: Decision[] }`

## GET /mabos/api/businesses

**Backend** (`index.ts:622`):

```json
{ "businesses": [ { "id": "acme", "name": "Acme", ... } ] }
```

**Frontend type**: `{ businesses: Business[] }`

## GET /mabos/api/contractors

**Backend** (`index.ts:666`):

```json
{ "contractors": [ { "id": "...", "name": "...", ... } ] }
```

**Frontend type**: `{ contractors: Contractor[] }`

## GET /mabos/api/businesses/:id/tasks

**Backend** (`index.ts:1428`):

```json
{ "tasks": [ { "id": "S-1", "title": "...", ... } ] }
```

**Frontend type**: `{ tasks: unknown[] }` (normalized via `normalizeTask()`)

## GET /mabos/api/businesses/:id/agents

**Backend** (`index.ts:1663`):

```json
{ "agents": [ { "id": "ceo", "name": "CEO", "type": "core", ... } ] }
```

**Frontend type**: `AgentListResponse` — already has `{ agents: AgentListItem[] }` (correct)

## GET /mabos/api/businesses/:id/goals

**Backend** (`index.ts:1324`):

```json
{ "actors": [...], "goals": [...], "dependencies": [...] }
```

**Frontend type**: `TroposGoalModel` — already matches (correct)

## GET /mabos/api/metrics/:business

**Backend** (`index.ts:648`):

```json
{ "business": "acme", "metrics": { ... } }
```

**Frontend type**: `unknown` (no specific type)
