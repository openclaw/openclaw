---
read_when:
    - 에이전트 도구 추가 또는 수정
    - '`openclaw-*` 기술 폐기 또는 변경'
summary: 레거시 `openclaw-*` 기술을 대체하는 OpenClaw(브라우저, 캔버스, 노드, 메시지, cron)용 에이전트 도구 표면
title: 도구
x-i18n:
    generated_at: "2026-02-08T16:14:30Z"
    model: gtx
    provider: google-translate
    source_hash: 84d3788b0f5df3d5e9bfcfb4695985292c9adc7aaec9b57ebb3ea1c353d26b6d
    source_path: tools/index.md
    workflow: 15
---

# 도구(OpenClaw)

OpenClaw 노출 **최고의 에이전트 도구** 브라우저, 캔버스, 노드 및 cron용.
이것들은 오래된 것을 대체합니다. `openclaw-*` 기술: 도구가 입력되고 포격이 없으며
에이전트는 이를 직접적으로 신뢰해야 합니다.

## 도구 비활성화

다음을 통해 전역적으로 도구를 허용/거부할 수 있습니다. `tools.allow` / `tools.deny` ~에 `openclaw.json`
(승리 거부). 이렇게 하면 허용되지 않는 도구가 모델 공급자에게 전송되는 것을 방지할 수 있습니다.

```json5
{
  tools: { deny: ["browser"] },
}
```

참고:

- 일치는 대소문자를 구분하지 않습니다.
- `*` 와일드카드가 지원됩니다(`"*"` 모든 도구를 의미합니다.)
- 만약에 `tools.allow` 알 수 없거나 로드되지 않은 플러그인 도구 이름만 참조합니다. OpenClaw는 경고를 기록하고 허용 목록을 무시하여 핵심 도구를 계속 사용할 수 있도록 합니다.

## 도구 프로필(기본 허용 목록)

`tools.profile` 세트하다 **기본 도구 허용 목록** ~ 전에 `tools.allow` / `tools.deny`.
에이전트별 재정의: `agents.list[].tools.profile`.

프로필:

- `minimal`: `session_status` 오직
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: 제한 없음(설정되지 않은 것과 동일)

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

## 제공자별 도구 정책

사용 `tools.byProvider` 에게 **더욱 제한하다** 특정 제공자를 위한 도구
(또는 단일 `provider/model`) 전역 기본값을 변경하지 않고.
에이전트별 재정의: `agents.list[].tools.byProvider`.

이 적용됩니다 **~ 후에** 기본 도구 프로필 및 ** ~ 전에 ** 허용/거부 목록,
따라서 도구 세트의 범위를 좁힐 수만 있습니다.
공급자 키는 다음 중 하나를 허용합니다. `provider` (예: `google-antigravity`) 또는
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

도구 정책(글로벌, 에이전트, 샌드박스) 지원 `group:*` 여러 도구로 확장되는 항목입니다.
다음에서 사용하세요. `tools.allow` / `tools.deny`.

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
- `group:openclaw`: 모든 내장 OpenClaw 도구(공급자 플러그인 제외)

예(파일 도구 + 브라우저만 허용):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## 플러그인 + 도구

플러그인 등록 가능 **추가 도구** (및 CLI 명령)은 코어 세트를 넘어서는 것입니다.
보다 [플러그인](/tools/plugin) 설치 + 구성의 경우 [기술](/tools/skills) 어떻게
도구 사용 지침이 프롬프트에 삽입됩니다. 일부 플러그인은 자체 기술을 제공합니다.
도구(예: 음성 통화 플러그인)와 함께.

선택적 플러그인 도구:

- [새우](/tools/lobster): 재개 가능한 승인이 포함된 입력된 워크플로 런타임입니다(게이트웨이 호스트에 Lobster CLI가 필요함).
- [LLM 작업](/tools/llm-task): 구조화된 워크플로 출력을 위한 JSON 전용 LLM 단계(선택적 스키마 검증)

## 도구 재고

### `apply_patch`

하나 이상의 파일에 구조화된 패치를 적용합니다. 다중 덩어리 편집에 사용합니다.
실험적: 다음을 통해 활성화 `tools.exec.applyPatch.enabled` (OpenAI 모델만 해당)

### `exec`

작업 공간에서 셸 명령을 실행합니다.

핵심 매개변수:

- `command` (필수의)
- `yieldMs` (시간 초과 후 자동 백그라운드, 기본값 10000)
- `background` (즉시 배경)
- `timeout` (초; 초과하면 프로세스를 종료합니다. 기본값은 1800입니다)
- `elevated` (부울; 관리자 모드가 활성화/허용된 경우 호스트에서 실행; 에이전트가 샌드박스 처리된 경우에만 동작을 변경함)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (노드 ID/이름 `host=node`)
- 실제 TTY가 필요하십니까? 세트 `pty: true`.

참고:

- 보고 `status: "running"` 와 `sessionId` 배경일 때.
- 사용 `process` 백그라운드 세션을 폴링/로그/쓰기/종료/삭제합니다.
- 만약에 `process` 허용되지 않습니다. `exec` 동기식으로 실행되고 무시됩니다. `yieldMs` / `background`.
- `elevated` 에 의해 게이트됩니다 `tools.elevated` 게다가 무엇이든 `agents.list[].tools.elevated` 재정의(둘 다 허용해야 함)이며 다음의 별칭입니다. `host=gateway` + `security=full`.
- `elevated` 에이전트가 샌드박스 처리된 경우에만 동작을 변경합니다(그렇지 않으면 작동하지 않습니다).
- `host=node` macOS 동반 앱 또는 헤드리스 노드 호스트를 대상으로 할 수 있습니다(`openclaw node run`).
- 게이트웨이/노드 승인 및 허용 목록: [임원 승인](/tools/exec-approvals).

### `process`

백그라운드 실행 세션을 관리합니다.

핵심 활동:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

참고:

- `poll` 완료되면 새 출력과 종료 상태를 반환합니다.
- `log` 라인 기반 지원 `offset` / `limit` (생략 `offset` 마지막 N 줄을 잡으려면).
- `process` 에이전트별로 범위가 지정됩니다. 다른 상담원의 세션은 표시되지 않습니다.

### `web_search`

Brave Search API를 사용하여 웹을 검색하세요.

핵심 매개변수:

- `query` (필수의)
- `count` (1–10; 기본값은 `tools.web.search.maxResults`)

참고:

- Brave API 키가 필요합니다(권장: `openclaw configure --section web`또는 설정 `BRAVE_API_KEY`).
- 다음을 통해 활성화 `tools.web.search.enabled`.
- 응답이 캐시됩니다(기본값 15분).
- 보다 [웹 도구](/tools/web) 설정을 위해.

### `web_fetch`

URL(HTML → markdown/text)에서 읽을 수 있는 콘텐츠를 가져오고 추출합니다.

핵심 매개변수:

- `url` (필수의)
- `extractMode` (`markdown` | `text`)
- `maxChars` (긴 페이지 잘림)

참고:

- 다음을 통해 활성화 `tools.web.fetch.enabled`.
- `maxChars` 에 의해 고정됩니다 `tools.web.fetch.maxCharsCap` (기본값은 50000).
- 응답이 캐시됩니다(기본값 15분).
- JS가 많은 사이트의 경우 브라우저 도구를 선호합니다.
- 보다 [웹 도구](/tools/web) 설정을 위해.
- 보다 [파이어 크롤링](/tools/firecrawl) 선택적 안티 봇 폴백을 위해.

### `browser`

전용 OpenClaw 관리 브라우저를 제어하세요.

핵심 활동:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (아리아/아이)
- `screenshot` (이미지 블록을 반환 + `MEDIA:<path>`)
- `act` (UI 작업: 클릭/입력/누르기/호버/드래그/선택/채우기/크기 조정/대기/평가)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

프로필 관리:

- `profiles` — 상태와 함께 모든 브라우저 프로필을 나열합니다.
- `create-profile` — 자동 할당된 포트로 새 프로필을 생성합니다(또는 `cdpUrl`)
- `delete-profile` — 브라우저 중지, 사용자 데이터 삭제, 구성에서 제거(로컬 전용)
- `reset-profile` — 프로필 포트에서 고아 프로세스 종료(로컬 전용)

공통 매개변수:

- `profile` (선택 사항; 기본값은 `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (선택사항, 특정 노드 ID/이름 선택)
  참고:
- 필요하다 `browser.enabled=true` (기본값은 `true`; 세트 `false` 비활성화합니다).
- 모든 작업은 선택 사항으로 허용됩니다. `profile` 다중 인스턴스 지원을 위한 매개변수입니다.
- 언제 `profile` 생략되어 사용됩니다 `browser.defaultProfile` (기본값은 "크롬").
- 프로필 이름: 소문자 영숫자 + 하이픈만 사용 가능(최대 64자).
- 포트 범위: 18800-18899(최대 프로필 100개).
- 원격 프로필은 연결 전용입니다(시작/중지/재설정 없음).
- 브라우저 가능 노드가 연결된 경우 도구는 해당 노드로 자동 라우팅될 수 있습니다(고정하지 않는 한). `target`).
- `snapshot` 기본값은 `ai` 극작가가 설치되면; 사용 `aria` 접근성 트리의 경우.
- `snapshot` 역할 스냅샷 옵션도 지원합니다(`interactive`, `compact`, `depth`, `selector`) 다음과 같은 심판을 반환합니다. `e12`.
- `act` 필요하다 `ref` ~에서 `snapshot` (숫자 `12` AI 스냅샷에서 또는 `e12` 역할 스냅샷에서) 사용 `evaluate` 드물게 CSS 선택기가 필요한 경우.
- 피하다 `act` → `wait` 기본적으로; 예외적인 경우에만 사용하십시오(기다릴 수 있는 안정적인 UI 상태가 없음).
- `upload` 선택적으로 `ref` 무장 후 자동 클릭합니다.
- `upload` 또한 지원합니다 `inputRef` (아리아 참조) 또는 `element` (CSS 선택기) 설정 `<input type="file">` 곧장.

### `canvas`

노드 Canvas(현재, 평가, 스냅샷, A2UI)를 구동합니다.

핵심 활동:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (이미지 블록을 반환 + `MEDIA:<path>`)
- `a2ui_push`, `a2ui_reset`

참고:

- 게이트웨이 사용 `node.invoke` 후드 아래.
- 그렇지 않은 경우 `node` 제공되면 도구는 기본값(단일 연결된 노드 또는 로컬 Mac 노드)을 선택합니다.
- A2UI는 v0.8 전용입니다(아니요 `createSurface`); CLI는 줄 오류로 인해 v0.9 JSONL을 거부합니다.
- 빠른 연기: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.

### `nodes`

쌍을 이루는 노드를 검색하고 타겟팅합니다. 알림 보내기 카메라/화면을 캡처합니다.

핵심 활동:

- `status`, `describe`
- `pending`, `approve`, `reject` (편성)
- `notify` (맥OS `system.notify`)
- `run` (맥OS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

참고:

- 카메라/화면 명령을 사용하려면 노드 앱이 포그라운드에 있어야 합니다.
- 이미지는 이미지 블록을 반환합니다. + `MEDIA:<path>`.
- 비디오 반환 `FILE:<path>` (MP4).
- 위치는 JSON 페이로드(위도/경도/정확도/타임스탬프)를 반환합니다.
- `run` 매개변수: `command` argv 배열; 선택 과목 `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.

예 (`run`):

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
- `maxBytesMb` (옵션 사이즈 캡)

참고:

- 다음 경우에만 사용 가능 `agents.defaults.imageModel` 구성된 경우(기본 또는 대체) 또는 기본 모델 + 구성된 인증에서 암시적 이미지 모델을 추론할 수 있는 경우(최선의 노력 쌍)
- 기본 채팅 모델과 별개로 이미지 모델을 직접 사용합니다.

### `message`

Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams 전반에 걸쳐 메시지와 채널 작업을 보냅니다.

핵심 활동:

- `send` (텍스트 + 선택적 미디어; MS Teams도 지원합니다. `card` 적응형 카드의 경우)
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

- `send` 게이트웨이를 통해 WhatsApp을 라우팅합니다. 다른 채널은 직접 이동합니다.
- `poll` WhatsApp 및 MS Teams용 게이트웨이를 사용합니다. Discord 여론조사는 직접 진행됩니다.
- 메시지 도구 호출이 활성 채팅 세션에 바인딩되면 컨텍스트 간 누출을 방지하기 위해 전송이 해당 세션의 대상으로 제한됩니다.

### `cron`

게이트웨이 크론 작업 및 깨우기를 관리합니다.

핵심 활동:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (큐에 추가 시스템 이벤트 + 선택적 즉시 하트비트)

참고:

- `add` 전체 크론 작업 개체(와 동일한 스키마)가 필요합니다. `cron.add` RPC).
- `update` 용도 `{ jobId, patch }` (`id` 호환성을 위해 허용됨).

### `gateway`

실행 중인 게이트웨이 프로세스(현재 위치)에 업데이트를 다시 시작하거나 적용합니다.

핵심 활동:

- `restart` (승인 + 전송 `SIGUSR1` 진행 중인 재시작의 경우; `openclaw gateway` 그 자리에서 다시 시작)
- `config.get` / `config.schema`
- `config.apply` (검증 + 구성 쓰기 + 다시 시작 + 깨우기)
- `config.patch` (부분 업데이트 병합 + 다시 시작 + 깨우기)
- `update.run` (업데이트 실행 + 다시 시작 + 깨우기)

참고:

- 사용 `delayMs` (기본값은 2000) 기내 응답이 중단되지 않도록 합니다.
- `restart` 기본적으로 비활성화되어 있습니다. 활성화 `commands.restart: true`.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

세션을 나열하고, 기록 기록을 검사하고, 다른 세션으로 보냅니다.

핵심 매개변수:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = 없음)
- `sessions_history`: `sessionKey` (또는 `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (또는 `sessionId`), `message`, `timeoutSeconds?` (0 = 실행 후 잊어버리기)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?` (기본 전류; 허용 `sessionId`), `model?` (`default` 재정의 지우기)

참고:

- `main` 표준 직접 채팅 키입니다. 전역/알 수 없음은 숨겨져 있습니다.
- `messageLimit > 0` 세션당 마지막 N개 메시지를 가져옵니다(도구 메시지는 필터링됨).
- `sessions_send` 최종 완료를 기다립니다. `timeoutSeconds > 0`.
- 전달/발표는 완료 후 이루어지며 최선의 노력을 다합니다. `status: "ok"` 알림이 전달되었음을 확인하는 것이 아니라 에이전트 실행이 완료되었음을 확인합니다.
- `sessions_spawn` 하위 에이전트 실행을 시작하고 요청자 채팅에 알림 응답을 다시 게시합니다.
- `sessions_spawn` 비 차단 및 반환 `status: "accepted"` 즉시.
- `sessions_send` 답장 탁구(답장)를 실행합니다. `REPLY_SKIP` 멈추다; 최대 회전수 `session.agentToAgent.maxPingPongTurns`, 0–5).
- 탁구 후에 대상 에이전트는 다음을 실행합니다. **단계를 발표하다**; 회신하다 `ANNOUNCE_SKIP` 발표를 억제합니다.

### `agents_list`

현재 세션이 대상으로 삼을 수 있는 상담사 ID 나열 `sessions_spawn`.

참고:

- 결과는 에이전트별 허용 목록(`agents.list[].subagents.allowAgents`).
- 언제 `["*"]` 구성되면 도구에는 구성된 모든 에이전트와 표시가 포함됩니다. `allowAny: true`.

## 매개변수(공통)

게이트웨이 지원 도구(`canvas`, `nodes`, `cron`):

- `gatewayUrl` (기본 `ws://127.0.0.1:18789`)
- `gatewayToken` (인증이 활성화된 경우)
- `timeoutMs`

참고: 언제 `gatewayUrl` 설정되어 있습니다. `gatewayToken` 명시적으로. 도구는 구성을 상속하지 않습니다.
또는 재정의를 위한 환경 자격 증명이 있으며 명시적 자격 증명이 누락되면 오류가 발생합니다.

브라우저 도구:

- `profile` (선택 사항; 기본값은 `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (선택사항, 특정 노드 ID/이름 고정)

## 권장 에이전트 흐름

브라우저 자동화:

1. `browser` → `status` / `start`
2. `snapshot` (아이 또는 아리아)
3. `act` (클릭/타자/누르기)
4. `screenshot` 시각적 확인이 필요한 경우

캔버스 렌더링:

1. `canvas` → `present`
2. `a2ui_push` (선택 과목)
3. `snapshot`

노드 타겟팅:

1. `nodes` → `status`
2. `describe` 선택한 노드에서
3. `notify` / `run` / `camera_snap` / `screen_record`

## 안전

- 직접 피하기 `system.run`; 사용 `nodes` → `run` 명시적인 사용자 동의가 있는 경우에만 가능합니다.
- 카메라/화면 캡처에 대한 사용자 동의를 존중합니다.
- 사용 `status/describe` 미디어 명령을 호출하기 전에 권한을 확인합니다.

## 상담원에게 도구가 제공되는 방식

도구는 두 개의 병렬 채널에 노출됩니다.

1. **시스템 프롬프트 텍스트**: 사람이 읽을 수 있는 목록 + 지침.
2. **도구 스키마**: 모델 API로 전송된 구조화된 함수 정의입니다.

즉, 상담원은 '어떤 도구가 존재하는지'와 '이 도구를 호출하는 방법'을 모두 볼 수 있습니다. 도구라면
시스템 프롬프트나 스키마에 나타나지 않으면 모델이 이를 호출할 수 없습니다.
