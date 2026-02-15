---
summary: "使用 apply_patch 工具應用多檔案補丁"
read_when:
  - 當您需要在多個檔案中進行結構化的檔案編輯時
  - 當您想要記錄或偵錯基於補丁的編輯時
title: "apply_patch 工具"
---

# apply_patch 工具

使用結構化補丁格式應用檔案變更。這對於多檔案或多區塊的編輯來說是理想的選擇，因為單一的 `edit` 呼叫可能會很脆弱。

此工具接受一個單一的 `input` 字串，其中包含一個或多個檔案操作：

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

- `input` (必要): 完整的補丁內容，包括 `*** Begin Patch` 和 `*** End Patch`。

## 注意事項

- 檔案路徑是相對於工作區根目錄解析的。
- 在 `*** Update File:` 區塊中使用 `*** Move to:` 來重新命名檔案。
- `*** End of File` 標記了僅在檔案結尾處的插入點（如果需要）。
- 這是實驗性功能，預設為停用。透過 `tools.exec.applyPatch.enabled` 啟用。
- 僅限 OpenAI（包括 OpenAI Codex）。可以透過 `tools.exec.applyPatch.allowModels` 選擇性地限制模型使用。
- 設定僅在 `tools.exec` 下。

## 範例

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n @@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
