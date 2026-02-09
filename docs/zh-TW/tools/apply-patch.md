---
summary: "使用 apply_patch 工具套用多檔案修補"
read_when:
  - 你需要跨多個檔案的結構化編輯
  - 12. 你想要記錄或除錯以補丁為基礎的編輯
title: "apply_patch 工具"
---

# apply_patch 工具

Apply file changes using a structured patch format. 13. 這非常適合多檔案或多區塊（multi-hunk）的編輯，因為單一 `edit` 呼叫會很脆弱。

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

- Paths are resolved relative to the workspace root.
- 在 `*** Update File:` 區塊（hunk）中使用 `*** Move to:` 以重新命名檔案。
- 在需要時，`*** End of File` 會標示僅於 EOF 的插入。
- 14. 屬於實驗性功能，且預設停用。 屬於實驗性功能，預設為停用。請使用 `tools.exec.applyPatch.enabled` 啟用。
- OpenAI-only (including OpenAI Codex). 15. 可選擇依模型進行門控，透過 `tools.exec.applyPatch.allowModels`。
- 設定僅位於 `tools.exec` 之下。

## 範例

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
