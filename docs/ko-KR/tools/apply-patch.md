---
summary: "apply_patch 도구를 사용하여 여러 파일 패치를 적용합니다"
read_when:
  - 여러 파일에 걸쳐 구조화된 파일 편집이 필요할 때
  - 패치 기반 편집을 문서화하거나 디버그하고 싶을 때
title: "apply_patch 도구"
---

# apply_patch 도구

구조화된 패치 형식을 사용하여 파일 변경을 적용합니다. 이는 여러 파일 또는 여러 청크의 편집에 이상적이며, 단일 `edit` 호출이 불안정할 수 있는 경우에 적합합니다.

이 도구는 하나 이상의 파일 작업을 포함하는 단일 `input` 문자열을 수락합니다:

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

- `input` (필수): `*** Begin Patch` 및 `*** End Patch`를 포함한 전체 패치 내용.

## Notes

- 패치 경로는 상대 경로 (작업 공간 디렉토리 기준)와 절대 경로를 지원합니다.
- `tools.exec.applyPatch.workspaceOnly`은 기본적으로 `true` (작업 공간 내 포함)로 설정됩니다. 의도적으로 작업 공간 디렉토리 외부에 `apply_patch`가 쓰거나 삭제하도록 설정하려면 `false`로 설정하십시오.
- 파일 이름 변경을 위해 `*** Update File:` 청크 내에서 `*** Move to:`를 사용하십시오.
- `*** End of File`은 필요할 때 EOF 전용 삽입을 표시합니다.
- 실험적이며 기본적으로 비활성화되어 있습니다. `tools.exec.applyPatch.enabled`로 활성화합니다.
- OpenAI 전용 (OpenAI Codex 포함). `tools.exec.applyPatch.allowModels`를 통해 선택적으로 모델로 제한할 수 있습니다.
- 설정은 `tools.exec` 하에만 있습니다.

## Example

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```