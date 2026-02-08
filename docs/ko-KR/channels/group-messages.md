---
summary: "그룹 채팅에서의 메시지 처리, 멘션, 활성화 설정"
read_when:
  - 그룹 채팅에서 에이전트를 사용하고 싶을 때
  - 그룹 메시지 정책을 설정하고 싶을 때
title: "그룹 메시지"
---

# 그룹 메시지

그룹 채팅에서 에이전트가 메시지를 처리하는 방식과 설정 방법입니다.

## 기본 동작

그룹에서 에이전트는 **멘션 시에만** 반응합니다 (기본값):

```
사용자A: 내일 날씨 어때?         → [무시]
사용자B: @openclaw 내일 날씨 알려줘  → [에이전트 반응]
```

## 활성화 모드

| 모드      | 설명                          |
| --------- | ----------------------------- |
| `mention` | 멘션 시에만 반응 (기본값)     |
| `always`  | 모든 메시지에 반응            |

### 설정

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": {
          requireMention: true,   // mention 모드
        },
        "특정그룹@g.us": {
          requireMention: false,  // always 모드
        },
      },
    },
  },
}
```

## 멘션 패턴

에이전트를 호출하는 멘션 패턴을 설정합니다:

```json5
{
  messages: {
    groupChat: {
      mentionPatterns: ["@openclaw", "@ai", "오픈클로"],
    },
  },
}
```

대소문자를 구분하지 않습니다.

## 그룹 정책

| 정책         | 설명                           |
| ------------ | ------------------------------ |
| `open`       | 모든 그룹에서 반응             |
| `disabled`   | 그룹에서 반응하지 않음         |
| `allowlist`  | 허용된 그룹에서만 반응         |

### WhatsApp 그룹 정책

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowlist: ["12345@g.us", "67890@g.us"],
    },
  },
}
```

### Telegram 그룹 정책

```json5
{
  channels: {
    telegram: {
      groupPolicy: "open",
      groups: {
        "*": { requireMention: true },
      },
    },
  },
}
```

### Discord 서버 정책

```json5
{
  channels: {
    discord: {
      groupPolicy: "allowlist",
      groupAllowlist: ["server-id-1", "server-id-2"],
    },
  },
}
```

## 세션 격리

그룹 메시지는 **그룹별 세션**을 사용합니다:

```
agent:main:whatsapp:group:12345@g.us    (그룹 세션)
agent:main:whatsapp:dm:821012345678     (DM 세션)
```

같은 사용자의 DM과 그룹 메시지는 별도 세션에서 처리됩니다.

## 발신자 표시

그룹에서 에이전트는 누가 메시지를 보냈는지 알 수 있습니다:

```
[from: 홍길동 (+821012345678)]
안녕하세요, 이 코드 리뷰해주세요.
```

## 그룹 컨텍스트 주입

에이전트가 처음 그룹에서 실행되면, 그룹 시스템 프롬프트가 주입됩니다. 이후 멘션되지 않은 메시지는 컨텍스트 블록으로 표시됩니다:

```
[Chat messages since your last reply - for context]
홍길동: 서버 배포 완료
김철수: 테스트 통과 확인
[End of context]
```

## 활성화 토글

그룹 소유자가 에이전트를 활성화/비활성화할 수 있습니다:

```
/activate on          # 그룹에서 에이전트 활성화
/activate off         # 비활성화
```

## 채널별 특수 사항

### WhatsApp

- 그룹 JID 형식: `12345678901@g.us`
- 하트비트는 그룹에서 실행되지 않음
- 타이핑 인디케이터는 그룹에서 비활성화

### Telegram

- 봇 프라이버시 모드에서는 `/` 명령어와 멘션만 수신
- 그룹 관리자가 봇 프라이버시 설정 변경 가능

### Discord

- 스레드 지원: 각 스레드는 별도 세션
- 멘션: `@봇이름` 또는 설정된 패턴

### Slack

- 스레드 지원: 스레드별 독립 세션
- 앱 멘션: `@앱이름` 또는 슬래시 명령

## 도구 제한

그룹 세션에서 특정 도구를 제한할 수 있습니다:

```json5
{
  agents: {
    defaults: {
      tools: {
        groups: {
          deny: ["bash", "write"],  // 그룹에서 실행/쓰기 금지
        },
      },
    },
  },
}
```

## 다음 단계

- [채널 라우팅](/ko-KR/channels/channel-routing) - 라우팅 규칙 상세
- [채널 개요](/ko-KR/channels) - 지원 채널 전체
- [보안](/ko-KR/gateway/security) - 접근 제어 설정
