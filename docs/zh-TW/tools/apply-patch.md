---
summary: "使用 apply_patch 工具套用多檔案修補"
read_when:
  - 你需要跨多個檔案的結構化編輯
  - 你想要記錄或除錯以修補為基礎的編輯
title: "apply_patch 工具"
x-i18n:
  source_path: tools/apply-patch.md
  source_hash: 8cec2b4ee3afa910
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:29:22Z
---

# apply_patch 工具

使用結構化的修補格式套用檔案變更。這非常適合多檔案
或多個區塊（hunk）的編輯情境，因為單一的 `edit` 呼叫會顯得脆弱。

此工具接受單一的 `input` 字串，該字串包裝一或多個檔案操作：

```
*** Begin Patch
*** Add File: path/to/file.txt
+line 1
+line 2
*** Update File: src/app.ts
@@
-old line
+new line
*** Delete File: obsolete.txt
*** End Patch
```

## 參數

- `input`（必填）：包含 `*** Begin Patch` 與 `*** End Patch` 的完整修補內容。

## 注意事項

- 路徑會相對於工作區根目錄解析。
- 在 `*** Update File:` 區塊（hunk）中使用 `*** Move to:` 以重新命名檔案。
- 在需要時，`*** End of File` 會標示僅於 EOF 的插入。
- 屬於實驗性功能，預設為停用。請使用 `tools.exec.applyPatch.enabled` 啟用。
- 僅限 OpenAI（包含 OpenAI Codex）。可選擇透過模型以 `tools.exec.applyPatch.allowModels` 進行控管。
- 設定僅位於 `tools.exec` 之下。

## 範例

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
