---
title: Lobster
summary: "OpenClaw를 위한 형식화된 워크플로 런타임으로 재개 가능한 승인 게이트를 제공합니다."
description: OpenClaw를 위한 형식화된 워크플로 런타임 — 승인 게이트가 있는 컴포저블 파이프라인.
read_when:
  - 명시적인 승인과 함께 결정론적 다단계 워크플로를 원할 때
  - 이전 단계를 다시 실행하지 않고 워크플로를 재개해야 할 때
---

# Lobster

Lobster는 OpenClaw가 명시적인 승인 체크포인트와 함께 여러 단계의 도구 시퀀스를 하나의 결정론적 작업으로 실행할 수 있게 하는 워크플로 셸입니다.

## Hook

귀하의 비서가 스스로 관리하는 도구를 구축할 수 있습니다. 워크플로를 요청하면 30분 후에 하나의 호출로 실행되는 CLI와 파이프라인을 갖게 됩니다. Lobster는 결여된 부분으로, 결정론적 파이프라인, 명시적 승인, 재개 가능한 상태를 제공합니다.

## Why

오늘날의 복잡한 워크플로는 도구 호출을 여러 번 반복해야 합니다. 각 호출은 토큰 비용이 들며, LLM이 모든 단계를 조율해야 합니다. Lobster는 그 조율을 형식화된 런타임으로 옮깁니다:

- **여러 번의 호출 대신 한 번의 호출**: OpenClaw는 하나의 Lobster 도구 호출을 실행하여 구조화된 결과를 받습니다.
- **내장된 승인**: 부작용(이메일 전송, 댓글 게시)은 명시적으로 승인될 때까지 워크플로를 중단합니다.
- **재개 가능**: 중단된 워크플로는 토큰을 반환하며, 모든 것을 다시 실행하지 않고 승인하고 재개할 수 있습니다.

## Why a DSL instead of plain programs?

Lobster는 의도적으로 작게 설계되었습니다. 목표는 "새로운 언어"가 아닌, 1급 승인과 재개 토큰이 포함된 예측 가능한 AI 친화적인 파이프라인 사양입니다.

- **승인/재개는 내장됨**: 일반 프로그램도 인간에게 프롬프트를 줄 수는 있지만, 내구성 있는 토큰으로 *중지 및 재개*할 수는 없습니다. 이를 위해선 스스로 런타임을 발명해야 합니다.
- **결정론 및 감사 가능성**: 파이프라인은 데이터이므로 기록, 차이 비교, 재실행 및 검토가 용이합니다.
- **AI를 위한 제약된 표면**: 작은 문법 + JSON 파이핑으로 "창의적인" 코드 경로를 줄이고 검증을 현실적으로 만듭니다.
- **내장된 안전 정책**: 타임아웃, 출력 한도, 샌드박스 검사 및 허용 목록이 각 스크립트가 아닌 런타임에 의해 강제됩니다.
- **여전히 프로그래밍 가능**: 각 단계는 모든 CLI나 스크립트를 호출할 수 있습니다. JS/TS가 필요하다면 코드에서 `.lobster` 파일을 생성하세요.

## How it works

OpenClaw는 로컬 `lobster` CLI를 **도구 모드**로 실행하며 표준 출력에서 JSON 봉투를 파싱합니다.
파이프라인이 승인을 위해 중단되면, 도구는 `resumeToken`을 반환하여 나중에 계속할 수 있게 해줍니다.

## Pattern: small CLI + JSON pipes + approvals

JSON을 말하는 작은 명령어를 구축하고 이를 하나의 Lobster 호출로 연결합니다. (예시 명령어 이름은 아래와 같으며, 본인의 것으로 교체하세요.)

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt '변경사항 적용하시겠습니까?'",
  "timeoutMs": 30000
}
```

파이프라인이 승인을 요청하면, 토큰으로 재개합니다.

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI는 워크플로를 트리거하고, Lobster는 단계를 실행합니다. 승인 게이트는 부작용을 명시적이고 감사 가능하게 유지합니다.

예시: 입력 항목을 도구 호출로 매핑합니다:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## JSON-only LLM steps (llm-task)

**구조화된 LLM 단계**가 필요한 워크플로의 경우, 선택적인
`llm-task` 플러그인 도구를 활성화하고 Lobster에서 호출하십시오. 이렇게 하면 워크플로가 결정론적이면서도 모델을 사용하여 분류/요약/초안을 작성할 수 있습니다.

도구를 활성화하십시오:

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

파이프라인에서 사용하십시오:

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "입력된 이메일을 입력 받아 의도와 초안을 반환하십시오.",
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

자세한 내용과 구성 옵션은 [LLM Task](/ko-KR/tools/llm-task) 참조하십시오.

## Workflow files (.lobster)

Lobster는 `name`, `args`, `steps`, `env`, `condition`, 및 `approval` 필드가 있는 YAML/JSON 워크플로 파일을 실행할 수 있습니다. OpenClaw 도구 호출에서 `pipeline`을 파일 경로로 설정하십시오.

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

설명:

- `stdin: $step.stdout` 및 `stdin: $step.json`은 이전 단계의 출력을 전달합니다.
- `condition` (또는 `when`)은 `$step.approved`의 조건에 따라 단계를 제어할 수 있습니다.

## Install Lobster

OpenClaw 게이트웨이를 실행하는 **동일한 호스트**에 Lobster CLI를 설치하고 (`lobster`가 `PATH`에 있는지 확인하십시오), [Lobster 저장소](https://github.com/openclaw/lobster)를 참조하십시오.

## Enable the tool

Lobster는 **선택적** 플러그인 도구입니다 (기본적으로 활성화되지 않음).

추천 (부가적이며 안전함):

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

또는 에이전트별:

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

엄격한 허용 목록 모드에서 실행할 계획이 아니라면 `tools.allow: ["lobster"]` 사용을 피하십시오.

참고: 허용 목록은 선택적 플러그인을 위해 옵트인 방식입니다. 허용 목록이 플러그인 도구 (예: `lobster`)만 포함되어 있다면, OpenClaw는 기본 도구를 활성화합니다. 기본 도구를 제한하려면 허용 목록에 포함하고 싶은 기본 도구나 그룹을 추가로 포함하십시오.

## Example: Email triage

Lobster가 없을 때:

```
User: "내 이메일을 확인하고 회신 초안을 작성해줘"
→ openclaw가 gmail.list를 호출
→ LLM이 요약
→ User: "2번과 5번에 회신 초안을 작성해줘"
→ LLM이 초안 작성
→ User: "2번을 보내줘"
→ openclaw가 gmail.send 호출
(매일 반복, triage의 기억 없음)
```

Lobster를 사용할 때:

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

다음과 같은 JSON 봉투를 반환 (짧게 표시):

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5개는 회신이 필요하고, 2개는 조치가 필요합니다." }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "두 개의 드래프트 회신을 보내시겠습니까?",
    "items": [],
    "resumeToken": "..."
  }
}
```

사용자가 승인 → 재개:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

하나의 워크플로. 결정론적. 안전함.

## Tool parameters

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

args를 사용하여 워크플로 파일 실행:

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

승인 후 중단된 워크플로 계속:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### Optional inputs

- `cwd`: 파이프라인의 상대 작업 디렉터리 (현재 프로세스 작업 디렉터리 내에 있어야 함).
- `timeoutMs`: 하위 프로세스가 이 기간을 초과하면 종료 (기본값: 20000).
- `maxStdoutBytes`: 표준 출력이 이 크기를 초과하면 하위 프로세스를 종료 (기본값: 512000).
- `argsJson`: `lobster run --args-json`에 전달되는 JSON 문자열 (워크플로 파일 전용).

## Output envelope

Lobster는 세 가지 상태 중 하나로 JSON 봉투를 반환합니다:

- `ok` → 성공적으로 완료됨
- `needs_approval` → 일시 중단됨; `requiresApproval.resumeToken`이 재개에 필요
- `cancelled` → 명시적으로 거부 또는 취소됨

도구는 봉투를 `content` (예쁘게 포맷된 JSON)와 `details` (원시 객체)로 모두 표시합니다.

## Approvals

`requiresApproval`이 있는 경우, 프롬프트를 점검하고 결정하십시오:

- `approve: true` → 부작용을 계속하고 재개
- `approve: false` → 워크플로를 취소하고 완료

`approve --preview-from-stdin --limit N`을 사용하여 승인 요청에 사용자 정의 jq/heredoc 연결 없이 JSON 미리보기를 첨부하십시오. 재개 토큰은 이제 더 간결하게 되어 있습니다: Lobster는 워크플로 재개 상태를 자신의 상태 디렉터리에 저장하고 작은 토큰 키를 반환합니다.

## OpenProse

OpenProse는 Lobster와 잘 어울립니다: `/prose`를 사용하여 다중 에이전트 준비를 조율한 다음, 결정론적 승인을 위한 Lobster 파이프라인을 실행하세요. Prose 프로그램이 Lobster를 필요로 한다면, `tools.subagents.tools`를 통해 하위 에이전트에 대해 `lobster` 도구를 허용하세요. 자세한 내용은 [OpenProse](/ko-KR/prose)를 참조하십시오.

## Safety

- **로컬 하위 프로세스만** — 플러그인 자체에서 네트워크 호출 없음.
- **비밀 없음** — Lobster는 OAuth를 관리하지 않습니다; OpenClaw 도구를 호출합니다.
- **샌드박스 인식** — 도구 컨텍스트가 샌드박스 격리되었을 때 비활성화됩니다.
- **강화됨** — 고정된 실행 파일 이름(`lobster`)을 `PATH`에서 사용; 타임아웃과 출력 한도가 강제됩니다.

## Troubleshooting

- **`lobster 하위 프로세스 시간 초과`** → `timeoutMs`를 늘리거나 긴 파이프라인을 분할하십시오.
- **`lobster 출력이 maxStdoutBytes를 초과했습니다`** → `maxStdoutBytes`를 늘리거나 출력 크기를 줄이십시오.
- **`lobster가 잘못된 JSON을 반환했습니다`** → 파이프라인이 도구 모드에서 실행되고 JSON만 출력하는지 확인하십시오.
- **`lobster 실패 (코드 …)`** → 동일한 파이프라인을 터미널에서 실행하여 stderr를 점검하십시오.

## Learn more

- [플러그인](/ko-KR/tools/plugin)
- [플러그인 도구 제작](/ko-KR/plugins/agent-tools)

## Case study: community workflows

한 가지 공공 예시: 암기, 파트너 및 공유의 세 개의 Markdown 금고를 관리하는 "두 번째 뇌" CLI + Lobster 파이프라인. CLI는 통계, 받은 편지함 목록 및 오래된 스캔에 대한 JSON을 내보내며, Lobster는 이러한 명령을 `weekly-review`, `inbox-triage`, `memory-consolidation`, 및 `shared-task-sync`와 같은 워크플로로 연결하며 각 단계에 승인 게이트가 있습니다. AI는 판단(분류)을 처리하고 가능할 때 그것을 사용하며 그렇지 않을 때는 결정론적 규칙에 따라 작동합니다.

- 스레드: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- 저장소: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
