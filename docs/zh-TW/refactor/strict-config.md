---
summary: Strict config validation + doctor-only migrations
read_when:
  - Designing or implementing config validation behavior
  - Working on config migrations or doctor workflows
  - Handling plugin config schemas or plugin load gating
title: Strict Config Validation
---

# 嚴格的設定驗證（僅限 doctor 的遷移）

## 目標

- **拒絕所有未知的設定鍵**（根目錄及巢狀），但根目錄 `$schema` 的 metadata 除外。
- **拒絕沒有 schema 的外掛設定**；不載入該外掛。
- **移除載入時的舊版自動遷移**；遷移僅透過 doctor 執行。
- **啟動時自動執行 doctor（模擬執行）**；若設定無效，阻擋非診斷指令。

## 非目標

- 載入時的向下相容（舊版鍵不會自動遷移）。
- 靜默丟棄無法識別的鍵。

## 嚴格驗證規則

- 設定必須在每個層級完全符合 schema。
- 未知鍵視為驗證錯誤（根目錄及巢狀皆不允許通過），根目錄 `$schema` 為字串時除外。
- `plugins.entries.<id>.config` 必須由外掛的 schema 驗證。
  - 若外掛缺少 schema，**拒絕載入外掛**並顯示明確錯誤。
- 未知的 `channels.<id>` 鍵視為錯誤，除非外掛清單宣告該 channel id。
- 所有外掛皆需有外掛清單 (`openclaw.plugin.json`)。

## 外掛 schema 強制執行

- 每個外掛需提供嚴格的 JSON Schema 作為設定（內嵌於清單中）。
- 外掛載入流程：
  1. 解析外掛清單與 schema (`openclaw.plugin.json`)。
  2. 依 schema 驗證設定。
  3. 若缺 schema 或設定無效：阻擋外掛載入，記錄錯誤。
- 錯誤訊息包含：
  - 外掛 id
  - 原因（缺 schema / 設定無效）
  - 驗證失敗的路徑
- 停用的外掛保留其設定，但 Doctor 與日誌會顯示警告。

## Doctor 流程

- Doctor **每次**載入設定時執行（預設為模擬執行）。
- 若設定無效：
  - 輸出摘要與可執行的錯誤訊息。
  - 指示：`openclaw doctor --fix`。
- `openclaw doctor --fix`：
  - 執行遷移。
  - 移除未知鍵。
  - 寫入更新後的設定。

## 指令限制（設定無效時）

允許（僅限診斷）：

- `openclaw doctor`
- `openclaw logs`
- `openclaw health`
- `openclaw help`
- `openclaw status`
- `openclaw gateway status`

其他指令皆須強制失敗，訊息為：「設定無效。請執行 `openclaw doctor --fix`。」

## 錯誤使用者體驗格式

- 單一摘要標題。
- 分組區塊：
  - 未知鍵（完整路徑）
  - 舊版鍵 / 需要遷移
  - 外掛載入失敗（外掛 ID + 原因 + 路徑）

## 實作接觸點

- `src/config/zod-schema.ts`：移除根節點透傳；全面嚴格物件。
- `src/config/zod-schema.providers.ts`：確保嚴格的頻道結構。
- `src/config/validation.ts`：遇到未知鍵即失敗；不套用舊版遷移。
- `src/config/io.ts`：移除舊版自動遷移；始終執行 doctor 乾跑。
- `src/config/legacy*.ts`：將使用情境移至 doctor 專用。
- `src/plugins/*`：新增結構註冊表與閘道控制。
- CLI 指令閘道控制在 `src/cli`。

## 測試

- 拒絕未知鍵（根節點與巢狀）。
- 外掛缺少結構 → 阻擋外掛載入並顯示明確錯誤。
- 無效設定 → 阻擋閘道啟動，診斷指令除外。
- 自動執行 doctor 乾跑；`doctor --fix` 寫入修正後設定。
