---
summary: "세션 관리, 히스토리, 컨텍스트, 압축"
read_when:
  - 세션 동작을 이해하고 싶을 때
title: "세션"
---

# 세션

세션은 사용자와 에이전트 간의 대화 상태를 관리합니다.

## 세션 키

각 세션은 고유한 키로 식별됩니다:

```
agent:<agentId>:<channel>:<type>:<identifier>
```

### 예시

| 세션 키                              | 설명                        |
| ------------------------------------ | --------------------------- |
| `agent:main:telegram:dm:123456789`   | Telegram DM                 |
| `agent:main:whatsapp:group:abc@g.us` | WhatsApp 그룹               |
| `agent:coder:discord:dm:987654321`   | Discord DM (coder 에이전트) |

## 세션 범위

### Per-Sender (기본값)

각 발신자마다 독립된 세션:

```json5
{
  agents: {
    defaults: {
      sessions: {
        scope: "per-sender",
      },
    },
  },
}
```

### Per-Channel

채널 전체에서 하나의 세션 공유:

```json5
{
  agents: {
    defaults: {
      sessions: {
        scope: "per-channel",
      },
    },
  },
}
```

## 세션 히스토리

### 히스토리 제한

```json5
{
  agents: {
    defaults: {
      historyLimit: 50, // 최대 메시지 수
    },
  },
}
```

### 히스토리 조회

```bash
# 세션 목록
openclaw sessions list

# 특정 세션 히스토리
openclaw sessions history <session-key>
```

## 컨텍스트 압축

대화가 길어지면 토큰 사용량이 증가합니다. `/compact` 명령어로 컨텍스트를 압축할 수 있습니다.

### 수동 압축

채팅에서:

```
/compact
```

### 자동 압축

```json5
{
  agents: {
    defaults: {
      compaction: {
        auto: true,
        threshold: 100000, // 토큰 임계값
      },
    },
  },
}
```

### 압축 동작

1. 현재 대화를 요약
2. 요약을 새 컨텍스트로 사용
3. 이전 메시지는 삭제 (히스토리에는 보존)

## 세션 초기화

### 채팅에서

```
/reset
# 또는
/new
```

### CLI에서

```bash
openclaw sessions reset <session-key>
```

## 세션 정리

오래된 세션을 정리하여 디스크 공간 확보:

```bash
# 오래된 세션 정리
openclaw sessions prune

# 특정 기간 이전 세션 삭제
openclaw sessions prune --older-than 30d
```

### 자동 정리

```json5
{
  agents: {
    defaults: {
      sessions: {
        pruneAfter: "30d",
      },
    },
  },
}
```

## 세션 데이터 위치

```
~/.openclaw/sessions/
├── agent:main:telegram:dm:123456789/
│   ├── history.json      # 대화 히스토리
│   ├── state.json        # 세션 상태
│   └── memory.json       # 메모리 (있는 경우)
```

## 세션 내보내기/가져오기

```bash
# 세션 내보내기
openclaw sessions export <session-key> > session.json

# 세션 가져오기
openclaw sessions import < session.json
```

## 세션 도구

에이전트가 세션을 관리하는 도구:

| 도구               | 설명                    |
| ------------------ | ----------------------- |
| `sessions_list`    | 세션 목록 조회          |
| `sessions_history` | 세션 히스토리 조회      |
| `sessions_send`    | 다른 세션에 메시지 전송 |
| `sessions_spawn`   | 새 세션 생성            |

### 세션 도구 활성화

```json5
{
  agents: {
    defaults: {
      tools: {
        sessions: true,
      },
    },
  },
}
```
