---
summary: "OpenClaw Gateway 설정 완전 가이드"
read_when:
  - 설정 옵션을 찾을 때
  - Gateway 동작을 커스터마이징할 때
title: "설정 가이드"
---

# 설정 가이드

OpenClaw 설정 파일 위치: `~/.openclaw/openclaw.json`

## 기본 설정

### 최소 설정

```json5
{
  agent: {
    model: "anthropic/claude-opus-4-6",
  },
}
```

### 전체 설정 예시

```json5
{
  // 에이전트 설정
  agent: {
    model: "anthropic/claude-opus-4-6",
    workspace: "~/.openclaw/workspace",
  },

  // Gateway 설정
  gateway: {
    port: 18789,
    bind: "loopback", // 로컬 전용
    auth: {
      mode: "password",
      password: "your_secure_password",
    },
    tailscale: {
      mode: "off", // "serve" 또는 "funnel"
    },
  },

  // 채널 설정
  channels: {
    telegram: {
      botToken: "your_bot_token",
    },
    discord: {
      token: "your_discord_token",
    },
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+821012345678"],
    },
  },

  // 브라우저 제어
  browser: {
    enabled: true,
    color: "#FF4500",
  },

  // 메시지 설정
  messages: {
    responsePrefix: "",
    groupChat: {
      mentionPatterns: ["@openclaw"],
    },
  },
}
```

## 주요 설정 섹션

### agent (에이전트 설정)

| 키          | 설명              | 기본값                  |
| ----------- | ----------------- | ----------------------- |
| `model`     | 사용할 AI 모델    | 필수                    |
| `workspace` | 워크스페이스 경로 | `~/.openclaw/workspace` |

### gateway (게이트웨이 설정)

| 키              | 설명          | 기본값     |
| --------------- | ------------- | ---------- |
| `port`          | Gateway 포트  | `18789`    |
| `bind`          | 바인드 주소   | `loopback` |
| `auth.mode`     | 인증 모드     | `password` |
| `auth.password` | 인증 비밀번호 | -          |

### channels (채널 설정)

각 채널별 설정은 해당 채널 문서를 참조하세요:

- [WhatsApp](/ko-KR/channels/whatsapp)
- [Telegram](/ko-KR/channels/telegram)
- [Discord](/ko-KR/channels/discord)
- [Slack](/ko-KR/channels/slack)

## 환경변수

환경변수가 설정 파일보다 우선합니다.

| 환경변수             | 설명             |
| -------------------- | ---------------- |
| `TELEGRAM_BOT_TOKEN` | Telegram 봇 토큰 |
| `DISCORD_BOT_TOKEN`  | Discord 봇 토큰  |
| `SLACK_BOT_TOKEN`    | Slack 봇 토큰    |
| `SLACK_APP_TOKEN`    | Slack 앱 토큰    |
| `ANTHROPIC_API_KEY`  | Anthropic API 키 |
| `OPENAI_API_KEY`     | OpenAI API 키    |

## 워크스페이스 구조

```
~/.openclaw/workspace/
├── AGENTS.md         # 에이전트에 주입되는 프롬프트
├── SOUL.md           # 에이전트 성격 정의
├── TOOLS.md          # 도구 사용 지침
└── skills/           # 워크스페이스 스킬
    └── my-skill/
        └── SKILL.md
```

### AGENTS.md

에이전트의 동작을 정의하는 프롬프트 파일입니다.

### SOUL.md

에이전트의 성격과 응답 스타일을 정의합니다.

### skills/

사용자 정의 스킬을 추가할 수 있는 디렉토리입니다.

## 고급 설정

### 멀티 에이전트 설정

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-6",
      workspace: "~/.openclaw/workspace",
      maxConcurrent: 3,
    },
    list: [
      {
        id: "main",
        model: "anthropic/claude-opus-4-6",
      },
      {
        id: "coding",
        model: "openai/gpt-5.2",
        workspace: "~/.openclaw/coding-workspace",
      },
    ],
  },
}
```

### 세션 설정

```json5
{
  session: {
    scope: "per-sender", // 또는 "per-channel"
    idle: "30m",
    store: "~/.openclaw/sessions",
  },
}
```

### 샌드박스 설정

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // 그룹/채널은 Docker에서 실행
      },
    },
  },
}
```

## 설정 검증

설정을 검증하려면:

```bash
openclaw doctor
```

## Tailscale 설정

원격 접근을 위한 Tailscale 설정:

```json5
{
  gateway: {
    tailscale: {
      mode: "serve", // "off", "serve", "funnel"
      resetOnExit: true,
    },
    auth: {
      mode: "password",
      allowTailscale: true,
    },
  },
}
```

| 모드     | 설명                            |
| -------- | ------------------------------- |
| `off`    | Tailscale 자동화 없음 (기본값)  |
| `serve`  | tailnet 전용 HTTPS              |
| `funnel` | 공개 HTTPS (비밀번호 인증 필수) |
