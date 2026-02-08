---
read_when:
    - 여러 파일에 걸쳐 구조화된 파일을 수정해야 하는 경우
    - 패치 기반 편집 내용을 문서화하거나 디버깅하려는 경우
summary: apply_patch 도구를 사용하여 다중 파일 패치 적용
title: apply_patch 도구
x-i18n:
    generated_at: "2026-02-08T16:12:15Z"
    model: gtx
    provider: google-translate
    source_hash: 8cec2b4ee3afa9105fc3dd1bc28a338917df129afc634ac83620a3347c46bcec
    source_path: tools/apply-patch.md
    workflow: 15
---

# apply_patch 도구

구조화된 패치 형식을 사용하여 파일 변경 사항을 적용합니다. 이는 다중 파일에 이상적입니다.
또는 단일 항목이 있는 다중 덩어리 편집 `edit` 통화가 불안정할 것입니다.

이 도구는 단일을 허용합니다 `input` 하나 이상의 파일 작업을 래핑하는 문자열:

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

- `input` (필수): 다음을 포함한 전체 패치 내용 `*** Begin Patch` 그리고 `*** End Patch`.

## 메모

- 경로는 작업공간 루트를 기준으로 확인됩니다.
- 사용 `*** Move to:` 이내에 `*** Update File:` 파일 이름을 바꾸는 데 큰 덩어리입니다.
- `*** End of File` 필요할 때 EOF 전용 삽입을 표시합니다.
- 실험적이며 기본적으로 비활성화되어 있습니다. 다음으로 활성화 `tools.exec.applyPatch.enabled`.
- OpenAI 전용(OpenAI Codex 포함). 선택적으로 다음을 통해 모델별 게이트
  `tools.exec.applyPatch.allowModels`.
- 구성은 아래에만 있습니다. `tools.exec`.

## 예

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
