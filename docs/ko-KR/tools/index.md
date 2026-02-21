---
summary: "OpenClaw 용 에이전트 도구 인터페이스 (브라우저, 캔버스, 노드, 메시지, 크론)로 레거시 openclaw-* 스킬을 대체합니다."
read_when:
  - 에이전트 도구 추가 또는 수정
  - openclaw-* 스킬 삭제 또는 변경
title: "Tools"
---

# Tools (OpenClaw)

OpenClaw는 브라우저, 캔버스, 노드, 크론을 위한 **일급 에이전트 도구**를 제공합니다. 이는 기존의 `openclaw-*` 스킬을 대체합니다. 도구는 타입화되어 있으며, 쉘 사용을 피하고 에이전트는 이를 직접적으로 의존해야 합니다.

## 도구 비활성화

`openclaw.json`에서 `tools.allow` / `tools.deny`를 통해 전역적으로 도구를 허용/거부할 수 있습니다 (거부가 우선). 이는 모델 프로바이더로 보내지는 비허용 도구를 방지합니다.

```json5
{
  tools: { deny: ["browser"] },
}
```

주요 내용:

- 매칭은 대소문자를 구분하지 않습니다.
- `*`와일드카드가 지원됩니다 (`"*"`은 모든 도구를 의미합니다).
- `tools.allow`가 불명확하거나 로드되지 않은 플러그인 도구 이름만 참조하는 경우, OpenClaw는 경고를 로그에 기록하고 허용 목록을 무시하여 핵심 도구가 계속 사용 가능하게 합니다.

## 도구 프로필 (기본 허용 목록)

`tools.profile`은 `tools.allow`/`tools.deny` 전에 **기본 도구 허용 목록**을 설정합니다. 에이전트별 오버라이드는 `agents.list[].tools.profile`을 사용합니다.

프로필:

- `minimal`: `session_status`만
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: 제한 없음 (미설정과 동일)

예시 (기본적으로 메시징 전용, Slack + Discord 도구도 허용):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

예시 (코딩 프로필이지만 exec/process를 항상 거부):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

예시 (글로벌 코딩 프로필, 메시징 전용 지원 에이전트):

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

`tools.byProvider`를 사용하여 특정 프로바이더 (또는 단일 `provider/model`)에 대한 도구를 **추가적으로 제한**할 수 있습니다. 글로벌 기본값을 변경하지 않고 적용 가능합니다. 에이전트별 오버라이드는 `agents.list[].tools.byProvider`를 사용합니다.

이는 **기본 도구 프로필** 이후 및 허용/거부 목록 전에 적용되며, 도구 집합을 제한할 수만 있습니다. 프로바이더 키는 `provider` (예: `google-antigravity`) 또는 `provider/model` (예: `openai/gpt-5.2`)를 수용합니다.

예시 (글로벌 코딩 프로필 유지, Google Antigravity에 대해 최소 도구 사용):

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

예시 (불안정한 엔드포인트에 대한 프로바이더/모델별 허용 목록):

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

예시 (단일 프로바이더에 대한 에이전트별 오버라이드):

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

## 도구 그룹 (약어)

도구 정책 (글로벌, 에이전트, 샌드박스)은 `group:*` 항목을 사용하여 여러 도구로 확장 가능합니다. 이를 `tools.allow` / `tools.deny`에서 사용하십시오.

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

예시 (파일 도구만 + 브라우저 허용):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## 플러그인 + 도구

플러그인은 핵심 세트를 넘어서 **추가 도구**(및 CLI 명령어)를 등록할 수 있습니다. 설치 및 설정에 대한 정보는 [플러그인](/ko-KR/tools/plugin)을 참조하고 도구 사용 지침이 프롬프트에 주입되는 방식은 [스킬](/ko-KR/tools/skills)을 참조하십시오. 일부 플러그인은 도구와 함께 자체 스킬도 제공합니다 (예: 음성 통화 플러그인).

옵션 플러그인 도구:

- [Lobster](/ko-KR/tools/lobster): 재개 가능한 승인 기능이 있는 타입화된 워크플로우 런타임 (게이트웨이 호스트에 Lobster CLI 필요).
- [LLM Task](/ko-KR/tools/llm-task): 구조화된 워크플로우 출력을 위한 JSON 전용 LLM 단계 (옵션 스키마 검증).

## 도구 인벤토리

### `apply_patch`

하나 이상의 파일에 구조화된 패치를 적용합니다. 다중 헝크 편집에 사용하십시오. 실험적 기능: `tools.exec.applyPatch.enabled`로 활성화 (OpenAI 모델만). `tools.exec.applyPatch.workspaceOnly`는 기본적으로 `true`로 설정되어 있습니다 (워크스페이스에 한정됨). `apply_patch`가 워크스페이스 디렉토리 외부에 쓰기/삭제하도록 하려면 이를 `false`로 설정하세요.

### `exec`

작업 공간에서 셸 명령어를 실행합니다.

핵심 매개변수:

- `command` (필수)
- `yieldMs` (타임아웃 후 자동 백그라운드, 기본값 10000)
- `background` (즉시 백그라운드)
- `timeout` (초; 초과 시 프로세스 종료, 기본값 1800)
- `elevated` (bool; 호스트에서 올라간 모드가 활성화/허용될 경우 실행; 에이전트가 샌드박스 격리된 경우에만 동작 변경)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (`host=node` 시 노드 id/이름)
- 실제 TTY가 필요한가요? `pty: true`를 설정하세요.

주요 내용:

- 백그라운드 상태에서는 `sessionId`와 함께 `status: "running"`을 반환합니다.
- `process`를 사용하여 백그라운드 세션을 폴링/로그/기록/종료/삭제할 수 있습니다.
- `process`가 허용되지 않는 경우, `exec`는 동기식으로 실행하며 `yieldMs`/`background`를 무시합니다.
- `elevated`는 `tools.elevated`와 `agents.list[].tools.elevated` 오버라이드를 모두 허용해야 하며, `host=gateway` + `security=full`의 별칭 역할을 합니다.
- `elevated`는 에이전트가 샌드박스 격리된 경우에만 동작을 변경하며, 그렇지 않으면 동작하지 않습니다.
- `host=node`는 macOS 동반 앱이나 헤드리스 노드 호스트 (`openclaw node run`)를 대상으로 할 수 있습니다.
- 게이트웨이/노드 승인 및 허용 목록: [Exec 승인](/ko-KR/tools/exec-approvals).

### `process`

백그라운드 exec 세션을 관리합니다.

핵심 작업:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

주요 내용:

- `poll`은 새로운 출력과 완료 시 종료 상태를 반환합니다.
- `log`는 라인 기반의 `offset`/`limit`을 지원합니다 (`offset`을 생략하면 마지막 N 라인을 가져옵니다).
- `process`는 에이전트별로 범위가 지정되며, 다른 에이전트의 세션은 보이지 않습니다.

### `loop-detection` (도구 호출 루프 가드레일)

OpenClaw는 최근 도구 호출 이력을 추적하여 반복적인 성과 없는 루프를 감지할 때 차단하거나 경고합니다.
`tools.loopDetection.enabled: true`로 활성화하세요 (기본값은 `false`).

```json5
{
  tools: {
    loopDetection: {
      enabled: true,
      warningThreshold: 10,
      criticalThreshold: 20,
      globalCircuitBreakerThreshold: 30,
      historySize: 30,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: true,
        pingPong: true,
      },
    },
  },
}
```

- `genericRepeat`: 도구와 매개변수가 동일한 반복적인 호출 패턴.
- `knownPollNoProgress`: 동일한 출력의 반복적인 폴링 도구.
- `pingPong`: 진행되지 않는 `A/B/A/B` 반복 패턴.
- 에이전트별 오버라이드: `agents.list[].tools.loopDetection`.

### `web_search`

Brave Search API를 사용하여 웹을 검색합니다.

핵심 매개변수:

- `query` (필수)
- `count` (1–10; 기본값은 `tools.web.search.maxResults`에서 설정)

주요 내용:

- Brave API 키가 필요합니다 (권장: `openclaw configure --section web` 명령어나 `BRAVE_API_KEY` 설정).
- `tools.web.search.enabled`로 활성화.
- 응답은 캐시됩니다 (기본 15분).
- 설정은 [웹 도구](/ko-KR/tools/web)를 참조하십시오.

### `web_fetch`

URL에서 읽을 수 있는 콘텐츠를 추출 (HTML → markdown/text)합니다.

핵심 매개변수:

- `url` (필수)
- `extractMode` (`markdown` | `text`)
- `maxChars` (긴 페이지를 자름)

주요 내용:

- `tools.web.fetch.enabled`로 활성화.
- `maxChars`는 `tools.web.fetch.maxCharsCap`으로 제한됩니다 (기본 50000).
- 응답은 캐시됩니다 (기본 15분).
- JS가 많은 사이트의 경우 브라우저 도구를 선호하십시오.
- 설정은 [웹 도구](/ko-KR/tools/web)를 참조하십시오.
- 선택적 안티봇 대체는 [Firecrawl](/ko-KR/tools/firecrawl)를 참조하십시오.

### `browser`

OpenClaw에서 관리하는 전용 브라우저를 제어합니다.

핵심 작업:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (이미지 블록 + `MEDIA:<path>` 반환)
- `act` (UI 작업: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

프로필 관리:

- `profiles` — 모든 브라우저 프로필을 상태와 함께 나열
- `create-profile` — 자동 할당된 포트(또는 `cdpUrl`)로 새 프로필 생성
- `delete-profile` — 브라우저 중지, 사용자 데이터 삭제, 설정에서 삭제 (로컬 전용)
- `reset-profile` — 고아 프로세스를 프로필의 포트에서 종료 (로컬 전용)

공통 매개변수:

- `profile` (옵션; 기본값은 `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (옵션; 특정 노드 id/이름 선택)

주요 내용:

- `browser.enabled=true`가 필요 (기본값은 `true`; 비활성화하려면 `false`로 설정).
- 모든 작업은 다중 인스턴스 지원을 위한 선택적 `profile` 매개변수를 수용합니다.
- `profile`이 생략되면 "chrome"으로 기본 설정되는 `browser.defaultProfile`을 사용합니다.
- 프로필 이름은 소문자, 영문자 및 하이픈만 허용 (최대 64자).
- 포트 범위: 18800-18899 (~100개 프로필 최대).
- 원격 프로필은 부착 전용 (시작/중지/재설정 없음).
- 브라우저 사용 가능한 노드가 연결된 경우, 도구가 자동으로 해당 노드로 경로를 지정할 수 있습니다 (직접 `target`을 지정하지 않은 경우).
- `snapshot`은 Playwright가 설치된 경우 기본적으로 `ai` 사용; 접근성 트리를 위한 `aria` 사용.
- `snapshot`은 `interactive`, `compact`, `depth`, `selector`와 같은 역할 스냅샷 옵션도 지원하여 `e12`와 같은 참조를 반환합니다.
- `act`는 `snapshot`의 `ref`을 필요로 하며, AI 스냅샷의 숫자 `12` 또는 역할 스냅샷의 `e12` 입니다. 드문 CSS 선택기 필요 시 `evaluate`를 사용하십시오.
- 기본적으로 `act` → `wait`를 피하십시오; 신뢰할 수 있는 UI 상태가 없는 경우에만 사용하십시오.
- `upload`는 선택적으로 무장 후 자동 클릭을 위한 `ref`를 전달할 수 있습니다.
- `upload`는 또한 `<input type="file">`을 직접 설정하기 위한 `inputRef` (aria 참조) 또는 `element` (CSS 선택기)를 지원합니다.

### `canvas`

노드 캔버스를 구동합니다 (present, eval, snapshot, A2UI).

핵심 작업:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (이미지 블록 + `MEDIA:<path>` 반환)
- `a2ui_push`, `a2ui_reset`

주요 내용:

- 게이트웨이 `node.invoke`를 내부적으로 사용합니다.
- `node`가 제공되지 않으면, 도구는 기본값을 선택합니다 (단일 연결 노드 또는 로컬 맥 노드).
- A2UI는 v0.8만 지원 ( `createSurface` 없음); CLI는 v0.9 JSONL을 라인 오류로 거부합니다.
- 빠른 테스트: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.

### `nodes`

짝지어진 노드를 검색하고 대상으로 합니다; 알림을 보내고 카메라/스크린을 캡처합니다.

핵심 작업:

- `status`, `describe`
- `pending`, `approve`, `reject` (페어링)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

주요 내용:

- 카메라/스크린 명령은 노드 앱이 전경에 있어야 합니다.
- 이미지는 이미지 블록 + `MEDIA:<path>`로 반환됩니다.
- 비디오는 `FILE:<path>`(mp4)로 반환됩니다.
- 위치는 JSON 페이로드 (위도/경도/정확도/타임스탬프)로 반환됩니다.
- `run` 매개변수: `command` argv 배열; 옵션으로 `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.

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

핵심 매개변수:

- `image` (필수 경로 또는 URL)
- `prompt` (옵션; 기본값은 "Describe the image.")
- `model` (옵션 오버라이드)
- `maxBytesMb` (옵션 사이즈 제한)

주요 내용:

- `agents.defaults.imageModel`이 구성되었을 때만 사용 가능 (주요 또는 보조), 또는 기본 모델과 구성된 인증에서 암시적 이미지 모델을 유추할 수 있을 때 (최선의 짝짓기).
- 주 채팅 모델과 독립적으로 이미지 모델을 직접 사용합니다.

### `message`

Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams에서 메시지 및 채널 작업을 보냅니다.

핵심 작업:

- `send` (텍스트 + 옵션 미디어; MS Teams는 `card`도 지원, 적응형 카드용)
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

주요 내용:

- `send`는 WhatsApp이 게이트웨이를 통해 라우팅되고, 다른 채널은 직접 연결됩니다.
- `poll`은 WhatsApp과 MS Teams는 게이트웨이를 사용하고, Discord 설문조사는 직접 연결됩니다.
- 메시지 도구 호출이 활성 채팅 세션에 바인딩된 경우, 전송은 그 세션의 대상으로 제한되어 교차 컨텍스트 유출을 방지합니다.

### `cron`

게이트웨이 크론 작업 및 웨이크업을 관리합니다.

핵심 작업:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (시스템 이벤트 큐에 추가 + 선택사항 즉시 하트비트)

주요 내용:

- `add`는 전체 크론 작업 객체가 필요 (`cron.add` RPC와 동일한 스키마).
- `update`는 `{ jobId, patch }`를 사용 (`id`는 호환성을 위해 수용됨).

### `gateway`

실행 중인 게이트웨이 프로세스를 다시 시작하거나 업데이트를 적용합니다 (인플레이스).

핵심 작업:

- `restart` (권한 부여 + 프로세스 내 재시작을 위한 `SIGUSR1` 전송; `openclaw gateway` 인플레이스 재시작)
- `config.get` / `config.schema`
- `config.apply` (유효성 검사 + 설정 기록 + 재시작 + 웨이크)
- `config.patch` (부분 업데이트 병합 + 재시작 + 웨이크)
- `update.run` (업데이트 실행 + 재시작 + 웨이크)

주요 내용:

- 비행 중인 응답을 방해하지 않도록 `delayMs`(기본값 2000)를 사용하십시오.
- `restart`는 기본적으로 활성화되어 있으며, `commands.restart: false`로 비활성화 가능합니다.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

세션 나열, 대화 내역 검사, 또는 다른 세션으로 전송합니다.

핵심 매개변수:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = 없음)
- `sessions_history`: `sessionKey` (또는 `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (또는 `sessionId`), `message`, `timeoutSeconds?` (0 = fire-and-forget)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `thinking?`, `runTimeoutSeconds?`, `thread?`, `mode?`, `cleanup?`
- `session_status`: `sessionKey?` (기본값 현재; `sessionId` 수용), `model?` (`default`는 오버라이드를 해제)

주요 내용:

- `main`은 정규 직접 채팅 키이며, 글로벌/알 수 없는 것은 숨겨집니다.
- `messageLimit > 0`은 각 세션에서 마지막 N개의 메시지를 가져옵니다 (도구 메시지는 필터링됨).
- 세션 타겟팅은 `tools.sessions.visibility`에 의해 제어됩니다 (기본값 `tree`: 현재 세션 + 생성된 하위 에이전트 세션). 여러 사용자를 위한 공유 에이전트를 실행하는 경우, `tools.sessions.visibility: "self"`로 설정하여 교차 세션 탐색을 방지하는 것을 고려하세요.
- `sessions_send`는 `timeoutSeconds > 0`일 때 최종 완료를 대기합니다.
- 전달/공지 사항은 완료 후 발생하고 최선의 결과로만 이루어지며, `status: "ok"`는 에이전트 실행이 완료되었음을 확인하며 공지 사항이 전달되었음을 나타내지 않습니다.
- `sessions_spawn`는 하위 에이전트 실행을 시작하며 요청자 채팅에 공지 답장을 게시합니다.
  - 일회성 모드 (`mode: "run"`)와 지속적인 스레드 바인딩 모드 (`mode: "session"`, `thread: true` 포함)를 지원합니다.
  - `thread: true`이고 `mode`가 생략된 경우 기본값은 `session`입니다.
  - `mode: "session"`은 `thread: true`가 필요합니다.
  - Discord 스레드 바인딩 흐름은 `session.threadBindings.*` 및 `channels.discord.threadBindings.*`에 의존합니다.
  - 답장 형식에는 `Status`, `Result`, 그리고 간단한 통계가 포함됩니다.
  - `Result`는 어시스턴트 완료 텍스트이며, 누락된 경우 최근 `toolResult`가 대체로 사용됩니다.
- 수동 완료 모드 생성은 먼저 직접 전송하며, 일시적 실패에 대한 대기열 대체 및 재시도가 있습니다 (`status: "ok"`는 실행이 완료되었음을 의미하며, 공지가 전달되었음을 의미하지 않음).
- `sessions_spawn`는 비차단이며 `status: "accepted"`를 즉시 반환합니다.
- `sessions_send`는 답장 백 핑퐁을 실행합니다 (답장 `REPLY_SKIP`으로 중단; `session.agentToAgent.maxPingPongTurns`를 통해 최대 턴 설정, 0–5).
- 핑퐁 후 대상 에이전트는 **announce step**을 실행하며, 공지 사항을 억제하려면 `ANNOUNCE_SKIP`으로 답장하세요.
- 샌드박스 제한: 현재 세션이 샌드박스 격리되고 `agents.defaults.sandbox.sessionToolsVisibility: "spawned"`인 경우, OpenClaw는 `tools.sessions.visibility`를 `tree`로 제한합니다.

### `agents_list`

현재 세션이 `sessions_spawn`으로 타겟팅할 수 있는 에이전트 ID를 나열합니다.

주요 내용:

- 결과는 에이전트별 허용 목록 (`agents.list[].subagents.allowAgents`)으로 제한됩니다.
- `["*"]`이 구성된 경우, 도구는 구성된 모든 에이전트를 포함하며 `allowAny: true`로 표시됩니다.

### `agents_list`

현재 세션이 `sessions_spawn`으로 타겟팅할 수 있는 에이전트 ID를 나열합니다.

주요 내용:

- 결과는 에이전트별 허용 목록 (`agents.list[].subagents.allowAgents`)으로 제한됩니다.
- `["*"]`이 구성된 경우, 도구는 구성된 모든 에이전트를 포함하며 `allowAny: true`로 표시됩니다.

## 매개변수 (공통)

게이트웨이가 지원하는 도구 (`canvas`, `nodes`, `cron`):

- `gatewayUrl` (기본값 `ws://127.0.0.1:18789`)
- `gatewayToken` (인증 활성화 시)
- `timeoutMs`

참고: `gatewayUrl`이 설정된 경우, `gatewayToken`을 명시적으로 포함하십시오. 도구는 재정의를 위한 구성이나 환경 자격 증명을 상속하지 않으며, 명시적 자격 증명이 없으면 오류가 발생합니다.

브라우저 도구:

- `profile` (옵션; 기본값은 `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (옵션; 특정 노드 id/이름 고정)

## 추천 에이전트 흐름

브라우저 자동화:

1. `browser` → `status` / `start`
2. `snapshot` (ai 또는 aria)
3. `act` (click/type/press)
4. 시각적 확인이 필요한 경우 `screenshot`

캔버스 렌더링:

1. `canvas` → `present`
2. `a2ui_push` (선택사항)
3. `snapshot`

노드 타겟팅:

1. `nodes` → `status`
2. 선택한 노드를 `describe`
3. `notify` / `run` / `camera_snap` / `screen_record`

## 안전성

- 직접적인 `system.run` 사용을 피하십시오; 사용자의 명시적 동의가 있을 때만 `nodes` → `run`을 사용하십시오.
- 카메라/스크린 캡처에 대한 사용자 동의를 존중하십시오.
- 미디어 명령을 실행하기 전에 `status/describe`를 사용하여 권한을 확인하십시오.

## 에이전트에게 도구가 제공되는 방법

도구는 두 개의 병렬 채널로 노출됩니다:

1. **시스템 프롬프트 텍스트**: 사람이 읽을 수 있는 목록 및 지침.
2. **도구 스키마**: 모델 API에 전송되는 구조화된 함수 정의.

이는 에이전트가 "어떤 도구가 존재하는지"와 "어떻게 호출하는지"를 모두 확인한다는 것을 의미합니다. 도구가 시스템 프롬프트나 스키마에 나타나지 않으면 모델이 호출할 수 없습니다.
