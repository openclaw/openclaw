---
summary: "후크: 명령어와 라이프사이클 이벤트에 대한 이벤트 기반 자동화"
read_when:
  - /new, /reset, /stop 및 에이전트 라이프사이클 이벤트에 대한 이벤트 기반 자동화를 원할 때
  - 후크를 생성, 설치 또는 디버그하고 싶을 때
title: "후크"
---

# 후크

후크는 에이전트 명령어 및 이벤트에 반응하는 작업을 자동화하기 위한 확장 가능한 이벤트 기반 시스템을 제공합니다. 후크는 디렉토리에서 자동으로 검색되며 OpenClaw의 스킬과 유사하게 CLI 명령어를 통해 관리할 수 있습니다.

## 방향 잡기

후크는 특정 상황에서 실행되도록 설계된 작은 스크립트입니다. 두 가지 종류가 있습니다:

- **후크** (이 페이지): 에이전트 이벤트가 발생할 때, 예를 들면 `/new`, `/reset`, `/stop` 또는 라이프사이클 이벤트 발생 시 게이트웨이 내부에서 실행됩니다.
- **웹후크**: 외부 HTTP 웹후크로 다른 시스템이 OpenClaw에서 작업을 트리거할 수 있도록 합니다. [Webhook Hooks](/ko-KR/automation/webhook)를 참조하거나 Gmail 헬퍼 명령어 용으로 `openclaw webhooks`를 사용할 수 있습니다.

후크는 또한 플러그인 내에 번들로 포함될 수 있습니다; [플러그인](/ko-KR/tools/plugin#plugin-hooks)을 참조하세요.

일반적인 용도:

- 세션을 리셋할 때 메모리 스냅샷 저장
- 문제 해결이나 컴플라이언스를 위한 명령어 감사 추적 유지
- 세션이 시작하거나 종료될 때 후속 자동화 트리거
- 이벤트가 발생할 때 에이전트 작업 공간에 파일을 작성하거나 외부 API 호출

작은 TypeScript 함수를 작성할 수 있다면 후크를 작성할 수 있습니다. 후크는 자동으로 검색되고, CLI를 통해 활성화하거나 비활성화할 수 있습니다.

## 개요

후크 시스템을 통해 다음을 할 수 있습니다:

- `/new` 명령어가 발행되면 세션 컨텍스트를 메모리에 저장
- 모든 명령어를 감사하기 위해 기록
- 에이전트 라이프사이클 이벤트에서 사용자 정의 자동화 트리거
- 핵심 코드를 수정하지 않고 OpenClaw의 동작 확장

## 시작하기

### 번들 후크

OpenClaw는 자동으로 검색되는 네 가지 번들 후크를 제공합니다:

- **💾 session-memory**: `/new` 명령어를 발행할 때 에이전트 작업 공간에 세션 컨텍스트를 저장(기본 경로 `~/.openclaw/workspace/memory/`)
- **📎 bootstrap-extra-files**: `agent:bootstrap` 중에 구성된 glob/패턴 경로에서 추가 워크스페이스 부트스트랩 파일을 주입
- **📝 command-logger**: 모든 명령어 이벤트를 `~/.openclaw/logs/commands.log`에 기록
- **🚀 boot-md**: 게이트웨이가 시작될 때 `BOOT.md`를 실행(내부 후크 활성화 필요)

사용 가능한 후크 목록:

```bash
openclaw hooks list
```

후크 활성화:

```bash
openclaw hooks enable session-memory
```

후크 상태 확인:

```bash
openclaw hooks check
```

자세한 정보 얻기:

```bash
openclaw hooks info session-memory
```

### 온보딩

온보딩 중(`openclaw onboard`), 추천 후크를 활성화하도록 제안됩니다. 마법사는 적격 후크를 자동으로 검색하고 선택을 제공합니다.

## 후크 검색

후크는 세 가지 디렉토리에서 자동으로 검색됩니다 (우선순위 순):

1. **워크스페이스 후크**: `<workspace>/hooks/` (에이전트별, 최고 우선순위)
2. **관리 후크**: `~/.openclaw/hooks/` (사용자 설치, 워크스페이스 전역 공유)
3. **번들 후크**: `<openclaw>/dist/hooks/bundled/` (OpenClaw에 포함됨)

관리 후크 디렉토리는 **단일 후크** 또는 **후크 팩**(패키지 디렉토리)일 수 있습니다.

각 후크는 디렉토리로 구성되어 있습니다:

```
my-hook/
├── HOOK.md          # 메타데이터 + 문서
└── handler.ts       # 핸들러 구현
```

## 후크 팩 (npm/아카이브)

후크 팩은 `package.json`의 `openclaw.hooks`를 통해 하나 이상의 후크를 내보내는 표준 npm 패키지입니다. 다음을 사용하여 설치합니다:

```bash
openclaw hooks install <path-or-spec>
```

Npm 사양은 레지스트리 전용입니다(패키지 이름 + 선택적 버전/태그). Git/URL/파일 사양은 거부됩니다.

`package.json` 예제:

```json
{
  "name": "@acme/my-hooks",
  "version": "0.1.0",
  "openclaw": {
    "hooks": ["./hooks/my-hook", "./hooks/other-hook"]
  }
}
```

각 항목은 `HOOK.md` 및 `handler.ts`(또는 `index.ts`)가 포함된 후크 디렉토리를 가리킵니다. 후크 팩은 종속성을 포함할 수 있으며, `~/.openclaw/hooks/<id>`에 설치됩니다.
각 `openclaw.hooks` 항목은 심링크 해석 후 패키지 디렉토리 내에 있어야 합니다; 이를 벗어나는 항목은 거부됩니다.

보안 주의사항: `openclaw hooks install`은 `npm install --ignore-scripts`로 종속성을 설치합니다 (라이프사이클 스크립트 없음). 후크 팩 종속성 트리는 "순수 JS/TS"로 유지하고, `postinstall` 빌드에 의존하는 패키지를 피하십시오.

## 후크 구조

### HOOK.md 형식

`HOOK.md` 파일은 YAML 프론트매터와 함께 메타데이터를 포함하며, 다음과 같은 내용이 포함됩니다:

```markdown
---
name: my-hook
description: "이 후크가 하는 일에 대한 간단한 설명"
homepage: https://docs.openclaw.ai/automation/hooks#my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---

# My Hook

자세한 문서는 여기에 작성됩니다...

## 수행 기능

- `/new` 명령어를 대기
- 특정 작업 수행
- 결과를 기록

## 요구 사항

- Node.js가 설치되어 있어야 합니다

## 구성

구성이 필요하지 않습니다.
```

### 메타데이터 필드

`metadata.openclaw` 객체는 다음을 지원합니다:

- **`emoji`**: CLI에 표시할 이모지 (예: `"💾"`)
- **`events`**: 수신 대기할 이벤트 배열 (예: `["command:new", "command:reset"]`)
- **`export`**: 사용할 이름이 지정된 내보내기 (기본값은 `"default"`)
- **`homepage`**: 문서 URL
- **`requires`**: 선택적 요구 사항
  - **`bins`**: PATH에 필요한 바이너리 (예: `["git", "node"]`)
  - **`anyBins`**: 이 바이너리 중 적어도 하나가 있어야 함
  - **`env`**: 필요한 환경 변수
  - **`config`**: 필요한 구성 경로 (예: `["workspace.dir"]`)
  - **`os`**: 필요한 플랫폼 (예: `["darwin", "linux"]`)
- **`always`**: 적격성 검사 무시 (boolean)
- **`install`**: 설치 방법 (번들 후크의 경우: `[{"id":"bundled","kind":"bundled"}]`)

### 핸들러 구현

`handler.ts` 파일은 `HookHandler` 함수를 내보냅니다:

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const myHandler: HookHandler = async (event) => {
  // 'new' 명령어에서만 트리거
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log(`[my-hook] New command triggered`);
  console.log(`  Session: ${event.sessionKey}`);
  console.log(`  Timestamp: ${event.timestamp.toISOString()}`);

  // 여기에 사용자 정의 로직 추가

  // 사용자에게 메시지 전송 선택 사항
  event.messages.push("✨ My hook executed!");
};

export default myHandler;
```

#### 이벤트 컨텍스트

각 이벤트에는 다음이 포함됩니다:

```typescript
{
  type: 'command' | 'session' | 'agent' | 'gateway',
  action: string,              // 예: 'new', 'reset', 'stop'
  sessionKey: string,          // 세션 식별자
  timestamp: Date,             // 이벤트 발생 시각
  messages: string[],          // 사용자에게 전송할 메시지 푸시
  context: {
    sessionEntry?: SessionEntry,
    sessionId?: string,
    sessionFile?: string,
    commandSource?: string,    // 예: 'whatsapp', 'telegram'
    senderId?: string,
    workspaceDir?: string,
    bootstrapFiles?: WorkspaceBootstrapFile[],
    cfg?: OpenClawConfig
  }
}
```

## 이벤트 유형

### 명령어 이벤트

에이전트 명령어가 발행될 때 트리거됨:

- **`command`**: 모든 명령어 이벤트 (일반 리스너)
- **`command:new`**: `/new` 명령어가 발행될 때
- **`command:reset`**: `/reset` 명령어가 발행될 때
- **`command:stop`**: `/stop` 명령어가 발행될 때

### 에이전트 이벤트

- **`agent:bootstrap`**: 워크스페이스 부트스트랩 파일이 주입되기 전 (후크가 `context.bootstrapFiles`를 수정할 수 있음)

### 게이트웨이 이벤트

게이트웨이가 시작될 때 트리거됨:

- **`gateway:startup`**: 채널이 시작되고 후크가 로드된 후

### 메시지 이벤트

메시지가 수신되거나 전송될 때 트리거됨:

- **`message`**: 모든 메시지 이벤트 (일반 리스너)
- **`message:received`**: 모든 채널에서 인바운드 메시지가 수신될 때
- **`message:sent`**: 아웃바운드 메시지가 성공적으로 전송될 때

#### 메시지 이벤트 컨텍스트

메시지 이벤트에는 메시지에 대한 풍부한 컨텍스트가 포함됩니다:

```typescript
// message:received context
{
  from: string,           // 발신자 식별자 (전화번호, 사용자 ID 등)
  content: string,        // 메시지 콘텐츠
  timestamp?: number,     // 수신 시 Unix 타임스탬프
  channelId: string,      // 채널 (예: "whatsapp", "telegram", "discord")
  accountId?: string,     // 다중 계정 설정용 프로바이더 계정 ID
  conversationId?: string, // 채팅/대화 ID
  messageId?: string,     // 프로바이더로부터의 메시지 ID
  metadata?: {            // 프로바이더별 추가 데이터
    to?: string,
    provider?: string,
    surface?: string,
    threadId?: string,
    senderId?: string,
    senderName?: string,
    senderUsername?: string,
    senderE164?: string,
  }
}

// message:sent context
{
  to: string,             // 수신자 식별자
  content: string,        // 전송된 메시지 콘텐츠
  success: boolean,       // 전송 성공 여부
  error?: string,         // 전송 실패 시 오류 메시지
  channelId: string,      // 채널 (예: "whatsapp", "telegram", "discord")
  accountId?: string,     // 프로바이더 계정 ID
  conversationId?: string, // 채팅/대화 ID
  messageId?: string,     // 프로바이더가 반환한 메시지 ID
}
```

#### 예제: 메시지 로거 후크

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";
import { isMessageReceivedEvent, isMessageSentEvent } from "../../src/hooks/internal-hooks.js";

const handler: HookHandler = async (event) => {
  if (isMessageReceivedEvent(event)) {
    console.log(`[message-logger] Received from ${event.context.from}: ${event.context.content}`);
  } else if (isMessageSentEvent(event)) {
    console.log(`[message-logger] Sent to ${event.context.to}: ${event.context.content}`);
  }
};

export default handler;
```

### 도구 결과 후크 (플러그인 API)

이 후크는 이벤트 스트림 리스너가 아니며, 플러그인이 OpenClaw가 저장하기 전에 도구 결과를 동기적으로 조정할 수 있도록 합니다.

- **`tool_result_persist`**: 세션 전사에 도구 결과가 기록되기 전에 도구 결과 변환. 동기적이어야 하며, 업데이트된 도구 결과 페이로드를 반환하거나 `undefined`를 반환하여 그대로 유지할 수 있습니다. [에이전트 루프](/ko-KR/concepts/agent-loop)를 참조하세요.

### 향후 이벤트

계획된 이벤트 유형:

- **`session:start`**: 세션이 시작될 때
- **`session:end`**: 세션이 종료될 때
- **`agent:error`**: 에이전트가 오류에 직면했을 때
- **`message:sent`**: 메시지가 전송되었을 때
- **`message:received`**: 메시지가 수신되었을 때

## 커스텀 후크 생성

### 1. 위치 선택

- **워크스페이스 후크** (`<workspace>/hooks/`): 에이전트별, 최고 우선순위
- **관리 후크** (`~/.openclaw/hooks/`): 워크스페이스 전역 공유

### 2. 디렉토리 구조 생성

```bash
mkdir -p ~/.openclaw/hooks/my-hook
cd ~/.openclaw/hooks/my-hook
```

### 3. HOOK.md 생성

```markdown
---
name: my-hook
description: "유용한 일을 합니다"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
---

# My Custom Hook

이 후크는 `/new` 명령어를 발행할 때 유용한 일을 합니다.
```

### 4. handler.ts 생성

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const handler: HookHandler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log("[my-hook] Running!");
  // 여기에 로직 추가
};

export default handler;
```

### 5. 활성화 및 테스트

```bash
# 후크가 검색되는지 확인
openclaw hooks list

# 활성화
openclaw hooks enable my-hook

# 게이트웨이 프로세스 재시작 (macOS에서 메뉴 바 앱 재시작하거나 개발 프로세스 재시작)

# 이벤트 트리거
# 메시지 채널을 통해 /new 전송
```

## 구성

### 새 구성 형식 (권장)

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": { "enabled": true },
        "command-logger": { "enabled": false }
      }
    }
  }
}
```

### 후크별 구성

후크는 사용자 정의 구성을 가질 수 있습니다:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "my-hook": {
          "enabled": true,
          "env": {
            "MY_CUSTOM_VAR": "value"
          }
        }
      }
    }
  }
}
```

### 추가 디렉토리

추가 디렉토리에서 후크 로드:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "load": {
        "extraDirs": ["/path/to/more/hooks"]
      }
    }
  }
}
```

### 레거시 구성 형식 (여전히 지원됨)

이전 구성 형식은 역호환성을 위해 여전히 작동합니다:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts",
          "export": "default"
        }
      ]
    }
  }
}
```

참고: `module`은 워크스페이스 상대 경로여야 합니다. 절대 경로와 워크스페이스 외부로의 탐색은 거부됩니다.

**이전:** 새로운 후크 이야기를 위해 새로운 발견 기반 시스템을 사용하세요. 레거시 핸들러는 디렉토리 기반 후크 후에 로드됩니다.

## CLI 명령어

### 후크 목록

```bash
# 모든 후크 나열
openclaw hooks list

# 적격 후크만 표시
openclaw hooks list --eligible

# 자세한 출력 (누락된 요구 사항 표시)
openclaw hooks list --verbose

# JSON 출력
openclaw hooks list --json
```

### 후크 정보

```bash
# 후크에 대한 자세한 정보 표시
openclaw hooks info session-memory

# JSON 출력
openclaw hooks info session-memory --json
```

### 적격성 확인

```bash
# 적격성 요약 표시
openclaw hooks check

# JSON 출력
openclaw hooks check --json
```

### 활성화/비활성화

```bash
# 후크 활성화
openclaw hooks enable session-memory

# 후크 비활성화
openclaw hooks disable command-logger
```

## 번들 후크 참조

### session-memory

`/new` 명령어를 발행할 때 세션 컨텍스트를 메모리에 저장합니다.

**이벤트**: `command:new`

**요구 사항**: `workspace.dir`이 구성되어 있어야 함

**출력**: `<workspace>/memory/YYYY-MM-DD-slug.md` (기본값 `~/.openclaw/workspace`)

**이것이 하는 일**:

1. 프리리셋 세션 항목을 사용하여 올바른 전사를 찾습니다
2. 대화의 마지막 15줄을 추출합니다
3. LLM을 사용하여 설명적인 파일명 슬러그를 생성합니다
4. 날짜가 표시된 메모리 파일에 세션 메타데이터를 저장합니다

**출력 예시**:

```markdown
# 세션: 2026-01-16 14:30:00 UTC

- **세션 키**: agent:main:main
- **세션 ID**: abc123def456
- **출처**: telegram
```

**파일명 예시**:

- `2026-01-16-vendor-pitch.md`
- `2026-01-16-api-design.md`
- `2026-01-16-1430.md` (슬러그 생성 실패 시 대체 타임스탬프)

**활성화**:

```bash
openclaw hooks enable session-memory
```

### bootstrap-extra-files

추가 부트스트랩 파일을 삽입합니다 (예: 모노레포 로컬 `AGENTS.md` / `TOOLS.md`) `agent:bootstrap` 중.

**이벤트**: `agent:bootstrap`

**요구 사항**: `workspace.dir`이 구성되어 있어야 함

**출력**: 파일이 기록되지 않음; 부트스트랩 컨텍스트는 메모리에서만 수정됩니다.

**구성**:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "bootstrap-extra-files": {
          "enabled": true,
          "paths": ["packages/*/AGENTS.md", "packages/*/TOOLS.md"]
        }
      }
    }
  }
}
```

**주의 사항**:

- 경로는 워크스페이스 상대적으로 해석됩니다.
- 파일은 워크스페이스 내부에 있어야 합니다 (실제 경로 확인됨).
- 인식된 부트스트랩 기본 이름만 로드됩니다.
- 서브 에이전트 허용 목록은 보존됨 (`AGENTS.md` 및 `TOOLS.md`만).

**활성화**:

```bash
openclaw hooks enable bootstrap-extra-files
```

### command-logger

모든 명령어 이벤트를 중앙화된 감사 파일에 기록합니다.

**이벤트**: `command`

**요구 사항**: 없음

**출력**: `~/.openclaw/logs/commands.log`

**이것이 하는 일**:

1. 이벤트 세부 정보를 캡처 (명령어 동작, 타임스탬프, 세션 키, 발신자 ID, 출처)
2. JSONL 형식으로 로그 파일에 추가
3. 백그라운드에서 조용히 실행

**로그 항목 예제**:

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

**로그 보기**:

```bash
# 최근 명령어 보기
tail -n 20 ~/.openclaw/logs/commands.log

# jq로 예쁘게 인쇄하기
cat ~/.openclaw/logs/commands.log | jq .

# 동작별 필터
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**활성화**:

```bash
openclaw hooks enable command-logger
```

### boot-md

게이트웨이가 시작될 때 (채널 시작 후) `BOOT.md`를 실행합니다.
내부 후크가 활성화되어 있어야만 실행됩니다.

**이벤트**: `gateway:startup`

**요구 사항**: `workspace.dir`이 구성되어 있어야 함

**이것이 하는 일**:

1. 워크스페이스에서 `BOOT.md`를 읽습니다
2. 에이전트 러너를 통해 지침을 실행합니다
3. 메시지 도구를 통해 요청된 아웃바운드 메시지를 보냅니다

**활성화**:

```bash
openclaw hooks enable boot-md
```

## 모범 사례

### 핸들러를 빠르게 유지

후크는 명령 처리 중에 실행됩니다. 가볍게 유지하세요:

```typescript
// ✓ 양호 - 비동기 작업, 즉시 반환
const handler: HookHandler = async (event) => {
  void processInBackground(event); // 실행하고 잊어버리기
};

// ✗ 좋지 않음 - 명령 처리 지연
const handler: HookHandler = async (event) => {
  await slowDatabaseQuery(event);
  await evenSlowerAPICall(event);
};
```

### 오류를 우아하게 처리

항상 위험한 작업을 래핑하세요:

```typescript
const handler: HookHandler = async (event) => {
  try {
    await riskyOperation(event);
  } catch (err) {
    console.error("[my-handler] Failed:", err instanceof Error ? err.message : String(err));
    // 던지지 마세요 - 다른 핸들러가 실행되도록 하세요
  }
};
```

### 이벤트를 초기에 필터링

이벤트가 관련이 없는 경우 미리 반환하세요:

```typescript
const handler: HookHandler = async (event) => {
  // 'new' 명령어에서만 처리
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // 여기에 로직 추가
};
```

### 특정 이벤트 키 사용

가능한 경우 메타데이터에 정확한 이벤트 지정:

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # 특정
```

다음 보다는:

```yaml
metadata: { "openclaw": { "events": ["command"] } } # 일반적 - 더 많은 오버헤드
```

## 디버깅

### 후크 로깅 활성화

게이트웨이가 시작되면 후크 로딩이 로그에 기록됩니다:

```
Registered hook: session-memory -> command:new
Registered hook: bootstrap-extra-files -> agent:bootstrap
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### 검색 확인

발견된 모든 후크 나열:

```bash
openclaw hooks list --verbose
```

### 등록 확인

핸들러가 호출될 때 로그 작성하기:

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] Triggered:", event.type, event.action);
  // 여기에 로직
};
```

### 적격성 확인

후크가 적격이 아닌 이유를 확인하십시오:

```bash
openclaw hooks info my-hook
```

출력에서 누락된 요구 사항을 찾으십시오.

## 테스트

### 게이트웨이 로그

후크 실행을 보기 위해 게이트웨이 로그를 모니터링:

```bash
# macOS
./scripts/clawlog.sh -f

# 다른 플랫폼
tail -f ~/.openclaw/gateway.log
```

### 후크 직접 테스트

격리에서 핸들러를 테스트하십시오:

```typescript
import { test } from "vitest";
import { createHookEvent } from "./src/hooks/hooks.js";
import myHandler from "./hooks/my-hook/handler.js";

test("my handler works", async () => {
  const event = createHookEvent("command", "new", "test-session", {
    foo: "bar",
  });

  await myHandler(event);

  // 부작용 확인
});
```

## 아키텍처

### 핵심 구성 요소

- **`src/hooks/types.ts`**: 타입 정의
- **`src/hooks/workspace.ts`**: 디렉토리 스캔 및 로딩
- **`src/hooks/frontmatter.ts`**: HOOK.md 메타데이터 파싱
- **`src/hooks/config.ts`**: 적격성 확인
- **`src/hooks/hooks-status.ts`**: 상태 보고
- **`src/hooks/loader.ts`**: 동적 모듈 로더
- **`src/cli/hooks-cli.ts`**: CLI 명령어
- **`src/gateway/server-startup.ts`**: 게이트웨이 시작 시 후크 로드
- **`src/auto-reply/reply/commands-core.ts`**: 명령어 이벤트 트리거

### 검색 흐름

```
게이트웨이 시작
    ↓
디렉토리 스캔 (워크스페이스 → 관리 → 번들)
    ↓
HOOK.md 파일 파싱
    ↓
적격성 확인 (바이너리, 환경 변수, 구성, 운영체제)
    ↓
적격 후크에서 핸들러 로드
    ↓
이벤트용 핸들러 등록
```

### 이벤트 흐름

```
사용자가 /new 보냄
    ↓
명령어 유효성 검사
    ↓
후크 이벤트 생성
    ↓
후크 트리거 (모든 등록된 핸들러)
    ↓
명령어 처리 계속
    ↓
세션 리셋
```

## 문제 해결

### 후크가 발견되지 않음

1. 디렉토리 구조 확인:

   ```bash
   ls -la ~/.openclaw/hooks/my-hook/
   # HOOK.md, handler.ts가 표시되어야 함
   ```

2. HOOK.md 형식 확인:

   ```bash
   cat ~/.openclaw/hooks/my-hook/HOOK.md
   # 이름과 메타데이터가 포함된 YAML 프론트매터가 있어야 함
   ```

3. 발견된 모든 후크 나열:

   ```bash
   openclaw hooks list
   ```

### 후크가 적격이 아님

요구 사항 확인:

```bash
openclaw hooks info my-hook
```

누락된 항목 찾기:

- 바이너리 (PATH 확인)
- 환경 변수
- 구성 값
- 운영체제 호환성

### 후크가 실행되지 않음

1. 후크가 활성화되었는지 확인:

   ```bash
   openclaw hooks list
   # 활성화된 후크 옆에 ✓가 표시되어야 함
   ```

2. 후크를 다시 로드할 수 있도록 게이트웨이 프로세스를 재시작하세요.

3. 게이트웨이 로그에서 오류 확인:

   ```bash
   ./scripts/clawlog.sh | grep hook
   ```

### 핸들러 오류

TypeScript/임포트 오류 검사:

```bash
# 직접 임포트 테스트
node -e "import('./path/to/handler.ts').then(console.log)"
```

## 마이그레이션 가이드

### 레거시 구성에서 검색으로

**이전:**

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts"
        }
      ]
    }
  }
}
```

**이후:**

1. 후크 디렉토리 생성:

   ```bash
   mkdir -p ~/.openclaw/hooks/my-hook
   mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts
   ```

2. HOOK.md 생성:

   ```markdown
   ---
   name: my-hook
   description: "나의 커스텀 후크"
   metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
   ---

   # My Hook

   유용한 일을 합니다.
   ```

3. 구성 업데이트:

   ```json
   {
     "hooks": {
       "internal": {
         "enabled": true,
         "entries": {
           "my-hook": { "enabled": true }
         }
       }
     }
   }
   ```

4. 게이트웨이 프로세스를 검토하고 재시작:

   ```bash
   openclaw hooks list
   # 다음 표시되어야 함: 🎯 my-hook ✓
   ```

**마이그레이션의 이점**:

- 자동 검색
- CLI 관리
- 적격성 확인
- 더 나은 문서
- 일관된 구조

## 추가 참고 자료

- [CLI 참조: 후크](/ko-KR/cli/hooks)
- [번들 후크 README](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)
- [Webhook Hooks](/ko-KR/automation/webhook)
- [구성](/ko-KR/gateway/configuration#hooks)
