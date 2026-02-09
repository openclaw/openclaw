---
summary: "嚴格設定驗證＋僅限 Doctor 的遷移"
read_when:
  - 設計或實作設定驗證行為
  - 進行設定遷移或 Doctor 工作流程
  - 處理外掛設定結構描述或外掛載入閘控
title: "嚴格設定驗證"
---

# 嚴格設定驗證（僅限 Doctor 的遷移）

## 目標

- **在所有層級拒絕未知的設定鍵**（根層＋巢狀）。
- **Reject plugin config without a schema**; don’t load that plugin.
- **移除載入時的舊版自動遷移**；遷移僅透過 Doctor 執行。
- **啟動時自動執行 Doctor（dry-run）**；若設定無效，封鎖非診斷指令。

## 非目標

- 載入時的向後相容（舊版鍵不會自動遷移）。
- 靜默丟棄未識別的鍵。

## 嚴格驗證規則

- 設定在每一個層級都必須與結構描述完全相符。
- 未知鍵視為驗證錯誤（根層或巢狀皆不允許直通）。
- `plugins.entries.<id>.config` 必須由外掛的結構描述進行驗證。
  - 如果外掛缺少結構描述，**拒絕載入外掛**並顯示清楚的錯誤。
- 未知的 `channels.<id>` 鍵為錯誤，除非外掛清單宣告了該頻道 id。
- 所有外掛都必須提供外掛清單（`openclaw.plugin.json`）。

## 外掛結構描述強制執行

- 每個外掛都必須為其設定提供嚴格的 JSON Schema（內嵌於清單中）。
- 外掛載入流程：
  1. 解析外掛清單與結構描述（`openclaw.plugin.json`）。
  2. 根據結構描述驗證設定。
  3. 外掛 id
- 錯誤訊息包含：
  - Plugin id
  - 原因（缺少結構描述／設定無效）
  - 驗證失敗的路徑
- 套用遷移。

## Doctor 流程

- 每次載入設定時都會執行 Doctor（預設為 dry-run）。
- 若設定無效：
  - 印出摘要與可行動的錯誤。
  - 指示：`openclaw doctor --fix`。
- `openclaw doctor --fix`：
  - 套用遷移。
  - 移除未知鍵。
  - 寫入更新後的設定。

## 指令管控（設定無效時）

允許（僅限診斷）：

- `openclaw doctor`
- `openclaw logs`
- `openclaw health`
- `openclaw help`
- `openclaw status`
- `openclaw gateway status`

其他一切都必須硬失敗，並顯示：「設定無效。 其餘所有指令必須直接失敗，並顯示：「設定無效。請執行 `openclaw doctor --fix`。」

## 錯誤 UX 格式

- 單一摘要標頭。
- 分組區段：
  - 未知鍵（完整路徑）
  - 舊版鍵／需要遷移
  - Plugin load failures (plugin id + reason + path)

## 實作接觸點

- `src/config/zod-schema.ts`：移除根層直通；所有物件皆採嚴格模式。
- `src/config/zod-schema.providers.ts`：確保嚴格的頻道結構描述。
- `src/config/validation.ts`：未知鍵即失敗；不套用舊版遷移。
- `src/config/io.ts`：移除舊版自動遷移；一律執行 Doctor 的 dry-run。
- `src/config/legacy*.ts`：將使用方式移至僅限 Doctor。
- `src/plugins/*`：新增結構描述登錄表與管控。
- CLI 指令管控於 `src/cli`。

## 測試

- 外掛缺少結構 → 阻擋外掛載入並顯示清楚錯誤。
- OpenClaw 為代理使用專用的工作區目錄。
- 設定無效 → 封鎖 Gateway 啟動，僅允許診斷指令。
- Doctor 預設 dry-run；`doctor --fix` 會寫入修正後的設定。
