# 研究紀錄

## Repo 實況

- 實際 owner repo 為 `hoh-dev-bot/openclaw`；`extensions/memory-wiki/src/lint.ts` 存在於此 repo。Linear project registry 已於規劃前補入該 repo 並 readback。
- `lintMemoryWikiVault` 讀取 source-sync state，現已計算 `managedImportedSourcePagePaths`，再傳入 `collectPageIssues`。
- `collectPageIssues` 對所有 `requiresStructuredPageMetadata && page.kind !== "report"` 的 stale/unknown freshness 一律發出 `stale-page`；這正是 false positive。
- `source-sync-state.ts` entry 已保存 `group`（`bridge` 或 `unsafe-local`）與 `pagePath`，足以做精準 policy 判定。
- `extensions/memory-wiki/src/lint.test.ts` 是既有 lint contract 測試位置，並已使用 `writeMemoryWikiSourceSyncState` 建立同步狀態 fixture。

## 決策

1. 將 lint 所需輸入從「所有 managed page path 的 set」調整為能識別 bridge-managed page 的集合或 predicate。
2. 只在產生 `stale-page` 時略過 bridge-managed path；不把 bridge page 排除於其他 lint rule，也不觸及 `stale-claim`。
3. 對 ordinary stale page 建立同測試 vault 的 control fixture，防止將 policy 寫成全面停用 freshness lint。
4. 不修改 markdown frontmatter、imported source timestamp、sync source 內容或 stale-pages report compile 邏輯。

## 外部契約

不適用。此變更只使用 repo 內既有 `MemoryWikiImportedSourceState` 與 lint API，沒有 provider、runtime、部署、credential 或跨 repo contract。
