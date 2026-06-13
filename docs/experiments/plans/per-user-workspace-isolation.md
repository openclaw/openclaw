# Option A — Per-User Workspace Isolation for the `life` Agent

**Status:** code merged-ready (PRs below); deploy gated. **Date:** 2026-06-12.

## Problem

The `life` (Havaya/TAL) agent runs in **one shared per-agent workspace**
(`/root/.openclaw/agents/life/workspace/`). Its built-in file tools
(`read`/`write`/`edit`/`exec`/`find`/…) are rooted there with the sandbox jail
**off** (`tools.fs.workspaceOnly` unset). So any app user who asks "show me the
files" could read the agent IP (`SOUL.md`, the TAL method files), other users'
`users/<id>.md`, and `sec001.md`. The per-user work already shipped (Graphiti
memory + the user-file API) never constrained these tools — there was **no
per-user workspace**.

A stopgap (`life-access-scope` hook) already blocks shell/enumeration and
out-of-workspace reads for app sessions. This is the **durable fix**.

## Mechanism: A2 (per-user workspace root)

Not the Docker sandbox subsystem (A1): it's Docker-coupled (the live gateway has
no docker sock), keys per-_conversation_ not per-user, and re-seeds the IP into
every dir. Instead, a small source change re-roots app sessions to a private
per-user dir, keyed by the **stable `appUserId`** from the session entry.

```
/root/.openclaw/agents/life/workspace/
├── AGENTS.md SOUL.md IDENTITY.md TOOLS.md USER.md BOOTSTRAP.md MEMORY.md  ← IP (boot-injected)
├── skills/ groups/ projects/                                              ← agent-global
├── users/<appUserId>.md                                                   ← canonical per-user file (dashboard reads here)
└── user-workspaces/<appUserId>/                                           ← app-session tool cwd/root (jailed, no IP)
```

- **App user (non-admin):** tools rooted at `user-workspaces/<appUserId>/`; cannot reach the IP or other users.
- **Admin (hard-coded allowlist) / telegram / owner / webchat / cron / subagent:** full shared `workspace/`.
- **App session with no resolvable appUserId:** throwaway empty dir (**fail closed**), never the shared workspace.
- **IP still reaches the agent:** skills + bootstrap context load from the agent home; only the tool cwd/root narrows.
- **User-file:** `save_user_section` writes `<workspace>/users/<appUserId>.md` via an explicit `userFileDir` (decoupled from the jailed cwd); the dashboard reader resolves the same path. One deterministic location for everyone, admins included.

## Code (PRs)

- Gateway — [cryptolir/openclaw#62](https://github.com/cryptolir/openclaw/pull/62): new `src/agents/app-user-workspace.ts` (single identity+workspace resolver); `run/attempt.ts` + `compact.ts` (both call sites) split tool-workspace vs bootstrap-workspace; `pi-tools.ts`/`openclaw-tools.ts`/`save-user-section.ts` thread `userFileDir`.
- Dashboard — [cryptolir/openclaw-dashboard#119](https://github.com/cryptolir/openclaw-dashboard/pull/119): `resolveUserFilePath` reads `workspace/users/<userId>.md` (also fixes the live reader/writer mismatch).

Both type-check clean.

## Deploy / migration (gated — prod)

1. **Backup** (US host): `tar czf /root/life-workspace-backup-<ts>.tgz -C /root/.openclaw/agents/life workspace` + `cp openclaw.json{,.bak.optionA}`.
2. **Clean cruft:** delete `USER.md.bak`, `USER.md.lock`, `AGENTS.md.bak.*`; **delete the legacy TAL method files** (confirmed unread at runtime — the method is inlined in SOUL.md).
3. **Reconcile the one test user's file:** today reader=`USER.md`(root) ≠ writer=`users/<id>.md` — consolidate into `workspace/users/<appUserId>.md`.
4. **Config:** set `tools.fs.workspaceOnly: true` on the life agent (tool-layer containment guard — the base tools have no `..`/absolute jail without it). Verify the obsidian skill doesn't need an out-of-workspace vault (else carve out).
5. **Rebuild + deploy** the gateway image; **verify telegram first** (un-jailed, unchanged), then app sessions auto-create their per-user dirs lazily.
6. **Deploy the dashboard** reader change.

**Rollback:** redeploy the prior gateway build (app sessions revert; `:app:`-gated) + prior dashboard; `tar xzf` the backup if files were touched.

## Verification

- App user A: reads can't reach B's file or the IP; `user-workspaces/<A>/` holds no SOUL/AGENTS on disk; IP still in the system prompt (ask a TAL-method question).
- `save_user_section` → lands at `workspace/users/<A>.md`; dashboard endpoint returns it.
- Second conversation for A reuses the same dir (per-user, not per-conversation).
- Telegram/owner: full `workspace/`, group/project writes intact.

## Open items

- **Admin allowlist is empty** (`ADMIN_APP_USER_IDS` in `app-user-workspace.ts`) — populate with real admin appUserIds (or wire to the admin dashboard, built separately). Adding admins currently needs a rebuild.
- **`workspaceOnly: true` is global** — confirm no owner/telegram out-of-workspace file op (obsidian external vault) breaks.
- **Turn-1 race:** appUserId is persisted "best effort" by `chat.send`; a user's very first message may resolve to the fail-closed throwaway dir before falling into their real dir on turn 2. Verify ordering / test the first-message case.
- **Stopgap stays** (`life-access-scope`) as defense-in-depth; its path-confinement is load-bearing until `workspaceOnly` is on, then redundant-but-kept.
- **Phase 5** (telegram users get a visible file) deferred — same files, ship as a fast follow.
