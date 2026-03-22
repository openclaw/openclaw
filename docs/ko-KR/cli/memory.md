---
summary: "`openclaw memory` CLI 레퍼런스 (status/index/search)"
read_when:
  - 시맨틱 메모리를 인덱싱하거나 검색하고 싶을 때
  - 메모리 가용성이나 인덱싱을 디버깅할 때
title: "memory"
x-i18n:
  source_path: "docs/cli/memory.md"
---

# `openclaw memory`

시맨틱 메모리 인덱싱 및 검색을 관리합니다.
활성 메모리 플러그인이 제공합니다 (기본값: `memory-core`; `plugins.slots.memory = "none"`으로 비활성화).

관련 문서:

- 메모리 개념: [Memory](/concepts/memory)
- 플러그인: [Plugins](/tools/plugin)

## 예시

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory index --force
openclaw memory search "meeting notes"
openclaw memory search --query "deployment" --max-results 20
openclaw memory status --json
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## 옵션

`memory status`와 `memory index`:

- `--agent <id>`: 단일 에이전트로 범위를 제한합니다. 이 옵션 없이 실행하면 설정된 각 에이전트에 대해 실행됩니다. 에이전트 목록이 설정되지 않은 경우 기본 에이전트로 폴백합니다.
- `--verbose`: 프로브 및 인덱싱 중 상세 로그를 출력합니다.

`memory status`:

- `--deep`: 벡터 + 임베딩 가용성을 프로브합니다.
- `--index`: 저장소가 더티 상태이면 재인덱싱을 실행합니다 (`--deep`을 포함합니다).
- `--json`: JSON 출력.

`memory index`:

- `--force`: 전체 재인덱싱을 강제합니다.

`memory search`:

- 쿼리 입력: 위치 인자 `[query]` 또는 `--query <text>`를 전달합니다.
- 둘 다 제공된 경우 `--query`가 우선합니다.
- 둘 다 제공되지 않으면 명령이 오류와 함께 종료됩니다.
- `--agent <id>`: 단일 에이전트로 범위를 제한합니다 (기본값: 기본 에이전트).
- `--max-results <n>`: 반환되는 결과 수를 제한합니다.
- `--min-score <n>`: 낮은 점수의 매치를 필터링합니다.
- `--json`: JSON 결과를 출력합니다.

참고:

- `memory index --verbose`는 단계별 세부 정보를 출력합니다 (프로바이더, 모델, 소스, 배치 활동).
- `memory status`에는 `memorySearch.extraPaths`를 통해 설정된 추가 경로가 포함됩니다.
- 실질적으로 활성화된 메모리 원격 API 키 필드가 SecretRef로 설정된 경우, 명령은 활성 Gateway 스냅샷에서 해당 값을 해석합니다. Gateway를 사용할 수 없으면 명령이 즉시 실패합니다.
- Gateway 버전 호환성 참고: 이 명령 경로는 `secrets.resolve`를 지원하는 Gateway가 필요합니다. 이전 버전의 Gateway는 알 수 없는 메서드 오류를 반환합니다.
