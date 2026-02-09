---
summary: "`openclaw memory` (status/index/search)에 대한 CLI 참조"
read_when:
  - 의미론적 메모리를 인덱싱하거나 검색하려는 경우
  - 메모리 가용성 또는 인덱싱을 디버깅하는 경우
title: "메모리"
---

# `openclaw memory`

의미론적 메모리 인덱싱과 검색을 관리합니다.
활성 메모리 플러그인에서 제공됩니다(기본값: `memory-core`; 비활성화하려면 `plugins.slots.memory = "none"` 를 설정하십시오).

관련 항목:

- 메모리 개념: [Memory](/concepts/memory)
- 플러그인: [Plugins](/tools/plugin)

## 예제

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory index
openclaw memory index --verbose
openclaw memory search "release checklist"
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## 옵션

공통:

- `--agent <id>`: 단일 에이전트로 범위를 제한합니다(기본값: 구성된 모든 에이전트).
- `--verbose`: 프로브 및 인덱싱 중에 상세 로그를 출력합니다.

참고:

- `memory status --deep` 는 벡터 + 임베딩 가용성을 프로브합니다.
- `memory status --deep --index` 는 스토어가 더러운 경우 재인덱싱을 실행합니다.
- `memory index --verbose` 는 단계별 세부 정보(프로바이더, 모델, 소스, 배치 활동)를 출력합니다.
- `memory status` 는 `memorySearch.extraPaths` 를 통해 구성된 모든 추가 경로를 포함합니다.
