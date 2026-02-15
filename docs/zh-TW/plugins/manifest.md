---
summary: "外掛程式清單 + JSON 結構描述要求 (嚴格的設定驗證)"
read_when:
  - 您正在建構 OpenClaw 外掛程式
  - 您需要提供外掛程式設定結構描述或偵錯外掛程式驗證錯誤
title: "外掛程式清單"
---

# 外掛程式清單 (openclaw.plugin.json)

每個外掛程式**都必須**在**外掛程式根目錄**中包含 `openclaw.plugin.json` 檔案。
OpenClaw 使用此清單來驗證設定，**而無需執行外掛程式程式碼**。缺少或無效的清單將被視為外掛程式錯誤並阻止設定驗證。

請參閱完整的外掛程式系統指南：[外掛程式](/tools/plugin)。

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

必填鍵名：

- `id` (字串): 標準外掛程式識別碼。
- `configSchema` (物件): 外掛程式設定的 JSON 結構描述 (內嵌)。

選填鍵名：

- `kind` (字串): 外掛程式種類 (例如：`"memory"`)。
- `channels` (陣列): 此外掛程式註冊的頻道識別碼 (例如：`["matrix"]`)。
- `providers` (陣列): 此外掛程式註冊的供應商識別碼。
- `skills` (陣列): 要載入的技能目錄 (相對於外掛程式根目錄)。
- `name` (字串): 外掛程式的顯示名稱。
- `description` (字串): 外掛程式簡要摘要。
- `uiHints` (物件): 用於 UI 渲染的設定欄位標籤/預留位置/敏感標誌。
- `version` (字串): 外掛程式版本 (資訊性)。

## JSON 結構描述要求

- 每個外掛程式**都必須包含一個 JSON 結構描述**，即使它不接受任何設定。
- 允許使用空結構描述 (例如，`{ "type": "object", "additionalProperties": false }`)。
- 結構描述在設定讀取/寫入時進行驗證，而不是在執行時進行驗證。

## 驗證行為

- 未知的 `channels.*` 鍵名為**錯誤**，除非頻道識別碼由外掛程式清單宣告。
- `plugins.entries.<id>`、`plugins.allow`、`plugins.deny` 和 `plugins.slots.*`
  必須參照**可被探索的**外掛程式識別碼。未知的識別碼為**錯誤**。
- 如果已安裝外掛程式但其清單或結構描述損壞或缺失，驗證將失敗，且 Doctor 將回報外掛程式錯誤。
- 如果外掛程式設定存在但外掛程式**已停用**，則該設定將被保留，並在 Doctor + 日誌中顯示**警告**。

## 注意事項

- 清單**對所有外掛程式都是必需的**，包括本地檔案系統載入。
- 執行時仍會單獨載入外掛程式模組；清單僅用於裝置探索 + 驗證。
- 如果您的外掛程式依賴於原生模組，請記錄建置步驟和任何套件管理器允許列表要求 (例如，pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`)。
