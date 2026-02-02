# `apps/web` Wiring Game Plan (Gateway Integration)

This is a complete, step‑by‑step wiring plan for `apps/web`, aligned with the Opus UX docs in `apps/web/ux-opus-design/`. It enumerates what to wire, where, open questions, and the **new/changed RPCs/APIs** required to support the current UX.

---

## Phase 0 — Unify Gateway Client + Event Pipeline (blocking)

**Goal:** One gateway client, protocol v3, consistent event shapes.

- **Replace** the split between `lib/api/gateway-client.ts` and `integrations/openclaw`.
- **Implement protocol v3 handshake** (nonce + device auth) used by legacy control UI:
  - `connect` with `minProtocol=3`, `maxProtocol=3`, device identity + optional token/password.
  - Handle `connect.challenge` before `connect`.
- **Standardize frames:** `{ type: "req" } / { type: "res" } / { type: "event" }`.
- **Event routing:**
  - Map gateway `chat` + `agent` events into the session store.
  - Replace `tool` event assumptions (apps/web) with `agent` stream parsing or add a gateway `tool` event.
- **Files to touch:**
  - `apps/web/src/lib/api/gateway-client.ts`
  - `apps/web/src/hooks/useGatewayStreamHandler.ts`
  - `apps/web/src/hooks/queries/useSessions.ts` (event subscription)
  - `apps/web/src/integrations/openclaw/*` (either delete or adapt)

---

## Phase 1 — Core Settings + Config Wiring

**Goal:** Fully live system settings using canonical config keys.

- **Settings data:**
  - Use `config.get`, `config.schema`, `config.patch`, `config.apply` for all settings panels.
  - Ensure `config.schema` returns `uiHints` in the shape expected by `DynamicConfigSection`.
- **Model & Provider:**
  - Use `models.list` for model list + capability gating.
  - Replace browser‑side `verifyProviderApiKey` with gateway RPC (see “New RPCs” below).
- **Gateway section:**
  - Bind to `config.gateway.*` with `config.patch` + `config.get` refresh.
- **Usage/Billing:**
  - Wire to `usage.status` + `usage.cost` (gateway already lists these methods).

**Files to touch:**
- `apps/web/src/components/domain/settings/*`
- `apps/web/src/hooks/queries/useConfig.ts`
- `apps/web/src/hooks/mutations/useConfigMutations.ts`

---

## Phase 2 — Agents + Sessions + Chat

**Goal:** Make agent list/detail and sessions fully live and consistent with gateway behavior.

- **Agent list:** use `agents.list` (gateway) instead of config‑derived mock list.
- **Agent detail:**
  - Hook Overview tab to `sessions.list` (recent sessions) + `agent.identity.get`.
  - Implement config editing using `config.patch` for per‑agent overrides.
- **Chat:**
  - Use `chat.history`, `chat.send`, `chat.abort`.
  - Ensure streaming deltas update `useSessionStore` via gateway events.
  - Align tool stream UI with `agent` event payloads (legacy uses `stream=tool`).

**Files to touch:**
- `apps/web/src/hooks/queries/useAgents.ts`
- `apps/web/src/hooks/queries/useSessions.ts`
- `apps/web/src/routes/agents/*`
- `apps/web/src/hooks/useChatBackend.ts`
- `apps/web/src/hooks/useGatewayStreamHandler.ts`

---

## Phase 3 — Channels + Pairing

**Goal:** Replace all mock/stub channel flows with gateway RPCs.

- **Channel status:** `channels.status` (already wired)
- **Channel logout:** `channels.logout` (already wired)
- **WhatsApp pairing:** add `web.login.start` + `web.login.wait` support (legacy behavior)
- **OAuth pairing:** implement gateway‑side OAuth flows per Opus auth plan (see new RPCs)
- **Nostr profile:** either implement HTTP endpoints or remove Nostr UI.

**Files to touch:**
- `apps/web/src/components/domain/config/ChannelConfigConnected.tsx`
- `apps/web/src/components/domain/config/channels/*`

---

## Phase 4 — Work / Goals / Rituals (Product mapping decision)

**Goal:** Decide how “Workstreams, Goals, Rituals, Jobs” map to existing gateway systems.

**Options:**
1. **Map Workstreams + Goals → Overseer**
   - `overseer.status`, `overseer.goal.*`, `overseer.work.update`, `overseer.tick`
2. **Map Rituals + Jobs → Cron**
   - `cron.list`, `cron.add`, `cron.update`, `cron.run`, `cron.runs`
3. **Use Automations for Workstreams (if intended)**
   - `automations.*` suite

**Action:** pick one mapping, then replace mock hooks:
- `useWorkstreams`, `useGoals`, `useRituals`, `useJobs`

---

## Phase 5 — Nodes, Devices, Exec Approvals

**Goal:** Wire power‑user controls to gateway security surfaces.

- **Nodes:** `node.list`, `node.pair.*`, `node.invoke.*` where needed.
- **Devices:** `device.pair.*`, `device.token.*`.
- **Exec approvals:** use `exec.approvals.*` + `exec.approval.resolve` (legacy‑compatible).
- **Tool approval buttons:** decide between existing exec approval system vs new `tool.approve/reject` RPCs.

---

## Phase 6 — Filesystem / Worktree

**Goal:** Replace mock filesystem with real agent workspace access.

- Use gateway RPCs: `worktree.list`, `worktree.read`, `worktree.write`, `worktree.move`, `worktree.delete`, `worktree.mkdir`.
- Update UI to build file tree from `worktree.list` and remove mock file nodes.
- Optional: add HTTP worktree endpoints if the HTTP adapter is kept.

---

## Phase 7 — Security, Audit, Debug

- **Unlock + 2FA + tokens:** wire all Security RPCs (already implemented in gateway).
- **Audit log:** use `audit.query` and wire UI view.
- **Debug:** implement real RPC runner + event log + `logs.tail`.

---

## Open Questions / Decisions Needed

1. **Workstreams mapping:** Overseer vs Automations vs new Workstreams API?
2. **Rituals mapping:** Cron jobs vs Automations?
3. **Tool approval UX:** use exec approvals (`exec.approval.*`) or introduce `tool.approve/reject`?
4. **Provider auth:** gateway‑mediated OAuth + pairing, or browser‑side only? (Opus docs strongly prefer gateway‑side, headless‑safe flows.)
5. **Nostr support:** keep + implement HTTP endpoints or remove from UI?
6. **Conversation model:** treat conversations as session keys (recommended) or add a new conversation API?
7. **Gateway client choice:** fully replace OpenClaw integration or bridge it to gateway protocol v3?

---

## RPCs/APIs to Create or Change

### Changes to Existing RPCs / Events

| Change | Needed for | Notes |
|---|---|---|
| **Protocol v3 handshake in `apps/web` client** | All gateway RPCs | Update `gateway-client.ts` to match gateway protocol v3 + device auth (nonce + signature). |
| **Event handling for tool stream** | Session chat UI | Gateway emits `agent` events; apps/web expects `tool` events. Either update UI to parse `agent` stream or add a `tool` event in gateway. |
| **Provider capability metadata in `models.list`** | Model/provider gating | Opus requires capability‑gated controls. Extend `models.list` to include capability flags if not present. |

### New RPCs / APIs (Not Currently in Gateway)

| New RPC/API | Needed by | Rationale |
|---|---|---|
| **`agent.test`** (or `models.test`) | Onboarding health checks | Legacy UI already calls `agent.test`; gateway lacks it. Should validate model/provider connectivity safely. |
| **Provider auth flows** (e.g., `auth.oauth.start`, `auth.oauth.status`, `auth.oauth.finish`, `auth.pairing.start`) | Settings → Model & Provider | Opus auth plan requires headless‑safe OAuth + pairing with gateway‑side token storage. |
| **Toolset CRUD** (`toolsets.list/create/update/delete/clone/export/import`) | Toolsets UI (Settings + Agents) | Opus design explicitly expects gateway‑backed toolsets. |
| **Workstreams API** (`workstreams.*`) *if not using Overseer/Automations* | Work tab + Workstreams views | Only required if Workstreams is not mapped to existing Overseer/Automations. |
| **Rituals API** (`rituals.*`) *if not using Cron* | Rituals views | Only required if Rituals isn’t backed by Cron. |
| **Memories API** (`memory.list`, `memory.search`, `memory.create`, `memory.update`, `memory.delete`) | Memories UX | Not present in gateway; aligns with Graph/Memory track docs. |
| **Worktree HTTP endpoints** (optional) | Filesystem HTTP adapter | Only if the HTTP worktree adapter remains in use. |
| **Nostr profile endpoints** (`/api/channels/nostr/...`) | Nostr channel UI | UI calls these today; backend handlers not found. |

---

## Practical Wiring Checklist (by file/area)

- `apps/web/src/lib/api/gateway-client.ts`: update to protocol v3 + device auth.
- `apps/web/src/hooks/useGatewayStreamHandler.ts`: parse `agent` events for tool stream; handle compaction + errors.
- `apps/web/src/hooks/queries/useSessions.ts`: real event subscription instead of placeholder.
- `apps/web/src/components/domain/config/*`: ensure all config mutation paths use `config.patch` with correct `baseHash`.
- `apps/web/src/components/domain/settings/ModelProviderSection.tsx`: replace browser‑side provider verification with gateway RPC.
- `apps/web/src/components/domain/settings/ChannelsSection.tsx` + `ChannelConfigConnected.tsx`: wire WhatsApp pairing + OAuth flows.
- `apps/web/src/routes/workstreams/*`, `routes/goals/*`, `routes/rituals/*`, `routes/jobs/*`: replace mock hooks with gateway RPCs per chosen mapping.
- `apps/web/src/routes/conversations/*`: replace mock store with sessions‑based data.
- `apps/web/src/routes/filesystem/*` + `components/domain/session/SessionWorkspacePane.tsx`: use `worktree.list/read` for file tree + preview.
- `apps/web/src/routes/debug/*`: wire real RPC runner, event log, and logs tail.
- `apps/web/src/features/security/*`: ensure unlock + tokens + audit are wired to gateway client.

