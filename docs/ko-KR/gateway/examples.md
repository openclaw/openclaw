---
summary: "설정 파일 상세 예시 모음"
read_when:
  - 설정 예시가 필요할 때
title: "설정 예시"
---

# 설정 예시

다양한 사용 사례를 위한 설정 예시 모음입니다.

## 기본 설정

최소 구성:

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-6",
    },
  },
}
```

## 개인 사용

```json5
{
  // 모델 설정
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-6",
      thinking: "medium",
    },
  },

  // WhatsApp만 활성화
  channels: {
    whatsapp: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },

  // Gateway
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

## 개발자 설정

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-6",
      thinking: "high",
      workspace: "~/projects",
    },
  },

  channels: {
    telegram: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },

  browser: {
    enabled: true,
    headless: true,
  },

  // 자동 승인 명령어
  agents: {
    defaults: {
      exec: {
        autoApprove: ["git *", "npm test", "npm run *", "ls *", "cat *"],
      },
    },
  },
}
```

## 팀 설정

```json5
{
  agents: {
    list: [
      {
        id: "main",
        model: "anthropic/claude-opus-4-6",
      },
      {
        id: "quick",
        model: "anthropic/claude-sonnet-4-20250514",
      },
    ],
  },

  channels: {
    slack: {
      enabled: true,
      dmPolicy: "allowlist",
      allowFrom: ["U12345", "U67890"],
    },
    discord: {
      enabled: true,
      groupPolicy: "allowlist",
      groupAllowFrom: ["trusted_user_id"],
    },
  },

  gateway: {
    auth: {
      mode: "password",
      password: "team_password",
    },
  },
}
```

## 보안 강화 설정

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        tools: {
          deny: ["browser", "elevated"],
        },
      },
    },
  },

  channels: {
    telegram: {
      dmPolicy: "allowlist",
      allowFrom: ["+821012345678"],
      groupPolicy: "disabled",
    },
  },

  gateway: {
    bind: "loopback",
    auth: {
      mode: "password",
      password: "very_strong_password",
    },
  },
}
```

## 자동화 설정

```json5
{
  // 크론 작업
  cron: {
    jobs: [
      {
        id: "morning",
        schedule: "0 8 * * *",
        prompt: "오늘의 할 일과 일정을 알려줘",
        target: { channel: "telegram", to: "123456789" },
      },
      {
        id: "backup",
        schedule: "0 0 * * *",
        prompt: "시스템 상태를 확인해줘",
        target: { channel: "telegram", to: "123456789" },
      },
    ],
  },

  // 하트비트
  agents: {
    defaults: {
      heartbeat: {
        every: "2h",
        target: { channel: "telegram", to: "123456789" },
      },
    },
  },

  timezone: "Asia/Seoul",
}
```

## 멀티 채널 설정

```json5
{
  channels: {
    whatsapp: { enabled: true, dmPolicy: "pairing" },
    telegram: { enabled: true, dmPolicy: "pairing" },
    discord: { enabled: true, dmPolicy: "allowlist" },
    slack: { enabled: true, dmPolicy: "allowlist" },
  },

  // 채널별 에이전트 라우팅
  bindings: [
    {
      peer: { kind: "dm", channel: "whatsapp" },
      agent: "main",
    },
    {
      peer: { kind: "dm", channel: "slack" },
      agent: "work",
    },
  ],
}
```

## Raspberry Pi 최적화

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-sonnet-4-20250514",
      thinking: "low",
      historyLimit: 20,
      compaction: { auto: true, threshold: 30000 },
    },
  },

  browser: { enabled: false },

  media: {
    cache: { maxSize: "100mb" },
  },

  logging: {
    level: "info",
    retention: { days: 3 },
  },
}
```
