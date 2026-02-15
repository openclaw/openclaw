---
summary: "新手導覽精靈與設定結構 (schema) 的 RPC 協定說明"
read_when: "變更新手導覽精靈步驟或設定結構端點時閱讀"
title: "新手導覽與設定協定"
---

# 新手導覽與設定協定

目的：在 CLI、macOS 應用程式與 Web UI 之間共用新手導覽與設定界面。

## 元件

- 精靈引擎（共用工作階段 + 提示詞 + 新手導覽狀態）。
- CLI 新手導覽使用與 UI 用戶端相同的精靈流程。
- Gateway RPC 公開了精靈與設定結構的端點。
- macOS 新手導覽使用精靈步驟模型。
- Web UI 根據 JSON Schema 與 UI 提示 (hints) 渲染設定表單。

## Gateway RPC

- `wizard.start` 參數：`{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` 參數：`{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` 參數：`{ sessionId }`
- `wizard.status` 參數：`{ sessionId }`
- `config.schema` 參數：`{}`

回應（格式）

- 精靈：`{ sessionId, done, step?, status?, error? }`
- 設定結構：`{ schema, uiHints, version, generatedAt }`

## UI 提示 (UI Hints)

- `uiHints` 以路徑為鍵值；包含選用的詮釋資料（標籤 / 說明 / 分組 / 順序 / 進階 / 敏感資訊 / 佔位符）。
- 敏感欄位會渲染為密碼輸入框；不具備編修層 (redaction layer)。
- 不支援的結構節點會回退到原始 JSON 編輯器。

## 注意事項

- 此檔案是追蹤新手導覽／設定之協定重構的唯一依據。
