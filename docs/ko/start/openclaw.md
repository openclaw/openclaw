---
read_when:
    - 새로운 어시스턴트 인스턴스 온보딩
    - 안전/권한 영향 검토
summary: 안전 주의사항과 함께 OpenClaw를 개인 비서로 실행하기 위한 엔드투엔드 가이드
title: 개인 비서 설정
x-i18n:
    generated_at: "2026-02-08T16:12:05Z"
    model: gtx
    provider: google-translate
    source_hash: 8ebb0f602c074f77b9bb04adb855aaab5007132272000048b68ca83e5c1276d9
    source_path: start/openclaw.md
    workflow: 15
---

# OpenClaw로 개인 비서 구축

OpenClaw는 WhatsApp + Telegram + Discord + iMessage 게이트웨이입니다. **파이** 자치령 대표. 플러그인은 Mattermost를 추가합니다. 이 가이드는 "개인 비서" 설정입니다. 상시 상담원처럼 작동하는 전용 WhatsApp 번호입니다.

## ⚠️ 안전이 최우선

상담원은 다음과 같은 역할을 맡게 됩니다.

- 컴퓨터에서 명령 실행(Pi 도구 설정에 따라 다름)
- 작업 공간에서 파일 읽기/쓰기
- WhatsApp/Telegram/Discord/Mattermost(플러그인)를 통해 메시지를 다시 보냅니다.

보수적으로 시작하세요:

- 항상 설정 `channels.whatsapp.allowFrom` (개인 Mac에서 공개적으로 실행하지 마십시오).
- 보조자 전용 WhatsApp 번호를 사용하세요.
- 하트비트는 이제 기본적으로 30분마다로 설정됩니다. 설정을 통해 설정을 신뢰할 때까지 비활성화 `agents.defaults.heartbeat.every: "0m"`.

## 전제조건

- OpenClaw 설치 및 온보딩 - 참조 [시작하기](/start/getting-started) 아직 이 일을 하지 않았다면
- 어시스턴트를 위한 두 번째 전화번호(SIM/eSIM/선불)

## 두 대의 전화기 설정(권장)

당신은 이것을 원합니다 :

```
Your Phone (personal)          Second Phone (assistant)
┌─────────────────┐           ┌─────────────────┐
│  Your WhatsApp  │  ──────▶  │  Assistant WA   │
│  +1-555-YOU     │  message  │  +1-555-ASSIST  │
└─────────────────┘           └────────┬────────┘
                                       │ linked via QR
                                       ▼
                              ┌─────────────────┐
                              │  Your Mac       │
                              │  (openclaw)      │
                              │    Pi agent     │
                              └─────────────────┘
```

개인 WhatsApp을 OpenClaw에 연결하면 귀하에게 보내는 모든 메시지가 "에이전트 입력"이 됩니다. 당신이 원하는 것은 거의 없습니다.

## 5분 빠른 시작

1. WhatsApp 웹 페어링(QR 표시, 보조 전화기로 스캔):

```bash
openclaw channels login
```

2. 게이트웨이를 시작합니다(실행 상태로 둡니다).

```bash
openclaw gateway --port 18789
```

3. 최소한의 구성을 넣어라 `~/.openclaw/openclaw.json`:

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

이제 허용 목록에 있는 전화기에서 보조자 번호로 메시지를 보내세요.

온보딩이 완료되면 대시보드가 ​​자동으로 열리고 깨끗한(토큰화되지 않은) 링크가 인쇄됩니다. 인증을 묻는 메시지가 나타나면 다음에서 토큰을 붙여넣으세요. `gateway.auth.token` 컨트롤 UI 설정으로 들어갑니다. 나중에 다시 열려면: `openclaw dashboard`.

## 상담원에게 작업공간 제공(AGENTS)

OpenClaw는 작업 공간 디렉토리에서 작동 지침과 "메모리"를 읽습니다.

기본적으로 OpenClaw는 다음을 사용합니다. `~/.openclaw/workspace` 에이전트 작업 영역으로 생성하고 이를 생성합니다(스타터 포함). `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`) 설정/첫 번째 에이전트 실행 시 자동으로 실행됩니다. `BOOTSTRAP.md` 작업 영역이 완전히 새로운 경우에만 생성됩니다(삭제한 후에는 다시 나타나지 않아야 함). `MEMORY.md` 선택사항입니다(자동 생성되지 않음). 존재하는 경우 일반 세션에 대해 로드됩니다. 하위 에이전트 세션은 삽입만 수행합니다. `AGENTS.md` 그리고 `TOOLS.md`.

팁: 이 폴더를 OpenClaw의 "메모리"처럼 취급하고 git repo(이상적으로는 비공개)로 만들어 `AGENTS.md` + 메모리 파일이 백업됩니다. git이 설치되면 새로운 작업 공간이 자동으로 초기화됩니다.

```bash
openclaw setup
```

전체 작업 공간 레이아웃 + 백업 가이드: [상담원 작업공간](/concepts/agent-workspace)
메모리 작업 흐름: [메모리](/concepts/memory)

선택사항: 다음을 사용하여 다른 작업공간을 선택하세요. `agents.defaults.workspace` (지원 `~`).

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

이미 저장소에서 자체 작업공간 파일을 제공한 경우 부트스트랩 파일 생성을 완전히 비활성화할 수 있습니다.

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## "어시스턴트"로 바꾸는 구성

OpenClaw는 기본적으로 좋은 어시스턴트 설정을 제공하지만 일반적으로 다음을 조정하고 싶을 것입니다.

- 페르소나/지침 `SOUL.md`
- 사고 기본값(원하는 경우)
- 심장 박동(일단 신뢰하면)

예:

```json5
{
  logging: { level: "info" },
  agent: {
    model: "anthropic/claude-opus-4-6",
    workspace: "~/.openclaw/workspace",
    thinkingDefault: "high",
    timeoutSeconds: 1800,
    // Start with 0; enable later.
    heartbeat: { every: "0m" },
  },
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@openclaw", "openclaw"],
    },
  },
  session: {
    scope: "per-sender",
    resetTriggers: ["/new", "/reset"],
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 10080,
    },
  },
}
```

## 세션 및 메모리

- 세션 파일: `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- 세션 메타데이터(토큰 사용량, 마지막 경로 등): `~/.openclaw/agents/<agentId>/sessions/sessions.json` (유산: `~/.openclaw/sessions/sessions.json`)
- `/new` 또는 `/reset` 해당 채팅에 대한 새로운 세션을 시작합니다(다음을 통해 구성 가능). `resetTriggers`). 단독으로 전송된 경우 에이전트는 재설정을 확인하기 위해 짧은 인사로 응답합니다.
- `/compact [instructions]` 세션 컨텍스트를 압축하고 나머지 컨텍스트 예산을 보고합니다.

## 하트비트(사전 모드)

기본적으로 OpenClaw는 다음 메시지와 함께 30분마다 하트비트를 실행합니다.
`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
세트 `agents.defaults.heartbeat.every: "0m"` 비활성화합니다.

- 만약에 `HEARTBEAT.md` 존재하지만 사실상 비어 있습니다(빈 줄과 다음과 같은 마크다운 헤더만 해당). `# Heading`), OpenClaw는 API 호출을 저장하기 위해 하트비트 실행을 건너뜁니다.
- 파일이 누락된 경우에도 하트비트는 계속 실행되며 모델이 수행할 작업을 결정합니다.
- 상담원이 다음과 같이 응답하면 `HEARTBEAT_OK` (선택적으로 짧은 패딩 사용; 참조 `agents.defaults.heartbeat.ackMaxChars`), OpenClaw는 해당 하트비트에 대한 아웃바운드 전달을 억제합니다.
- 하트비트는 전체 에이전트 회전을 실행합니다. 간격이 짧을수록 더 많은 토큰이 소모됩니다.

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## 미디어 입출력

인바운드 첨부 파일(이미지/오디오/문서)은 템플릿을 통해 명령에 표시될 수 있습니다.

- `{{MediaPath}}` (로컬 임시 파일 경로)
- `{{MediaUrl}}` (의사 URL)
- `{{Transcript}}` (오디오 전사가 활성화된 경우)

상담원의 아웃바운드 첨부 파일: 포함 `MEDIA:<path-or-url>` 한 줄에(공백 없이). 예:

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

OpenClaw는 이를 추출하여 텍스트와 함께 미디어로 보냅니다.

## 운영 체크리스트

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

로그는 다음 위치에 살고 있습니다. `/tmp/openclaw/` (기본: `openclaw-YYYY-MM-DD.log`).

## 다음 단계

- 웹챗: [웹채팅](/web/webchat)
- 게이트웨이 운영: [게이트웨이 런북](/gateway)
- 크론 + 웨이크업: [크론 작업](/automation/cron-jobs)
- macOS 메뉴 표시줄 컴패니언: [OpenClaw macOS 앱](/platforms/macos)
- iOS 노드 앱: [iOS 앱](/platforms/ios)
- Android 노드 앱: [안드로이드 앱](/platforms/android)
- 윈도우 상태: [윈도우(WSL2)](/platforms/windows)
- 리눅스 상태: [리눅스 앱](/platforms/linux)
- 보안: [보안](/gateway/security)
