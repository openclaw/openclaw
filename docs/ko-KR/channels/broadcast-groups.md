---
summary: "여러 에이전트에게 WhatsApp 메시지 방송"
read_when:
  - 방송 그룹 구성
  - WhatsApp에서 다중 에이전트 응답 디버깅
status: 실험적
title: "방송 그룹"
---

# 방송 그룹

**상태:** 실험적  
**버전:** 2026.1.9에 추가됨

## 개요

방송 그룹은 여러 에이전트가 동일한 메시지를 동시에 처리하고 응답할 수 있게 합니다. 이를 통해 하나의 전화번호를 사용하여 WhatsApp 그룹 또는 다이렉트 메시지에서 함께 작업하는 전문 에이전트 팀을 구성할 수 있습니다.

현재 범위: **WhatsApp 전용** (웹 채널).

방송 그룹은 채널 허용 목록과 그룹 활성화 규칙 후에 평가됩니다. WhatsApp 그룹에서는 OpenClaw가 보통 응답할 때 방송이 발생합니다 (예: 그룹 설정에 따라 멘션 시).

## 사용 사례

### 1. 전문 에이전트 팀

원자적이고 집중된 책임을 지닌 여러 에이전트를 배포합니다:

```
그룹: "개발 팀"
에이전트:
  - CodeReviewer (코드 스니펫 리뷰)
  - DocumentationBot (문서 생성)
  - SecurityAuditor (취약점 점검)
  - TestGenerator (테스트 케이스 제안)
```

각 에이전트는 동일한 메시지를 처리하고 그에 대한 전문적인 시각을 제공합니다.

### 2. 다중 언어 지원

```
그룹: "국제 지원"
에이전트:
  - Agent_EN (영어로 응답)
  - Agent_DE (독일어로 응답)
  - Agent_ES (스페인어로 응답)
```

### 3. 품질 보증 워크플로

```
그룹: "고객 지원"
에이전트:
  - SupportAgent (답변 제공)
  - QAAgent (품질 리뷰, 문제 발견 시에만 응답)
```

### 4. 작업 자동화

```
그룹: "프로젝트 관리"
에이전트:
  - TaskTracker (작업 데이터베이스 업데이트)
  - TimeLogger (소요 시간 기록)
  - ReportGenerator (요약 보고서 생성)
```

## 구성

### 기본 설정

상위 수준에 `broadcast` 섹션을 추가하세요 (`bindings` 옆에). 키는 WhatsApp 피어 ID입니다:

- 그룹 채팅: 그룹 JID (예: `120363403215116621@g.us`)
- 다이렉트 메시지: E.164 전화번호 (예: `+15551234567`)

```json
{
  "broadcast": {
    "120363403215116621@g.us": ["alfred", "baerbel", "assistant3"]
  }
}
```

**결과:** 이 채팅에서 OpenClaw가 응답할 때, 세 에이전트 모두가 실행됩니다.

### 처리 전략

에이전트가 메시지를 처리하는 방식을 제어합니다:

#### 병렬 (기본값)

모든 에이전트가 동시에 처리합니다:

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

#### 순차적

에이전트가 순서대로 처리합니다 (이전이 완료될 때까지 대기):

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

1. **들어오는 메시지**가 WhatsApp 그룹에 도착합니다.
2. **방송 확인**: 시스템이 피어 ID가 `broadcast`에 있는지 확인합니다.
3. **방송 목록에 있을 경우**:
   - 나열된 모든 에이전트가 메시지를 처리합니다.
   - 각 에이전트는 자기만의 세션 키와 독립된 컨텍스트를 가집니다.
   - 에이전트는 기본값으로 병렬 또는 순차적으로 처리합니다.
4. **방송 목록에 없을 경우**:
   - 일반적인 라우팅이 적용됩니다 (첫 번째 일치하는 바인딩).

참고: 방송 그룹은 채널 허용 목록이나 그룹 활성화 규칙(멘션/명령어/기타)을 우회하지 않습니다. 단지 메시지가 처리될 때 _어떤 에이전트가 실행되는지_ 변경합니다.

### 세션 격리

방송 그룹의 각 에이전트는 완전히 별도로 유지됩니다:

- **세션 키** (`agent:alfred:whatsapp:group:120363...` vs `agent:baerbel:whatsapp:group:120363...`)
- **대화 기록** (에이전트는 다른 에이전트의 메시지를 보지 않음)
- **작업 공간** (구성된 경우 별도의 샌드박스)
- **도구 접근** (다른 허용/거부 목록)
- **메모리/컨텍스트** (별도의 IDENTITY.md, SOUL.md 등)
- **그룹 컨텍스트 버퍼** (컨텍스트에 사용되는 최근 그룹 메시지)는 피어별로 공유됨, 따라서 모든 방송 에이전트는 트리거될 때 동일한 컨텍스트를 봅니다.

이는 각 에이전트가 다음을 보장합니다:

- 다른 인격
- 다른 도구 접근 (예: 읽기 전용 vs. 읽기-쓰기)
- 다른 모델 (예: opus vs. sonnet)
- 다른 스킬 설치됨

### 예제: 격리된 세션

에이전트 `["alfred", "baerbel"]`이 있는 그룹 `120363403215116621@g.us`:

**Alfred의 컨텍스트:**

```
세션: agent:alfred:whatsapp:group:120363403215116621@g.us
역사: [사용자 메시지, alfred의 이전 응답]
작업 공간: /Users/pascal/openclaw-alfred/
도구: 읽기, 쓰기, 실행
```

**Bärbel의 컨텍스트:**

```
세션: agent:baerbel:whatsapp:group:120363403215116621@g.us
역사: [사용자 메시지, baerbel의 이전 응답]
작업 공간: /Users/pascal/openclaw-baerbel/
도구: 읽기 전용
```

## 모범 사례

### 1. 에이전트에 초점을 둡세요

각 에이전트를 단일 및 명확한 책임으로 설계하세요:

```json
{
  "broadcast": {
    "DEV_GROUP": ["formatter", "linter", "tester"]
  }
}
```

✅ **좋음:** 각 에이전트는 하나의 작업을 가집니다  
❌ **나쁨:** 한 명의 일반적인 "dev-helper" 에이전트

### 2. 설명적인 이름을 사용하세요

각 에이전트가 하는 일을 명확하게 하세요:

```json
{
  "agents": {
    "security-scanner": { "name": "Security Scanner" },
    "code-formatter": { "name": "Code Formatter" },
    "test-generator": { "name": "Test Generator" }
  }
}
```

### 3. 다른 도구 접근 설정하기

에이전트에게 필요한 도구만 제공하세요:

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

많은 에이전트가 있을 경우 다음을 고려하세요:

- 속도를 위해 `"strategy": "parallel"` (기본값)을 사용
- 방송 그룹을 5-10 에이전트로 제한
- 간단한 에이전트에 빠른 모델을 사용

### 5. 오류를 유연하게 처리

에이전트는 독립적으로 실패합니다. 한 에이전트의 오류가 다른 에이전트를 막지는 않습니다:

```
메시지 → [에이전트 A ✓, 에이전트 B ✗ 오류, 에이전트 C ✓]
결과: 에이전트 A와 C가 응답하고, 에이전트 B는 오류 기록
```

## 호환성

### 프로바이더

방송 그룹은 현재 다음과 함께 작동합니다:

- ✅ WhatsApp (구현됨)
- 🚧 Telegram (계획 중)
- 🚧 Discord (계획 중)
- 🚧 Slack (계획 중)

### 라우팅

방송 그룹은 기존 라우팅과 함께 작동합니다:

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

- `GROUP_A`: Alfred만 응답 (일반 라우팅)
- `GROUP_B`: agent1과 agent2가 응답 (방송)

**우선순위:** `broadcast`가 `bindings`보다 우선합니다.

## 문제 해결

### 에이전트가 응답하지 않음

**확인하세요:**

1. 에이전트 ID가 `agents.list`에 존재하는지 확인
2. 피어 ID 형식이 올바른지 확인 (예: `120363403215116621@g.us`)
3. 에이전트가 거부 목록에 없는지 확인

**디버그:**

```bash
tail -f ~/.openclaw/logs/gateway.log | grep broadcast
```

### 하나의 에이전트만 응답

**원인:** 피어 ID가 `bindings`에는 있지만 `broadcast`에는 없을 수 있습니다.

**수정:** 방송 설정에 추가하거나 바인딩에서 제거하세요.

### 성능 문제

**많은 에이전트와 함께 실행이 느립니다:**

- 그룹당 에이전트 수를 줄입니다.
- 가벼운 모델 사용 (sonnet 대신 opus)
- 샌드박스 시작 시간을 확인합니다.

## 예제

### 예제 1: 코드 리뷰 팀

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

**사용자 전송:** 코드 스니펫  
**응답:**

- code-formatter: "들여쓰기 수정 및 타입 힌트 추가"
- security-scanner: "⚠️ SQL 인젝션 취약성이 12번째 줄에 있습니다"
- test-coverage: "커버리지는 45%입니다. 오류 사례에 대한 테스트가 누락되었습니다"
- docs-checker: "`process_data` 함수에 대한 도크스트링이 누락되었습니다"

### 예제 2: 다중 언어 지원

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

- `strategy` (선택 사항): 에이전트를 처리하는 방법
  - `"parallel"` (기본값): 모든 에이전트가 동시에 처리합니다.
  - `"sequential"`: 에이전트가 배열 순서대로 처리합니다.
- `[peerId]`: WhatsApp 그룹 JID, E.164 번호 또는 다른 피어 ID
  - 값: 메시지를 처리할 에이전트 ID 배열

## 제한 사항

1. **최대 에이전트:** 하드 제한은 없으나, 10개 이상의 에이전트는 느릴 수 있습니다.
2. **공유된 컨텍스트:** 에이전트는 다른 에이전트의 응답을 보지 않습니다 (설계된 대로).
3. **메시지 순서:** 병렬 응답은 어떤 순서로든 도착할 수 있습니다.
4. **속도 제한:** 모든 에이전트가 WhatsApp 속도 제한에 포함됩니다.

## 향후 개선 사항

계획된 기능:

- [ ] 공유 컨텍스트 모드 (다른 에이전트의 응답을 봅니다)
- [ ] 에이전트 협력 (에이전트가 서로 신호를 보낼 수 있음)
- [ ] 동적 에이전트 선택 (메시지 내용에 따라 에이전트 선택)
- [ ] 에이전트 우선순위 (일부 에이전트가 다른 에이전트보다 먼저 응답)

## 추가 정보

- [다중 에이전트 구성](/ko-KR/tools/multi-agent-sandbox-tools)
- [라우팅 구성](/ko-KR/channels/channel-routing)
- [세션 관리](/ko-KR/concepts/sessions)
