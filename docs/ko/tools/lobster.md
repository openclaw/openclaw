---
description: Typed workflow runtime for OpenClaw — composable pipelines with approval gates.
read_when:
    - 명시적인 승인이 포함된 결정적 다단계 워크플로가 필요합니다.
    - 이전 단계를 다시 실행하지 않고 워크플로를 재개해야 합니다.
summary: 재개 가능한 승인 게이트가 있는 OpenClaw용 형식화된 워크플로 런타임입니다.
title: 새우
x-i18n:
    generated_at: "2026-02-08T16:11:47Z"
    model: gtx
    provider: google-translate
    source_hash: e787b65558569e8a1a7237a2cd74da71c89d0c46af710e9b3229eb7d00fb055f
    source_path: tools/lobster.md
    workflow: 15
---

# 새우

Lobster는 OpenClaw가 명시적인 승인 체크포인트가 있는 단일 결정론적 작업으로 다단계 도구 시퀀스를 실행할 수 있게 해주는 워크플로 셸입니다.

## 훅

당신의 어시스턴트는 스스로 관리하는 도구를 만들 수 있습니다. 워크플로를 요청하면 30분 후에 한 번의 호출로 실행되는 CLI와 파이프라인이 생성됩니다. 랍스터는 결정론적 파이프라인, 명시적 승인, 재개 가능한 상태 등 누락된 부분입니다.

## 왜

오늘날 복잡한 워크플로우에는 도구 호출이 많이 필요합니다. 각 호출에는 토큰이 필요하며 LLM은 모든 단계를 조정해야 합니다. Lobster는 해당 오케스트레이션을 형식화된 런타임으로 이동합니다.

- **여러 통화 대신 한 번의 통화**: OpenClaw는 Lobster 도구 호출을 한 번 실행하고 구조화된 결과를 얻습니다.
- **내장된 승인**: 부작용(이메일 보내기, 댓글 게시)으로 인해 명시적으로 승인될 때까지 워크플로가 중단됩니다.
- **재개 가능**: 중단된 워크플로는 토큰을 반환합니다. 모든 것을 다시 실행하지 않고 승인하고 재개합니다.

## 일반 프로그램 대신 DSL을 사용하는 이유는 무엇입니까?

랍스터는 의도적으로 작습니다. 목표는 "새로운 언어"가 아니라, 일류 승인 및 이력서 토큰을 갖춘 예측 가능하고 AI 친화적인 파이프라인 사양입니다.

- **승인/재개 기능이 내장되어 있습니다.**: 일반적인 프로그램은 인간에게 메시지를 표시할 수 있지만 그렇게 할 수는 없습니다. _일시 정지 및 재개_ 해당 런타임을 직접 개발하지 않고도 내구성 있는 토큰을 사용할 수 있습니다.
- **결정성 + 감사 가능성**: 파이프라인은 데이터이므로 기록, 비교, 재생 및 검토가 쉽습니다.
- **AI를 위한 제한된 표면**: 작은 문법 + JSON 파이핑은 "창의적인" 코드 경로를 줄이고 검증을 현실적으로 만듭니다.
- **안전 정책이 내장되어 있습니다.**: 시간 초과, 출력 제한, 샌드박스 검사 및 허용 목록은 각 스크립트가 아닌 런타임에 의해 적용됩니다.
- **여전히 프로그래밍 가능**: 각 단계에서는 CLI나 스크립트를 호출할 수 있습니다. JS/TS를 원할 경우 생성 `.lobster` 코드에서 파일.

## 작동 원리

OpenClaw가 로컬 출시 `lobster` CLI의 **도구 모드** stdout에서 JSON 봉투를 구문 분석합니다.
파이프라인이 승인을 위해 일시 ​​중지되면 도구는 `resumeToken` 나중에 계속할 수 있습니다.

## 패턴: 소형 CLI + JSON 파이프 + 승인

JSON을 말하는 작은 명령을 작성한 다음 단일 Lobster 호출로 연결합니다. (아래 명령 이름의 예 - 직접 바꾸십시오.)

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

파이프라인이 승인을 요청하면 토큰을 사용하여 재개합니다.

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI가 워크플로를 트리거합니다. 랍스터가 단계를 실행합니다. 승인 게이트는 부작용을 명시적이고 감사 가능하게 유지합니다.

예: 입력 항목을 도구 호출에 매핑:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## JSON 전용 LLM 단계(llm-task)

필요한 워크플로의 경우 **구조화된 LLM 단계**, 선택 사항을 활성화합니다
`llm-task` 플러그인 도구를 사용하여 Lobster에서 호출하세요. 이렇게 하면 작업 흐름이 유지됩니다.
모델을 분류/요약/초안화하는 동시에 결정적입니다.

도구를 활성화합니다:

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

파이프라인에서 사용합니다.

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": { "subject": "Hello", "body": "Can you help?" },
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

보다 [LLM 작업](/tools/llm-task) 자세한 내용 및 구성 옵션을 확인하세요.

## 워크플로 파일(.lobster)

Lobster는 다음을 사용하여 YAML/JSON 워크플로 파일을 실행할 수 있습니다. `name`, `args`, `steps`, `env`, `condition`, 그리고 `approval` 전지. OpenClaw 도구 호출에서 다음을 설정합니다. `pipeline` 파일 경로에.

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

참고:

- `stdin: $step.stdout` 그리고 `stdin: $step.json` 이전 단계의 출력을 전달합니다.
- `condition` (또는 `when`) 단계를 밟을 수 있습니다 `$step.approved`.

## 랍스터 설치

에 Lobster CLI를 설치합니다. **같은 호스트** OpenClaw Gateway를 실행하는 [랍스터 저장소](https://github.com/openclaw/lobster)), 그리고 보장 `lobster` 켜져 있다 `PATH`.
사용자 정의 바이너리 위치를 사용하려면 **순수한** `lobsterPath` 도구 호출에서.

## 도구 활성화

랍스터는 **선택 과목** 플러그인 도구(기본적으로 활성화되어 있지 않음)

권장사항(첨가물, 안전함):

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

사용을 피하세요 `tools.allow: ["lobster"]` 제한적인 허용 목록 모드에서 실행하려는 경우가 아니면.

참고: 허용 목록은 선택적 플러그인에 대해 선택적으로 제공됩니다. 허용 목록에 이름만 있는 경우
플러그인 도구(예: `lobster`), OpenClaw는 핵심 도구를 활성화된 상태로 유지합니다. 코어를 제한하려면
도구를 사용하려면 원하는 핵심 도구나 그룹도 허용 목록에 포함하세요.

## 예: 이메일 분류

랍스터 제외:

```
User: "Check my email and draft replies"
→ openclaw calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ openclaw calls gmail.send
(repeat daily, no memory of what was triaged)
```

랍스터 포함:

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

JSON 봉투(잘림)를 반환합니다.

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
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

하나의 워크플로. 결정적. 안전한.

## 도구 매개변수

### `run`

도구 모드에서 파이프라인을 실행합니다.

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "/path/to/workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

인수를 사용하여 워크플로 파일을 실행합니다.

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

승인 후 중단된 워크플로를 계속합니다.

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### 선택적 입력

- `lobsterPath`: Lobster 바이너리의 절대 경로(사용 생략) `PATH`).
- `cwd`: 파이프라인의 작업 디렉터리(기본값은 현재 프로세스 작업 디렉터리)입니다.
- `timeoutMs`: 이 기간(기본값: 20000)을 초과하면 하위 프로세스를 종료합니다.
- `maxStdoutBytes`: stdout이 이 크기를 초과하면 하위 프로세스를 종료합니다(기본값: 512000).
- `argsJson`: 전달된 JSON 문자열 `lobster run --args-json` (워크플로 파일에만 해당)

## 출력 봉투

Lobster는 다음 세 가지 상태 중 하나로 JSON 봉투를 반환합니다.

- `ok` → 성공적으로 끝났다
- `needs_approval` → 일시 중지; `requiresApproval.resumeToken` 재개가 필요합니다
- `cancelled` → 명시적으로 거부되거나 취소됨

도구는 두 영역 모두에서 봉투를 표면화합니다. `content` (예쁜 JSON) 그리고 `details` (원시 객체).

## 승인

만약에 `requiresApproval` 존재하는 경우 프롬프트를 검사하고 다음을 결정합니다.

- `approve: true` → 재개 및 부작용 지속
- `approve: false` → 워크플로 취소 및 마무리

사용 `approve --preview-from-stdin --limit N` 사용자 정의 jq/heredoc 글루 없이 승인 요청에 JSON 미리보기를 첨부합니다. 이제 이력서 토큰이 간결해졌습니다. Lobster는 워크플로 재개 상태를 해당 상태 디렉토리에 저장하고 작은 토큰 키를 돌려줍니다.

## 오픈프로즈

OpenProse는 Lobster와 잘 어울립니다. `/prose` 다중 에이전트 준비를 조정한 다음 결정론적 승인을 위해 Lobster 파이프라인을 실행합니다. Prose 프로그램에 Lobster가 필요한 경우 다음을 허용하십시오. `lobster` 하위 에이전트를 위한 도구 `tools.subagents.tools`. 보다 [오픈프로즈](/prose).

## 안전

- **로컬 하위 프로세스만** — 플러그인 자체에서는 네트워크 호출이 없습니다.
- **비밀은 없습니다** — Lobster는 OAuth를 관리하지 않습니다. 이를 수행하는 OpenClaw 도구를 호출합니다.
- **샌드박스 인식** — 도구 컨텍스트가 샌드박스화되면 비활성화됩니다.
- **강화** — `lobsterPath` 지정된 경우 절대적이어야 합니다. 시간 초과 및 출력 제한이 적용되었습니다.

## 문제 해결

- **`lobster subprocess timed out`** → 증가 `timeoutMs`, 또는 긴 파이프라인을 분할합니다.
- **`lobster output exceeded maxStdoutBytes`** → 올리다 `maxStdoutBytes` 또는 출력 크기를 줄이세요.
- **`lobster returned invalid JSON`** → 파이프라인이 도구 모드에서 실행되고 JSON만 인쇄되는지 확인하세요.
- **`lobster failed (code …)`** → 터미널에서 동일한 파이프라인을 실행하여 stderr을 검사합니다.

## 자세히 알아보기

- [플러그인](/tools/plugin)
- [플러그인 도구 저작](/plugins/agent-tools)

## 사례 연구: 커뮤니티 워크플로

한 가지 공개 예: 3개의 Markdown 저장소(개인, 파트너, 공유)를 관리하는 "두 번째 두뇌" CLI + Lobster 파이프라인입니다. CLI는 통계, 받은 편지함 목록 및 오래된 스캔에 대해 JSON을 내보냅니다. Lobster는 이러한 명령을 다음과 같은 워크플로에 연결합니다. `weekly-review`, `inbox-triage`, `memory-consolidation`, 그리고 `shared-task-sync`, 각각 승인 게이트가 있습니다. AI는 가능한 경우 판단(분류)을 처리하고 그렇지 않은 경우 결정론적 규칙으로 돌아갑니다.

- 실: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- 레포: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
