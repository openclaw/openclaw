---
summary: "CLI reference for `openclaw memory` (status/index/search)"
read_when:
  - You want to index or search semantic memory
  - You’re debugging memory availability or indexing
title: "memory"
x-i18n:
  source_hash: cb8ee2c9b2db2d574f3247f0c27e4b2de4656a48910b8d820edc4d6ba1ccd053
---

# `openclaw memory`

의미기억 인덱싱 및 검색을 관리합니다.
활성 메모리 플러그인에서 제공됩니다(기본값: `memory-core`; 비활성화하려면 `plugins.slots.memory = "none"` 설정).

관련 항목:

- 메모리 개념 : [메모리](/concepts/memory)
- 플러그인: [플러그인](/tools/plugin)

## 예

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

- `--agent <id>`: 단일 에이전트로 범위를 지정합니다(기본값: 구성된 모든 에이전트).
- `--verbose`: 프로브 및 인덱싱 중에 자세한 로그를 내보냅니다.

참고:

- `memory status --deep` 프로브 벡터 + 임베딩 가용성.
- `memory status --deep --index` 저장소가 더러워지면 재색인을 실행합니다.
- `memory index --verbose`는 단계별 세부 정보(공급자, 모델, 소스, 배치 활동)를 인쇄합니다.
- `memory status`에는 `memorySearch.extraPaths`를 통해 구성된 추가 경로가 포함됩니다.
