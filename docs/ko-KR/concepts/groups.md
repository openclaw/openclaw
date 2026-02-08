---
summary: "그룹 채팅 설정 상세 가이드"
read_when:
  - 그룹 채팅을 설정할 때
title: "그룹 채팅"
---

# 그룹 채팅

그룹 채팅에서 에이전트를 사용하는 상세 가이드입니다.

## 그룹 정책

### 기본 정책

```json5
{
  channels: {
    telegram: {
      groupPolicy: "allowlist", // open | allowlist | disabled
    },
  },
}
```

| 정책        | 설명           |
| ----------- | -------------- |
| `open`      | 모든 그룹 허용 |
| `allowlist` | 허용된 그룹만  |
| `disabled`  | 그룹 비활성화  |

### 그룹 허용 목록

```json5
{
  channels: {
    telegram: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["trusted_admin_id"],
    },
  },
}
```

## 멘션 요구

그룹에서 멘션해야 응답:

```json5
{
  messages: {
    groupChat: {
      mentionPatterns: ["@openclaw", "@claw", "클로"],
    },
  },
}
```

### 그룹별 설정

```json5
{
  channels: {
    telegram: {
      groups: {
        "-123456789": {
          requireMention: true,
          mentionPatterns: ["@봇"],
        },
        "-987654321": {
          requireMention: false, // 모든 메시지에 응답
        },
      },
    },
  },
}
```

## 에이전트 라우팅

그룹별 에이전트 지정:

```json5
{
  bindings: [
    {
      peer: {
        kind: "group",
        channel: "discord",
        group: "server/channel",
      },
      agent: "quick",
    },
  ],
}
```

## 권한 레벨

### 관리자 전용

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": {
          allowFrom: ["admin_id_1", "admin_id_2"],
        },
      },
    },
  },
}
```

### 채널별 다른 권한

```json5
{
  channels: {
    telegram: {
      groups: {
        "-123456789": {
          allowFrom: ["*"], // 모든 멤버
        },
        "-987654321": {
          allowFrom: ["admin_only"], // 관리자만
        },
      },
    },
  },
}
```

## 스레드 모드

### Telegram 스레드

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": {
          threadMode: true,
          replyInThread: true,
        },
      },
    },
  },
}
```

### Discord 스레드

```json5
{
  channels: {
    discord: {
      groups: {
        "*": {
          useThreads: true,
        },
      },
    },
  },
}
```

## Slack 채널

### 채널별 설정

```json5
{
  channels: {
    slack: {
      channels: {
        C12345678: {
          agent: "main",
          requireMention: true,
        },
      },
    },
  },
}
```

## 도구 제한

그룹에서 도구 제한:

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": {
          tools: {
            deny: ["bash", "elevated", "write"],
          },
        },
      },
    },
  },
}
```

## 샌드박스

그룹에서 자동 샌드박스:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // 그룹 세션 샌드박스
      },
    },
  },
}
```

## 알림 제어

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": {
          silentReplies: true, // 알림 없이 응답
        },
      },
    },
  },
}
```

## 세션 범위

### 그룹 공유 세션

```json5
{
  agents: {
    defaults: {
      sessions: {
        scope: "per-channel", // 그룹 전체 공유
      },
    },
  },
}
```

### 사용자별 세션

```json5
{
  agents: {
    defaults: {
      sessions: {
        scope: "per-sender", // 같은 그룹에서도 사용자별
      },
    },
  },
}
```

## 문제 해결

### 그룹에서 응답하지 않음

1. 그룹 정책 확인
2. 멘션 패턴 확인
3. 봇 권한 확인 (메시지 읽기)

### 모든 메시지에 응답

1. `requireMention: true` 설정
2. 멘션 패턴 설정
