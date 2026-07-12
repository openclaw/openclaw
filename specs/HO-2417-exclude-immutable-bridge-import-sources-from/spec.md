# 功能規格：排除不可變 bridge 匯入來源的 stale-page lint

**Feature Branch**：`HO-2417-exclude-bridge-sources-stale-lint`  
**建立日期**：2026-07-12  
**狀態**：Draft  
**Issue**：[`HO-2417`](https://linear.app/hohsiang-lab/issue/HO-2417/bug-exclude-immutable-bridge-import-sources-from-memory-wiki-stale)

## 使用者情境與測試

### 使用者故事 1：保留 bridge 匯入資料的原始時間（P1）

作為維護 memory wiki 的操作員，我要讓由 bridge sync-state 管理的歷史來源頁不再因刻意保留的舊 `updatedAt` 產生 `stale-page`，以免為了消警告而偽造來源時間。

**獨立測試**：建立一個已登錄在 source-sync state 的 bridge source page，執行 lint 後確認該路徑不含 `stale-page`。

**驗收情境**：

1. **Given** source-sync state 將 `sources/bridge-history.md` 註冊為 `bridge` 群組，且頁面 freshness 為 stale，**When** 執行 `lintMemoryWikiVault`，**Then** 該頁不產生 `stale-page`。
2. **Given** 同一頁仍有其他可檢測的資料品質問題，**When** 執行 lint，**Then** 本變更只排除 `stale-page`，不將它視為所有 lint 規則的豁免。

### 使用者故事 2：保留真實知識頁的 stale 偵測（P1）

作為維護者，我要 ordinary entity/source/synthesis pages 仍被 freshness policy 檢查，避免降低 stale-page 報表的可信度。

**獨立測試**：建立未受 bridge sync-state 管理的 stale entity 或 source page，執行 lint 後確認仍有 `stale-page`。

**驗收情境**：

1. **Given** 一個 ordinary stale entity/source/synthesis page，**When** 執行 lint，**Then** lint 仍回報該路徑的 `stale-page`。
2. **Given** stale claim 位於任意頁面，**When** 執行 lint，**Then** 既有 `stale-claim` 規則與 claim freshness 語意不因本變更而改變。

## 邊界案例

- source-sync state 內不存在的 raw source page 沿用目前未受 structured metadata 要求的行為；本 issue 不擴大其 policy。
- sync-state entry 屬於 `unsafe-local` 時，不因「managed」身分被新規則隱藏；本 issue 僅處理 immutable `bridge` imported source。
- report page 既有不產生 stale-page 的規則不變。
- stale-pages report 的生成範圍、其他品質警告及 imported source 的 frontmatter 不更新、不重寫。

## 功能需求

- **FR-001**：lint MUST 對 source-sync state 管理、且 entry group 為 `bridge` 的 source page 排除 `stale-page`。
- **FR-002**：排除判定 MUST 以既有 persisted source-sync state 的 page path 與 group 為依據，不得用寫入或修改頁面 `updatedAt` 達成。
- **FR-003**：lint MUST 繼續對未被上述 bridge entry 管理的 stale entity、source 與 synthesis page 回報 `stale-page`。
- **FR-004**：lint MUST 保留所有非 `stale-page` 的既有 rule 行為，尤其是 provenance、結構、open question、claim freshness 與 stale claim。
- **FR-005**：回歸測試 MUST 同時覆蓋「已管理 stale bridge source 不警告」與「ordinary stale page 仍警告」。

## 成功標準

- **SC-001**：受管理 stale bridge source 的 lint issue codes 不含 `stale-page`。
- **SC-002**：同一測試 vault 的 ordinary stale page issue codes 仍含 `stale-page`。
- **SC-003**：針對 memory-wiki lint 的 focused test suite 通過。
- **SC-004**：測試 fixture 的 imported source `updatedAt` 維持舊值，沒有為壓制 lint 改寫 timestamp。

## 假設與範圍

- 已驗證 `extensions/memory-wiki/src/lint.ts` 已讀取 `managedImportedSourcePagePaths`；實作會將其升級為可辨識 bridge group 的資料，而非新增外部服務或資料格式。
- 本 issue 為 BE/plugin lint policy，沒有 UI route、Figma、mockscreen 或視覺回歸需求。
- 不處理 claim-level provenance、genuine stale/open-question 資料清理，亦不改動 `reports/stale-pages.md` 的 compile policy。
