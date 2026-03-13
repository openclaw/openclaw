---
summary: Apply multi-file patches with the apply_patch tool
read_when:
  - You need structured file edits across multiple files
  - You want to document or debug patch-based edits
title: apply_patch Tool
---

# apply_patch 工具

使用結構化的 patch 格式來套用檔案變更。這非常適合多檔案或多段落的編輯，因為單一的 `edit` 呼叫會比較脆弱。

此工具接受一個包含一個或多個檔案操作的 `input` 字串：

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

- `input`（必填）：完整的 patch 內容，包括 `*** Begin Patch` 和 `*** End Patch`。

## 注意事項

- Patch 路徑支援相對路徑（相對於工作目錄）和絕對路徑。
- `tools.exec.applyPatch.workspaceOnly` 預設為 `true`（工作目錄內）。只有在你有意讓 `apply_patch` 在工作目錄外寫入或刪除時，才設定為 `false`。
- 在 `*** Update File:` 段落中使用 `*** Move to:` 來重新命名檔案。
- `*** End of File` 用於標記僅在檔案結尾插入的情況。
- 為實驗性功能，預設為停用。可透過 `tools.exec.applyPatch.enabled` 啟用。
- 僅限 OpenAI（包含 OpenAI Codex）。可選擇透過 `tools.exec.applyPatch.allowModels` 依模型限制使用。
- 設定僅在 `tools.exec` 下。

## 範例

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
