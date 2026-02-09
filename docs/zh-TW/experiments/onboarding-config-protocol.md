---
summary: "11. 新手導覽精靈與設定結構的 RPC 協定備註"
read_when: "12. 變更新手導覽精靈步驟或設定結構端點"
title: "13. 新手導覽與設定協定"
---

# 入門引導 + 設定通訊協定

目的：在 CLI、macOS 應用程式與 Web UI 之間共用入門引導與設定介面。

## 元件

- 14. 精靈引擎（共用工作階段 + 提示 + 新手導覽狀態）。
- 15. CLI 新手導覽使用與 UI 客戶端相同的精靈流程。
- Gateway RPC （遠端程序呼叫）公開精靈 + 設定結構描述端點。
- 16. macOS 新手導覽使用精靈步驟模型。
- Web UI 依據 JSON Schema + UI 提示來呈現設定表單。

## Gateway RPC

- `wizard.start` 參數：`{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` 參數：`{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` 參數：`{ sessionId }`
- `wizard.status` 參數：`{ sessionId }`
- `config.schema` 參數：`{}`

回應（結構）

- 精靈：`{ sessionId, done, step?, status?, error? }`
- 設定結構描述：`{ schema, uiHints, version, generatedAt }`

## UI 提示

- `uiHints` 依路徑作為索引；可選的中繼資料（label/help/group/order/advanced/sensitive/placeholder）。
- 敏感欄位會以密碼輸入呈現；沒有額外的遮罩層。
- 不支援的結構描述節點會退回使用原始 JSON 編輯器。

## 注意事項

- 17. 本文件是追蹤新手導覽／設定協定重構的唯一來源。
