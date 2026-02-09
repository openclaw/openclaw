---
summary: "레거시 `openclaw-*` Skills 를 대체하는 OpenClaw 용 에이전트 도구 표면 (browser, canvas, nodes, message, cron)"
read_when:
  - 에이전트 도구를 추가하거나 수정할 때
  - "`openclaw-*` Skills 를 폐기하거나 변경할 때"
title: "도구"
---

# Tools (OpenClaw)

OpenClaw 는 browser, canvas, nodes, cron 에 대한 **일급 에이전트 도구**를 제공합니다.
이는 기존 `openclaw-*` Skills 를 대체합니다. 이 도구들은 타입이 지정되어 있고 셸 실행이 없으며,
에이전트는 이를 직접 의존하여 사용해야 합니다.

## 도구 비활성화

`openclaw.json` 에서 `tools.allow` / `tools.deny` 를 통해 전역적으로 도구를 허용/차단할 수 있습니다
(차단이 우선합니다). 이를 통해 허용되지 않은 도구가 모델 프로바이더로 전송되는 것을 방지합니다.

```json5
{
  tools: { deny: ["browser"] },
}
```

참고:

- 매칭은 대소문자를 구분하지 않습니다.
- `*` 와일드카드를 지원합니다 (`"*"` 는 모든 도구를 의미합니다).
- `tools.allow` 가 알 수 없거나 로드되지 않은 플러그인 도구 이름만 참조하는 경우, OpenClaw 는 경고를 로그에 기록하고 allowlist 를 무시하여 핵심 도구가 계속 사용 가능하도록 합니다.

## 도구 프로필 (기본 allowlist)

`tools.profile` 는 `tools.allow`/`tools.deny` 이전에 적용되는 **기본 도구 allowlist** 를 설정합니다.
에이전트별 재정의: `agents.list[].tools.profile`.

프로필:

- `minimal`: `session_status` 만
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: 제한 없음 (미설정과 동일)

예시 (기본은 메시징 전용, Slack + Discord 도구도 허용):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

예시 (코딩 프로필이지만 exec/process 는 전역 차단):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

예시 (전역 코딩 프로필, 메시징 전용 지원 에이전트):

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

## 프로바이더별 도구 정책

전역 기본값을 변경하지 않고 특정 프로바이더
(또는 단일 `provider/model`) 에 대해 도구를 **추가로 제한** 하려면 `tools.byProvider` 를 사용하십시오.
에이전트별 재정의: `agents.list[].tools.byProvider`.

이는 기본 도구 프로필 **이후**, allow/deny 리스트 **이전** 에 적용되므로,
도구 집합을 축소하는 용도로만 사용할 수 있습니다.
프로바이더 키는 `provider` (예: `google-antigravity`) 또는
`provider/model` (예: `openai/gpt-5.2`) 을 허용합니다.

예시 (전역 코딩 프로필은 유지하되, Google Antigravity 에는 최소 도구만):

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

예시 (불안정한 엔드포인트를 위한 프로바이더/모델별 allowlist):

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

예시 (단일 프로바이더에 대한 에이전트별 재정의):

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

## 도구 그룹 (단축 표기)

도구 정책 (전역, 에이전트, 샌드박스) 은 여러 도구로 확장되는 `group:*` 항목을 지원합니다.
이를 `tools.allow` / `tools.deny` 에서 사용하십시오.

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
- `group:openclaw`: 모든 내장 OpenClaw 도구 (프로바이더 플러그인 제외)

예시 (파일 도구 + browser 만 허용):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## 플러그인 + 도구

플러그인은 핵심 세트 외에 **추가 도구** (및 CLI 명령) 를 등록할 수 있습니다.
설치 및 구성은 [Plugins](/tools/plugin) 를 참고하고,
도구 사용 가이던스가 프롬프트에 어떻게 주입되는지는 [Skills](/tools/skills) 를 참고하십시오. 일부 플러그인은 도구와 함께 자체 Skills 를 제공합니다
(예: 음성 통화 플러그인).

선택적 플러그인 도구:

- [Lobster](/tools/lobster): 재개 가능한 승인 기능을 갖춘 타입드 워크플로 런타임 (게이트웨이 호스트에 Lobster CLI 필요).
- [LLM Task](/tools/llm-task): 구조화된 워크플로 출력을 위한 JSON 전용 LLM 단계 (선택적 스키마 검증).

## 도구 인벤토리

### `apply_patch`

하나 이상의 파일에 구조화된 패치를 적용합니다. 다중 헝크 편집에 사용하십시오.
실험적 기능: `tools.exec.applyPatch.enabled` 를 통해 활성화 (OpenAI 모델만).

### `exec`

워크스페이스에서 셸 명령을 실행합니다.

핵심 파라미터:

- `command` (필수)
- `yieldMs` (타임아웃 후 자동 백그라운드, 기본값 10000)
- `background` (즉시 백그라운드)
- `timeout` (초; 초과 시 프로세스 종료, 기본값 1800)
- `elevated` (bool; 상승 모드가 활성화/허용된 경우 호스트에서 실행; 에이전트가 샌드박스화된 경우에만 동작 변경)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (`host=node` 용 노드 id/name)
- 실제 TTY 가 필요한가요? `pty: true` 를 설정하십시오.

참고:

- 백그라운드로 전환되면 `sessionId` 가 포함된 `status: "running"` 를 반환합니다.
- 백그라운드 세션을 폴링/로그/쓰기/종료/정리하려면 `process` 를 사용하십시오.
- `process` 이 허용되지 않으면, `exec` 는 동기적으로 실행되며 `yieldMs`/`background` 를 무시합니다.
- `elevated` 는 `tools.elevated` 와 모든 `agents.list[].tools.elevated` 재정의에 의해 게이트되며 (둘 다 허용되어야 함), `host=gateway` + `security=full` 의 별칭입니다.
- `elevated` 는 에이전트가 샌드박스화된 경우에만 동작을 변경합니다 (그 외에는 no-op).
- `host=node` 는 macOS 컴패니언 앱 또는 헤드리스 노드 호스트 (`openclaw node run`) 를 대상으로 할 수 있습니다.
- 게이트웨이/노드 승인 및 allowlist: [Exec approvals](/tools/exec-approvals).

### `process`

백그라운드 exec 세션을 관리합니다.

핵심 액션:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

참고:

- `poll` 는 완료 시 새 출력과 종료 상태를 반환합니다.
- `log` 는 라인 기반 `offset`/`limit` 를 지원합니다 (`offset` 를 생략하면 마지막 N 줄을 가져옵니다).
- `process` 는 에이전트별 범위로 제한되며, 다른 에이전트의 세션은 보이지 않습니다.

### `web_search`

Brave Search API 를 사용하여 웹을 검색합니다.

핵심 파라미터:

- `query` (필수)
- `count` (1–10; 기본값은 `tools.web.search.maxResults`)

참고:

- Brave API 키가 필요합니다 (권장: `openclaw configure --section web`, 또는 `BRAVE_API_KEY` 설정).
- `tools.web.search.enabled` 를 통해 활성화하십시오.
- 응답은 캐시됩니다 (기본 15 분).
- 설정은 [Web tools](/tools/web) 를 참고하십시오.

### `web_fetch`

URL 에서 읽기 쉬운 콘텐츠를 가져와 추출합니다 (HTML → markdown/text).

핵심 파라미터:

- `url` (필수)
- `extractMode` (`markdown` | `text`)
- `maxChars` (긴 페이지 자르기)

참고:

- `tools.web.fetch.enabled` 를 통해 활성화하십시오.
- `maxChars` 는 `tools.web.fetch.maxCharsCap` (기본값 50000) 로 제한됩니다.
- 응답은 캐시됩니다 (기본 15 분).
- JS 비중이 큰 사이트의 경우 browser 도구를 선호하십시오.
- 설정은 [Web tools](/tools/web) 를 참고하십시오.
- 선택적 안티봇 대체 수단은 [Firecrawl](/tools/firecrawl) 을 참고하십시오.

### `browser`

OpenClaw 가 관리하는 전용 browser 를 제어합니다.

핵심 액션:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (이미지 블록 + `MEDIA:<path>` 반환)
- `act` (UI 액션: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

프로필 관리:

- `profiles` — 상태와 함께 모든 browser 프로필 나열
- `create-profile` — 자동 할당 포트로 새 프로필 생성 (또는 `cdpUrl`)
- `delete-profile` — browser 중지, 사용자 데이터 삭제, 구성에서 제거 (로컬 전용)
- `reset-profile` — 프로필 포트의 고아 프로세스 종료 (로컬 전용)

공통 파라미터:

- `profile` (선택; 기본값 `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (선택; 특정 노드 id/name 지정)
  참고:
- `browser.enabled=true` 가 필요합니다 (기본값은 `true`; 비활성화하려면 `false` 설정).
- 모든 액션은 다중 인스턴스 지원을 위해 선택적 `profile` 파라미터를 허용합니다.
- `profile` 가 생략되면 `browser.defaultProfile` (기본값 "chrome") 을 사용합니다.
- 프로필 이름: 소문자 영숫자 + 하이픈만 허용 (최대 64 자).
- 포트 범위: 18800-18899 (최대 약 100 개 프로필).
- 원격 프로필은 attach 전용입니다 (start/stop/reset 불가).
- browser 가능 노드가 연결되어 있으면, 도구가 자동으로 라우팅할 수 있습니다 (`target` 를 고정하지 않는 한).
- Playwright 가 설치된 경우 `snapshot` 는 기본적으로 `ai` 를 사용합니다; 접근성 트리는 `aria` 를 사용하십시오.
- `snapshot` 는 역할 스냅샷 옵션 (`interactive`, `compact`, `depth`, `selector`) 도 지원하며, `e12` 와 같은 참조를 반환합니다.
- `act` 는 `snapshot` 의 `ref` 가 필요합니다 (AI 스냅샷의 숫자 `12` 또는 역할 스냅샷의 `e12`); 드문 CSS 셀렉터 요구에는 `evaluate` 를 사용하십시오.
- 기본적으로 `act` → `wait` 는 피하십시오; 신뢰할 수 있는 UI 상태를 기다릴 수 없는 예외적 경우에만 사용하십시오.
- `upload` 는 준비 후 자동 클릭을 위해 선택적으로 `ref` 를 전달할 수 있습니다.
- `upload` 는 `<input type="file">` 를 직접 설정하기 위해 `inputRef` (aria ref) 또는 `element` (CSS 셀렉터) 도 지원합니다.

### `canvas`

노드 Canvas 를 구동합니다 (present, eval, snapshot, A2UI).

핵심 액션:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (이미지 블록 + `MEDIA:<path>` 반환)
- `a2ui_push`, `a2ui_reset`

참고:

- 내부적으로 게이트웨이 `node.invoke` 를 사용합니다.
- `node` 가 제공되지 않으면, 도구가 기본값 (단일 연결 노드 또는 로컬 mac 노드) 을 선택합니다.
- A2UI 는 v0.8 전용입니다 (`createSurface` 없음); CLI 는 v0.9 JSONL 을 라인 오류로 거부합니다.
- 빠른 스모크 테스트: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.

### `nodes`

페어링된 노드를 검색하고 대상으로 지정하며, 알림을 전송하고 카메라/화면을 캡처합니다.

핵심 액션:

- `status`, `describe`
- `pending`, `approve`, `reject` (페어링)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

참고:

- 카메라/화면 명령은 노드 앱이 포그라운드에 있어야 합니다.
- 이미지는 이미지 블록 + `MEDIA:<path>` 를 반환합니다.
- 비디오는 `FILE:<path>` (mp4) 를 반환합니다.
- 위치는 JSON 페이로드 (lat/lon/accuracy/timestamp) 를 반환합니다.
- `run` 파라미터: `command` argv 배열; 선택적 `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.

예시 (`run`):

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

핵심 파라미터:

- `image` (필수 경로 또는 URL)
- `prompt` (선택; 기본값 "Describe the image.")
- `model` (선택적 재정의)
- `maxBytesMb` (선택적 크기 제한)

참고:

- `agents.defaults.imageModel` 가 구성된 경우 (기본 또는 폴백), 또는 기본 모델 + 구성된 인증에서 암시적 이미지 모델을 추론할 수 있는 경우에만 사용 가능합니다 (best-effort 페어링).
- 메인 채팅 모델과 독립적으로 이미지 모델을 직접 사용합니다.

### `message`

Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams 전반에 걸쳐 메시지 및 채널 액션을 전송합니다.

핵심 액션:

- `send` (텍스트 + 선택적 미디어; MS Teams 는 Adaptive Cards 용 `card` 도 지원)
- `poll` (WhatsApp/Discord/MS Teams 설문)
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

- `send` 는 WhatsApp 을 Gateway(게이트웨이) 를 통해 라우팅하며, 다른 채널은 직접 전송합니다.
- `poll` 는 WhatsApp 과 MS Teams 에 Gateway(게이트웨이) 를 사용하며, Discord 설문은 직접 전송됩니다.
- 메시지 도구 호출이 활성 채팅 세션에 바인딩된 경우, 컨텍스트 간 누출을 방지하기 위해 해당 세션의 대상에만 전송이 제한됩니다.

### `cron`

Gateway(게이트웨이) cron 작업 및 웨이크업을 관리합니다.

핵심 액션:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (시스템 이벤트 큐잉 + 선택적 즉시 하트비트)

참고:

- `add` 는 전체 cron 작업 객체를 기대합니다 (`cron.add` RPC 와 동일한 스키마).
- `update` 는 `{ jobId, patch }` 를 사용합니다 (호환성을 위해 `id` 허용).

### `gateway`

실행 중인 Gateway(게이트웨이) 프로세스를 재시작하거나 업데이트를 적용합니다 (인플레이스).

핵심 액션:

- `restart` (권한 부여 + 인프로세스 재시작을 위한 `SIGUSR1` 전송; `openclaw gateway` 는 인플레이스 재시작)
- `config.get` / `config.schema`
- `config.apply` (구성 검증 + 기록 + 재시작 + 웨이크)
- `config.patch` (부분 업데이트 병합 + 재시작 + 웨이크)
- `update.run` (업데이트 실행 + 재시작 + 웨이크)

참고:

- 진행 중인 응답을 중단하지 않으려면 `delayMs` (기본값 2000) 을 사용하십시오.
- `restart` 는 기본적으로 비활성화되어 있으며, `commands.restart: true` 로 활성화합니다.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

세션을 나열하고, 전사 기록을 검사하거나 다른 세션으로 전송합니다.

핵심 파라미터:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = 없음)
- `sessions_history`: `sessionKey` (또는 `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (또는 `sessionId`), `message`, `timeoutSeconds?` (0 = fire-and-forget)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?` (기본값 current; `sessionId` 허용), `model?` (`default` 는 재정의 해제)

참고:

- `main` 는 표준 direct-chat 키이며, global/unknown 은 숨겨집니다.
- `messageLimit > 0` 는 세션별 마지막 N 개 메시지를 가져옵니다 (도구 메시지는 필터링됨).
- `sessions_send` 는 `timeoutSeconds > 0` 인 경우 최종 완료를 대기합니다.
- 전달/공지(announce) 는 완료 후 best-effort 로 수행됩니다; `status: "ok"` 는 공지가 전달되었음을 보장하지 않고 에이전트 실행이 완료되었음을 확인합니다.
- `sessions_spawn` 는 서브 에이전트 실행을 시작하고 요청자 채팅으로 공지 응답을 게시합니다.
- `sessions_spawn` 는 논블로킹이며 즉시 `status: "accepted"` 를 반환합니다.
- `sessions_send` 는 응답 핑퐁을 실행합니다 (중단하려면 `REPLY_SKIP` 로 응답; 최대 턴은 `session.agentToAgent.maxPingPongTurns`, 0–5).
- 핑퐁 이후 대상 에이전트는 **공지 단계** 를 실행합니다; 공지를 억제하려면 `ANNOUNCE_SKIP` 로 응답하십시오.

### `agents_list`

현재 세션이 `sessions_spawn` 로 대상으로 지정할 수 있는 에이전트 id 를 나열합니다.

참고:

- 결과는 에이전트별 allowlist (`agents.list[].subagents.allowAgents`) 로 제한됩니다.
- `["*"]` 가 구성된 경우, 도구는 모든 구성된 에이전트를 포함하고 `allowAny: true` 를 표시합니다.

## 파라미터 (공통)

Gateway(게이트웨이) 기반 도구 (`canvas`, `nodes`, `cron`):

- `gatewayUrl` (기본값 `ws://127.0.0.1:18789`)
- `gatewayToken` (인증이 활성화된 경우)
- `timeoutMs`

참고: `gatewayUrl` 가 설정된 경우 `gatewayToken` 를 명시적으로 포함하십시오. 도구는 재정의에 대해
구성이나 환경 자격 증명을 상속하지 않으며, 명시적 자격 증명이 없으면 오류입니다.

Browser 도구:

- `profile` (선택; 기본값 `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (선택; 특정 노드 id/name 고정)

## 권장 에이전트 플로우

Browser 자동화:

1. `browser` → `status` / `start`
2. `snapshot` (ai 또는 aria)
3. `act` (click/type/press)
4. 시각적 확인이 필요하면 `screenshot`

Canvas 렌더:

1. `canvas` → `present`
2. `a2ui_push` (선택)
3. `snapshot`

노드 타기팅:

1. `nodes` → `status`
2. 선택한 노드에서 `describe`
3. `notify` / `run` / `camera_snap` / `screen_record`

## 안전

- 직접적인 `system.run` 는 피하고, 명시적인 사용자 동의가 있을 때만 `nodes` → `run` 를 사용하십시오.
- 카메라/화면 캡처에 대한 사용자 동의를 준수하십시오.
- 미디어 명령을 호출하기 전에 권한을 확인하려면 `status/describe` 를 사용하십시오.

## 도구가 에이전트에 제시되는 방식

도구는 두 개의 병렬 채널로 노출됩니다:

1. **시스템 프롬프트 텍스트**: 사람이 읽을 수 있는 목록 + 가이던스.
2. **도구 스키마**: 모델 API 로 전송되는 구조화된 함수 정의.

즉, 에이전트는 '어떤 도구가 존재하는지' 와 '어떻게 호출하는지' 를 모두 확인합니다. 어떤 도구가 시스템 프롬프트나 스키마에 나타나지 않으면, 모델은 해당 도구를 호출할 수 없습니다.
