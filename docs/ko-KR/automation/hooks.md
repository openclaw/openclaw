---
summary: "이벤트 기반 훅 자동화: 구조, 이벤트, 핸들러 개발"
read_when:
  - 에이전트/Gateway 이벤트에 자동화를 연결하고 싶을 때
  - 커스텀 훅을 개발하고 싶을 때
title: "훅 (Hooks)"
---

# 훅 (Hooks)

훅은 에이전트와 Gateway 이벤트에 반응하여 자동으로 실행되는 핸들러입니다. 웹훅(HTTP 콜백)과는 다르게, 훅은 Gateway 프로세스 내에서 직접 실행됩니다.

## 훅 vs 웹훅

| 항목     | 훅 (Hook)                    | 웹훅 (Webhook)               |
| -------- | ---------------------------- | ---------------------------- |
| 실행     | Gateway 프로세스 내          | 외부 HTTP 요청               |
| 지연     | 매우 낮음                    | 네트워크 지연 포함           |
| 기능     | 이벤트 수정/차단 가능        | 알림 전용                    |
| 설정     | HOOK.md + handler.ts         | URL 설정                     |

## 번들 훅

OpenClaw에 기본 포함된 훅들:

| 훅 이름            | 설명                              |
| ------------------ | --------------------------------- |
| `session-memory`   | 세션 간 메모리 유지               |
| `command-logger`   | 명령어 실행 로깅                  |
| `boot-md`          | 부트스트랩 파일 자동 생성         |
| `soul-evil`        | 재미있는 성격 주입 (예시 훅)      |

## 훅 구조

### 디렉토리

```
~/.openclaw/workspace/hooks/
└── my-hook/
    ├── HOOK.md           # 메타데이터 (필수)
    └── handler.ts        # 핸들러 코드 (필수)
```

### HOOK.md

```markdown
---
name: my-hook
description: "메시지 수신 시 로깅"
emoji: "📝"
events:
  - message_received
requires:
  bins: []
  env: []
  config: []
  os: []
---

# My Hook

메시지가 수신될 때마다 로그를 기록합니다.
```

### 메타데이터 필드

| 필드          | 설명                              |
| ------------- | --------------------------------- |
| `name`        | 훅 이름                           |
| `description` | 설명                              |
| `emoji`       | 표시용 이모지                     |
| `events`      | 구독할 이벤트 목록                |
| `export`      | 외부 공유용 이름                  |
| `homepage`    | 프로젝트 URL                     |
| `requires`    | 필요 조건 (바이너리, 환경변수 등) |

### handler.ts

```typescript
import type { HookHandler } from "openclaw/plugin-sdk";

const handler: HookHandler<"message_received"> = async (ctx) => {
  console.log(`메시지 수신: ${ctx.message} from ${ctx.sender}`);
  // 메시지 수정
  return {
    ...ctx,
    message: ctx.message.trim(),
  };
};

export default handler;
```

## 이벤트 타입

### 에이전트 이벤트

| 이벤트                  | 시점                      | 수정 가능 |
| ----------------------- | ------------------------- | --------- |
| `agent:bootstrap`       | 워크스페이스 준비 시      | 예        |
| `before_agent_start`    | 에이전트 실행 직전        | 예        |
| `agent_end`             | 에이전트 실행 완료        | 아니오    |

### 도구 이벤트

| 이벤트                  | 시점                      | 수정 가능 |
| ----------------------- | ------------------------- | --------- |
| `before_tool_call`      | 도구 실행 직전            | 예        |
| `after_tool_call`       | 도구 실행 직후            | 예        |
| `tool_result_persist`   | 도구 결과 저장 시         | 예        |

### 메시지 이벤트

| 이벤트                  | 시점                      | 수정 가능 |
| ----------------------- | ------------------------- | --------- |
| `message_received`      | 메시지 수신               | 예        |
| `message_sending`       | 메시지 전송 직전          | 예        |
| `message_sent`          | 메시지 전송 완료          | 아니오    |

### 세션 이벤트

| 이벤트                  | 시점                      |
| ----------------------- | ------------------------- |
| `session_start`         | 세션 시작                 |
| `session_end`           | 세션 종료                 |

### Gateway 이벤트

| 이벤트                  | 시점                      |
| ----------------------- | ------------------------- |
| `gateway_start`         | Gateway 시작              |
| `gateway_stop`          | Gateway 종료              |

### 명령어 이벤트

| 이벤트                  | 시점                      |
| ----------------------- | ------------------------- |
| `command.new`           | 새 명령어 실행 시         |
| `command.reset`         | 세션 리셋 시              |
| `command.stop`          | 에이전트 중단 시          |

## 커스텀 훅 만들기

### 1단계: 디렉토리 생성

```bash
mkdir -p ~/.openclaw/workspace/hooks/notify-slack
```

### 2단계: HOOK.md 작성

```markdown
---
name: notify-slack
description: "에이전트 완료 시 Slack 알림"
events:
  - agent_end
requires:
  env:
    - SLACK_WEBHOOK_URL
---
```

### 3단계: handler.ts 작성

```typescript
import type { HookHandler } from "openclaw/plugin-sdk";

const handler: HookHandler<"agent_end"> = async (ctx) => {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `에이전트 실행 완료: ${ctx.sessionKey}`,
    }),
  });
};

export default handler;
```

## 훅 관리

### CLI

```bash
openclaw hooks list          # 설치된 훅 목록
openclaw hooks info my-hook  # 훅 상세 정보
openclaw hooks check         # 훅 유효성 검사
openclaw hooks enable my-hook   # 활성화
openclaw hooks disable my-hook  # 비활성화
```

### 설정

```json5
{
  hooks: {
    discovery: {
      workspace: true,       // 워크스페이스 훅 검색
      managed: true,         // 관리 훅 검색
      bundled: true,         // 번들 훅 검색
    },
    entries: {
      "session-memory": { enabled: true },
      "my-hook": { enabled: true },
    },
  },
}
```

## 훅 팩 (npm)

npm 패키지로 훅을 배포할 수 있습니다:

```bash
npm install openclaw-hooks-monitoring
```

```json5
{
  hooks: {
    packs: ["openclaw-hooks-monitoring"],
  },
}
```

## 베스트 프랙티스

- **핸들러를 빠르게 유지**: 긴 작업은 비동기로 처리
- **오류를 처리**: try/catch로 감싸고 오류 로깅
- **이벤트를 좁게 필터**: 필요한 이벤트만 구독
- **구체적 이벤트 사용**: 포괄적 이벤트보다 특정 이벤트 구독

## 디버깅

```bash
# 훅 로그 확인
openclaw logs --filter hooks

# 훅 유효성 검사
openclaw hooks check

# 훅 검색 경로 확인
openclaw hooks list --verbose
```

## 다음 단계

- [에이전트 실행 루프](/ko-KR/concepts/agent-loop) - 훅 포인트 상세
- [웹훅](/ko-KR/automation/webhook) - HTTP 웹훅 설정
- [크론 작업](/ko-KR/automation/cron) - 예약 작업
