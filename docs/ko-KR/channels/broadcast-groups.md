---
summary: "여러 에이전트에게 WhatsApp 메시지 브로드캐스트"
read_when:
  - 브로드캐스트 그룹을 구성하는 경우
  - WhatsApp 에서 다중 에이전트 응답을 디버깅하는 경우
status: experimental
title: "브로드캐스트 그룹"
x-i18n:
  source_path: docs/channels/broadcast-groups.md
---

# 브로드캐스트 그룹

**상태:** 실험적
**버전:** 2026.1.9 에 추가됨

## 개요

브로드캐스트 그룹을 사용하면 여러 에이전트가 동일한 메시지를 동시에 처리하고 응답할 수 있습니다. 이를 통해 단일 WhatsApp 그룹이나 DM 에서 하나의 전화번호를 사용하여 함께 작업하는 전문 에이전트 팀을 만들 수 있습니다.

현재 범위: **WhatsApp 만** (웹 채널).

브로드캐스트 그룹은 채널 허용 목록과 그룹 활성화 규칙 이후에 평가됩니다. WhatsApp 그룹에서 이는 OpenClaw 가 정상적으로 응답할 때 (예: 멘션 시, 그룹 설정에 따라) 브로드캐스트가 발생한다는 의미입니다.

## 사용 사례

### 1. 전문 에이전트 팀

원자적이고 집중된 책임을 가진 여러 에이전트를 배포합니다:

```
그룹: "Development Team"
에이전트:
  - CodeReviewer (코드 스니펫 검토)
  - DocumentationBot (문서 생성)
  - SecurityAuditor (취약점 검사)
  - TestGenerator (테스트 케이스 제안)
```

각 에이전트는 동일한 메시지를 처리하고 전문적인 관점을 제공합니다.

### 2. 다국어 지원

```
그룹: "International Support"
에이전트:
  - Agent_EN (영어로 응답)
  - Agent_DE (독일어로 응답)
  - Agent_ES (스페인어로 응답)
```

### 3. 품질 보증 워크플로

```
그룹: "Customer Support"
에이전트:
  - SupportAgent (답변 제공)
  - QAAgent (품질 검토, 문제가 있을 때만 응답)
```

### 4. 태스크 자동화

```
그룹: "Project Management"
에이전트:
  - TaskTracker (태스크 데이터베이스 업데이트)
  - TimeLogger (소요 시간 기록)
  - ReportGenerator (요약 생성)
```

## 구성

### 기본 설정

최상위 `broadcast` 섹션을 추가합니다 (`bindings` 옆에). 키는 WhatsApp 피어 ID 입니다:

- 그룹 채팅: 그룹 JID (예: `120363403215116621@g.us`)
- DM: E.164 전화번호 (예: `+15551234567`)

```json
{
  "broadcast": {
    "120363403215116621@g.us": ["alfred", "baerbel", "assistant3"]
  }
}
```

**결과:** OpenClaw 가 이 채팅에서 응답할 때 세 에이전트 모두 실행됩니다.

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

에이전트가 순서대로 처리합니다 (이전 에이전트가 완료될 때까지 대기):

```json
{
  "broadcast": {
    "strategy": "sequential",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

### 전체 예시

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

1. **수신 메시지**가 WhatsApp 그룹에 도착합니다
2. **브로드캐스트 확인**: 시스템이 피어 ID 가 `broadcast` 에 있는지 확인합니다
3. **브로드캐스트 목록에 있는 경우**:
   - 나열된 모든 에이전트가 메시지를 처리합니다
   - 각 에이전트는 자체 세션 키와 격리된 컨텍스트를 가집니다
   - 에이전트는 병렬 (기본값) 또는 순차적으로 처리합니다
4. **브로드캐스트 목록에 없는 경우**:
   - 정상 라우팅이 적용됩니다 (첫 번째 일치하는 바인딩)

참고: 브로드캐스트 그룹은 채널 허용 목록이나 그룹 활성화 규칙 (멘션/명령 등) 을 우회하지 않습니다. 메시지가 처리 대상일 때 _어떤 에이전트가 실행되는지_ 만 변경합니다.

### 세션 격리

브로드캐스트 그룹의 각 에이전트는 완전히 별도의 다음을 유지합니다:

- **세션 키** (`agent:alfred:whatsapp:group:120363...` vs `agent:baerbel:whatsapp:group:120363...`)
- **대화 기록** (에이전트는 다른 에이전트의 메시지를 보지 않음)
- **워크스페이스** (구성된 경우 별도의 샌드박스)
- **도구 접근** (다른 allow/deny 목록)
- **메모리/컨텍스트** (별도의 IDENTITY.md, SOUL.md 등)
- **그룹 컨텍스트 버퍼** (컨텍스트로 사용되는 최근 그룹 메시지) 는 피어별로 공유되므로 모든 브로드캐스트 에이전트가 트리거될 때 동일한 컨텍스트를 봅니다

이를 통해 각 에이전트가 다음을 가질 수 있습니다:

- 다른 성격
- 다른 도구 접근 (예: 읽기 전용 vs. 읽기-쓰기)
- 다른 모델 (예: opus vs. sonnet)
- 다른 Skills 설치

### 예시: 격리된 세션

그룹 `120363403215116621@g.us` 에 에이전트 `["alfred", "baerbel"]`:

**Alfred 의 컨텍스트:**

```
Session: agent:alfred:whatsapp:group:120363403215116621@g.us
History: [사용자 메시지, alfred 의 이전 응답]
Workspace: /Users/pascal/openclaw-alfred/
Tools: read, write, exec
```

**Baerbel 의 컨텍스트:**

```
Session: agent:baerbel:whatsapp:group:120363403215116621@g.us
History: [사용자 메시지, baerbel 의 이전 응답]
Workspace: /Users/pascal/openclaw-baerbel/
Tools: read only
```

## 모범 사례

### 1. 에이전트를 집중적으로 유지

각 에이전트를 단일하고 명확한 책임으로 설계합니다.

### 2. 설명적인 이름 사용

각 에이전트가 무엇을 하는지 명확하게 합니다.

### 3. 다른 도구 접근 구성

에이전트에게 필요한 도구만 제공합니다.

### 4. 성능 모니터링

많은 에이전트가 있는 경우 고려 사항:

- 속도를 위해 `"strategy": "parallel"` (기본값) 사용
- 브로드캐스트 그룹당 5-10 개 에이전트로 제한
- 간단한 에이전트에는 더 빠른 모델 사용

### 5. 실패를 우아하게 처리

에이전트는 독립적으로 실패합니다. 한 에이전트의 오류가 다른 에이전트를 차단하지 않습니다.

## 호환성

### 프로바이더

브로드캐스트 그룹은 현재 다음에서 작동합니다:

- WhatsApp (구현됨)
- Telegram (계획됨)
- Discord (계획됨)
- Slack (계획됨)

### 라우팅

브로드캐스트 그룹은 기존 라우팅과 함께 작동합니다.

**우선순위:** `broadcast` 가 `bindings` 보다 우선합니다.

## 문제 해결

### 에이전트가 응답하지 않음

**점검:**

1. 에이전트 ID 가 `agents.list` 에 존재
2. 피어 ID 형식이 올바름 (예: `120363403215116621@g.us`)
3. 에이전트가 거부 목록에 없음

### 하나의 에이전트만 응답

**원인:** 피어 ID 가 `bindings` 에는 있지만 `broadcast` 에는 없을 수 있습니다.

**수정:** 브로드캐스트 구성에 추가하거나 바인딩에서 제거합니다.

### 성능 문제

**많은 에이전트로 느린 경우:**

- 그룹당 에이전트 수 줄이기
- 더 가벼운 모델 사용 (opus 대신 sonnet)
- 샌드박스 시작 시간 확인

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

- `strategy` (선택): 에이전트 처리 방식
  - `"parallel"` (기본값): 모든 에이전트가 동시에 처리
  - `"sequential"`: 에이전트가 배열 순서로 처리
- `[peerId]`: WhatsApp 그룹 JID, E.164 번호, 또는 기타 피어 ID
  - 값: 메시지를 처리해야 하는 에이전트 ID 배열

## 제한 사항

1. **최대 에이전트:** 하드 제한 없음, 그러나 10 개 이상은 느릴 수 있음
2. **공유 컨텍스트:** 에이전트는 서로의 응답을 보지 않음 (의도적 설계)
3. **메시지 순서:** 병렬 응답은 어떤 순서로든 도착할 수 있음
4. **속도 제한:** 모든 에이전트가 WhatsApp 속도 제한에 포함

## 향후 개선

계획된 기능:

- [ ] 공유 컨텍스트 모드 (에이전트가 서로의 응답을 볼 수 있음)
- [ ] 에이전트 조정 (에이전트가 서로 신호를 보낼 수 있음)
- [ ] 동적 에이전트 선택 (메시지 내용에 따라 에이전트 선택)
- [ ] 에이전트 우선순위 (일부 에이전트가 다른 에이전트보다 먼저 응답)

## 참조

- [Multi-Agent Configuration](/tools/multi-agent-sandbox-tools)
- [Routing Configuration](/channels/channel-routing)
- [Session Management](/concepts/session)
