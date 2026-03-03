# Agent Collaboration v2: 런타임 정책

> **Status**: ⚠️ 부분 구현 (런타임 정책 중 레이트리밋/루프가드 미구현)
> **Date**: 2026-02-26
> **Parent**: [AGENT-COLLABORATION-V2.md](./AGENT-COLLABORATION-V2.md)
> **Architecture Doc**: [prontolab/custom/AGENT-COLLABORATION-V2.md](../prontolab/custom/AGENT-COLLABORATION-V2.md)

---

## 1. A2A 역할 재정의 (Discord-first 기준)

Discord-first 체제에서 A2A는 "협업 채널"이 아니라 **"컨트롤 플레인"**으로 남는다.

### A2A의 책임

- collaborate 호출/성공/실패를 **이벤트**로 남김 (관측/감사)
- 무응답 리마인더/에스컬레이션의 **상태 머신**을 관리 (운영 안정성)
- 루프 가드/레이트리밋 같은 **안전장치** (스레드 핑퐁 폭주 방지)
- Discord 밖 세션 (webchat/main)에서 협업을 시작할 때도 동일 규칙으로 동작 (기본 channel/account 결정 포함)

### A2A의 비책임

- **"실제 협업 메시지 전달 경로"는 Discord 스레드가 주류** (sessions_send는 보조/백업)

### A2A 이벤트 스키마

```typescript
// a2a.collaborate.requested | a2a.collaborate.sent | a2a.collaborate.failed | a2a.collaborate.responded

interface CollaborateEvent {
  conversationId: string;
  threadId: string;
  parentChannelId: string;
  fromAgentId: string;
  toAgentId: string;
  mode: "new_thread" | "reuse_thread";
  attempt: number;
  errorCode?: string; // "permission_denied" | "not_found" | "rate_limited" | "timeout"
  errorMessage?: string;
  ts: number;
}
```

---

## 2. A2A Conversation Sink 분리 정책

### 문제

discord-conversation-sink.ts가 A2A 이벤트를 Discord로 내보낼 수 있고, collaborate가 같은 스레드를 사용하면 무한 루프/중복/잡음 위험.

### 결정: 옵션 A — Sink 스레드와 협업 스레드 분리 (채택)

| 구분             | 협업 스레드                      | 리포트 스레드 (Sink)            |
| ---------------- | -------------------------------- | ------------------------------- |
| **목적**         | 에이전트 간 실시간 협업          | 대시보드/리포팅, 이벤트 기록    |
| **생성 주체**    | collaborate() 도구               | discord-conversation-sink       |
| **네이밍**       | `[협업] {from} → {to} · {topic}` | `[리포트] {event-type} · {ts}`  |
| **Handler 처리** | ✅ 참여자가 HANDLER로 처리       | ❌ 절대 HANDLER로 처리하지 않음 |
| **루프 위험**    | 없음 (sink가 글을 쓰지 않음)     | 없음 (Handler 처리 금지)        |

### 운영 규약 (CRITICAL)

1. **협업 스레드에 sink가 글을 쓰지 않는다** — sink의 대상 채널/스레드는 협업 스레드와 분리
2. **리포트 스레드에서 나온 메시지는 Handler로 처리하지 않는다** — 안전망
3. **스레드 식별**: collaborate()가 만든 스레드는 ThreadParticipantMap에 등록됨. Sink 스레드는 등록되지 않음. → 구분 가능

### 구현 가이드 — Sink 스레드 식별 (결정: Option 2 채택)

> **주의**: "ThreadParticipantMap에 없으면 sink로 간주" (Option 3)는 **채택하지 않는다**.
> 재시작 직후 Safe Degradation 상태에서 참여자 맵이 유실되면, 정상 협업 스레드까지 sink로 오인해 드랍하는 오탐이 발생한다.

**Option 2: sink가 생성한 스레드 ID를 별도 저장 (채택)**

```typescript
// state/sink-threads.json — sink가 생성한 스레드 ID 목록
// discord-conversation-sink.ts에서 스레드 생성 시 등록
const sinkThreads = new Set<string>(); // + 디스크 영속성

function isSinkThread(threadId: string): boolean {
  return sinkThreads.has(threadId);
}

// message-handler.preflight.ts
if (isInThread && isSinkThread(threadId)) {
  return null; // 드랍 — sink 스레드는 Handler로 처리하지 않음
}
```

**보조 식별 (Option 1 병행)**: sink 스레드 네이밍 prefix `[리포트]`로도 판별 가능 (이중 안전망)

---

## 3. Observer 히스토리 저장 정책 (폭증 방지)

### 문제

"모든 봇이 채널을 본다"는 목표대로 하면 봇 수만큼 저장 비용이 증가.

### 저장 규칙

| 구분                                        | 저장 형식          | 보존 기간              |
| ------------------------------------------- | ------------------ | ---------------------- |
| **Handler 메시지** (내가 처리한 것)         | 원문 보존          | 세션 TTL에 따름        |
| **Observer 메시지** (다른 봇/사용자 메시지) | **Compact 포맷만** | 24h TTL 또는 최대 50개 |
| **협업 스레드 메시지** (참여자)             | 원문 보존          | 세션 TTL에 따름        |

### Compact 포맷

```typescript
interface ObserverRecord {
  messageId: string;
  sender: string; // 사용자명 or 에이전트ID
  summary: string; // 첫 50자 truncate (원문 아님)
  ts: number;
  channelId: string;
  threadId?: string;
  mentionedBots?: string[]; // 멘션된 봇 목록 (빠른 조회용)
  extractedTokens?: {
    // 핵심 토큰 별도 보존 (정보 손실 방지)
    mentions: string[]; // @멘션된 사용자/봇 목록
    urls: string[]; // 링크 (PR, 이슈, 외부 URL)
    prNumbers: string[]; // PR/이슈 번호 (#42 등)
    codeRefs: string[]; // 파일 경로, 함수명 등
  };
}
```

### 상한/TTL 규칙

- **채널별 최대 50개** Observer 기록
- **24h TTL** — 24시간 지난 Observer 기록은 자동 삭제
- **멘션/참여자/협업 스레드의 메시지는 예외** — Handler 메시지로 취급, 원문 보존
- **요약 생성**: Observer 기록 시 원문 대신 `sender + 첫 50자 + messageId + ts` 저장 (LLM 요약 아님, 단순 truncate)
- **핵심 토큰 추출**: 50자 truncate로 유실되는 정보를 보완하기 위해, 멘션/URL/PR번호/코드 참조를 정규식으로 추출하여 `extractedTokens`에 별도 보존 (기존 `mentionedBots` 필드의 확장)

> **참고**: Observer 기록은 "정확한 원문 재현"이 아니라 "대략적 맥락 파악"이 목적이다.
> "아까 루다가 뭐라고 했어?" 질문에는 compact 기록 범위 내에서 요약 수준으로 답변 가능하다.

### 비용 추정 (10개 봇 기준)

- 채널당 메시지 100개/일 가정
- Handler (1봇 처리): 100 × 원문 = ~200KB
- Observer (9봇 × 50개 cap): 9 × 50 × ~100B = ~45KB
- **총 증가분: ~10% 미만** (compact 포맷 + cap 덕분)

---

## 4. 스레드 폭발 방지 (재사용 정책)

### 재사용 결정 규칙

```
collaborate(targetAgent, message, threadId?, channelId?)
  │
  ├── threadId 지정됨 → 무조건 해당 스레드에 이어쓰기
  │
  └── threadId 없음
      │
      ├── ThreadRouteCache에서 (fromAgent, toAgent) 키로 최근 스레드 조회
      │   │
      │   ├── 6시간 이내 활성 스레드 있음 → 재사용
      │   │
      │   └── 없음 → 새 스레드 생성
      │
      └── 새 스레드 생성
          ├── threadName: "[협업] {from} → {to} · {topic}"
          └── ThreadRouteCache에 등록
```

### ThreadRouteCache

```typescript
interface ThreadRoute {
  key: string; // 기본: "{fromAgentId}:{toAgentId}"
  // topicId 있으면: "{fromAgentId}:{toAgentId}:{topicId}"
  threadId: string;
  channelId: string;
  createdAt: number;
  lastUsedAt: number;
  messageCount: number;
}

// 저장: state/thread-route-cache.json (재시작 복구)
// TTL: 6시간 (마지막 사용 기준)
// 최대 항목: 키당 1개 (가장 최근 스레드만)
```

**키 설계 참고:**

- 기본 키는 **방향성 있음** — `루다:이든`과 `이든:루다`는 다른 스레드. 방향이 있어야 대화 컨텍스트(누가 요청하고 누가 응답하는지)가 명확함.
- `topicId` 또는 `threadName`이 collaborate() 호출 시 주어지면 키에 포함 (선택적 확장). 이를 통해 같은 에이전트 쌍이라도 토픽별로 스레드를 분리할 수 있음.
- 양방향 스레드 통합이 필요하면 키를 `sorted([a,b]).join(":")`으로 변경 가능하지만, 현재는 방향성 유지를 기본으로 함.

### 스레드명 규칙

- 일관된 형식: `[협업] {fromAgentName} → {toAgentName} · {topic}`
- topic은 collaborate() 호출 시 threadName 또는 message 첫 30자
- 예: `[협업] 루다 → 이든 · 인증 모듈 코드 리뷰`

---

## 5. 레이트리밋 / 중복 전송 / Idempotency

### Idempotency

```typescript
interface CollaborateRequest {
  idempotencyKey: string; // crypto.randomUUID() — 호출 시 자동 생성
  // ... other fields
}

// 같은 idempotencyKey로는 스레드 생성/메시지 전송을 1회로 dedupe
// 저장: in-memory Map (5분 TTL)
const recentRequests = new Map<string, CollaborateResult>();
```

### 실패 분류

| 코드    | 분류       | 재시도               | 처리                               |
| ------- | ---------- | -------------------- | ---------------------------------- |
| 403     | permission | ❌ 즉시 실패         | 에스컬레이션 (채널 권한 확인 필요) |
| 404     | not_found  | ❌ 즉시 실패         | 에스컬레이션 (봇/채널 존재 확인)   |
| 429     | rate_limit | ✅ backoff 후 재시도 | Discord rate limit 헤더 준수       |
| 5xx     | transient  | ✅ 3회까지 재시도    | 지수 backoff (1s, 2s, 4s)          |
| timeout | transient  | ✅ 3회까지 재시도    | 10초 timeout                       |

### a2a-retry 연동

- **transient 에러에서만** a2a-retry가 동작
- 403/404는 즉시 실패 + 에스컬레이션 채널로 알림
- 429는 Discord API의 Retry-After 헤더를 존중

### Discord API 레이트리밋 준수

- 기존 `send.ts`의 레이트리밋 핸들링을 재활용
- 스레드 생성: 분당 5개 제한 (Discord API 기준)
- 메시지 전송: 채널당 초당 5개 제한
- 초과 시 큐에 쌓고 순차 처리

---

## 6. 권한/보안 정책

### 허용 채널 (allowlist 기반)

```typescript
// config 구조
interface CollaborationConfig {
  defaultChannel: string; // 기본 협업 채널 ID
  allowedChannels: string[]; // 스레드 생성 허용 채널 목록
  allowedGuilds?: string[]; // 허용 길드 (멀티 길드 시)
}

// collaborate()에서 검증
function validateChannel(channelId: string): boolean {
  const config = getCollaborationConfig();
  return config.allowedChannels.includes(channelId);
}
```

### 제한 규칙

1. **allowlist 외 채널에서 스레드 생성 금지**
   - collaborate()가 허용되지 않은 채널 ID를 받으면 → 즉시 에러 반환
   - 기본 채널로 fallback하지 않음 (의도치 않은 스레드 생성 방지)

2. **대상 봇 멘션도 허용 채널/길드에서만**
   - 다른 길드에서 봇을 멘션해도 HANDLER로 전환하지 않음

3. **민감정보 방지**
   - Observer 기록은 원문 저장 금지 (compact 포맷만, 3번 정책 연계)
   - collaborate(message)는 최대 2000자 제한 (Discord API 기준)
   - 첨부파일 전달은 Phase 1-2에서는 미지원 (텍스트만)

### 루프 방지 (기존 Loop Guard 강화)

- 기존: 6msg/60s per thread
- 추가: collaborate 응답에 대한 자동 collaborate 금지
  - "B가 스레드에서 응답" → A가 그 응답을 읽고 다시 collaborate(B) 호출 → 금지
  - 같은 스레드 내에서는 일반 메시지로 대화 (collaborate 재호출 불필요)
- 추가: 에이전트간 핑퐁 감지
  - 같은 (A, B) 쌍이 5분 내 10회 이상 collaborate 호출 → 경고 + 11회째부터 차단

---

## 7. 스레드에서 sibling bot 메시지 처리 규칙 (명문화)

### 현행 전제와의 충돌

현행: 스레드에서 sibling bot 메시지 → 드랍
v2: 협업 스레드에서는 허용해야 함

### v2 허용 조건

#### Thread Handler 조건 (둘 중 하나면 처리)

1. `threadParticipants[threadId]`에 내 botUserId가 포함되어 있음
2. 메시지가 나를 명시적으로 멘션함 (`<@myBotId>`)

#### Thread Observer 조건

- 위 Handler 조건을 만족하지 않으면:
  - 히스토리 기록만 (compact 포맷 적용)
  - 응답/LLM 호출 금지

### 구현 (message-handler.preflight.ts)

```typescript
// 스레드에서 sibling bot 메시지 처리
if (isSiblingBot(authorId) && isInThread) {
  const amIParticipant = threadParticipants.isParticipant(threadId, myBotUserId);
  const amIMentioned = mentionsMe(message, myBotUserId);

  if (amIParticipant || amIMentioned) {
    // HANDLER — 처리 진행
    if (amIMentioned && !amIParticipant) {
      threadParticipants.register(threadId, myBotUserId); // 멘션으로 신규 참여
    }
    // → processDiscordMessage() 진행
  } else {
    // OBSERVER — 기록만
    recordObserverMessage(message); // compact 포맷
    markMentionRespondedIfApplicable(threadId, authorId);
    return null;
  }
}
```

---

## 부록: 정책 설정 예시 (config)

```typescript
// discordConfig.collaboration (신규 섹션)
{
  collaboration: {
    defaultChannel: "1234567890",              // 기본 협업 채널
    allowedChannels: ["1234567890", "0987654321"], // 스레드 생성 허용
    threadReuseTTL: 6 * 60 * 60 * 1000,        // 6시간 (ms)
    observerHistoryLimit: 50,                    // 채널당 Observer 기록 상한
    observerHistoryTTL: 24 * 60 * 60 * 1000,    // 24시간 (ms)
    participantTTL: 24 * 60 * 60 * 1000,        // 참여자 만료 24시간
    loopGuard: {
      maxCollaboratePerPair: 10,                 // 5분 내 같은 쌍 최대 10회
      windowMs: 5 * 60 * 1000,
    },
    rateLimit: {
      threadCreationPerMinute: 5,
      messagePerChannelPerSecond: 5,
    }
  }
}
```
