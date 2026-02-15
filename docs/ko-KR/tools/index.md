---
summary: "Agent tool surface for OpenClaw (browser, canvas, nodes, message, cron) replacing legacy `openclaw-*` skills"
read_when:
  - Adding or modifying agent tools
  - Retiring or changing `openclaw-*` skills
title: "Tools"
x-i18n:
  source_hash: 84d3788b0f5df3d5e9bfcfb4695985292c9adc7aaec9b57ebb3ea1c353d26b6d
---

# 도구(OpenClaw)

OpenClaw는 브라우저, 캔버스, 노드 및 cron을 위한 **최고 수준의 에이전트 도구**를 제공합니다.
이는 이전 `openclaw-*` 스킬을 대체합니다. 도구가 입력되고 포격이 없으며
에이전트는 이를 직접적으로 신뢰해야 합니다.

## 도구 비활성화

`openclaw.json`에서 `tools.allow` / `tools.deny`를 통해 전역적으로 도구를 허용/거부할 수 있습니다.
(승리 거부). 이렇게 하면 허용되지 않는 도구가 모델 공급자에게 전송되는 것을 방지할 수 있습니다.

```json5
{
  tools: { deny: ["browser"] },
}
```

참고:

- 일치는 대소문자를 구분하지 않습니다.
- `*` 와일드카드가 지원됩니다(`"*"`는 모든 도구를 의미함).
- `tools.allow` 알 수 없거나 로드되지 않은 플러그인 도구 이름만 참조하는 경우 OpenClaw는 경고를 기록하고 허용 목록을 무시하여 핵심 도구를 계속 사용할 수 있도록 합니다.

## 도구 프로필(기본 허용 목록)

`tools.profile`는 `tools.allow`/`tools.deny` 앞에 **기본 도구 허용 목록**을 설정합니다.
에이전트별 재정의: `agents.list[].tools.profile`.

프로필:

- `minimal`: `session_status` 전용
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: 제한 없음(설정 해제와 동일)

예(기본적으로 메시지 전용, Slack + Discord 도구도 허용):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

예(코딩 프로필, 모든 곳에서 실행/프로세스 거부):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

예(글로벌 코딩 프로필, 메시징 전용 지원 에이전트):

```json5
{
  tools: { profile: "coding" },
  agents: {
    list: [
      {
        id: "support",
        tools: { profile: "messaging", allow: ["slack"] },
      },
    ],
  },
}
```

## 제공업체별 도구 정책

특정 제공업체에 대한 도구를 **더 제한**하려면 `tools.byProvider`를 사용하세요.
(또는 단일 `provider/model`) 전역 기본값을 변경하지 않고.
에이전트별 재정의: `agents.list[].tools.byProvider`.

이는 기본 도구 프로필 **이후** 및 허용/거부 목록 **이전**에 적용됩니다.
따라서 도구 세트의 범위를 좁힐 수만 있습니다.
공급자 키는 `provider`(예: `google-antigravity`) 또는
`provider/model` (예: `openai/gpt-5.2`).

예(전역 코딩 프로필을 유지하지만 Google Antigravity를 위한 최소한의 도구):

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

예(불안정한 엔드포인트에 대한 제공업체/모델별 허용 목록):

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

예(단일 공급자에 대한 에이전트별 재정의):

```json5
{
  agents: {
    list: [
      {
        id: "support",
        tools: {
          byProvider: {
            "google-antigravity": { allow: ["message", "sessions_list"] },
          },
        },
      },
    ],
  },
}
```

## 도구 그룹(약칭)

도구 정책(글로벌, 에이전트, 샌드박스)은 여러 도구로 확장되는 `group:*` 항목을 지원합니다.
`tools.allow` / `tools.deny`에서 사용하세요.

사용 가능한 그룹:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: 모든 내장 OpenClaw 도구(제공자 플러그인 제외)

예(파일 도구 + 브라우저만 허용):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## 플러그인 + 도구

플러그인은 코어 세트 외에 **추가 도구**(및 CLI 명령)를 등록할 수 있습니다.
설치 + 구성은 [플러그인](/tools/plugin), 방법은 [스킬](/tools/skills)을 참조하세요.
도구 사용 지침이 프롬프트에 삽입됩니다. 일부 플러그인은 자체 기술을 제공합니다.
도구(예: 음성 통화 플러그인)와 함께.

선택적 플러그인 도구:

- [Lobster](/tools/lobster): 재개 가능한 승인이 있는 입력된 워크플로 런타임(게이트웨이 호스트에 Lobster CLI가 필요함)
- [LLM 작업](/tools/llm-task): 구조화된 워크플로 출력을 위한 JSON 전용 LLM 단계(선택적 스키마 검증).

## 도구 인벤토리

### `apply_patch`

하나 이상의 파일에 구조화된 패치를 적용합니다. 다중 덩어리 편집에 사용합니다.
실험적: `tools.exec.applyPatch.enabled`를 통해 활성화합니다(OpenAI 모델에만 해당).

### `exec`

작업 공간에서 셸 명령을 실행합니다.

핵심 매개변수:

- `command` (필수)
- `yieldMs` (시간 초과 후 자동 배경화면, 기본값 10000)
- `background` (즉시 배경)
- `timeout` (초; 초과하면 프로세스를 종료합니다. 기본값은 1800)
- `elevated` (부울; 관리자 모드가 활성화/허용된 경우 호스트에서 실행; 에이전트가 샌드박스 처리될 때만 동작을 변경함)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (`host=node`의 노드 ID/이름)
- 실제 TTY가 필요하십니까? `pty: true`를 설정합니다.

참고:

- 백그라운드인 경우 `sessionId`와 함께 `status: "running"`를 반환합니다.
- `process`를 사용하여 백그라운드 세션을 폴링/로그/쓰기/종료/삭제합니다.
- `process`가 허용되지 않으면 `exec`는 동기적으로 실행되고 `yieldMs`/`background`를 무시합니다.
- `elevated`는 `tools.elevated`와 `agents.list[].tools.elevated` 재정의(둘 다 허용해야 함)에 의해 제어되며 `host=gateway` + `security=full`의 별칭입니다.
- `elevated`는 에이전트가 샌드박싱된 경우에만 동작을 변경합니다(그렇지 않으면 작동하지 않습니다).
- `host=node`는 macOS 컴패니언 앱 또는 헤드리스 노드 호스트(`openclaw node run`)를 대상으로 할 수 있습니다.
- 게이트웨이/노드 승인 및 허용 목록: [실행 승인](/tools/exec-approvals).

### `process`

백그라운드 실행 세션을 관리합니다.

핵심 활동:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

참고:

- `poll`는 완료되면 새로운 출력과 종료 상태를 반환합니다.
- `log`는 라인 기반 `offset`/`limit`을 지원합니다(마지막 N 라인을 가져오려면 `offset` 생략).
- `process`는 에이전트별로 범위가 지정됩니다. 다른 상담원의 세션은 표시되지 않습니다.

### `web_search`

Brave Search API를 사용하여 웹을 검색하세요.

핵심 매개변수:

- `query` (필수)
- `count` (1–10; 기본값은 `tools.web.search.maxResults`)

참고:

- Brave API 키가 필요합니다(권장: `openclaw configure --section web` 또는 `BRAVE_API_KEY` 설정).
- `tools.web.search.enabled`를 통해 활성화합니다.
- 응답이 캐시됩니다(기본값 15분).
- 설정 방법은 [웹 도구](/tools/web)를 참조하세요.

### `web_fetch`

URL(HTML → markdown/text)에서 읽을 수 있는 콘텐츠를 가져오고 추출합니다.

핵심 매개변수:

- `url` (필수)
- `extractMode` (`markdown` | `text`)
- `maxChars` (긴 페이지 잘림)

참고:

- `tools.web.fetch.enabled`을 통해 활성화합니다.
- `maxChars`는 `tools.web.fetch.maxCharsCap`에 의해 고정됩니다(기본값 50000).
- 응답이 캐시됩니다(기본값 15분).
- JS가 많은 사이트의 경우 브라우저 도구를 선호합니다.
- 설정 방법은 [웹 도구](/tools/web)를 참조하세요.
- 선택적 안티 봇 폴백에 대해서는 [Firecrawl](/tools/firecrawl)을 참조하세요.

### `browser`

전용 OpenClaw 관리 브라우저를 제어하세요.

핵심 활동:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (아리아/ai)
- `screenshot` (이미지 블록 + `MEDIA:<path>` 반환)
- `act` (UI 작업: 클릭/입력/누르기/호버/드래그/선택/채우기/크기 조정/대기/평가)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

프로필 관리:

- `profiles` — 상태와 함께 모든 브라우저 프로필을 나열합니다.
- `create-profile` — 자동 할당된 포트로 새 프로필 생성(또는 `cdpUrl`)
- `delete-profile` — 브라우저 중지, 사용자 데이터 삭제, 구성에서 제거(로컬 전용)
- `reset-profile` — 프로필 포트에서 고아 프로세스를 종료합니다(로컬 전용).

공통 매개변수:

- `profile` (선택 사항; 기본값은 `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (선택 사항, 특정 노드 ID/이름 선택)
  참고:
- `browser.enabled=true`가 필요합니다(기본값은 `true`입니다. 비활성화하려면 `false`를 설정하세요).
- 모든 작업은 다중 인스턴스 지원을 위한 선택적 `profile` 매개변수를 허용합니다.
- `profile`를 생략하면 `browser.defaultProfile`를 사용합니다. (기본값은 "chrome")
- 프로필 이름: 소문자 영숫자 + 하이픈만 사용 가능(최대 64자).
- 포트 범위: 18800-18899(최대 프로필 100개).
- 원격 프로필은 연결 전용입니다(시작/중지/재설정 없음).
- 브라우저 가능 노드가 연결된 경우 도구는 해당 노드로 자동 라우팅될 수 있습니다(`target`를 고정하지 않는 한).
- Playwright가 설치되면 `snapshot`는 기본적으로 `ai`로 설정됩니다. 접근성 트리에는 `aria`를 사용하세요.
- `snapshot`는 `e12`와 같은 참조를 반환하는 역할 스냅샷 옵션(`interactive`, `compact`, `depth`, `selector`)도 지원합니다.
- `act`에는 `snapshot`의 `ref`가 필요합니다(AI 스냅샷의 숫자 `12` 또는 역할 스냅샷의 `e12`). 드물게 CSS 선택기가 필요한 경우에는 `evaluate`를 사용하세요.
- 기본적으로 `act` → `wait`를 피하세요. 예외적인 경우에만 사용하십시오(기다릴 수 있는 안정적인 UI 상태가 없음).
- `upload`는 선택적으로 무장 후 자동 클릭을 위해 `ref`를 전달할 수 있습니다.
- `upload`는 `inputRef`(aria ref) 또는 `element`(CSS 선택기)를 지원하여 `<input type="file">`를 직접 설정할 수도 있습니다.

### `canvas`

노드 Canvas(현재, 평가, 스냅샷, A2UI)를 구동합니다.

핵심 활동:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (이미지 블록 + `MEDIA:<path>` 반환)
- `a2ui_push`, `a2ui_reset`

참고:

- 내부적으로 게이트웨이 `node.invoke`를 사용합니다.
- `node`가 제공되지 않으면 도구는 기본값(단일 연결된 노드 또는 로컬 Mac 노드)을 선택합니다.
- A2UI는 v0.8 전용입니다(`createSurface` 없음). CLI는 줄 오류로 인해 v0.9 JSONL을 거부합니다.
- 빠른 연기: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.

### `nodes`

쌍을 이루는 노드를 검색하고 타겟팅합니다. 알림 보내기 카메라/화면을 캡처합니다.

핵심 활동:

- `status`, `describe`
- `pending`, `approve`, `reject` (페어링)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

참고:

- 카메라/화면 명령을 실행하려면 노드 앱이 포그라운드에 있어야 합니다.
- 이미지는 이미지 블록 + `MEDIA:<path>`를 반환합니다.
- 동영상은 `FILE:<path>`(mp4)를 반환합니다.
- 위치는 JSON 페이로드(위도/경도/정확도/타임스탬프)를 반환합니다.
- `run` 매개변수: `command` argv 배열; 선택 사항 `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.

예(`run`):

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hello"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

구성된 이미지 모델로 이미지를 분석합니다.

핵심 매개변수:

- `image` (필수 경로 또는 URL)
- `prompt` (선택사항, 기본값은 "이미지 설명"입니다.)
- `model` (선택적 재정의)
- `maxBytesMb` (선택적 크기 제한)

참고:

- `agents.defaults.imageModel`가 구성된 경우(기본 또는 대체) 또는 암시적 이미지 모델이 기본 모델 + 구성된 인증에서 추론될 수 있는 경우(최선의 노력 쌍)에만 사용할 수 있습니다.
- 이미지 모델을 직접 사용합니다(메인 채팅 모델과 별개).

### `message`

Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams 전반에 걸쳐 메시지와 채널 작업을 보냅니다.

핵심 활동:

- `send` (텍스트 + 선택적 미디어, MS Teams는 적응형 카드에 대해 `card`도 지원합니다)
- `poll` (WhatsApp/Discord/MS Teams 설문조사)
- `react` / `reactions` / `read` / `edit` / `delete`
- `pin` / `unpin` / `list-pins`
- `permissions`
- `thread-create` / `thread-list` / `thread-reply`
- `search`
- `sticker`
- `member-info` / `role-info`
- `emoji-list` / `emoji-upload` / `sticker-upload`
- `role-add` / `role-remove`
- `channel-info` / `channel-list`
- `voice-status`
- `event-list` / `event-create`
- `timeout` / `kick` / `ban`

참고:

- `send`는 게이트웨이를 통해 WhatsApp을 라우팅합니다. 다른 채널은 직접 이동합니다.
- `poll`는 WhatsApp 및 MS Teams용 게이트웨이를 사용합니다. Discord 여론조사는 직접 진행됩니다.
- 메시지 도구 호출이 활성 채팅 세션에 바인딩되면 컨텍스트 간 누출을 방지하기 위해 전송이 해당 세션의 대상으로 제한됩니다.

### `cron`

게이트웨이 크론 작업 및 깨우기를 관리합니다.

핵심 활동:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (인큐 시스템 이벤트 + 선택적 즉시 하트비트)

참고:

- `add`는 전체 크론 작업 개체(`cron.add` RPC와 동일한 스키마)를 기대합니다.
- `update`는 `{ jobId, patch }`를 사용합니다(`id`는 호환성을 위해 허용됩니다).

### `gateway`

실행 중인 게이트웨이 프로세스(현재 위치)에 업데이트를 다시 시작하거나 적용합니다.

핵심 활동:

- `restart` (진행 중인 재시작을 위해 `SIGUSR1`를 승인하고 전송합니다. `openclaw gateway` 제자리에서 재시작)
- `config.get` / `config.schema`
- `config.apply` (검증 + 구성 쓰기 + 재시작 + 깨우기)
- `config.patch` (부분 업데이트 병합 + 다시 시작 + 깨우기)
- `update.run` (업데이트 실행 + 재시작 + 깨우기)

참고:

- 기내 응답을 방해하지 않으려면 `delayMs`(기본값은 2000)을 사용하십시오.
- `restart`는 기본적으로 비활성화되어 있습니다. `commands.restart: true`로 활성화하세요.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

세션을 나열하고, 기록 기록을 검사하고, 다른 세션으로 보냅니다.

핵심 매개변수:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = 없음)
- `sessions_history`: `sessionKey` (또는 `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (또는 `sessionId`), `message`, `timeoutSeconds?` (0 = 실행 후 잊어버리기)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?` (기본 전류; `sessionId` 허용), `model?` (`default` 재정의 삭제)

참고:

- `main`는 정식 직접 채팅 키입니다. 전역/알 수 없음은 숨겨져 있습니다.
- `messageLimit > 0`는 세션당 마지막 N개의 메시지를 가져옵니다(도구 메시지는 필터링됨).
- `sessions_send`는 `timeoutSeconds > 0`일 때 최종 완료를 기다립니다.
- 전달/공지는 완료 후 이루어지며 최선의 노력을 다합니다. `status: "ok"` 알림이 전달된 것이 아니라 에이전트 실행이 완료되었음을 확인합니다.
- `sessions_spawn`는 하위 에이전트 실행을 시작하고 요청자 채팅에 알림 답변을 다시 게시합니다.
- `sessions_spawn`는 비차단이며 즉시 `status: "accepted"`를 반환합니다.
- `sessions_send`는 응답 탁구를 실행합니다(중지하려면 `REPLY_SKIP`라고 응답하고 `session.agentToAgent.maxPingPongTurns`를 통해 최대 회전 수, 0–5).
- 탁구 후에 대상 에이전트는 **발표 단계**를 실행합니다. 공지를 억제하려면 `ANNOUNCE_SKIP`로 답장하세요.

### `agents_list`

`sessions_spawn`를 사용하여 현재 세션이 대상으로 삼을 수 있는 에이전트 ID를 나열합니다.

참고:

- 결과는 에이전트별 허용 목록(`agents.list[].subagents.allowAgents`)으로 제한됩니다.
- `["*"]`이 구성되면 도구에는 구성된 모든 에이전트와 `allowAny: true` 표시가 포함됩니다.

## 매개변수(공통)

게이트웨이 지원 도구(`canvas`, `nodes`, `cron`):

- `gatewayUrl` (기본값 `ws://127.0.0.1:18789`)
- `gatewayToken` (인증이 활성화된 경우)
- `timeoutMs`

참고: `gatewayUrl`가 설정된 경우 `gatewayToken`를 명시적으로 포함합니다. 도구는 구성을 상속하지 않습니다.
또는 재정의를 위한 환경 자격 증명이 있으며 명시적 자격 증명이 누락되면 오류가 발생합니다.

브라우저 도구:

- `profile` (선택 사항, 기본값은 `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (선택 사항, 특정 노드 ID/이름 고정)

## 권장 에이전트 흐름

브라우저 자동화:

1. `browser` → `status` / `start`
2. `snapshot` (ai 또는 아리아)
3. `act` (클릭/타자/누르기)
4. `screenshot` 육안 확인이 필요한 경우

캔버스 렌더링:

1. `canvas` → `present`
2. `a2ui_push` (선택 사항)
3. `snapshot`

노드 타겟팅:

1. `nodes` → `status`
2. 선택한 노드의 `describe`
3. `notify` / `run` / `camera_snap` / `screen_record`

## 안전

- 직접적인 `system.run`를 피하세요. 명시적인 사용자 동의가 있는 경우에만 `nodes` → `run`를 사용하세요.
- 카메라/화면 캡처에 대한 사용자 동의를 존중합니다.
- 미디어 명령을 호출하기 전에 `status/describe`를 사용하여 권한을 확인하세요.

## 상담원에게 도구가 제공되는 방식

도구는 두 개의 병렬 채널에 노출됩니다.

1. **시스템 프롬프트 텍스트**: 사람이 읽을 수 있는 목록 + 지침.
2. **도구 스키마**: 모델 API로 전송된 구조화된 함수 정의입니다.

즉, 상담원은 '어떤 도구가 존재하는지'와 '이 도구를 호출하는 방법'을 모두 볼 수 있습니다. 도구라면
시스템 프롬프트나 스키마에 나타나지 않으면 모델이 이를 호출할 수 없습니다.
