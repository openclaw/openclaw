---
summary: "지원되는 모든 채널 개요 및 설정 가이드"
read_when:
  - 채널을 선택하거나 설정할 때
title: "채널"
---

# 채널

OpenClaw는 다양한 메시징 플랫폼을 지원합니다. 각 채널은 독립적으로 설정하고 동시에 운영할 수 있습니다.

## 지원 채널

### 주요 채널

| 채널                                 | 상태        | 설명                        |
| ------------------------------------ | ----------- | --------------------------- |
| [WhatsApp](/ko-KR/channels/whatsapp) | ✅ 프로덕션 | Baileys를 통한 WhatsApp Web |
| [Telegram](/ko-KR/channels/telegram) | ✅ 프로덕션 | grammY를 통한 Bot API       |
| [Discord](/ko-KR/channels/discord)   | ✅ 프로덕션 | discord.js를 통한 Bot API   |
| [Slack](/ko-KR/channels/slack)       | ✅ 프로덕션 | Bolt 프레임워크             |
| iMessage                             | ✅ 프로덕션 | macOS/BlueBubbles           |
| Google Chat                          | ✅ 프로덕션 | Google Workspace            |
| Microsoft Teams                      | ✅ 프로덕션 | Bot Framework               |
| Signal                               | ✅ 프로덕션 | signald 기반                |

### 확장 채널

| 채널       | 상태        | 설명                |
| ---------- | ----------- | ------------------- |
| Matrix     | ✅ 프로덕션 | 분산형 메시징       |
| Mattermost | ✅ 프로덕션 | 오픈소스 Slack 대안 |
| LINE       | 🔧 베타     | LINE Bot API        |
| Twitch     | 🔧 베타     | 스트리밍 채팅       |
| Zalo       | 🔧 베타     | 베트남 메시징 앱    |
| Nostr      | 🔧 실험적   | 분산형 프로토콜     |

## 빠른 설정 가이드

### 1. 채널 활성화

각 채널은 `~/.openclaw/openclaw.json`에서 설정합니다:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "your_token",
    },
    whatsapp: {
      dmPolicy: "pairing",
    },
    discord: {
      token: "your_discord_token",
    },
  },
}
```

### 2. 채널 로그인 (필요한 경우)

WhatsApp처럼 로그인이 필요한 채널:

```bash
openclaw channels login
```

### 3. 채널 상태 확인

```bash
openclaw channels status
```

## 채널 공통 설정

### DM 정책

모든 채널에서 DM 접근을 제어합니다:

| 정책        | 설명                                            |
| ----------- | ----------------------------------------------- |
| `pairing`   | 알 수 없는 발신자에게 페어링 코드 전송 (기본값) |
| `allowlist` | 허용 목록에 있는 사용자만 접근                  |
| `open`      | 모든 DM 허용                                    |
| `disabled`  | DM 비활성화                                     |

```json5
{
  channels: {
    telegram: {
      dmPolicy: "pairing",
      allowFrom: ["user_id"],
    },
  },
}
```

### 그룹 정책

그룹/채널 접근을 제어합니다:

| 정책        | 설명                               |
| ----------- | ---------------------------------- |
| `open`      | 모든 그룹 멤버가 메시지 가능       |
| `allowlist` | 허용 목록에 있는 사용자만 (기본값) |
| `disabled`  | 그룹 메시지 비활성화               |

```json5
{
  channels: {
    telegram: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user_id"],
    },
  },
}
```

### 멘션 게이팅

그룹에서 @멘션 요구 여부:

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: true }, // 모든 그룹에서 멘션 필요
        "-123456789": { requireMention: false }, // 특정 그룹은 항상 응답
      },
    },
  },
}
```

## 페어링

OpenClaw의 기본 DM 보안 메커니즘입니다.

### 페어링 작동 방식

1. 알 수 없는 사용자가 봇에 메시지를 보냅니다.
2. 봇이 6자리 페어링 코드를 반환합니다.
3. 관리자가 코드를 승인합니다.
4. 사용자가 영구적으로 허용됩니다.

### 페어링 관리

```bash
# 대기 중인 요청 보기
openclaw pairing list <channel>

# 요청 승인
openclaw pairing approve <channel> <code>

# 요청 거부
openclaw pairing reject <channel> <code>
```

### 페어링 설정

```json5
{
  channels: {
    telegram: {
      dmPolicy: "pairing",
      pairing: {
        expiresAfter: "1h", // 코드 만료 시간
        maxPending: 3, // 최대 대기 요청 수
      },
    },
  },
}
```

## 다음 단계

- [WhatsApp 설정](/ko-KR/channels/whatsapp)
- [Telegram 설정](/ko-KR/channels/telegram)
- [Discord 설정](/ko-KR/channels/discord)
- [Slack 설정](/ko-KR/channels/slack)
