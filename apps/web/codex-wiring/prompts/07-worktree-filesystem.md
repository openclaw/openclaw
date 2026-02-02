# Ticket 07 — Worktree + Filesystem Wiring

## Goal
Replace mock filesystem UI with real agent workspace access via gateway worktree RPCs.

## Background
- Gateway implements `worktree.*` RPCs (`src/gateway/server-methods/worktree.ts`).
- `apps/web` uses a mock file tree in `SessionWorkspacePane` and `/filesystem` route.

## Scope
- Use `worktree.list/read/write/move/delete/mkdir` for file tree + file preview.
- Remove mock file tree and mock filesystem data.
- Decide on RPC adapter vs HTTP adapter (prefer RPC).

## Requirements
1. **File tree**
   - Populate file tree using `worktree.list`.
2. **File preview**
   - Use `worktree.read` to display file contents.
3. **File operations**
   - Add write/move/delete/mkdir operations to UI where applicable.

## Fixed Decisions (Do Not Re‑decide)
- Use **RPC** methods (`worktree.*`) only; do **not** rely on HTTP adapters.
- `worktree.*` requires `agentId` + `path` for every call.
- Handle `encoding: "utf8"` by default; support `base64` for binary previews.

## Required Decisions (Blockers)
1. **Default agent for /filesystem**
   - **Question:** which agentId should `/filesystem` use when no agent route param exists?
   - **Allowed answers:** `agents.list.defaultId` or `agents.list.mainKey` or `explicit-ui-setting`
   - **Required response format:** single literal from list.
2. **Path normalization rules**
   - **Question:** should UI always send absolute-like paths (`/`) or allow relative?
   - **Allowed answers:** `always-absolute` or `allow-relative`
   - **Required response format:** single literal from list.

## Files to Touch (expected)
- `apps/web/src/components/domain/session/SessionWorkspacePane.tsx`
- `apps/web/src/components/integrations/WorktreeFileManager.tsx`
- `apps/web/src/routes/filesystem/index.tsx`
- `apps/web/src/lib/api/worktree.ts`

## Acceptance Criteria
- File tree reflects actual agent workspace.
- File preview works using `worktree.read`.
- Basic file operations succeed via gateway RPCs.

## Testing
- Manual: browse workspace, open a file, verify content.
- Manual: create/edit/delete a file and confirm via reload.
