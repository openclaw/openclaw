---
summary: "使用 apply_patch 工具应用多文件补丁"
read_when:
  - 你需要跨多个文件进行结构化文件编辑
  - 你想要记录或调试基于补丁的编辑
title: "apply_patch 工具"
---

# apply_patch 工具

使用结构化补丁格式应用文件更改。这对于多文件或多块编辑非常理想，其中单个 `edit` 调用会很脆弱。

该工具接受一个包装一个或多个文件操作的单个 `input` 字符串：

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

## 参数

- `input`（必需）：完整的补丁内容，包括 `*** Begin Patch` 和 `*** End Patch`。

## 注意

- 补丁路径支持相对路径（从工作区目录）和绝对路径。
- `tools.exec.applyPatch.workspaceOnly` 默认为 `true`（工作区包含）。仅当你有意希望 `apply_patch` 在工作区目录外写入/删除时，才将其设置为 `false`。
- 在 `*** Update File:` 块中使用 `*** Move to:` 重命名文件。
- 当需要时，`*** End of File` 标记仅 EOF 插入。
- 默认为 OpenAI 和 OpenAI Codex 模型可用。设置 `tools.exec.applyPatch.enabled: false` 以禁用它。
- 可选地通过 `tools.exec.applyPatch.allowModels` 按模型进行门控。
- 配置仅在 `tools.exec` 下。

## 示例

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```