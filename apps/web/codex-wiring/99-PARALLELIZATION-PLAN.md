# Parallelization Plan (4 Agents)

## Agent Kickoff Checklist (Required)
1. **Create your own worktree** (mandatory)  
   ```
   cd /Users/dgarson/clawd/clawdbot
   git worktree add /private/tmp/clawdbot-<branch-slug> -b <branch-name>
   cd /private/tmp/clawdbot-<branch-slug>
   ```
2. **Claim your ticket + file set** in your first update.
3. **Read the ticket prompt** in `apps/web/codex-wiring/prompts/`.
4. **Check decision blockers** in `apps/web/codex-wiring/requirements-clarifications.md`.
5. **Do not edit files outside your ownership map.**
6. **Post a hand‑off note** with files changed + open decisions.

## Goal
Maximize correctness and efficiency with 4 agents while avoiding file collisions and respecting blocking dependencies.

## Model Allocation (Reliability‑First)
- **Agent A (Claude Opus 4.5)**: Protocol/client + streaming correctness (highest risk).
- **Agent B (Claude Sonnet 4.5)**: Sessions/chat wiring + agents wiring.
- **Agent C (Claude Sonnet 4.5)**: Settings/config wiring.
- **Agent D (Claude Sonnet 4.5)**: Channels/OAuth wiring.

> **1M context window not needed** for this phase. Current tickets are bounded to specific file sets and don’t require extremely large context.

---

## Blocking Sequence (Must Be Sequential)
1. **Ticket 01 — Unify Gateway Client (Protocol v3)**
2. **Ticket 02 — Event Stream Alignment**
3. **Ticket 06 — Sessions + Chat + Conversations** (depends on 01+02)

---

## Parallel Execution Windows

### Window 1 (Starts immediately)
**Agent A (Opus): Ticket 01**  
**Agents B/C/D:** prep only (read docs + identify file targets) — no edits until Ticket 01 merged.

### Window 2 (After Ticket 01 is merged)
**Agent A (Opus): Ticket 02**  
**Agent B (Sonnet): Ticket 05** (Agents list/detail wiring)  
**Agent C (Sonnet): Ticket 03** (Settings/config wiring)  
**Agent D (Sonnet): Ticket 04** (Channels/OAuth wiring)

### Window 3 (After Ticket 02 is merged)
**Agent A or B (Sonnet): Ticket 06** (Sessions/chat/conversations)  
**Agent C (Sonnet): continue Ticket 03** (if not done)  
**Agent D (Sonnet): continue Ticket 04** (if not done)

### Window 4 (After Ticket 06 is merged)
Parallelize remaining independent tracks:
- **Ticket 07** (Worktree/Filesystem)  
- **Ticket 08** (Nodes/Devices/Exec approvals)  
- **Ticket 11** (Security/Audit/Debug)  
- **Ticket 10** (Work/Goals/Rituals/Jobs) **only after** Ticket 09 decision doc is accepted  
- **Ticket 12** (Memories API) **only after** its decision block is resolved

---

## Collision‑Avoidance Rules (Required)
1. **Worktree per agent (mandatory)**  
   ```
   cd /Users/dgarson/clawd/clawdbot
   git worktree add /private/tmp/clawdbot-<branch-slug> -b <branch-name>
   cd /private/tmp/clawdbot-<branch-slug>
   ```
2. **File ownership** — no two agents edit the same files.
3. **No reformatting** outside the ticket scope.
4. **Decision blockers** must be resolved in `apps/web/codex-wiring/requirements-clarifications.md` before implementing.

---

## File Ownership Map (Per Ticket)

### Ticket 01 (Agent A)
- `apps/web/src/lib/api/gateway-client.ts`
- `apps/web/src/lib/api/index.ts`
- `apps/web/src/integrations/openclaw/*`

### Ticket 02 (Agent A)
- `apps/web/src/hooks/useGatewayStreamHandler.ts`
- `apps/web/src/stores/useSessionStore.ts`
- `apps/web/src/hooks/queries/useSessions.ts` (event wiring only)

### Ticket 03 (Agent C)
- `apps/web/src/components/domain/settings/*`
- `apps/web/src/hooks/queries/useConfig.ts`
- `apps/web/src/hooks/mutations/useConfigMutations.ts`
- `apps/web/src/lib/api/config.ts`

### Ticket 04 (Agent D)
- `apps/web/src/components/domain/config/channels/*`
- `apps/web/src/components/domain/config/ChannelConfigConnected.tsx`
- `apps/web/src/hooks/mutations/useConfigMutations.ts` (only if not claimed by Ticket 03)

### Ticket 05 (Agent B)
- `apps/web/src/hooks/queries/useAgents.ts`
- `apps/web/src/routes/agents/$agentId.tsx`
- `apps/web/src/components/domain/agents/*`
- `apps/web/src/hooks/mutations/useAgentMutations.ts`

### Ticket 06 (Agent A or B)
- `apps/web/src/hooks/queries/useSessions.ts` (full wiring)
- `apps/web/src/hooks/useChatBackend.ts`
- `apps/web/src/routes/conversations/*`
- `apps/web/src/routes/agents/$agentId/session/$sessionKey.tsx`

### Ticket 07 (unassigned)
- `apps/web/src/components/domain/session/SessionWorkspacePane.tsx`
- `apps/web/src/components/integrations/WorktreeFileManager.tsx`
- `apps/web/src/routes/filesystem/index.tsx`
- `apps/web/src/lib/api/worktree.ts`

### Ticket 08 (unassigned)
- `apps/web/src/routes/nodes/index.tsx`
- `apps/web/src/hooks/queries/useNodes.ts`
- `apps/web/src/hooks/mutations/useNodesMutations.ts`
- `apps/web/src/hooks/queries/useDevices.ts`
- `apps/web/src/hooks/mutations/useDevicesMutations.ts`

### Ticket 10 (unassigned; after Ticket 09)
- `apps/web/src/hooks/queries/useWorkstreams.ts`
- `apps/web/src/hooks/queries/useGoals.ts`
- `apps/web/src/hooks/queries/useRituals.ts`
- `apps/web/src/routes/workstreams/*`
- `apps/web/src/routes/goals/*`
- `apps/web/src/routes/rituals/*`
- `apps/web/src/routes/jobs/*`

### Ticket 11 (unassigned)
- `apps/web/src/features/security/*`
- `apps/web/src/routes/unlock/*`
- `apps/web/src/routes/debug/*`

### Ticket 12 (unassigned; after decision)
- `apps/web/src/hooks/queries/useMemories.ts`
- `apps/web/src/hooks/mutations/useMemoryMutations.ts`
- `apps/web/src/routes/memories/index.tsx`
- gateway handlers under `src/gateway/server-methods/*`

---

## Hand‑off Protocol Between Agents
- Post a short update with:
  - Files changed
  - Open questions/decisions
  - Any new RPCs assumed
- If a file in another ticket is needed, **ask to claim it first**.
