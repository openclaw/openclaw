# Carve spec — PR2 (Workspaces UI) + PR3 (custom widgets) onto fresh upstream

You are carving 2 stacked branches in THIS worktree (`/Volumes/LEXAR/repos/openclaw.worktrees/upstream-carve`, deps installed). PR1 is DONE: branch `up/pr1-backend` (the plugin backend, off `upstream/main`) is committed + pushed. The full polished feature lives on `fork/feat/modular-dashboard`. Fresh upstream = `upstream/main` (5b5a540e34).

**Verified facts (rely on these):** our stack has ZERO source-code conflicts with upstream — only 4 EXISTING upstream files are touched, all with small additive edits: `ui/src/pages/plugin/plugin-page.ts`, `ui/src/styles.css`, `ui/src/app/app-host.ts`, `ui/src/components/app-topbar.ts`. Everything else we add is net-new (safe to copy from `fork/feat/modular-dashboard`). The `extensions/dashboard` backend is entirely in PR1.

## The 3 shared files that span layers (the ONLY tricky part)

- `extensions/dashboard/index.ts`: PR1 has backend regs only. **PR2 adds** the `registerControlUiDescriptor({surface:"tab", id:"workspaces", …})` block. **PR3 adds** the `createWidgetHttpRouteHandler` + `api.registerHttpRoute({path: WIDGETS_ROUTE_PREFIX, auth:"plugin", …})` block. (See the final version on fork/feat/modular-dashboard:extensions/dashboard/index.ts for the exact blocks.)
- `ui/src/components/dashboard-widget-cell.ts`: **PR2** ships the TRUSTED state — builtin dispatch + a neutral placeholder for `custom:` kinds, and it must NOT import `./dashboard-custom-widget.ts` or reference `renderCustomWidget`/`DashboardCustomWidgetContext` (those are PR3). **PR3** adds the custom-widget branch back (the full final version). Reconstruct PR2's version from the final file by removing the custom-host wiring so it compiles with NO L5 files present.
- `ui/src/pages/plugin/dashboard-view.ts`: same principle — PR2 = trusted (no manifest-loading / custom-host plumbing that references L5); PR3 = final. If view.ts's L5-specific additions are cleanly separable, split them; if trivial, PR2 may carry the manifest-cache state fields as long as they don't import L5 files.

## PR2 — `up/pr2-workspaces-ui` (branch off `up/pr1-backend`)

Content = the Workspaces UI: shell + grid/drag/collapse + 9 builtin widgets + Overview-as-data default workspace + the UX polish. Copy these NET-NEW paths from `fork/feat/modular-dashboard` (`git checkout fork/feat/modular-dashboard -- <path>`):

- `ui/src/pages/plugin/dashboard-view.ts`, `dashboard-controller.ts`
- `ui/src/lib/dashboard/` (index.ts, grid.ts, types.ts, widgets/\*) — EXCLUDING `bridge.ts` (that's L5/PR3)
- `ui/src/components/dashboard-widget-cell.ts` (then reconstruct to trusted state — see above), `dashboard-header.ts`
- `ui/src/styles/dashboard.css`
- The tests for all the above (exclude any that import L5: bridge/custom-widget/serve/manifest tests, and `rpc-allowlist-sync.test.ts`).
- `ui/src/i18n/locales/en.ts` — bring over ALL dashboard._ keys (yes, incl. approval._ even though the UI lands in PR3; simplest, and harmless). Then run `pnpm ui:i18n:sync` (NO api key) to regenerate bundles. The `ships-no-fallbacks` i18n test will go RED — that's EXPECTED; leave it, the orchestrator runs the translation pass before the PR opens.
  For the 4 EXISTING files (3-way — copy our final versions; they have zero conflicts so the final version applied onto upstream is correct): `plugin-page.ts` (the BUNDLED_TAB_VIEWS "dashboard/workspaces" entry), `styles.css` (the dashboard.css import), `app-host.ts` + `app-topbar.ts` (the breadcrumb-label prop). Apply our edits onto UPSTREAM's current version (do NOT blindly overwrite — upstream may have other changes; use `git checkout fork/feat/modular-dashboard -- <file>` then eyeball that no upstream content was lost, or hand-apply the small additive hunk).
  `extensions/dashboard/index.ts`: add the descriptor block.
  **PR2 acceptance:** `pnpm ui:build` clean; `cd ui && pnpm vitest run src/lib/dashboard src/pages/plugin src/components` green; type-aware oxlint clean on touched files; `node scripts/test-projects.mjs extensions/dashboard` still green; NO L5 files present (`ls extensions/dashboard/src/http-route.ts` → absent); `ui/src/components/dashboard-custom-widget.ts` absent; grep the diff for any import of a non-existent file → none. Commit, `git push fork up/pr2-workspaces-ui`.

## PR3 — `up/pr3-custom-widgets` (branch off `up/pr2-workspaces-ui`)

Content = the sandboxed custom-widget host. Copy from `fork/feat/modular-dashboard`:

- `extensions/dashboard/src/http-route.ts`, `serve.ts`, `serve.test.ts`, `manifest.ts`, `manifest.test.ts`, `rpc-allowlist-sync.test.ts`
- `ui/src/lib/dashboard/bridge.ts` + `bridge.test.ts`
- `ui/src/components/dashboard-custom-widget.ts` + `dashboard-custom-widget.test.ts`
- `ui/src/e2e/dashboard-custom-widget.e2e.test.ts`
- `dashboard-widget-cell.ts` → restore the FINAL version (custom branch back); `dashboard-widget-cell.test.ts` → final.
- `extensions/dashboard/index.ts` → add the http-route block (final version).
- Any en.ts approval keys not already carried in PR2 (if you carried them all in PR2, nothing to add here; re-sync i18n only if en.ts changed).
  **PR3 acceptance:** `node scripts/test-projects.mjs extensions/dashboard` green (incl. serve/manifest/jail/sync-guard); `cd ui && pnpm vitest run src/lib/dashboard src/components src/pages/plugin` green; `pnpm ui:build` clean; type-aware oxlint clean. Commit, `git push fork up/pr3-custom-widgets`.

## Rules

- Do NOT touch `up/pr1-backend`. Work only on the two new branches.
- Each branch must be independently buildable/testable at its tip (that's what makes them reviewable PRs).
- If the `ships-no-fallbacks` i18n test is the ONLY red test, that's expected (orchestrator translates after) — note it and proceed. ANY other red test = stop and report with the exact failure.
- No new npm deps beyond what PR1 already added (typebox).

## Report (bounded, ≤35 lines)

Per branch: the sha, `git diff --stat upstream/main..<branch> | tail -1` size, the acceptance-command verdicts, the reconstructed-shared-file confirmation (PR2 has no L5 imports; PR3 restores the custom branch), and any deviation. If a shared-file reconstruction was non-obvious, show the key hunk.
