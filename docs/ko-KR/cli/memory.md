---
summary: "의미 메모리 인덱싱 및 검색을 위한 CLI 참조"
read_when:
  - 의미 메모리를 인덱싱하거나 검색하려고 할 때
  - 메모리 가용성 또는 인덱싱을 디버깅할 때
title: "memory"
---

# `openclaw memory`

의미 메모리 인덱싱 및 검색을 관리합니다.
활성 메모리 플러그인에서 제공됩니다 (기본값: `memory-core`; 비활성화하려면 `plugins.slots.memory = "none"` 설정).

관련 사항:

- 메모리 개념: [Memory](/concepts/memory)
- 플러그인: [Plugins](/tools/plugin)

## 예시

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory search "release checklist"
openclaw memory search --query "release checklist"
```

## 옵션

일반:

- `--agent <id>`: 단일 에이전트로 범위 지정 (기본값: 모든 구성된 에이전트).
- `--verbose`: 프로브 및 인덱싱 중 상세 로그를 내보냅니다.

`memory search`:

- 쿼리 입력: 위치 `[query]` 또는 `--query <text>` 중 하나를 전달합니다.
- 둘 다 제공되면 `--query` 가 우선합니다.
- 둘 다 제공되지 않으면 명령이 오류로 종료됩니다.

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/cli/memory.md
workflow: 15
