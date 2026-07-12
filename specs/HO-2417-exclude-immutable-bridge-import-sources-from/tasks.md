# 工作清單：排除不可變 bridge 匯入來源的 stale-page lint

## Phase 1：回歸測試（RED）

- [ ] T001 在 `extensions/memory-wiki/src/lint.test.ts` 新增 source-sync state 的 `group: "bridge"` stale source fixture，先斷言該路徑不應有 `stale-page`。
- [ ] T002 在同一 test scope 新增或保留 ordinary stale source/entity control fixture，斷言其仍有 `stale-page`。
- [ ] T003 執行 focused lint test，確認新 bridge assertion 在實作前為 RED，且 control assertion 表示既有 ordinary policy 未被意外放寬。

## Phase 2：最小 policy 實作

- [ ] T004 在 `extensions/memory-wiki/src/lint.ts` 從 source-sync state 僅收集 `group: "bridge"` 的 normalized page path。
- [ ] T005 在 `collectPageIssues` 的 page freshness 分支套用 bridge-managed path exclusion，其他 page/claim lint branches 不變。

## Phase 3：驗證與範圍保護

- [ ] T006 執行 focused lint test，確認 bridge source 沒有 `stale-page` 且 ordinary stale page 仍有 warning。
- [ ] T007 執行 memory-wiki package 對應的 typecheck/targeted test，確認 TypeScript 與 extension contract 正確。
- [ ] T008 檢查 diff，確認未修改 imported source markdown、`updatedAt`、stale-pages compile report 或無關的 lint policy。
