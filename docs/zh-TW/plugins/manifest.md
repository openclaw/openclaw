---
summary: Plugin manifest + JSON schema requirements (strict config validation)
read_when:
  - You are building a OpenClaw plugin
  - You need to ship a plugin config schema or debug plugin validation errors
title: Plugin Manifest
---

# 外掛清單檔 (openclaw.plugin.json)

每個外掛**必須**在**外掛根目錄**中提供一個 `openclaw.plugin.json` 檔案。  
OpenClaw 使用此清單來驗證設定，**不需執行外掛程式碼**。  
缺少或無效的清單會被視為外掛錯誤，並阻擋設定驗證。

完整外掛系統指南請參考：[Plugins](/tools/plugin)。

## 必填欄位

```json
{
  "id": "voice-call",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

必填鍵值：

- `id` (字串)：標準化外掛 ID。
- `configSchema` (物件)：外掛設定的 JSON Schema（內嵌）。

選填鍵值：

- `kind` (字串)：外掛類型（範例：`"memory"`、`"context-engine"`）。
- `channels` (陣列)：此外掛註冊的頻道 ID（範例：`["matrix"]`）。
- `providers` (陣列)：此外掛註冊的提供者 ID。
- `skills` (陣列)：要載入的技能目錄（相對於外掛根目錄）。
- `name` (字串)：外掛顯示名稱。
- `description` (字串)：外掛簡短摘要。
- `uiHints` (物件)：UI 呈現用的設定欄位標籤／提示文字／敏感標記。
- `version` (字串)：外掛版本（僅供參考）。

## JSON Schema 要求

- **每個外掛都必須提供 JSON Schema**，即使不接受任何設定。
- 空的 Schema 也是可接受的（例如 `{ "type": "object", "additionalProperties": false }`）。
- Schema 會在設定讀取／寫入時驗證，非執行時。

## 驗證行為

- 未知的 `channels.*` 鍵值會被視為**錯誤**，除非該頻道 ID 已由外掛清單宣告。
- `plugins.entries.<id>`、`plugins.allow`、`plugins.deny` 和 `plugins.slots.*` 必須參考**可被發現的**外掛 ID，未知 ID 會被視為**錯誤**。
- 若外掛已安裝但清單或 Schema 損壞或遺失，驗證會失敗，Doctor 會回報外掛錯誤。
- 若外掛設定存在但外掛**被停用**，設定會保留，且 Doctor 與日誌會顯示**警告**。

## 備註

- 清單**對所有外掛皆為必需**，包含本地檔案系統載入的外掛。
- 執行時仍會另外載入外掛模組，清單僅用於發現與驗證。
- 排他性外掛類型透過 `plugins.slots.*` 選擇。
  - `kind: "memory"` 由 `plugins.slots.memory` 選擇。
  - `kind: "context-engine"` 由 `plugins.slots.contextEngine` 選擇（預設為內建的 `legacy`）。
- 若您的外掛依賴原生模組，請記錄建置步驟及任何套件管理器允許清單需求（例如 pnpm `allow-build-scripts` - `pnpm rebuild <package>`）。
