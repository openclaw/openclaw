---
summary: "使用 apply_patch 工具套用多檔案 patch"
read_when:
  - 您需要在多個檔案中進行結構化檔案編輯
  - 您想要記錄或偵錯基於 patch 的編輯
title: "apply_patch 工具"
---

# apply_patch 工具

使用結構化的 patch 格式套用檔案變更。這非常適合多檔案或多程式碼片段 (hunk) 的編輯，在這種情況下，單次的 `edit` 呼叫可能會顯得脆弱。

此工具接受單一的 `input` 字串，其中封裝了一個或多個檔案操作：

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

- `input` (必填)：完整的 patch 內容，包含 `*** Begin Patch` 與 `*** End Patch`。

## 注意事項

- 路徑是相對於工作區根目錄進行解析。
- 在 `*** Update File:` hunk 中使用 `*** Move to:` 來重新命名檔案。
- `*** End of File` 在需要時標記僅限檔案結尾 (EOF) 的插入。
- 實驗性功能，預設為停用。可透過 `tools.exec.applyPatch.enabled` 啟用。
- 僅限 OpenAI（包含 OpenAI Codex）。可選擇性地透過 `tools.exec.applyPatch.allowModels` 根據模型進行限制。
- 設定僅位於 `tools.exec` 之下。

## 範例

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n @@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
