---
summary: "外掛程式資訊清單 + JSON Schema 要求（嚴格的設定驗證）"
read_when:
  - 您正在建構 OpenClaw 外掛程式
  - 您需要提供外掛程式設定 schema 或對外掛程式驗證錯誤進行除錯
title: "外掛程式資訊清單"
---

# 外掛程式資訊清單 (openclaw.plugin.json)

每個外掛程式**必須**在**外掛程式根目錄**中包含一個 `openclaw.plugin.json` 檔案。
OpenClaw 使用此資訊清單來驗證設定，**而無需執行外掛程式程式碼**。遺失或無效的資訊清單將被視為外掛程式錯誤，並會阻礙設定驗證。

查看完整的外掛程式系統指南：[Plugins](/tools/plugin)。

## 必要欄位

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

必要鍵名：

- `id` (string)：規範的外掛程式 id。
- `configSchema` (object)：外掛程式設定的 JSON Schema（行內）。

選用鍵名：

- `kind` (string)：外掛程式種類（範例：`"memory"`）。
- `channels` (array)：此外掛程式註冊的頻道 id（範例：`["matrix"]`）。
- `providers` (array)：此外掛程式註冊的供應商 id。
- `skills` (array)：要載入的 Skills 目錄（相對於外掛程式根目錄）。
- `name` (string)：外掛程式的顯示名稱。
- `description` (string)：外掛程式的簡短摘要。
- `uiHints` (object)：用於 UI 渲染的設定欄位標籤/預留位置/敏感旗標。
- `version` (string)：外掛程式版本（僅供參考）。

## JSON Schema 要求

- **每個外掛程式都必須提供一個 JSON Schema**，即使它不接受任何設定。
- 空的 schema 是可以接受的（例如：`{ "type": "object", "additionalProperties": false }`）。
- Schema 會在設定讀取/寫入時進行驗證，而非在執行階段。

## 驗證行為

- 未知的 `channels.*` 鍵名會被視為**錯誤**，除非該頻道 id 已在外掛程式資訊清單中宣告。
- `plugins.entries.<id>`、`plugins.allow`、`plugins.deny` 和 `plugins.slots.*` 必須引用**可被探索**的外掛程式 id。未知的 id 會被視為**錯誤**。
- 如果外掛程式已安裝，但資訊清單或 schema 損壞或遺失，驗證將會失敗，且 Doctor 會回報該外掛程式錯誤。
- 如果外掛程式設定存在但外掛程式已**停用**，設定將會保留，並在 Doctor 和日誌中顯示**警告**。

## 注意事項

- 所有外掛程式都**必須包含資訊清單**，包括從本機檔案系統載入的外掛程式。
- 執行階段仍會單獨載入外掛程式模組；資訊清單僅用於裝置探索 + 驗證。
- 如果您的外掛程式依賴原生模組，請記錄建置步驟以及任何套件管理員的允許清單要求（例如：pnpm `allow-build-scripts` - `pnpm rebuild <package>`）。
