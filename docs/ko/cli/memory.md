---
read_when:
    - 의미 기억을 색인화하거나 검색하고 싶습니다.
    - 메모리 가용성 또는 인덱싱을 디버깅하고 있습니다.
summary: '`openclaw memory`에 대한 CLI 참조(상태/색인/검색)'
title: 메모리
x-i18n:
    generated_at: "2026-02-08T15:52:11Z"
    model: gtx
    provider: google-translate
    source_hash: cb8ee2c9b2db2d574f3247f0c27e4b2de4656a48910b8d820edc4d6ba1ccd053
    source_path: cli/memory.md
    workflow: 15
---

# `openclaw memory`

의미기억 인덱싱 및 검색을 관리합니다.
활성 메모리 플러그인에서 제공(기본값: `memory-core`; 세트 `plugins.slots.memory = "none"` 비활성화합니다).

관련된:

- 메모리 개념: [메모리](/concepts/memory)
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

흔한:

- `--agent <id>`: 단일 에이전트로 범위를 지정합니다(기본값: 구성된 모든 에이전트).
- `--verbose`: 프로브 및 인덱싱 중에 자세한 로그를 내보냅니다.

참고:

- `memory status --deep` 프로브 벡터 + 임베딩 가용성.
- `memory status --deep --index` 저장소가 더러워지면 재색인을 실행합니다.
- `memory index --verbose` 단계별 세부 정보(공급자, 모델, 소스, 배치 활동)를 인쇄합니다.
- `memory status` 다음을 통해 구성된 추가 경로가 포함됩니다. `memorySearch.extraPaths`.
