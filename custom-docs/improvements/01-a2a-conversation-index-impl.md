# #1 A2A 대화 연속성 인덱스 교체 — 구현 기록

> 구현일: 2026-02-19
> 설계 문서: `01-a2a-conversation-index.md`

---

## 변경된 파일

| 파일                                     | 변경 유형 | 설명                                                 |
| ---------------------------------------- | --------- | ---------------------------------------------------- |
| `src/infra/events/a2a-index.ts`          | **신규**  | A2AIndexWriter + Reader, module-level start/stop API |
| `src/infra/events/a2a-index.test.ts`     | **신규**  | 24개 단위 테스트 (Writer 14, Reader 6, Lifecycle 4)  |
| `src/agents/tools/sessions-send-tool.ts` | **수정**  | NDJSON 선형 스캔 → 인덱스 O(1) 조회로 교체           |
| `src/gateway/server-startup.ts`          | **수정**  | `startA2AIndex(stateDir)` 호출 추가                  |

## 설계 문서와의 차이점

| 설계 문서                              | 실제 구현                                                                | 이유                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Writer/Reader를 class로                | module-level 함수(`startA2AIndex`/`stopA2AIndex`/`getA2AConversationId`) | `event-log.ts`의 기존 패턴(`startEventLog`/`stopEventLog`)에 맞춤                    |
| `routeKey` 필드를 이벤트에서 직접 읽음 | 이벤트 `data.fromAgent`/`data.toAgent`/`data.workSessionId`에서 재구성   | 이벤트 스키마에 `routeKey` 필드 없음 → 기존 스캔과 동일하게 agent pair 정렬하여 구성 |
| 마이그레이션 스크립트 (선택)           | 미구현 (graceful degradation)                                            | 인덱스 없으면 `undefined` 반환 → 새 대화 시작. 기존 대화도 재시작 시 어차피 초기화됨 |
| `flushA2AIndex()`                      | **추가** (설계 문서에 없음)                                              | 테스트에서 write queue drain 필요 → 편의 함수 추가                                   |

## 핵심 구현 내용

### 인덱스 파일 (`~/.openclaw/a2a-conversation-index.json`)

```json
{
  "version": 1,
  "updatedAt": 1740000000000,
  "entries": {
    "ws-1::eden|ruda": {
      "conversationId": "conv-abc",
      "timestamp": 1740000000000,
      "lastEventType": "a2a.complete",
      "runId": "run-xyz"
    }
  }
}
```

### 조회 흐름 (변경 후)

```
1. 인메모리 캐시 (Map) → hit 시 즉시 반환
2. 인덱스 파일 조회 (JSON.parse → entries[routeKey]) → O(1)
3. 없으면 undefined → 새 conversationId 생성
```

### 삭제된 코드

- `readLatestConversationIdFromEventLog()` — 전체 NDJSON 선형 스캔 (O(N))
- `A2A_EVENT_LOG_SCAN_LIMIT = 4000` — 스캔 상한선 임시방편
- `A2A_CONVERSATION_EVENT_TYPES` / `A2A_CONVERSATION_ROLE` 상수
- `import fs`, `import path`, `import { resolveStateDir }` (더 이상 불필요)

## 운영 영향

- **성능**: A2A 전송마다 NDJSON 전체 스캔(최대 4000줄 JSON.parse) → 단일 JSON 파일 읽기로 변경
- **재시작 후**: 인덱스 파일이 디스크에 유지되므로 캐시 워밍 불필요
- **인덱스 파일 크기**: routeKey 수 × ~200바이트 (수십 KB 이하)
- **기존 대화 연속성**: 인덱스 없는 상태에서 첫 시작 시 새 대화로 시작 (기존과 동일한 동작)

## 테스트 결과

- `a2a-index.test.ts`: 24/24 통과
- `src/infra/events/` 전체: 42/42 통과
- `pnpm build`: 성공 (271 files, 7480.09 kB)
- `sessions-send-tool.a2a.test.ts`: 6개 pre-existing failures (변경 전과 동일)
