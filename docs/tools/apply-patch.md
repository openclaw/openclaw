---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Apply multi-file patches with the apply_patch tool"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need structured file edits across multiple files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to document or debug patch-based edits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "apply_patch Tool"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# apply_patch tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Apply file changes using a structured patch format. This is ideal for multi-file（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
or multi-hunk edits where a single `edit` call would be brittle.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The tool accepts a single `input` string that wraps one or more file operations:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
*** Begin Patch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
*** Add File: path/to/file.txt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
+line 1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
+line 2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
*** Update File: src/app.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
@@（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-old line（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
+new line（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
*** Delete File: obsolete.txt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
*** End Patch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Parameters（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `input` (required): Full patch contents including `*** Begin Patch` and `*** End Patch`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Paths are resolved relative to the workspace root.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `*** Move to:` within an `*** Update File:` hunk to rename files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `*** End of File` marks an EOF-only insert when needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Experimental and disabled by default. Enable with `tools.exec.applyPatch.enabled`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenAI-only (including OpenAI Codex). Optionally gate by model via（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `tools.exec.applyPatch.allowModels`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config is only under `tools.exec`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "tool": "apply_patch",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
