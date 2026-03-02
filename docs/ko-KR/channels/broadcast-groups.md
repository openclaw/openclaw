---
summary: "WhatsApp 메시지를 여러 에이전트에게 브로드캐스트"
read_when:
  - 브로드캐스트 그룹 구성 중
  - WhatsApp 에서 다중 에이전트 회신 디버깅 중
status: experimental
title: "브로드캐스트 그룹"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: channels/broadcast-groups.md
  workflow: 15
---

# 브로드캐스트 그룹

**상태:** 실험적
**버전:** 2026.1.9 에서 추가됨

## 개요

브로드캐스트 그룹을 사용하면 여러 에이전트가 동일한 메시지를 동시에 처리하고 응답할 수 있습니다. 이를 통해 단일 WhatsApp 그룹 또는 DM에서 협력하는 전문화된 에이전트 팀을 만들 수 있습니다. 모두 하나의 전화 번호를 사용합니다.

현재 범위: **WhatsApp 만** (Web 채널).

브로드캐스트 그룹은 채널 허용 목록 및 그룹 활성화 규칙 후에 평가됩니다. WhatsApp 그룹에서 이는 OpenClaw 가 일반적으로 회신할 때 (예: mention 시, 그룹 설정에 따라) 브로드캐스트가 발생함을 의미합니다.

## 사용 사례

### 1. 전문화된 에이전트 팀

원자적 집중된 책임을 가진 여러 에이전트 배포:

```
그룹: "Development Team"
에이전트:
  - CodeReviewer (코드 스니펫 검토)
  - DocumentationBot (문서 생성)
  - SecurityAuditor (취약점 확인)
  - TestGenerator (테스트 케이스 제안)
```

각 에이전트는 동일한 메시지를 처리하고 전문화된 관점을 제공합니다.

### 2. 다국어 지원

```
그룹: "International Support"
에이전트:
  - Agent_EN (영어로 응답)
  - Agent_DE (독일어로 응답)
  - Agent_ES (스페인어로 응답)
```

### 3. 품질 보증 워크플로우

```
그룹: "Customer Support"
에이전트:
  - SupportAgent (답변 제공)
  - QAAgent (품질 검토, 문제 발견 시만 응답)
```

### 4. 작업 자동화

```
그룹: "Project Management"
에이전트:
  - TaskTracker (작업 데이터베이스 업데이트)
  - TimeLogger (소비 시간 기록)
  - ReportGenerator (요약 생성)
```

## 구성

### 기본 설정

최상위 `broadcast` 섹션을 추가합니다 (`bindings` 옆). 키는 WhatsApp peer ID입니다:

- 그룹 채팅: 그룹 JID (예: `120363403215116621@g.us`)
- DM: E.164 전화 번호 (예: `+15551234567`)

```json
{
  "broadcast": {
    "120363403215116621@g.us": ["alfred", "baerbel", "assistant3"]
  }
}
```

**결과:** OpenClaw 가 이 채팅에서 회신할 때 세 에이전트 모두를 실행합니다.

### 처리 전략

에이전트가 메시지를 처리하는 방법을 제어합니다:

#### 병렬 (기본)

모든 에이전트가 동시에 처리:

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

#### 순차적

에이전트는 순서대로 처리 (하나가 이전 완료를 기다림):

```json
{
  "broadcast": {
    "strategy": "sequential",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

### 완전한 예제

```json
{
  "agents": {
    "list": [
      {
        "id": "code-reviewer",
        "name": "Code Reviewer",
        "workspace": "/path/to/code-reviewer",
        "sandbox": { "mode": "all" }
      },
      {
        "id": "security-auditor",
        "name": "Security Auditor",
        "workspace": "/path/to/security-auditor",
        "sandbox": { "mode": "all" }
      },
      {
        "id": "docs-generator",
        "name": "Documentation Generator",
        "workspace": "/path/to/docs-generator",
        "sandbox": { "mode": "all" }
      }
    ]
  },
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["code-reviewer", "security-auditor", "docs-generator"],
    "120363424282127706@g.us": ["support-en", "support-de"],
    "+15555550123": ["assistant", "logger"]
  }
}
```

## 작동 방식

### 메시지 흐름

1. **들어오는 메시지** 가 WhatsApp 그룹에 도착
2. **브로드캐스트 확인**: 시스템이 peer ID 가 `broadcast` 에 있는지 확인
3. **브로드캐스트 목록에 있으면**:
   - 나열된 모든 에이전트가 메시지를 처리
   - 각 에이전트는 자신의 세션 키와 격리된 컨텍스트를 가짐
   - 에이전트는 병렬 (기본) 또는 순차적으로 처리
4. **브로드캐스트 목록에 없으면**:
   - 정상 라우팅이 적용 (첫 번째 일치하는 바인딩)

참고: 브로드캐스트 그룹은 채널 허용 목록 또는 그룹 활성화 규칙 (언급/명령 등) 을 무시하지 않습니다. 메시지가 처리 대상일 때 **어느 에이전트가 실행되는지** 만 변경합니다.

### 세션 격리

브로드캐스트 그룹의 각 에이전트는 완전히 별도의 것을 유지합니다:

- **세션 키** (`agent:alfred:whatsapp:group:120363...` vs `agent:baerbel:whatsapp:group:120363...`)
- **대화 이력** (에이전트가 다른 에이전트의 메시지를 보지 못함)
- **워크스페이스** (구성된 경우 별도 샌드박스)
- **도구 접근** (다양한 allow/deny 목록)
- **메모리/컨텍스트** (별도 IDENTITY.md, SOUL.md 등)
- **그룹 컨텍스트 버퍼** (컨텍스트에 사용되는 최근 그룹 메시지) 는 peer 당 공유되므로 모든 브로드캐스트 에이전트는 트리거될 때 동일한 컨텍스트를 봅니다

이를 통해 각 에이전트는 다음을 가질 수 있습니다:

- 다양한 성격
- 다양한 도구 접근 (예: 읽기 전용 vs. 읽기-쓰기)
- 다양한 모델 (예: opus vs. sonnet)
- 다양한 설치된 스킬

### 예제: 격리된 세션

그룹 `120363403215116621@g.us` 의 에이전트 `["alfred", "baerbel"]` 사용:

**Alfred 의 컨텍스트:**

```
세션: agent:alfred:whatsapp:group:120363403215116621@g.us
이력: [user message, alfred's previous responses]
워크스페이스: /Users/pascal/openclaw-alfred/
도구: read, write, exec
```

**Bärbel 의 컨텍스트:**

```
세션: agent:baerbel:whatsapp:group:120363403215116621@g.us
이력: [user message, baerbel's previous responses]
워크스페이스: /Users/pascal/openclaw-baerbel/
도구: read only
```

## 모범 사례

### 1. 에이전트를 집중되게 유지

단일하고 명확한 책임을 가진 각 에이전트 설계:

```json
{
  "broadcast": {
    "DEV_GROUP": ["formatter", "linter", "tester"]
  }
}
```

✅ **좋음:** 각 에이전트는 하나의 일을 함
❌ **나쁨:** 하나의 일반 "dev-helper" 에이전트

### 2. 설명적인 이름 사용

각 에이전트가 무엇을 하는지 명확히 합니다:

```json
{
  "agents": {
    "security-scanner": { "name": "Security Scanner" },
    "code-formatter": { "name": "Code Formatter" },
    "test-generator": { "name": "Test Generator" }
  }
}
```

### 3. 다양한 도구 접근 구성

에이전트에 필요한 도구만 제공:

```json
{
  "agents": {
    "reviewer": {
      "tools": { "allow": ["read", "exec"] } // 읽기 전용
    },
    "fixer": {
      "tools": { "allow": ["read", "write", "edit", "exec"] } // 읽기-쓰기
    }
  }
}
```

### 4. 성능 모니터링

많은 에이전트의 경우 다음을 고려합니다:

- 속도를 위해 `"strategy": "parallel"` (기본) 사용
- 브로드캐스트 그룹을 5-10 개 에이전트로 제한
- 간단한 에이전트에 더 빠른 모델 사용

### 5. 우아하게 실패 처리

에이전트는 독립적으로 실패합니다. 한 에이전트의 오류가 다른 에이전트를 차단하지 않습니다:

```
메시지 → [에이전트 A ✓, 에이전트 B ✗ error, 에이전트 C ✓]
결과: 에이전트 A 와 C 응답, 에이전트 B 로그 오류
```

## 호환성

### 공급자

브로드캐스트 그룹은 현재 다음과 함께 작동합니다:

- ✅ WhatsApp (구현됨)
- 🚧 Telegram (계획)
- 🚧 Discord (계획)
- 🚧 Slack (계획)

### 라우팅

브로드캐스트 그룹은 기존 라우팅과 함께 작동합니다:

```json
{
  "bindings": [
    {
      "match": { "channel": "whatsapp", "peer": { "kind": "group", "id": "GROUP_A" } },
      "agentId": "alfred"
    }
  ],
  "broadcast": {
    "GROUP_B": ["agent1", "agent2"]
  }
}
```

- `GROUP_A`: alfred 만 응답 (정상 라우팅)
- `GROUP_B`: agent1 AND agent2 응답 (브로드캐스트)

**우선순위:** `broadcast` 는 `bindings` 보다 우선합니다.

## 문제 해결

### 에이전트가 응답하지 않음

**확인:**

1. 에이전트 ID 가 `agents.list` 에 있음
2. Peer ID 형식이 올바름 (예: `120363403215116621@g.us`)
3. 에이전트가 거부 목록에 없음

**디버그:**

```bash
tail -f ~/.openclaw/logs/gateway.log | grep broadcast
```

### 하나의 에이전트만 응답

**원인:** Peer ID 가 `bindings` 에는 있지만 `broadcast` 에는 없을 수 있습니다.

**수정:** 브로드캐스트 구성에 추가하거나 바인딩에서 제거합니다.

### 성능 문제

**많은 에이전트로 느린 경우:**

- 그룹당 에이전트 수 감소
- 더 가벼운 모델 사용 (opus 대신 sonnet)
- 샌드박스 시작 시간 확인

## 예제

### 예제 1: 코드 검토 팀

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": [
      "code-formatter",
      "security-scanner",
      "test-coverage",
      "docs-checker"
    ]
  },
  "agents": {
    "list": [
      {
        "id": "code-formatter",
        "workspace": "~/agents/formatter",
        "tools": { "allow": ["read", "write"] }
      },
      {
        "id": "security-scanner",
        "workspace": "~/agents/security",
        "tools": { "allow": ["read", "exec"] }
      },
      {
        "id": "test-coverage",
        "workspace": "~/agents/testing",
        "tools": { "allow": ["read", "exec"] }
      },
      { "id": "docs-checker", "workspace": "~/agents/docs", "tools": { "allow": ["read"] } }
    ]
  }
}
```

**사용자가 전송:** 코드 스니펫
**응답:**

- code-formatter: "들여쓰기 고정 및 타입 힌트 추가"
- security-scanner: "⚠️ 12 줄의 SQL injection 취약점"
- test-coverage: "적용 범위는 45%, 오류 케이스에 대한 테스트 누락"
- docs-checker: "`process_data` 함수에 대한 docstring 누락"

### 예제 2: 다국어 지원

```json
{
  "broadcast": {
    "strategy": "sequential",
    "+15555550123": ["detect-language", "translator-en", "translator-de"]
  },
  "agents": {
    "list": [
      { "id": "detect-language", "workspace": "~/agents/lang-detect" },
      { "id": "translator-en", "workspace": "~/agents/translate-en" },
      { "id": "translator-de", "workspace": "~/agents/translate-de" }
    ]
  }
}
```

## API 참조

### 구성 스키마

```typescript
interface OpenClawConfig {
  broadcast?: {
    strategy?: "parallel" | "sequential";
    [peerId: string]: string[];
  };
}
```

### 필드

- `strategy` (선택 사항): 에이전트 처리 방법
  - `"parallel"` (기본): 모든 에이전트가 동시에 처리
  - `"sequential"`: 에이전트는 배열 순서대로 처리
- `[peerId]`: WhatsApp 그룹 JID, E.164 번호 또는 기타 peer ID
  - 값: 메시지를 처리해야 하는 에이전트 ID 배열

## 제한사항

1. **최대 에이전트:** 하드 제한 없음, 하지만 10+ 에이전트는 느릴 수 있음
2. **공유 컨텍스트:** 에이전트는 서로의 응답을 보지 못함 (설계상)
3. **메시지 순서:** 병렬 응답은 어떤 순서로든 도착할 수 있음
4. **속도 제한:** 모든 에이전트는 WhatsApp 속도 제한으로 계산됨

## 향후 개선 사항

계획된 기능:

- [ ] 공유 컨텍스트 모드 (에이전트가 서로의 응답을 봄)
- [ ] 에이전트 조정 (에이전트가 서로 신호를 보낼 수 있음)
- [ ] 동적 에이전트 선택 (메시지 콘텐츠에 따라 에이전트 선택)
- [ ] 에이전트 우선순위 (일부 에이전트가 다른 에이전트 전에 응답)

## 참고

- [다중 에이전트 구성](/tools/multi-agent-sandbox-tools)
- [라우팅 구성](/channels/channel-routing)
- [세션 관리](/concepts/sessions)
