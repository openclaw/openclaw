---
title: Lobster
summary: "OpenClaw용 타입화된 워크플로우 런타임 (승인 게이트 포함)"
description: "OpenClaw용 타입화된 워크플로우 런타임 - 승인 게이트가 있는 구성 가능한 파이프라인"
read_when:
  - "명시적 승인이 있는 결정론적 다단계 워크플로우를 원할 때"
  - "이전 단계를 다시 실행하지 않고 워크플로우를 재개해야 할 때"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/tools/lobster.md
  workflow: 15
---

# Lobster

Lobster는 명시적 승인 체크포인트가 있는 단일의 결정론적 작업으로 OpenClaw가 다단계 도구 시퀀스를 실행할 수 있게 하는 워크플로우 셸입니다.

## 훅

당신의 어시스턴트는 자신을 관리하는 도구를 구축할 수 있습니다. 워크플로우를 요청하면 30분 후에 CLI와 파이프라인이 있습니다. Lobster는 누락된 조각입니다: 결정론적 파이프라인, 명시적 승인, 및 재개 가능한 상태입니다.

## 왜 인가

현재, 복잡한 워크플로우는 많은 왕복 도구 호출이 필요합니다. 각 호출은 토큰이 소모되고, LLM이 모든 단계를 조율해야 합니다. Lobster는 해당 조율을 타입화된 런타임으로 이동합니다:

- **한 번의 호출 대신 많은 호출**: OpenClaw는 하나의 Lobster 도구 호출을 실행하고 구조화된 결과를 얻습니다.
- **승인이 내장됨**: 부작용 (이메일 전송, 댓글 게시)은 명시적으로 승인될 때까지 워크플로우를 중지합니다.
- **재개 가능**: 중지된 워크플로우는 토큰을 반환합니다. 승인 및 재개 (모든 것을 다시 실행하지 않고).

## DSL 대신 일반 프로그램이 아닌 이유

Lobster는 의도적으로 작습니다. 목표는 "새로운 언어"가 아니라 예측 가능하고, AI 친화적인 파이프라인 스펙이며 첫 번째 클래스 승인 및 재개 토큰입니다.

- **승인/재개가 내장됨**: 일반 프로그램은 사람에게 프롬프트할 수 있지만, 지속 가능한 토큰 없이 _일시 중지하고 재개할_ 수 없습니다 (당신이 그 런타임을 직접 발명하지 않으면).
- **결정론성 + 감시성**: 파이프라인은 데이터이므로 로깅, diffing, 재생 및 검토가 쉽습니다.
- **AI를 위한 제한된 표면**: 작은 문법 + JSON 파이핑은 "창의적인" 코드 경로를 줄이고 검증을 현실적으로 만듭니다.
- **안전 정책이 내장됨**: 타임아웃, 출력 한계, 샌드박스 체크 및 allowlist는 각 스크립트가 아닌 런타임으로 강제됩니다.
- **여전히 프로그래밍 가능**: 각 단계는 CLI 또는 스크립트를 호출할 수 있습니다. JS/TS를 원하면 코드에서 `.lobster` 파일을 생성합니다.

## 어떻게 작동하는가

OpenClaw는 로컬 `lobster` CLI를 **도구 모드**에서 시작하고 stdout에서 JSON 봉투를 구문 분석합니다.
파이프라인이 승인을 위해 일시 중지되면, 도구는 나중에 계속할 수 있는 `resumeToken`을 반환합니다.

## 패턴: 작은 CLI + JSON 파이프 + 승인

작은 JSON을 말하는 명령을 구축한 다음 하나의 Lobster 호출로 체이닝합니다 (아래 예제 명령 이름 - 당신의 것으로 교환).

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

파이프라인이 승인을 요청하면 토큰으로 재개합니다:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI가 워크플로우를 트리거합니다. Lobster가 단계를 실행합니다. 승인 게이트는 부작용을 명시적이고 감시 가능하게 유지합니다.

예: 입력 항목을 도구 호출로 매핑합니다:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## JSON 전용 LLM 단계 (llm-task)

**구조화된 LLM 단계**가 필요한 워크플로우의 경우 선택적
`llm-task` 플러그인 도구를 활성화하고 Lobster에서 호출합니다. 이것은 워크플로우를 결정론적으로 유지하면서 모델로 분류/요약/초안을 허용합니다.

도구 활성화:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

파이프라인에서 사용:

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "주어진 입력 이메일이 있으면 의도와 초안을 반환합니다.",
  "input": { "subject": "Hello", "body": "도와줄 수 있나요?" },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

세부 사항 및 구성 옵션은 [LLM Task](/tools/llm-task)를 참조하세요.

## 워크플로우 파일 (.lobster)

Lobster는 `name`, `args`, `steps`, `env`, `condition`, 및 `approval` 필드가 있는 YAML/JSON 워크플로우 파일을 실행할 수 있습니다. OpenClaw 도구 호출에서 `pipeline`을 파일 경로로 설정합니다.

```yaml
name: inbox-triage
args:
  tag:
    default: "family"
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

메모:

- `stdin: $step.stdout` 및 `stdin: $step.json`은 이전 단계의 출력을 전달합니다.
- `condition` (또는 `when`)은 `$step.approved`에 단계를 게이트할 수 있습니다.

## Lobster 설치

OpenClaw Gateway가 실행되는 **같은 호스트**에서 Lobster CLI를 설치합니다 ([Lobster repo](https://github.com/openclaw/lobster) 참조) 및 `lobster`가 `PATH`에 있는지 확인합니다.

## 도구 활성화

Lobster는 **선택적** 플러그인 도구입니다 (기본적으로 활성화되지 않음).

권장 (추가, 안전):

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

또는 에이전트당:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    ]
  }
}
```

제한적 allowlist 모드에서 실행하려는 의도가 있지 않으면 `tools.allow: ["lobster"]`를 사용하지 마세요.

참고: allowlist는 선택적 플러그인에 대해 선택적입니다. allowlist가 플러그인 도구만 명시하면 (예: `lobster`),
OpenClaw는 핵심 도구를 활성화 상태로 유지합니다. 핵심 도구를 제한하려면 allowlist에도 핵심 도구나 그룹을 포함합니다.

## 예: 이메일 분류

Lobster 없음:

```
사용자: "내 이메일을 확인하고 회신 초안"
→ openclaw gmail.list 호출
→ LLM 요약
→ 사용자: "#2 및 #5에 회신 초안"
→ LLM 회신 초안
→ 사용자: "#2 전송"
→ openclaw gmail.send 호출
(반복 일일, 분류된 것을 기억 안함)
```

Lobster 포함:

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

JSON 봉투 반환 (잘려짐):

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5는 회신이 필요, 2는 조치가 필요" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "2개 초안 회신 전송?",
    "items": [],
    "resumeToken": "..."
  }
}
```

사용자 승인 → 재개:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

한 워크플로우. 결정론적. 안전.

## 도구 파라미터

### `run`

도구 모드에서 파이프라인을 실행합니다.

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

인수가 있는 워크플로우 파일을 실행합니다:

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

승인 후 중지된 워크플로우를 계속합니다.

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### 선택적 입력

- `cwd`: 파이프라인의 상대 작업 디렉토리 (현재 프로세스 작업 디렉토리 내 유지).
- `timeoutMs`: 이 기간을 초과하면 부프로세스를 종료합니다 (기본값: 20000).
- `maxStdoutBytes`: stdout이 이 크기를 초과하면 부프로세스를 종료합니다 (기본값: 512000).
- `argsJson`: `lobster run --args-json`에 전달된 JSON 문자열 (워크플로우 파일만).

## 출력 봉투

Lobster는 세 가지 상태 중 하나를 가진 JSON 봉투를 반환합니다:

- `ok` → 성공적으로 완료
- `needs_approval` → 일시 중지; `requiresApproval.resumeToken`이 재개하는 데 필요함
- `cancelled` → 명시적으로 거부 또는 취소됨

도구는 봉투를 `content` (아름다운 JSON)와 `details` (원본 객체)에서 표시합니다.

## 승인

`requiresApproval`이 있으면 프롬프트를 검사하고 결정합니다:

- `approve: true` → 재개 및 부작용 계속
- `approve: false` → 취소 및 워크플로우 종료

`approve --preview-from-stdin --limit N`을 사용하여 커스텀 jq/heredoc 글루 없이 승인 요청에 JSON 미리보기를 첨부합니다. 재개 토큰은 이제 컴팩트합니다: Lobster는 워크플로우 재개 상태를 자신의 상태 디렉토리 아래에 저장하고 작은 토큰 키를 반환합니다.

## OpenProse

OpenProse는 Lobster와 잘 쌍을 이룹니다: `/prose`를 사용하여 다중 에이전트 준비를 조율한 다음 결정론적 승인을 위해 Lobster 파이프라인을 실행합니다. Prose 프로그램이 Lobster가 필요하면 `tools.subagents.tools`를 통해 부에이전트에 `lobster` 도구를 허용합니다. [OpenProse](/prose)를 참조하세요.

## 안전

- **로컬 부프로세스만** - 플러그인 자체에서 네트워크 호출 없음.
- **비밀 없음** - Lobster는 OAuth를 관리하지 않습니다. OpenClaw 도구를 호출합니다.
- **샌드박스 인식** - 도구 컨텍스트가 샌드박싱될 때 비활성화됨.
- **강화됨** - 고정된 실행 파일 이름 (`lobster`) on `PATH`; 타임아웃 및 출력 한계 강제.

## 문제 해결

- **`lobster subprocess timed out`** → `timeoutMs`를 높이거나 긴 파이프라인을 분할합니다.
- **`lobster output exceeded maxStdoutBytes`** → `maxStdoutBytes`를 올리거나 출력 크기를 줄입니다.
- **`lobster returned invalid JSON`** → 파이프라인이 도구 모드에서 실행되고 JSON만 출력하는지 확인합니다.
- **`lobster failed (code …)`** → 동일한 파이프라인을 터미널에서 실행하여 stderr를 검사합니다.

## 더 알아보기

- [플러그인](/tools/plugin)
- [플러그인 도구 작성](/plugins/agent-tools)

## 사례 연구: 커뮤니티 워크플로우

한 공개 예: 3개의 Markdown 볼트 (개인, 파트너, 공유)를 관리하는 "두 번째 뇌" CLI + Lobster 파이프라인. CLI는 통계, 받은편지함 목록 및 오래된 스캔용 JSON을 내보냅니다. Lobster는 해당 명령을 `weekly-review`, `inbox-triage`, `memory-consolidation`, 및 `shared-task-sync`와 같은 워크플로우로 체이닝합니다 (각각 승인 게이트 포함). AI는 사용 가능할 때 판단 (분류)을 처리하고 사용 가능하지 않을 때 결정론적 규칙으로 폴백합니다.

- 스레드: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repo: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
