---
summary: "Apply multi-file patches with the apply_patch tool"
read_when:
  - You need structured file edits across multiple files
  - You want to document or debug patch-based edits
title: "apply_patch Tool"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/tools/apply-patch.md
workflow: 15
---

# apply_patch tool

구조화된 patch 형식을 사용하여 파일 변경사항을 적용합니다. 단일 `edit` 호출이 취약할 수 있는
다중 파일 또는 다중 hunk 편집에 이상적입니다.

도구는 하나 이상의 파일 작업을 래핑하는 단일 `input` 문자열을 받습니다:

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

## Parameters

- `input` (필수): `*** Begin Patch` 와 `*** End Patch` 를 포함한 전체 patch 내용.

## Notes

- Patch 경로는 상대 경로 (workspace 디렉터리에서) 및 절대 경로를 지원합니다.
- `tools.exec.applyPatch.workspaceOnly` 는 기본값이 `true` (workspace 포함). workspace 디렉터리 외부에 쓰거나 삭제하려는 경우에만 `false` 로 설정합니다.
- `*** Update File:` hunk 내에서 `*** Move to:` 를 사용하여 파일을 이름 변경합니다.
- `*** End of File` 은 필요할 때 EOF 전용 삽입을 표시합니다.
- 실험용이며 기본적으로 비활성화됨. `tools.exec.applyPatch.enabled` 로 활성화합니다.
- OpenAI 전용 (OpenAI Codex 포함). 선택적으로 `tools.exec.applyPatch.allowModels` 를 통해 모델로 gating 합니다.
- Config 는 `tools.exec` 아래에만 있습니다.

## Example

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
