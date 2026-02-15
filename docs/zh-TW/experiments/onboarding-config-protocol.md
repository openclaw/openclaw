---
summary: "新手導覽精靈與設定結構描述的 RPC 協定說明"
read_when: "變更新手導覽精靈步驟或設定結構描述端點時"
title: "新手導覽與設定協定"
---

# 新手導覽與設定協定

目的：在 CLI、macOS 應用程式和 Web 使用者介面之間共用新手導覽與設定介面。

## 組件

- 精靈引擎 (共用工作階段 + 提示 + 新手導覽狀態)。
- CLI 新手導覽使用與使用者介面用戶端相同的精靈流程。
- Gateway RPC 揭露精靈 + 設定結構描述端點。
- macOS 新手導覽使用精靈步驟模型。
- Web 使用者介面從 JSON 結構描述 + 使用者介面提示渲染設定表單。

## Gateway RPC

- `wizard.start` params: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` params: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` params: `{ sessionId }`
- `wizard.status` params: `{ sessionId }`
- `config.schema` params: `{}`

回應 (格式)

- 精靈: `{ sessionId, done, step?, status?, error? }`
- 設定結構描述: `{ schema, uiHints, version, generatedAt }`

## 使用者介面提示

- `uiHints` 以路徑作為鍵；可選的中繼資料 (標籤/幫助/群組/順序/進階/敏感/佔位符)。
- 敏感欄位渲染為密碼輸入；沒有遮蔽層。
- 不支援的結構描述節點將退回至原始 JSON 編輯器。

## 備註

- 本文件是追蹤新手導覽/設定協定重構的唯一場所。
