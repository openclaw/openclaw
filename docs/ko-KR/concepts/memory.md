---
summary: "에이전트 메모리 시스템: 단기, 장기, 시맨틱 메모리"
read_when:
  - 메모리 기능을 설정할 때
title: "메모리"
---

# 메모리

OpenClaw 에이전트는 대화 간 정보를 기억하는 메모리 시스템을 제공합니다.

## 메모리 유형

### 단기 메모리 (Short-term)

현재 세션의 대화 히스토리입니다.

- 자동으로 관리됨
- 세션 초기화 시 삭제
- `historyLimit`으로 크기 제한

### 장기 메모리 (Long-term)

세션 간 유지되는 지속적 메모리입니다.

```json5
{
  agents: {
    defaults: {
      memory: {
        enabled: true,
        type: "persistent",
      },
    },
  },
}
```

### 시맨틱 메모리

벡터 검색 기반의 관련 정보 회상:

```json5
{
  agents: {
    defaults: {
      memory: {
        enabled: true,
        type: "semantic",
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
        },
      },
    },
  },
}
```

## 메모리 활성화

### 기본 활성화

```json5
{
  agents: {
    defaults: {
      memory: {
        enabled: true,
      },
    },
  },
}
```

### 에이전트별 설정

```json5
{
  agents: {
    list: [
      {
        id: "main",
        memory: {
          enabled: true,
          type: "semantic",
        },
      },
      {
        id: "quick",
        memory: {
          enabled: false, // 이 에이전트는 메모리 없음
        },
      },
    ],
  },
}
```

## 메모리 명령어

채팅에서:

| 명령어                   | 설명                 |
| ------------------------ | -------------------- |
| `/memory`                | 현재 메모리 상태     |
| `/memory search <query>` | 메모리 검색          |
| `/memory clear`          | 메모리 초기화        |
| `/remember <text>`       | 수동으로 메모리 추가 |
| `/forget <text>`         | 특정 메모리 삭제     |

## 메모리 저장

메모리는 다음 위치에 저장됩니다:

```
~/.openclaw/memory/
├── agent:main/
│   ├── facts.json        # 사실 정보
│   ├── preferences.json  # 사용자 선호도
│   └── embeddings/       # 벡터 임베딩 (시맨틱)
```

## 메모리 유형별 설정

### Persistent 메모리

```json5
{
  agents: {
    defaults: {
      memory: {
        type: "persistent",
        maxEntries: 1000,
        retentionDays: 90,
      },
    },
  },
}
```

### Semantic 메모리

```json5
{
  agents: {
    defaults: {
      memory: {
        type: "semantic",
        embeddings: {
          provider: "openai", // openai | anthropic | local
          model: "text-embedding-3-small",
        },
        similarity: {
          threshold: 0.7,
          topK: 5,
        },
      },
    },
  },
}
```

## 자동 메모리 추출

에이전트가 대화에서 중요한 정보를 자동으로 추출:

```json5
{
  agents: {
    defaults: {
      memory: {
        autoExtract: true,
        extractCategories: ["user_preferences", "facts", "reminders"],
      },
    },
  },
}
```

## 메모리 프라이버시

### 채널별 메모리 격리

```json5
{
  agents: {
    defaults: {
      memory: {
        isolation: "per-channel", // per-channel | per-sender | shared
      },
    },
  },
}
```

### 민감 정보 필터링

```json5
{
  agents: {
    defaults: {
      memory: {
        filter: {
          excludePatterns: ["password", "api_key", "secret"],
        },
      },
    },
  },
}
```

## 메모리 백업

```bash
# 메모리 백업
openclaw memory export > memory_backup.json

# 메모리 복원
openclaw memory import < memory_backup.json
```

## 문제 해결

### 메모리가 작동하지 않음

1. 메모리가 활성화되어 있는지 확인:

```bash
openclaw config get agents.defaults.memory.enabled
```

2. 임베딩 API 키 확인 (시맨틱 메모리 사용 시)

### 메모리 사용량이 높음

1. 오래된 메모리 정리:

```bash
openclaw memory prune --older-than 30d
```

2. maxEntries 제한 설정
