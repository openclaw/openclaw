# Requirements Clarifications (Ticket 13 Dossier)

This dossier enumerates ambiguities across Tickets 01–12 and documents explicit decisions or required operator choices. It also includes a wiring assumptions ledger that each ticket should follow.

## Required Decisions (Operator Needed)

| Ticket(s) | Ambiguous Point | Decision Needed (Allowed Answers) | Recommended Default | Risk if Wrong |
|---|---|---|---|---|
| 03 | Provider API key verification RPC | Choose RPC name + shape: `provider.verify` or `models.verify` or `auth.provider.verify` (table with params/result/error) | None (gateway does not define this yet) | Provider setup fails or is inconsistent with gateway storage |
| 03 | Usage polling cadence | `15s` / `30s` / `60s` / `manual-only` | `30s` (typical dashboard) | Excess load or stale billing data |
| 04 | OAuth RPC contract | `auth.oauth.*` vs `oauth.*` (table with params/result) | `auth.oauth.*` (namespacing aligns with security/auth surfaces) | OAuth flow unusable or inconsistent |
| 04 | OAuth redirect strategy | `popup + postMessage` / `new-tab + polling` / `same-tab + hash` | `popup + postMessage` (best UX) | OAuth flow breaks in headless or cross-origin contexts |
| 04 | Nostr support | `keep-and-implement-http-endpoints` or `remove-ui` | None (backend endpoints not found) | Dead UI or missing feature |
| 05 | Per‑agent config paths | Explicit key list per UI section (from Canonical Config doc) | Use canonical config keys | Wrong fields updated or config corruption |
| 06 | Session sorting | `lastMessageAt desc` / `updatedAt desc` / `createdAt desc` | `lastMessageAt desc` (best chat UX) | Confusing session ordering |
| 06 | Sessions pagination | `fixed-limit` or `paged` | `fixed-limit` with 50 | Performance issues on large stores |
| 07 | Default agent for `/filesystem` | `agents.list.defaultId` / `agents.list.mainKey` / `explicit-ui-setting` | `agents.list.defaultId` | Wrong workspace opened |
| 07 | Path normalization | `always-absolute` or `allow-relative` | `always-absolute` | Path traversal bugs or inconsistent list/read |
| 08 | Exec approvals queue source | `events-only` or `events+polling` | `events+polling` (events can be missed) | Missing pending approvals |
| 08 | Node scope selection | `explicit-select` or `current-node-context` | `explicit-select` | Editing wrong node approvals |
| 11 | Debug RPC runner scope | `all-methods` or `allowlist` | `allowlist` (safer) | Accidental dangerous calls |
| 11 | Security history source | `security.getHistory` or `audit.query` | `security.getHistory` | Confusing or incomplete history |
| 12 | Memory object schema | Explicit field list (table) | None (new API) | UI/gateway mismatch |
| 12 | Memory storage backend | `sqlite` / `graph-service` / `hybrid` | `sqlite` for MVP | Over‑scoped backend work |
| 12 | Memory search semantics | `keyword` / `vector` / `hybrid` | `keyword` for MVP | Search unusable or expensive |

## Clarified Defaults (From Source)

- **Gateway protocol:** Web UI must use protocol **v3** with `connect.challenge` nonce before `connect` (legacy control UI reference).
- **Event names:** Gateway events include `agent`, `chat`, `presence`, `cron`, `exec.approval.requested`, `exec.approval.resolved`, etc. (see `src/gateway/server-methods-list.ts`).
- **Chat event schema:** `{ runId, sessionKey, seq, state, message?, errorMessage?, usage?, stopReason? }` (see `src/gateway/protocol/schema/logs-chat.ts`).
- **Agent event schema:** `{ runId, seq, stream, ts, data }` (see `src/gateway/protocol/schema/agent.ts`). `sessionKey` is often included by runtime but not guaranteed by schema.
- **Worktree RPCs:** `worktree.list/read/write/move/delete/mkdir` require `agentId` and `path` (see `src/gateway/server-methods/worktree.ts`).
- **Exec approvals:** `exec.approvals.*` and `exec.approval.*` are the canonical API for approvals (see `src/gateway/server-methods-list.ts`).
- **Sessions:** `sessions.list` supports `includeLastMessage` and `includeDerivedTitles` (see `src/gateway/protocol/schema/sessions.ts`).

## Wiring Assumptions Ledger (per Ticket)

### Ticket 01 — Gateway Client v3
- **RPCs:** `connect` (after `connect.challenge`).
- **Frames:** `{ type: "req" | "res" | "event" }` only.
- **Auth:** role `operator`, scopes `operator.admin`, `operator.approvals`, `operator.pairing`.
- **Hello:** expect `hello-ok` with features + auth.deviceToken.

### Ticket 02 — Event Streams
- **Events:** `chat` + `agent` only (no `tool` event).
- **Chat payload:** see schema above.
- **Agent payload:** parse `stream` values `tool` and `compaction`.

### Ticket 03 — Settings
- **Config:** `config.get`, `config.schema`, `config.patch`, `config.apply`.
- **Models:** `models.list` (schema in `agents-models-skills.ts`).
- **Usage:** `usage.status`, `usage.cost`.

### Ticket 04 — Channels + OAuth
- **WhatsApp:** `web.login.start`, `web.login.wait`.
- **Status/logout:** `channels.status`, `channels.logout`.
- **OAuth:** RPC contract pending decision.

### Ticket 05 — Agents
- **List:** `agents.list` returns `{ defaultId, mainKey, scope, agents[] }`.
- **Identity:** `agent.identity.get`.
- **Stats:** `sessions.list` with `agentId` filter.

### Ticket 06 — Sessions + Chat
- **List:** `sessions.list` with `includeLastMessage` + `includeDerivedTitles`.
- **History:** `chat.history` with `limit`.
- **Send:** `chat.send` with `idempotencyKey`.
- **Abort:** `chat.abort` with `runId` optional.

### Ticket 07 — Worktree
- **RPCs:** `worktree.list/read/write/move/delete/mkdir`.
- **File size:** `worktree.read` respects `maxBytes`.

### Ticket 08 — Nodes/Devices/Approvals
- **Nodes:** `node.list`.
- **Devices:** `device.pair.list/approve/reject`, `device.token.rotate/revoke`.
- **Approvals:** `exec.approvals.get/set`, `exec.approvals.node.get/set`, `exec.approval.request/resolve`.

### Ticket 09 — Workstreams/Goals/Rituals/Jobs
- **Mapping decision required**; may involve `overseer.*`, `automations.*`, `cron.*`.

### Ticket 10 — Workstreams/Goals/Rituals/Jobs Implementation
- **Uses Ticket 09 mapping** without changes.

### Ticket 11 — Security/Audit/Debug
- **Security:** `security.*` flows; `tokens.*`.
- **Audit:** `audit.query` with filters and paging.
- **Debug:** `logs.tail`, `status`, `health`, and RPC runner (scope decision pending).

### Ticket 12 — Memories
- **New RPCs:** `memory.list/search/create/update/delete` (schema pending).
- **Backend:** decision required.
