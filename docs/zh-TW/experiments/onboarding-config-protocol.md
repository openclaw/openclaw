---
summary: RPC protocol notes for onboarding wizard and config schema
read_when: Changing onboarding wizard steps or config schema endpoints
title: Onboarding and Config Protocol
---

# Onboarding + Config Protocol

目的：在 CLI、macOS 應用程式和 Web UI 之間共享入門和設定介面。

## Components

- Wizard 引擎（共享會話 + 提示 + 上線狀態）。
- CLI 上線使用與 UI 用戶端相同的 Wizard 流程。
- Gateway RPC 暴露 Wizard + 設定架構端點。
- macOS 上線使用 Wizard 步驟模型。
- Web UI 從 JSON Schema + UI 提示渲染設定表單。

## Gateway RPC

- `wizard.start` 參數: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` 參數: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` 參數: `{ sessionId }`
- `wizard.status` 參數: `{ sessionId }`
- `config.schema` 參數: `{}`
- `config.schema.lookup` 參數: `{ path }`
  - `path` 接受標準設定段以及斜線分隔的插件 ID，例如 `plugins.entries.pack/one.config`。

[[BLOCK_1]]  
Responses (shape)  
[[BLOCK_1]]

- Wizard: `{ sessionId, done, step?, status?, error? }`
- 設定架構: `{ schema, uiHints, version, generatedAt }`
- 設定架構查詢: `{ path, schema, hint?, hintPath?, children[] }`

## UI 提示

- `uiHints` 以路徑為鍵；可選的元資料（標籤/說明/群組/順序/進階/敏感/佔位符）。
- 敏感欄位顯示為密碼輸入；沒有遮蔽層。
- 不支援的架構節點將回退到原始 JSON 編輯器。

## Notes

- 本文件是追蹤入門/設定的協議重構的唯一地方。
