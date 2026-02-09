---
summary: "外掛清單與 JSON Schema 需求（嚴格的設定驗證）"
read_when:
  - 你正在建置 OpenClaw 外掛
  - You need to ship a plugin config schema or debug plugin validation errors
title: "Plugin Manifest"
---

# 外掛清單（openclaw.plugin.json）

每個外掛 **必須** 在 **外掛根目錄** 內提供一個 `openclaw.plugin.json` 檔案。  
OpenClaw 會使用此清單在 **不執行外掛程式碼** 的情況下驗證設定。  
缺少或無效的清單會被視為外掛錯誤，並阻止設定驗證。
OpenClaw uses this manifest to validate configuration **without executing plugin
code**. Missing or invalid manifests are treated as plugin errors and block
config validation.

請參閱完整的外掛系統指南：[Plugins](/tools/plugin)。

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

必要金鑰：

- `id`（string）：標準化的外掛 id。
- `configSchema`（object）：外掛設定的 JSON Schema（內嵌）。

選用金鑰：

- `kind`（string）：外掛類型（例如：`"memory"`）。
- `channels`（array）：此外掛註冊的頻道 id（例如：`["matrix"]`）。
- `providers`（array）：此外掛註冊的 provider id。
- `skills`（array）：要載入的 Skill 目錄（相對於外掛根目錄）。
- `name`（string）：外掛的顯示名稱。
- `description`（string）：外掛的簡短摘要。
- `uiHints`（object）：用於 UI 呈現的設定欄位標籤／提示文字／敏感旗標。
- `version`（string）：外掛版本（僅供資訊）。

## JSON Schema 需求

- **每個外掛都必須提供 JSON Schema**，即使不接受任何設定。
- 可以使用空的結構描述（例如：`{ "type": "object", "additionalProperties": false }`）。
- Schemas are validated at config read/write time, not at runtime.

## 驗證行為

- 未知的 `channels.*` 金鑰會被視為 **錯誤**，除非該頻道 id 已在外掛清單中宣告。
- `plugins.entries.<id>`、`plugins.allow`、`plugins.deny` 與 `plugins.slots.*`  
  必須參考 **可被探索** 的外掛 id。未知的 id 會被視為 **錯誤**。 Unknown ids are **errors**.
- 如果外掛已安裝但資訊清單或 schema 損壞或遺失，驗證會失敗，Doctor 會回報外掛錯誤。
- 如果外掛設定存在但外掛被 **停用**，設定會被保留，並在 Doctor + 日誌中顯示 **警告**。

## 注意事項

- The manifest is **required for all plugins**, including local filesystem loads.
- Runtime still loads the plugin module separately; the manifest is only for
  discovery + validation.
- 如果你的外掛相依於原生模組，請記錄建置步驟以及任何套件管理器允許清單需求（例如：pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`）。
