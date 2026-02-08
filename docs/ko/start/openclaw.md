---
summary: "안전 주의사항을 포함하여 개인 비서로 OpenClaw 를 실행하는 엔드투엔드 가이드"
read_when:
  - 새 어시스턴스 인스턴스 온보딩
  - 안전/권한 영향 검토
title: "개인 비서 설정"
x-i18n:
  source_path: start/openclaw.md
  source_hash: 8ebb0f602c074f77
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:26:28Z
---

# OpenClaw 로 개인 비서 만들기

OpenClaw 는 **Pi** 에이전트를 위한 WhatsApp + Telegram + Discord + iMessage Gateway(게이트웨이)입니다. 플러그인을 통해 Mattermost 가 추가됩니다. 이 가이드는 '개인 비서' 설정으로, 항상 켜져 있는 에이전트처럼 동작하는 전용 WhatsApp 번호 하나를 사용하는 방식입니다.

## ⚠️ 안전 우선

에이전트를 다음과 같은 위치에 두게 됩니다:

- (Pi 도구 설정에 따라) 머신에서 명령 실행
- 워크스페이스에서 파일 읽기/쓰기
- WhatsApp/Telegram/Discord/Mattermost(플러그인)를 통해 메시지 발송

보수적으로 시작하십시오:

- 항상 `channels.whatsapp.allowFrom` 를 설정하십시오(개인 Mac 에서 외부에 공개된 상태로 실행하지 마십시오).
- 비서를 위한 전용 WhatsApp 번호를 사용하십시오.
- 하트비트는 현재 기본값이 30분마다입니다. 설정을 신뢰하기 전까지 `agents.defaults.heartbeat.every: "0m"` 를 설정하여 비활성화하십시오.

## 사전 준비 사항

- OpenClaw 설치 및 온보딩 완료 — 아직 완료하지 않았다면 [시작하기](/start/getting-started)를 참고하십시오
- 비서를 위한 두 번째 전화번호(SIM/eSIM/선불)

## 두 대의 휴대전화 설정(권장)

다음 구성을 권장합니다:

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

개인 WhatsApp 을 OpenClaw 에 연결하면, 당신에게 오는 모든 메시지가 '에이전트 입력'이 됩니다. 이는 대부분 원하지 않는 동작입니다.

## 5분 빠른 시작

1. WhatsApp Web 페어링(QR 표시; 비서용 휴대전화로 스캔):

```bash
openclaw channels login
```

2. Gateway(게이트웨이) 시작(계속 실행 상태 유지):

```bash
openclaw gateway --port 18789
```

3. `~/.openclaw/openclaw.json` 에 최소 설정 추가:

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

이제 허용 목록에 있는 휴대전화에서 비서 번호로 메시지를 보내십시오.

온보딩이 완료되면 대시보드를 자동으로 열고 정리된(토큰이 포함되지 않은) 링크를 출력합니다. 인증을 요구하면 `gateway.auth.token` 의 토큰을 Control UI 설정에 붙여넣으십시오. 나중에 다시 열려면: `openclaw dashboard`.

## 에이전트에 워크스페이스 부여(AGENTS)

OpenClaw 는 워크스페이스 디렉토리에서 운영 지침과 '메모리'를 읽습니다.

기본적으로 OpenClaw 는 에이전트 워크스페이스로 `~/.openclaw/workspace` 를 사용하며, 설정/첫 에이전트 실행 시 자동으로 생성합니다(초기 `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md` 포함). `BOOTSTRAP.md` 는 워크스페이스가 완전히 새로울 때만 생성됩니다(삭제 후에는 다시 생성되지 않아야 합니다). `MEMORY.md` 는 선택 사항(자동 생성되지 않음)이며, 존재하면 일반 세션에서 로드됩니다. 서브에이전트 세션은 `AGENTS.md` 와 `TOOLS.md` 만 주입합니다.

팁: 이 폴더를 OpenClaw 의 '메모리'로 취급하고 git 저장소(가능하면 비공개)로 만들어 `AGENTS.md` 와 메모리 파일을 백업하십시오. git 이 설치되어 있으면, 완전히 새로운 워크스페이스는 자동으로 초기화됩니다.

```bash
openclaw setup
```

전체 워크스페이스 레이아웃 + 백업 가이드: [에이전트 워크스페이스](/concepts/agent-workspace)
메모리 워크플로: [메모리](/concepts/memory)

선택 사항: `agents.defaults.workspace` 로 다른 워크스페이스를 선택할 수 있습니다(`~` 지원).

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

이미 저장소에서 자체 워크스페이스 파일을 배포하고 있다면, 부트스트랩 파일 생성을 완전히 비활성화할 수 있습니다:

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## '비서'로 만드는 설정

OpenClaw 는 기본적으로 좋은 비서 설정을 사용하지만, 일반적으로 다음을 조정하게 됩니다:

- `SOUL.md` 의 페르소나/지침
- 사고(thinking) 기본값(원하는 경우)
- 하트비트(신뢰한 이후)

예시:

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

## 세션과 메모리

- 세션 파일: `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- 세션 메타데이터(토큰 사용량, 마지막 라우트 등): `~/.openclaw/agents/<agentId>/sessions/sessions.json`(레거시: `~/.openclaw/sessions/sessions.json`)
- `/new` 또는 `/reset` 는 해당 채팅에 대해 새 세션을 시작합니다(`resetTriggers` 로 구성 가능). 단독으로 보내면, 에이전트는 리셋을 확인하기 위해 짧은 인사를 응답합니다.
- `/compact [instructions]` 는 세션 컨텍스트를 압축하고 남은 컨텍스트 예산을 보고합니다.

## 하트비트(선제적 모드)

기본적으로 OpenClaw 는 다음 프롬프트로 30분마다 하트비트를 실행합니다:
`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
비활성화하려면 `agents.defaults.heartbeat.every: "0m"` 를 설정하십시오.

- `HEARTBEAT.md` 이 존재하지만 사실상 비어 있는 경우(빈 줄과 `# Heading` 같은 마크다운 헤더만 포함), API 호출을 절약하기 위해 하트비트 실행을 건너뜁니다.
- 파일이 없으면 하트비트는 계속 실행되며, 모델이 수행할 작업을 결정합니다.
- 에이전트가 `HEARTBEAT_OK` 로 응답하면(선택적으로 짧은 패딩 포함; `agents.defaults.heartbeat.ackMaxChars` 참고), OpenClaw 는 해당 하트비트의 외부 전송을 억제합니다.
- 하트비트는 전체 에이전트 턴으로 실행됩니다 — 더 짧은 간격은 더 많은 토큰을 소모합니다.

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## 미디어 입출력

수신 첨부파일(이미지/오디오/문서)은 템플릿을 통해 명령에 노출될 수 있습니다:

- `{{MediaPath}}` (로컬 임시 파일 경로)
- `{{MediaUrl}}` (의사 URL)
- `{{Transcript}}` (오디오 전사가 활성화된 경우)

에이전트에서 보내는 첨부파일: 단독 줄에 `MEDIA:<path-or-url>` 를 포함하십시오(공백 없음). 예시:

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

OpenClaw 는 이를 추출하여 텍스트와 함께 미디어로 전송합니다.

## 운영 체크리스트

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

로그는 `/tmp/openclaw/` 아래에 있습니다(기본값: `openclaw-YYYY-MM-DD.log`).

## 다음 단계

- WebChat: [WebChat](/web/webchat)
- Gateway 운영: [Gateway runbook](/gateway)
- Cron + 웨이크업: [Cron jobs](/automation/cron-jobs)
- macOS 메뉴 바 컴패니언: [OpenClaw macOS app](/platforms/macos)
- iOS 노드 앱: [iOS app](/platforms/ios)
- Android 노드 앱: [Android app](/platforms/android)
- Windows 상태: [Windows (WSL2)](/platforms/windows)
- Linux 상태: [Linux app](/platforms/linux)
- 보안: [Security](/gateway/security)
