---
summary: "嚴格的設定驗證 + 僅限 doctor 執行遷移"
read_when:
  - 設計或實作設定驗證行為時
  - 處理設定遷移或 doctor 工作流時
  - 處理插件設定結構 (schema) 或插件載入限制時
title: "嚴格的設定驗證"
---

# 嚴格的設定驗證（僅限 doctor 執行遷移）

## 目標

- **拒絕所有位置（根目錄 + 巢狀結構）的未知設定鍵名**，根目錄的 `$schema` 中繼資料除外。
- **拒絕沒有結構 (schema) 的插件設定**；不載入該插件。
- **移除載入時的舊版自動遷移**；遷移僅透過 doctor 執行。
- **啟動時自動執行 doctor (dry-run)**；若無效，則封鎖非診斷指令。

## 非目標

- 載入時的回溯相容性（舊版鍵名不會自動遷移）。
- 靜默刪除無法識別的鍵名。

## 嚴格驗證規則

- 設定在每個層級都必須完全符合結構 (schema)。
- 未知的鍵名為驗證錯誤（根目錄或巢狀結構均不允許透傳），根目錄下作為字串的 `$schema` 除外。
- `plugins.entries.<id>.config` 必須由插件的結構 (schema) 進行驗證。
  - 若插件缺少結構 (schema)，則**拒絕插件載入**並顯示明確的錯誤。
- 未知的 `channels.<id>` 鍵名為錯誤，除非插件資訊 (manifest) 宣告了該頻道 ID。
- 所有插件都需要插件資訊 (`openclaw.plugin.json`)。

## 插件結構強制執行

- 每個插件都為其設定提供嚴格的 JSON Schema（內嵌在資訊檔中）。
- 插件載入流程：
  1. 解析插件資訊 (manifest) + 結構 (schema) (`openclaw.plugin.json`)。
  2. 根據結構 (schema) 驗證設定。
  3. 若缺少結構 (schema) 或設定無效：封鎖插件載入，記錄錯誤。
- 錯誤訊息包含：
  - 插件 ID
  - 原因（缺少結構 / 設定無效）
  - 驗證失敗的標記路徑
- 停用的插件會保留其設定，但 Doctor + 日誌會顯示警告。

## Doctor 流程

- 每次載入設定時都會執行 Doctor（預設為 dry-run）。
- 若設定無效：
  - 列印摘要 + 可執行的錯誤。
  - 提示：`openclaw doctor --fix`。
- `openclaw doctor --fix`：
  - 執行遷移。
  - 移除未知鍵名。
  - 寫入更新後的設定。

## 指令限制（當設定無效時）

允許（僅限診斷）：

- `openclaw doctor`
- `openclaw logs`
- `openclaw health`
- `openclaw help`
- `openclaw status`
- `openclaw gateway status`

其他所有項目都必須強制失敗，並顯示：「設定無效。請執行 `openclaw doctor --fix`。」

## 錯誤使用者體驗格式

- 單一摘要標題。
- 分組區塊：
  - 未知鍵名（完整路徑）
  - 舊版鍵名 / 需要遷移
  - 插件載入失敗（插件 ID + 原因 + 路徑）

## 實作接觸點

- `src/config/zod-schema.ts`：移除根目錄透傳；所有位置均使用嚴格物件。
- `src/config/zod-schema.providers.ts`：確保嚴格的頻道結構。
- `src/config/validation.ts`：在未知鍵名上失敗；不套用舊版遷移。
- `src/config/io.ts`：移除舊版自動遷移；始終執行 doctor dry-run。
- `src/config/legacy*.ts`：將用法移至僅限 doctor。
- `src/plugins/*`：新增結構註冊表 + 限制。
- `src/cli` 中的 CLI 指令限制。

## 測試

- 拒絕未知鍵名（根目錄 + 巢狀結構）。
- 插件缺少結構 → 插件載入被封鎖並顯示明確錯誤。
- 設定無效 → Gateway 啟動被封鎖，診斷指令除外。
- Doctor 自動 dry-run；`doctor --fix` 寫入修正後的設定。
