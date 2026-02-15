---
summary: "Apply multi-file patches with the apply_patch tool"
read_when:
  - You need structured file edits across multiple files
  - You want to document or debug patch-based edits
title: "apply_patch Tool"
x-i18n:
  source_hash: 8cec2b4ee3afa9105fc3dd1bc28a338917df129afc634ac83620a3347c46bcec
---

# apply_patch 도구

구조화된 패치 형식을 사용하여 파일 변경 사항을 적용합니다. 이는 다중 파일에 이상적입니다.
또는 단일 `edit` 호출이 취약한 다중 덩어리 편집.

이 도구는 하나 이상의 파일 작업을 래핑하는 단일 `input` 문자열을 허용합니다.

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

## 매개변수

- `input` (필수) : `*** Begin Patch`, `*** End Patch`를 포함한 전체 패치 내용입니다.

## 메모

- 경로는 작업공간 루트를 기준으로 확인됩니다.
- `*** Update File:` 덩어리 내에서 `*** Move to:`를 사용하여 파일 이름을 바꿉니다.
- `*** End of File`는 필요할 때 EOF 전용 삽입을 표시합니다.
- 실험적이며 기본적으로 비활성화되어 있습니다. `tools.exec.applyPatch.enabled`로 활성화하세요.
- OpenAI 전용(OpenAI Codex 포함). 선택적으로 다음을 통해 모델별 게이트
  `tools.exec.applyPatch.allowModels`.
- 구성은 `tools.exec`에만 있습니다.

## 예

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
