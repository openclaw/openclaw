# Maibot ↔ OpenClaw upstream alignment

## Policy

- **Prefer upstream OpenClaw** on this repo’s `main` (tracking `https://github.com/openclaw/openclaw.git`).
- **Product-specific behavior** (operator brief, UI visibility, workbench copy) stays in **Maibot** via `chat.send` / `sessions.send` **`extraSystemPrompt`** and local state — not fork-only gateway fields.
- **Minimal OpenClaw deltas** should be limited to **RPC/schema gaps** that Maibot needs and upstream is willing to carry (e.g. optional `extraSystemPrompt` on `chat.send` and `sessions.send`).

## Fork backup (local maintainer)

After a hard reset to `origin/main`, prior fork work may still exist as:

- **Branch:** `backup/main-pre-official-reset-20260417` (or similar name you created before reset).
- **Stash:** `git stash list` → entry like `wip: control-ui + schema before sync origin/main …`.

Restore WIP with `git stash pop` only when you intend to **reconcile conflicts** against current upstream; otherwise keep stash as an archive.

## Removed / non-upstream concepts

Upstream **does not** define `workflowMode` on `sessions.patch` or session rows. Maibot **Ask / Plan / Agent** remains a **client workbench** concept:

- **Server alignment:** `thinkingLevel` `off` ↔ Ask-style low reasoning; `auto` ↔ Plan/Agent (both use extended thinking on the gateway). Plan vs Agent distinction is **UI + `extraSystemPrompt`** (e.g. plan strict appendix), not a separate session field.

## Implemented gateway extension (this tree)

- `ChatSendParamsSchema` / `SessionsSendParamsSchema`: optional **`extraSystemPrompt`** (max 65535 chars).
- `chat.send` → `MsgContext.GatewayExtraSystemPrompt` → `get-reply-run` merges into the run’s `extraSystemPrompt` parts.
- Unit tests: `src/gateway/server-methods/chat.extra-system-prompt.test.ts` (normalizer + AJV schema).
- **Workbench / Maibot project binding:** `SessionsCreateParamsSchema` / `SessionsPatchParamsSchema` optional **`projectId`** / **`projectName`** (max 512 chars); persisted on `SessionEntry` and returned on `sessions.list` rows (`GatewaySessionRow`). Maibot uses these for cross-client `WorkProject` sync.

This matches Maibot’s operator brief and UI snapshot injection without stuffing them into the user `message` field.

## Maibot client (sibling repo)

- Shared strict-RPC retry: `packages/store/src/gateway-strict-body-retry.ts` (`extraSystemPrompt` strip + retry) used by **`chat.send` / `sessions.send`** and **`sessions.steer`**.
- Prompt size cap SSOT: `@maibot/contracts` **`CHAT_EXTRA_SYSTEM_PROMPT_MAX_CHARS`** (must stay aligned with OpenClaw `maxLength: 65_535` on `chat.send` / `sessions.send`).

## Workspace indexing (Maibot ↔ OpenClaw)

- **Maibot desktop** mirrors indexing preferences to **`<primaryWorkspace>/.maibot/indexing/preferences.json`** (JSON schema version `1`), aligned with `extraSystemPrompt` shell appendix (`buildWorkspaceIndexingAppendix`).
- **OpenClaw gateway** reads that file from the **default agent workspace** (`resolveAgentWorkspaceDir`) and, when valid, exposes a compact copy on **`hello.ok.snapshot.maibotWorkspaceIndexing`** (`SnapshotSchema` / `MaibotWorkspaceIndexingSnapshotSchema`).
- Implementation: `src/infra/maibot-indexing-preferences.ts` (`readMaibotIndexingPreferencesFromWorkspace`, `toMaibotWorkspaceIndexingHelloSnapshot`); wired in `src/gateway/server/health-state.ts` → `buildGatewaySnapshot`.
- If the file is missing or invalid, the field is omitted (connect still succeeds). Clients may use the field to align UI with on-disk prefs when the gateway cwd matches the same tree.

### Maibot UI (sibling repo)

- Parses `hello.ok.snapshot.maibotWorkspaceIndexing` via `parseMaibotWorkspaceIndexingFromHello`, stores `gatewayMaibotWorkspaceIndexing`, and **Settings → Indexing** compares it to local prefs + `resolveEffectiveWorkspaceForPrompt` (`compareIndexingPreferencesWithGateway`).
- Parses `hello.ok.snapshot.openclawAgentWorkspaceRoot` (absolute default-agent OpenClaw workspace on the gateway host) into `gatewayOpenClawAgentWorkspaceRoot`; **Settings → Indexing** shows it next to the Maibot effective root and indexing JSON primary.
- Injects `buildWorkspaceDualPlaneAppendix` into `extraSystemPrompt` when the gateway is non-loopback or paths diverge, so models do not assume laptop paths == tool cwd.
