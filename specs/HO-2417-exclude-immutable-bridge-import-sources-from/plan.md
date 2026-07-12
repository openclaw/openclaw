# 實作計畫：排除不可變 bridge 匯入來源的 stale-page lint

**Branch**：`HO-2417-exclude-bridge-sources-stale-lint` | **日期**：2026-07-12 | **Spec**：[`spec.md`](./spec.md)

## 摘要

以 source-sync state 的 `group: "bridge"` 與 `pagePath` 精準識別 immutable bridge-import source page，僅在 `stale-page` 評估時排除這些頁面。一般 page 與 claim 的 freshness 規則、其他 lint 類別、stale-pages report 與 timestamp provenance 均維持不變。

## 技術背景

**語言**：TypeScript / ESM  
**主要依賴**：OpenClaw memory-wiki extension、Vitest  
**儲存**：既有 memory-wiki source-sync state  
**測試**：`extensions/memory-wiki/src/lint.test.ts` focused Vitest  
**平台**：OpenClaw plugin runtime  
**效能**：僅在既有 state entries 上過濾並建 set，O(n)；不新增 I/O 或掃描。  
**限制**：禁止改寫 imported source timestamp；不可隱藏 ordinary stale pages 或 stale claims。  
**UI**：N/A；issue 與程式 ownership 均為 lint policy，無 route/畫面/Playwright surface。

## 設計

### 資料流

1. `lintMemoryWikiVault` 讀取既有 source-sync state。
2. 從 state entries 擷取 group 為 `bridge` 的 normalized `pagePath`。
3. 將此 bridge-managed 路徑集合傳入 `collectPageIssues`。
4. 每個 page 仍照既有規則做結構、provenance、link、question、confidence 與 claim health 檢查。
5. 僅在 page freshness 為 stale/unknown 且準備發出 `stale-page` 時，若 path 屬於 bridge-managed 集合則略過。

### 變更表面

- `extensions/memory-wiki/src/lint.ts`：從 sync state 保留 `bridge` group 身分並收斂 stale-page predicate。
- `extensions/memory-wiki/src/lint.test.ts`：用 source-sync state fixture 驗證 managed stale bridge source 被排除，同時 ordinary stale page 仍被警告。
- `specs/HO-2417-exclude-immutable-bridge-import-sources-from/*`：本 planning PR 的 SpecKit artifacts。

### 不變條件

- `unsafe-local` 不在本 issue 的 immutable bridge exemption 內。
- `stale-claim`、claim provenance 與 stale-pages report compile 邏輯不變。
- 不更新 imported markdown 的 `updatedAt`，不重新匯入或修改 bridge artifacts。

## 測試策略

先寫 RED regression：建立 stale bridge source（有舊 `updatedAt`）並以 `writeMemoryWikiSourceSyncState` 登錄 `group: "bridge"`，目前預期會失敗，因為仍回報 `stale-page`。同一測試或鄰接測試建立未管理 stale source/entity 作為 control，預期一直回報 `stale-page`。實作最小 predicate 後執行 focused lint test，再執行 extension 的型別/相關 test command。

## Gate 判定

- Async lifecycle ownership：N/A；沒有跨 async phase 的 owner transfer。
- Visual TDD：N/A；無 UI/FE/Playwright route。
- External contract：N/A；只讀取 repo 內既有 state 與 lint module。
- Live validation：N/A；acceptance 可由 deterministic Vitest fixture 驗證，無 deployed/runtime credential dependency。
- Missing part：none；source entry group、page path、lint call site 和 test helper 均已在 repo 確認。
