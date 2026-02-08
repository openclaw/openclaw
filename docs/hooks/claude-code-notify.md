---
summary: "Claude Code → MAIBOT Discord DM notification hook"
read_when:
  - You want to receive Discord DM notifications when Claude Code responds or needs attention
  - You want to set up Claude Code hook integration with MAIBOT
---
# Claude Code Discord DM Notification

Claude Code의 hook 시스템을 활용하여, 응답 완료/알림 등의 이벤트 발생 시 MAIBOT Gateway를 통해 Discord DM으로 알림을 전송합니다.

## 아키텍처

```
Claude Code Event (Stop/Notification)
  → bash .claude/hooks/notify-discord.sh   (stdin: JSON)
    → node .claude/hooks/notify-discord.mjs (parse + send)
      → node moltbot.mjs message send --channel discord --target user:<ID> --message <msg>
        → MAIBOT Gateway → Discord DM
```

## 파일 구성

| 파일 | 역할 |
|------|------|
| `.claude/hooks/notify-discord.sh` | Bash wrapper — stdin을 Node.js 스크립트로 전달 |
| `.claude/hooks/notify-discord.mjs` | 핵심 로직 — hook JSON 파싱 + moltbot CLI로 Discord DM 전송 |
| `.claude/settings.local.json` | Claude Code hook 이벤트 등록 (gitignored) |

## 지원 이벤트

| 이벤트 | Discord 메시지 |
|--------|---------------|
| `Stop` | "Claude Code 응답 완료" |
| `Notification` | "Claude Code 알림: 확인이 필요합니다" |
| `SessionStart` | "Claude Code 세션 시작" |
| `SessionEnd` | "Claude Code 세션 종료" |

## 설정 방법

### 1. Hook 파일 확인

`.claude/hooks/notify-discord.sh` 와 `.claude/hooks/notify-discord.mjs`가 프로젝트에 포함되어 있습니다.

### 2. Discord User ID 확인

MAIBOT 로그에서 본인의 Discord User ID를 확인합니다:

```bash
node moltbot.mjs channels logs | grep "discord inbound"
# from=discord:<USER_ID> 형태로 표시됨
```

`notify-discord.mjs`의 `TARGET` 변수에 `user:<USER_ID>` 형식으로 설정합니다.

### 3. Claude Code settings.local.json 설정

`.claude/settings.local.json`에 hook 이벤트를 등록합니다:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/notify-discord.sh\"",
            "timeout": 10
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/notify-discord.sh\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

### 4. 테스트

```bash
# 수동 테스트
echo '{"hook_event_name":"Stop","stop_hook_active":false}' | bash .claude/hooks/notify-discord.sh

# 직접 메시지 전송 테스트
node moltbot.mjs message send --channel discord --target "user:<USER_ID>" --message "테스트"
```

## 전제 조건

- MAIBOT Gateway 실행 중 (`node moltbot.mjs gateway status`)
- Discord 채널 설정 완료 (`node moltbot.mjs channels list`)
- Git Bash 설치 (Windows에서 `bash` 명령어 사용)

## 무한루프 방지

`Stop` 이벤트 hook이 다시 `Stop`을 트리거하는 것을 방지하기 위해, hook JSON의 `stop_hook_active` 플래그를 확인합니다:

```javascript
if (event === "Stop" && input.stop_hook_active) process.exit(0);
```

## 타임아웃

- Claude Code hook timeout: 10초 (settings.local.json)
- 스크립트 내부 fallback timeout: 8초 (`setTimeout`)
- Gateway에서 응답이 없어도 Claude Code는 블로킹되지 않음

## 문제 해결

| 증상 | 원인 | 해결 |
|------|------|------|
| DM 안 옴 | Gateway 꺼져있음 | `node moltbot.mjs gateway start` |
| DM 안 옴 | `user:me` 사용 | 실제 Discord User ID로 변경 |
| hook 실행 안 됨 | bash 없음 | Git Bash 설치 확인 |
| 타임아웃 | Gateway 응답 느림 | timeout 값 증가 |
