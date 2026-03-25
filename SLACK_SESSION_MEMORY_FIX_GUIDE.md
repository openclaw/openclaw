# Slack session-memory 훅 미동작 수정 가이드

## 문제

Slack에서 `/new`, `/reset` 커맨드가 OpenClaw에 전달되지 않아 session-memory 훅이 트리거되지 않음.

**근본 원인**: Slack 플랫폼이 `/`로 시작하는 메시지를 슬래시 커맨드로 인터셉트하여 봇에 전달하지 않음.

**결과**: Slack 사용자는 세션을 리셋할 수 없고, 대화 내용이 memory에 저장되지 않음.

## 확인된 사실

- **CLI에서는 정상 동작**: `npx openclaw agent --agent main --message '/new'` → memory 파일 생성됨
- session-memory 훅은 `command:new` / `command:reset` 이벤트에만 반응
- `commands-core.ts:162`에서 regex 매칭: `/^\/(new|reset)(?:\s|$)/`
- Slack의 `slashCommand` config는 별도 메커니즘 (네이티브 Slack 슬래시 커맨드 등록용)이며, `/new`를 네이티브 커맨드로 등록하는 코드는 없음
- `memoryFlush`는 compaction 직전에만 동작하므로 대화량이 적으면 영원히 트리거되지 않음

## 관련 소스 코드

### 핵심 파일

| 파일 | 역할 |
|------|------|
| `src/auto-reply/reply/commands-core.ts` | `/new`, `/reset` 커맨드 감지 및 `emitResetCommandHooks()` 호출 |
| `src/hooks/bundled/session-memory/handler.ts` | session-memory 훅 핸들러 (`event.type === "command"` && `event.action === "new\|reset"`) |
| `src/hooks/internal-hooks.ts` | 내부 훅 이벤트 시스템, 이벤트 타입 정의 |
| `src/auto-reply/reply/commands-context.ts` | `buildCommandContext()` — `commandBodyNormalized` 생성 |
| `src/auto-reply/commands-registry.ts` | `normalizeCommandBody()`, `shouldHandleTextCommands()` |
| `src/auto-reply/reply/memory-flush.ts` | compaction 기반 memoryFlush (별도 메커니즘) |

### 메시지 흐름

```
Slack 메시지 수신
  → inbound context 생성 (get-reply.ts)
  → buildCommandContext() → commandBodyNormalized 생성
  → handleCommands() (commands-core.ts:158)
    → regex 매칭: /^\/(new|reset)(?:\s|$)/
    → emitResetCommandHooks() → session-memory 훅 트리거
```

Slack이 `/` 메시지를 인터셉트하므로 이 흐름의 첫 단계에서 메시지가 도착하지 않음.

### 훅 이벤트 타입 (internal-hooks.ts)

```
command:new, command:reset, command:stop
session:compact:before, session:compact:after
agent:bootstrap
gateway:startup
message:received, message:transcribed, message:preprocessed, message:sent
```

## 수정 방향 제안

### 방안 1: Slack 네이티브 커맨드로 `/new`, `/reset` 등록

Slack App에 `/new`, `/reset`을 슬래시 커맨드로 등록하고, Slack이 보내는 slash_command 이벤트를 받아서 `command:new` / `command:reset` 이벤트를 발생시키는 핸들러 추가.

- Slack 플러그인 소스: `node_modules/openclaw/` 내부 또는 별도 플러그인 패키지
- `slashCommand` config 활용 가능성 확인 필요 (`src/config/types.slack.ts:72-81`)

### 방안 2: session-memory 훅을 추가 이벤트에서도 트리거

현재 `command:new`/`command:reset`에만 반응하는 session-memory 훅을 다른 이벤트에서도 동작하도록 확장:

- `session:compact:before` — compaction 직전에 memory 저장
- `gateway:startup` — 게이트웨이 재시작 시 이전 세션 memory 저장
- 별도 idle timeout 이벤트 추가

수정 대상: `src/hooks/bundled/session-memory/handler.ts:55-58`

```typescript
// 현재: command:new / command:reset 에만 반응
const isResetCommand = event.action === "new" || event.action === "reset";
if (event.type !== "command" || !isResetCommand) {
  return;
}

// 제안: 추가 이벤트 지원
const isResetCommand = event.action === "new" || event.action === "reset";
const isCompaction = event.type === "session" && event.action === "compact:before";
const isGatewayRestart = event.type === "gateway" && event.action === "startup";
if (!isResetCommand && !isCompaction && !isGatewayRestart) {
  return;
}
```

### 방안 3: Slack 메시지에서 슬래시 없이 커맨드 인식

`commands-core.ts`에서 `/new` 외에 `new`, `reset` (슬래시 없이)도 커맨드로 인식하도록 확장. 단, 일반 대화에서 "new"라는 단어를 사용할 때 오탐 위험.

## 테스트 방법

```bash
# 훅 상태 확인
npx openclaw hooks list --verbose

# CLI에서 /new 테스트 (기준 동작)
npx openclaw agent --agent main --message '/new'
ls -la ~/.openclaw/workspace/memory/

# memory 인덱스 확인
npx openclaw memory status --deep --json

# 리인덱스
npx openclaw memory index --force
```

## 환경 정보

- OpenClaw 서버 버전: 2026.3.23-2
- Slack 연결 방식: Socket Mode
- 설정: `slashCommand.enabled: false`, `commands.native: "auto"`
