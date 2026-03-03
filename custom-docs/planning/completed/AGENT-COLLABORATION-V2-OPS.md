# Agent Collaboration v2: 운영 / 복구 / 마이그레이션

> **Status**: ✅ 기본 구현 완료 (고급 복구 절차는 미구현)
> **Date**: 2026-02-26
> **Parent**: [AGENT-COLLABORATION-V2.md](./AGENT-COLLABORATION-V2.md)
> **Architecture Doc**: [prontolab/custom/AGENT-COLLABORATION-V2.md](../prontolab/custom/AGENT-COLLABORATION-V2.md)

---

## 1. 장애 시나리오 및 복구 절차

### 1.1 대상 에이전트 봇 오프라인 / 토큰 만료

**증상**: collaborate() 호출 시 Discord API 403 또는 메시지 전송 실패

**복구 절차**:

1. collaborate()가 즉시 실패를 반환 (재시도 없음 — 403은 transient이 아님)
2. A2A 이벤트 발행: `a2a.collaborate.failed { errorCode: "bot_offline", toAgentId }`
3. 에스컬레이션 채널 (또는 운영자 DM)로 알림:
   ```
   ⚠️ {toAgentId} 봇이 오프라인이거나 토큰이 만료되었습니다.
   - Discord API 응답: {statusCode}
   - 확인 필요: 게이트웨이 상태, 봇 토큰 유효성
   ```
4. 호출한 에이전트에게 반환: `{ success: false, error: "대상 에이전트가 현재 오프라인입니다." }`
5. 호출 에이전트는 사용자에게 "이든이 현재 오프라인 상태입니다. 나중에 다시 시도하겠습니다." 응답

**운영 체크리스트**:

- [ ] 게이트웨이 프로세스 확인: `launchctl list | grep ai.openclaw`
- [ ] 봇 토큰 유효성 확인: Discord Developer Portal
- [ ] 게이트웨이 재시작: `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway`

### 1.2 threadParticipants 맵 유실 (게이트웨이 재시작)

**증상**: 재시작 후 스레드 참여자 정보 없음 → 멘션 없는 스레드 메시지가 무시됨

**복구 절차**:

1. 시작 시 `state/thread-participants.json` 로드 시도
2. 파일 존재 + 유효 → 메모리 맵 복원 ✅
3. 파일 없음 또는 손상 → **Safe Degradation Mode**:
   - 스레드에서는 멘션 기반 HANDLER만 허용 (참여자 자동 인식 비활성)
   - 로그 경고: `"ThreadParticipantMap lost. Falling back to mention-only mode."`
   - 에이전트가 스레드에서 새로 멘션되거나 응답하면 자동 재등록
   - **collaborate() 호출이 정상 복구를 가속함**: collaborate()가 새 스레드를 만들면 ThreadParticipantMap에 정상 등록되므로, Safe Degradation 중에도 새 협업은 즉시 정상 동작함
   - 기존 스레드도 멘션/응답을 통해 참여자가 재등록되면서 자연스럽게 정상 상태로 복귀

**예방**:

- threadParticipants 변경 시마다 디스크에 비동기 flush (debounce 1초)
- 플러시 실패 시 로그 경고 (데이터 유실 방지 위해 sync 옵션도 제공)

### 1.3 agentId ↔ botUserId 매핑 실패

**증상**: collaborate()에서 대상 봇 Discord ID를 찾지 못함

**복구 절차**:

1. **Stage 1**: `getBotUserIdForAgent(agentId)` 직접 조회
2. **Stage 2** (fallback): config binding에서 `agentId → accountId` 찾아 `getBotUserIdForAgent(accountId)` 시도
3. **Stage 3** (최종 실패):
   - 호출 에이전트에게 명확한 에러 반환:
     ```
     { success: false, error: "'{targetAgent}'에 대한 Discord 봇 매핑을 찾을 수 없습니다.
       필요한 설정: config에서 agentId '{targetAgent}'의 Discord accountId/봇 바인딩을 확인하세요." }
     ```
   - A2A 이벤트: `a2a.collaborate.failed { errorCode: "mapping_not_found" }`
   - 운영자 알림: 매핑 설정 안내 포함

**예방**:

- 게이트웨이 시작 시 모든 에이전트의 매핑 검증 (시작 로그에 매핑 테이블 출력)
- 매핑 실패 에이전트가 있으면 시작 시 경고 로그

### 1.4 Discord API 장애 (5xx / timeout)

**증상**: collaborate() 호출 시 Discord API가 5xx 반환 또는 timeout

**복구 절차**:

1. 자동 재시도: 최대 3회, 지수 backoff (1s → 2s → 4s)
2. 3회 실패 → collaborate 실패 반환 + A2A 이벤트
3. 에스컬레이션: "Discord API 장애가 지속됩니다. 수동 확인이 필요합니다."

### 1.5 스레드 루프 감지 (핑퐁 폭주)

**증상**: 두 에이전트가 스레드에서 무한 대화 → 메시지 폭발

**복구 절차**:

1. Loop Guard 발동: 6msg/60s 초과 시 스레드 일시 중단
2. 추가: 같은 (A, B) 쌍 5분 내 collaborate 3회 초과 → 차단
3. 에스컬레이션: "루프 감지됨. {threadId}에서 {agentA}↔{agentB} 무한 대화. 수동 개입 필요."
4. 차단 해제: 운영자가 Loop Guard 리셋 또는 5분 경과 후 자동 해제

### 1.6 Observer 히스토리 저장 실패

**증상**: 디스크 쓰기 실패 또는 메모리 부족

**복구 절차**:

1. Observer 기록 실패 시 → 해당 메시지 드랍 (핵심 기능 아님)
2. 경고 로그: `"Observer history write failed for channel {channelId}. Message dropped."`
3. 반복 실패 시 → Observer 기능 일시 비활성화 (Handler 기능은 유지)

---

## 2. 정책 문서 마이그레이션 (Discord-first 단일화)

### 2.1 현재 상태 (3중 충돌)

| 문서                                | 현재 정책                                      | 문제                        |
| ----------------------------------- | ---------------------------------------------- | --------------------------- |
| `workspace-shared/COLLABORATION.md` | sessions_send만 허용, Discord 스레드 협업 금지 | v2 설계와 정면 충돌         |
| `workspace-*/AGENTS.md` (다수)      | agentSend 우선 사용                            | v1 기준, collaborate 미반영 |
| `AGENT-COLLABORATION-V2.md` (신규)  | collaborate로 전환                             | 코드 미구현 상태            |
| `sessions-send-helpers.ts:212`      | A2A 컨텍스트에서 외부 채널 협업 금지           | Discord-first와 반대        |

### 2.2 마이그레이션 계획

#### Phase 4-A: 공통 정책 문서 개정

| 파일                                | 변경 내용                                                                                                   | 우선순위 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------- |
| `workspace-shared/COLLABORATION.md` | "sessions_send 주류" → "Discord-first + collaborate 주류. sessions_send는 백그라운드 작업/상태 전달용 보조" | **필수** |
| `workspace-shared/COLLABORATION.md` | "Discord 스레드 협업 금지" 문구 삭제 → "collaborate()를 통한 스레드 협업이 기본"                            | **필수** |

#### Phase 4-B: 에이전트별 AGENTS.md 개정

| 대상                    | 변경 내용                                         |
| ----------------------- | ------------------------------------------------- |
| 11개 에이전트 AGENTS.md | 협업 섹션에서 `agentSend` → `collaborate` 교체    |
| 11개 에이전트 AGENTS.md | "Peer Collaboration — collaborate 도구" 섹션 추가 |
| 11개 에이전트 AGENTS.md | 스레드 대화 규칙, 채널 발언 규칙 추가             |

#### Phase 4-C: 런타임 프롬프트 수정

| 파일                           | 변경                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `sessions-send-helpers.ts:212` | A2A 컨텍스트의 "외부 채널 협업 금지" → "Discord 스레드 협업은 collaborate() 사용. 직접 메시지 전송 금지." |
| `sessions-send-helpers.ts`     | collaborate 도구 존재를 A2A 컨텍스트에 알리는 힌트 추가                                                   |

#### Phase 4-D: 기존 도구 정리

| 파일                           | 변경                                                  |
| ------------------------------ | ----------------------------------------------------- |
| `discord-actions-messaging.ts` | `case "agentSend"` 제거 또는 collaborate로 리다이렉트 |
| `discord-send-tool.ts`         | collaborate-tool.ts로 통합 후 제거                    |
| `discord-actions.ts`           | `messagingActions`에서 `"agentSend"` 제거             |

### 2.3 마이그레이션 순서

```
Phase 1-2 배포 (코드 구현)
  │
  ├── collaborate 도구가 동작 확인
  │
  ▼
Phase 4-A (공통 정책 개정) ← 코드 배포 후 즉시
  │
  ▼
Phase 4-B (AGENTS.md 일괄 개정) ← 모든 에이전트 동시 적용
  │
  ▼
Phase 4-C (런타임 프롬프트 수정)
  │
  ▼
Phase 4-D (v1 코드 정리) ← 마지막. 2주 이상 운영 확인 후
```

### 2.4 task-hub 관측성 연계

- Discord-first여도 이벤트/로그는 task-hub에 남긴다
- 목표 재정의: "중간 대화는 Discord에서 하지만, 이벤트는 task-hub에 기록"
- A2A 이벤트 (`a2a.collaborate.*`)가 task-hub Communications에 자동 반영
- task-hub UI에서 collaborate 이력 조회 가능 (Phase 3+ 이후)

---

## 3. 기존 코드 문제 목록 (구현 시 참고)

### 3.1 런타임에 없는 기능

| 문제                        | 위치                         | 영향                       | 해결 Phase |
| --------------------------- | ---------------------------- | -------------------------- | ---------- |
| collaborate 도구 미구현     | 설계만 존재                  | 세션 독립 협업 불가        | Phase 2    |
| Handler/Observer 미구현     | message-handler.preflight.ts | 모든 봇이 모든 메시지 처리 | Phase 1    |
| ThreadParticipantMap 미구현 | 없음                         | 스레드 멘션 없이 동작 불가 | Phase 1    |

### 3.2 매핑 불일치

| 문제                       | 위치                                 | 영향         | 해결 Phase |
| -------------------------- | ------------------------------------ | ------------ | ---------- |
| accountId ↔ agentId 불일치 | provider.ts:536 / sibling-bots.ts:69 | 봇 조회 실패 | Phase 2    |

### 3.3 사용 안 되는 설정

| 설정                  | 위치                 | 상태                        |
| --------------------- | -------------------- | --------------------------- |
| `threadCommunication` | types.discord.ts:252 | 타입만 존재, 소비 코드 없음 |
| `taskApprovals`       | types.discord.ts:262 | 타입만 존재, 소비 코드 없음 |

→ Phase 4에서 정리 또는 v2에서 활용 여부 결정

### 3.4 깨진 경로

| 문제                                     | 위치                                     | 영향                          |
| ---------------------------------------- | ---------------------------------------- | ----------------------------- |
| `send_to_dashboard` → `/api/dm/incoming` | extensions/send-to-dashboard/index.ts:68 | 실제 라우트 없음, 런타임 실패 |
| task-hub 설계 vs 구현 drift              | task-hub docs vs AppNav.tsx              | 기대 UX ≠ 실제 화면           |

→ task-hub 별도 이슈로 트래킹 (v2 scope 밖, 하지만 인지 필요)

---

## 4. 운영 모니터링 체크리스트

### 배포 직후 (Phase 1-2)

- [ ] Handler/Observer 분리 확인: @멘션된 봇만 응답하는지
- [ ] Observer 기록 확인: 멘션 안 된 봇의 세션에 히스토리가 쌓이는지
- [ ] collaborate 도구 동작 확인: 스레드 생성 + 대상 봇 멘션
- [ ] 매핑 확인: 모든 에이전트 ID → botUserId 해결되는지
- [ ] 루프 가드 확인: 핑퐁 시 차단되는지

### 안정화 기간 (Phase 3)

- [ ] 무응답 리마인더 동작 확인
- [ ] 에스컬레이션 알림 동작 확인
- [ ] Observer 히스토리 TTL/cap 동작 확인
- [ ] 스레드 재사용 캐시 동작 확인

### 마이그레이션 완료 후 (Phase 4)

- [ ] agentSend 코드 완전 제거 확인
- [ ] 모든 AGENTS.md에서 collaborate 가이드 존재 확인
- [ ] COLLABORATION.md Discord-first 반영 확인
- [ ] sessions-send-helpers.ts 프롬프트 수정 확인
