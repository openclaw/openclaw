# UI: Conversation tabs, tab history, delete-from-history, and extra themes

## Summary

Describe the problem and fix in 2–5 bullets:

- **Problem:** Single chat session only; no way to keep multiple conversations or reopen closed ones; limited theme options.
- **Why it matters:** Users need to switch between chats without losing context and to personalize the UI with more themes.
- **What changed:** Added conversation tabs (multi-session), tab history sidebar with reopen/delete, rename tab flow, and four new themes (Indigo, Slate, Rose, Forest). Theme and tab state persisted in localStorage.
- **What did NOT change (scope boundary):** Gateway, skills, auth, memory, integrations, API contracts, CLI. No backend or config schema changes.

## Change Type (select all)

- [ ] Bug fix
- [x] Feature
- [ ] Refactor
- [ ] Docs
- [ ] Security hardening
- [ ] Chore/infra

## Scope (select all touched areas)

- [ ] Gateway / orchestration
- [ ] Skills / tool execution
- [ ] Auth / tokens
- [ ] Memory / storage
- [ ] Integrations
- [ ] API / contracts
- [x] UI / DX
- [ ] CI/CD / infra

## Linked Issue/PR

- Closes #
- Related #

## User-visible / Behavior Changes

- **Tabs:** Tab bar above chat; add (+), close (×), click to switch; each tab has its own chat session. Tab label and color (purple/green/amber/rose/sky).
- **Rename tab:** Double-click or context action opens rename popup.
- **Tab history:** Right sidebar lists closed tabs; "Keep last N" (10/20/30/40); click to reopen; trash icon to delete from history (with confirm).
- **Themes:** Topbar theme toggle now has 7 options: System, Light, Dark, Indigo, Slate, Rose, Forest. Selection saved in settings.
- **Defaults:** One tab on first load; theme default unchanged (system); history limit default 20.

## Security Impact (required)

- New permissions/capabilities? **No**
- Secrets/tokens handling changed? **No**
- New/changed network calls? **No**
- Command/tool execution surface changed? **No**
- Data access scope changed? **No** (only existing localStorage for settings; new key for tab state)
- If any `Yes`, explain risk + mitigation: N/A

## Repro + Verification

### Environment

- OS: macOS (dev)
- Runtime/container: Node
- Model/provider: N/A
- Integration/channel (if any): N/A
- Relevant config (redacted): `gateway.controlUi.root` pointing at built control-ui

### Steps

1. Build UI: `pnpm -w run ui:build`. Start gateway; open dashboard.
2. Chat tab: Add tab (+), close tab (×), switch tabs, double-click tab to rename.
3. Tab history: Close a tab; see it in right sidebar; click to reopen; use trash to delete from history; change "Keep last" and close more tabs to verify limit.
4. Themes: Use topbar theme toggle; switch to Indigo, Slate, Rose, Forest; refresh page and confirm theme persists.

### Expected

- Tabs and history work as described; themes apply and persist.

### Actual

- (Confirm after testing)

## Evidence

Attach at least one:

- [ ] Failing test/log before + passing after
- [ ] Trace/log snippets
- [x] Screenshot/recording (recommended: tab bar + history sidebar + theme toggle)
- [ ] Perf numbers (if relevant)

## Human Verification (required)

- **Verified scenarios:** Tab add/close/switch; reopen from history; delete from history with confirm; rename tab; theme switch and persistence.
- **Edge cases checked:** Single tab (no close); history at limit (trim); invalid saved state (parse defaults).
- **What you did not verify:** All themes on all viewport sizes; non-English locales.

## Compatibility / Migration

- Backward compatible? **Yes**
- Config/env changes? **No**
- Migration needed? **No**
- If yes, exact upgrade steps: N/A

## Failure Recovery (if this breaks)

- **How to disable/revert:** Revert PR or deploy previous control-ui build; set `gateway.controlUi.root` to prior build if needed.
- **Files/config to restore:** Previous `ui/` build or source.
- **Known bad symptoms reviewers should watch for:** Tab state not loading (localStorage key `openclaw.control.conversationTabs.v1`); theme not applying (check `data-theme` on `<html>`).

## Risks and Mitigations

- **Risk:** Large localStorage payload if user keeps many history entries.
  - **Mitigation:** History capped at 10/20/30/40; trim on load/save.
- **Risk:** Stale tab state if session keys change on backend.
  - **Mitigation:** Reopen loads chat history by sessionKey; no new backend contract.
- Otherwise: **None.**
