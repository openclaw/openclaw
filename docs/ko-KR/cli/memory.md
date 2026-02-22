---
summary: "CLI 레퍼런스 `openclaw memory` (status/index/search)"
read_when:
  - 의미론적 메모리를 인덱싱하거나 검색하고 싶은 경우
  - 메모리 가용성 또는 인덱싱을 디버깅하는 경우
title: "memory"
---

# `openclaw memory`

의미론적 메모리 인덱싱 및 검색을 관리합니다. 활성 메모리 플러그인에 의해 제공됩니다(기본값: `memory-core`; `plugins.slots.memory = "none"`을 설정하여 비활성화).

연관:

- 메모리 개념: [Memory](/ko-KR/concepts/memory)
- 플러그인: [Plugins](/ko-KR/tools/plugin)

## Examples

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

## Options

Common:

- `--agent <id>`: 단일 에이전트에 범위를 지정합니다 (기본값: 모든 구성된 에이전트).
- `--verbose`: 프로브 및 인덱싱 중에 자세한 로그를 출력합니다.

Notes:

- `memory status --deep`은 벡터 및 임베딩 가용성을 프로브합니다.
- `memory status --deep --index`는 저장소가 깨끗하지 않을 경우 재인덱스를 실행합니다.
- `memory index --verbose`는 각 단계의 세부 정보를 출력합니다 (프로바이더, 모델, 소스, 배치 활동).
- `memory status`는 `memorySearch.extraPaths`를 통해 구성된 추가 경로를 포함합니다.