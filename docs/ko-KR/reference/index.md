---
summary: "기여 가이드, 용어집"
read_when:
  - 기여하고 싶을 때
title: "참조"
---

# 참조

## 용어집

| 용어        | 설명                                          |
| ----------- | --------------------------------------------- |
| **Gateway** | 모든 채널과 에이전트를 연결하는 중앙 프로세스 |
| **Channel** | 메시징 플랫폼 (WhatsApp, Telegram 등)         |
| **Agent**   | AI 모델과 상호작용하는 구성요소               |
| **Session** | 사용자와 에이전트 간의 대화 상태              |
| **Node**    | iOS/Android에서 실행되는 모바일 앱            |
| **Canvas**  | 모바일 화면 공유 기능                         |
| **Skill**   | 에이전트에 추가되는 기능 모듈                 |
| **Pairing** | 알 수 없는 사용자 승인 메커니즘               |
| **Binding** | 발신자/그룹을 에이전트에 매핑                 |
| **Sandbox** | Docker 격리 환경                              |

## 설정 키 참조

### Gateway

| 키                      | 타입   | 기본값     | 설명        |
| ----------------------- | ------ | ---------- | ----------- |
| `gateway.port`          | number | 18789      | 포트 번호   |
| `gateway.bind`          | string | "loopback" | 바인드 주소 |
| `gateway.auth.mode`     | string | -          | 인증 모드   |
| `gateway.auth.password` | string | -          | 비밀번호    |

### 에이전트

| 키                            | 타입   | 기본값   | 설명      |
| ----------------------------- | ------ | -------- | --------- |
| `agents.defaults.model`       | string | -        | 기본 모델 |
| `agents.defaults.maxTokens`   | number | 16384    | 최대 토큰 |
| `agents.defaults.temperature` | number | 0.7      | 온도      |
| `agents.defaults.thinking`    | string | "medium" | 사고 레벨 |

### 채널 공통

| 키                       | 타입    | 기본값      | 설명        |
| ------------------------ | ------- | ----------- | ----------- |
| `channels.*.enabled`     | boolean | true        | 채널 활성화 |
| `channels.*.dmPolicy`    | string  | "pairing"   | DM 정책     |
| `channels.*.allowFrom`   | array   | []          | 허용 목록   |
| `channels.*.groupPolicy` | string  | "allowlist" | 그룹 정책   |

## 환경변수

| 변수                 | 설명             |
| -------------------- | ---------------- |
| `ANTHROPIC_API_KEY`  | Anthropic API 키 |
| `OPENAI_API_KEY`     | OpenAI API 키    |
| `GOOGLE_AI_API_KEY`  | Google AI API 키 |
| `TELEGRAM_BOT_TOKEN` | Telegram 봇 토큰 |
| `DISCORD_BOT_TOKEN`  | Discord 봇 토큰  |
| `SLACK_BOT_TOKEN`    | Slack 봇 토큰    |
| `SLACK_APP_TOKEN`    | Slack 앱 토큰    |
| `OPENCLAW_CONFIG`    | 설정 파일 경로   |
| `OPENCLAW_HOME`      | 홈 디렉토리      |
| `OPENCLAW_LOG_LEVEL` | 로그 레벨        |

## 디렉토리 구조

```
~/.openclaw/
├── openclaw.json        # 메인 설정
├── credentials/         # 채널 자격 증명
│   ├── whatsapp/       # WhatsApp 세션
│   └── ...
├── sessions/           # 세션 데이터
├── memory/             # 메모리 저장소
├── workspace/          # 워크스페이스
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── TOOLS.md
│   └── skills/
└── logs/               # 로그 파일
```

## 포트

| 포트  | 용도                     |
| ----- | ------------------------ |
| 18789 | Gateway HTTP/WebSocket   |
| 18790 | Bonjour Discovery (mDNS) |

## API 엔드포인트

| 엔드포인트      | 메서드 | 설명        |
| --------------- | ------ | ----------- |
| `/health`       | GET    | 헬스 체크   |
| `/api/chat`     | POST   | 메시지 전송 |
| `/api/sessions` | GET    | 세션 목록   |
| `/api/channels` | GET    | 채널 상태   |
| `/webhook`      | POST   | 웹훅 수신   |

## 링크

- [GitHub](https://github.com/openclaw/openclaw)
- [Discord 커뮤니티](https://discord.gg/clawd)
- [문서 (영문)](https://docs.openclaw.ai)
