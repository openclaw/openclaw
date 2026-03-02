---
summary: "OpenClaw 에이전트 도구 surface (browser, canvas, nodes, message, cron) - 레거시 `openclaw-*` skills 대체"
read_when:
  - 에이전트 도구 추가 또는 수정 중
  - `openclaw-*` skills 사용 중단 또는 변경 중
title: "도구"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: tools/index.md
  workflow: 15
---

# 도구 (OpenClaw)

OpenClaw 는 browser, canvas, nodes 및 cron 을 위한 **first-class agent tools** 을 노출합니다.
이는 오래된 `openclaw-*` skills 을 대체합니다: tools 은 typed 이고 shelling 이 없으며
에이전트는 이들에 직접 의존해야 합니다.

## 도구 비활성화

`openclaw.json` 의 `tools.allow` / `tools.deny` 를 통해 전역적으로 도구를 허용/거부할 수 있습니다
(deny 가 wins). 이는 허용되지 않은 도구가 모델 공급자에게 전송되는 것을 방지합니다.

```json5
{
  tools: { deny: ["browser"] },
}
```

참고:

- Matching 은 대소문자를 구분하지 않습니다.
- `*` 와일드카드는 지원됩니다 (`"*"` 은 모든 도구를 의미).
- `tools.allow` 가 알 수 없는 또는 로드되지 않은 플러그인 도구 이름만 참조하면 OpenClaw 는 경고를 로깅하고 허용 목록을 무시하여 core tools 이 사용 가능하게 유지됩니다.

## 도구 프로필 (기본 허용 목록)

`tools.profile` 은 `tools.allow`/`tools.deny` 전에 **기본 도구 허용 목록을** 설정합니다.
에이전트별 재정의: `agents.list[].tools.profile`.

프로필:

- `minimal`: `session_status` 만
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: 제한 없음 (미설정과 동일)

예제 (기본적으로 messaging 만, Slack + Discord tools 도 허용):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

예제 (coding profile, 하지만 모든 곳에서 exec/process 거부):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

예제 (글로벌 coding profile, messaging 만 support agent):

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

## 공급자별 도구 정책

`tools.byProvider` 를 사용하여 글로벌 기본값을 변경하지 않고
특정 공급자 (또는 단일 `provider/model`) 에 대한 도구를 **추가로 제한합니다**.
에이전트별 재정의: `agents.list[].tools.byProvider`.

이는 기본 도구 프로필 **이후에**, allow/deny 목록 **이전에** 적용되므로
도구 세트를 좁힐 수만 있습니다.
공급자 키는 `provider` (예: `google-antigravity`) 또는
`provider/model` (예: `openai/gpt-5.2`) 을 수락합니다.

예제 (글로벌 coding profile 유지, 하지만 Google Antigravity 에 대해 minimal tools):

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

예제 (flaky endpoint 에 대한 공급자/모델별 허용 목록):

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

예제 (단일 공급자에 대한 에이전트별 재정의):

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

## 도구 그룹 (shorthand)

도구 정책 (글로벌, 에이전트, 샌드박스) 은 여러 도구로 확장되는 `group:*` 항목을 지원합니다.
`tools.allow` / `tools.deny` 에서 이들을 사용합니다.

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
- `group:openclaw`: 모든 built-in OpenClaw tools (공급자 플러그인 제외)

예제 (file tools + browser 만 허용):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## 플러그인 + 도구

플러그인은 core 세트 외에 **추가 도구** (및 CLI 명령) 를 등록할 수 있습니다.
설치 + 구성은 [플러그인](/tools/plugin) 을 참고하고, tool 사용 안내가 prompts 에 어떻게 주입되는지는 [스킬](/tools/skills) 을 참고하세요. 일부 플러그인은 도구와 함께 자신의 스킬을 제공합니다 (예: voice-call 플러그인).

선택 사항인 플러그인 도구:

- [Lobster](/tools/lobster): resumable approvals 가 있는 typed workflow runtime (gateway host 에서 Lobster CLI 필요).
- [LLM Task](/tools/llm-task): structured workflow output 을 위한 JSON 전용 LLM step (optional schema validation).
- [Diffs](/tools/diffs): before/after text 또는 unified patches 에 대한 read-only diff viewer 및 PNG renderer.

## 도구 inventory

### `apply_patch`

하나 이상의 파일 전체에 구조화된 patches 를 적용합니다. Multi-hunk edits 에 사용합니다.
실험적: `tools.exec.applyPatch.enabled` 를 통해 활성화 (OpenAI models 만).
`tools.exec.applyPatch.workspaceOnly` 는 기본값 `true` (workspace-contained). workspace directory 외부에 쓰기/삭제하려고 의도적으로 원하면 `false` 로 설정합니다.

### `exec`

워크스페이스에서 shell 명령을 실행합니다.

핵심 매개변수:

- `command` (필수)
- `yieldMs` (timeout 후 auto-background, 기본 10000)
- `background` (즉시 background)
- `timeout` (초. 초과 시 프로세스 kill, 기본 1800)
- `elevated` (bool. elevated mode 가 활성화/허용된 경우 host 에서 실행. 에이전트가 샌드박스될 때만 동작 변경)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (host=node 의 node id/name)
- 실제 TTY 가 필요합니까? `pty: true` 를 설정합니다.

참고:

- background 될 때 `status: "running"` 과 `sessionId` 를 반환합니다.
- `process` 를 사용하여 background 세션을 poll/log/write/kill/clear 합니다.
- `process` 가 허용되지 않으면 `exec` 는 동기적으로 실행되고 `yieldMs`/`background` 를 무시합니다.
- `elevated` 는 `tools.elevated` plus 모든 `agents.list[].tools.elevated` 재정의로 게이트됩니다 (둘 다 허용해야) 그리고 `host=gateway` + `security=full` 의 alias 입니다.
- `elevated` 는 에이전트가 샌드박스될 때만 동작을 변경합니다 (그렇지 않으면 no-op).
- `host=node` 는 macOS companion app 또는 headless node host (`openclaw node run`) 을 대상으로 할 수 있습니다.
- gateway/node approvals 및 allowlists: [Exec approvals](/tools/exec-approvals).

### `process`

background exec 세션을 관리합니다.

핵심 작업:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

참고:

- `poll` 은 새 output 과 exit status (완료 시) 를 반환합니다.
- `log` 은 line-based `offset`/`limit` 를 지원합니다 (last N lines 을 가져오려면 `offset` 을 생략합니다).
- `process` 는 에이전트별로 범위가 지정됩니다. 다른 에이전트의 세션은 보이지 않습니다.

### `loop-detection` (tool-call loop 방어)

OpenClaw 는 최근 tool-call 이력을 추적하고 반복적인 no-progress 루프를 감지할 때 차단하거나 경고합니다.
`tools.loopDetection.enabled: true` 로 활성화 (기본값 `false`).

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

- `genericRepeat`: 반복되는 같은 tool + 같은 params call pattern.
- `knownPollNoProgress`: identical outputs 을 사용하여 반복되는 poll-like tools.
- `pingPong`: alternating `A/B/A/B` no-progress patterns.
- 에이전트별 재정의: `agents.list[].tools.loopDetection`.

### `web_search`

Brave Search API 를 사용하여 웹을 검색합니다.

핵심 매개변수:

- `query` (필수)
- `count` (1–10. `tools.web.search.maxResults` 에서의 기본값)

참고:

- Brave API key 필요 (권장: `openclaw configure --section web`, 또는 `BRAVE_API_KEY` 설정).
- `tools.web.search.enabled` 를 통해 활성화.
- 응답은 cached (기본 15 분).
- 설정은 [Web tools](/tools/web) 을 참고하세요.

### `web_fetch`

URL 에서 읽을 수 있는 콘텐츠를 가져오고 추출합니다 (HTML → markdown/text).

핵심 매개변수:

- `url` (필수)
- `extractMode` (`markdown` | `text`)
- `maxChars` (긴 페이지 truncate)

참고:

- `tools.web.fetch.enabled` 를 통해 활성화.
- `maxChars` 는 `tools.web.fetch.maxCharsCap` 로 고정됩니다 (기본 50000).
- 응답은 cached (기본 15 분).
- JS-heavy sites 의 경우 browser tool 을 선호합니다.
- 설정은 [Web tools](/tools/web) 을 참고하세요.
- optional anti-bot fallback 은 [Firecrawl](/tools/firecrawl) 을 참고하세요.

### `browser`

dedicated OpenClaw-managed browser 를 제어합니다.

핵심 작업:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (image block + `MEDIA:<path>` 반환)
- `act` (UI actions: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

프로필 관리:

- `profiles` — 상태가 있는 모든 browser 프로필 나열
- `create-profile` — auto-allocated port 로 새 프로필 생성 (또는 `cdpUrl`)
- `delete-profile` — browser stop, 사용자 데이터 삭제, 구성에서 제거 (로컬만)
- `reset-profile` — 프로필의 포트에서 orphan process kill (로컬만)

공통 매개변수:

- `profile` (선택 사항. 기본값 `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (선택 사항. 특정 node id/name 선택)

참고:

- `browser.enabled=true` 필요 (기본값 `true`. `false` 로 설정하여 비활성화).
- 모든 작업은 multi-instance support 을 위해 선택 사항 `profile` 매개변수를 수락합니다.
- `profile` 이 생략되면 `browser.defaultProfile` 을 사용합니다 (기본값 "chrome").
- 프로필 이름: 소문자 alphanumeric + hyphens 만 (최대 64 chars).
- 포트 범위: 18800-18899 (~100 profiles max).
- Remote profiles 은 attach-only (start/stop/reset 없음).
- browser-capable node 가 연결되면 tool 은 자동으로 라우팅할 수 있습니다 (`target` 을 pin 하지 않으면).
- `snapshot` 은 Playwright 가 설치되었을 때 기본값 `ai`. aria 의 경우 `aria` 사용 (accessibility tree).
- `snapshot` 은 role-snapshot options 도 지원합니다 (`interactive`, `compact`, `depth`, `selector`) - `e12` 와 같은 refs 반환.
- `act` 는 `snapshot` 에서 `ref` 를 필요로 합니다 (AI snapshots 의 numeric `12`, 또는 role snapshots 의 `e12`). rare CSS selector needs 에 `evaluate` 사용.
- `act` → `wait` 을 기본값으로 피하세요. exceptional cases 에서만 사용하세요 (reliable UI state 가 없을 때).
- `upload` 은 optionally arm 후 auto-click 하는 `ref` 를 전달할 수 있습니다.
- `upload` 은 `inputRef` (aria ref) 또는 `element` (CSS selector) 도 지원하여 `<input type="file">` 을 직접 설정합니다.

### `canvas`

node Canvas 를 드라이브합니다 (present, eval, snapshot, A2UI).

핵심 작업:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (image block + `MEDIA:<path>` 반환)
- `a2ui_push`, `a2ui_reset`

참고:

- gateway `node.invoke` 를 hood 아래에서 사용합니다.
- `node` 가 제공되지 않으면 tool 이 기본값을 선택합니다 (connected node 또는 local mac node 단일).
- A2UI 는 v0.8 만 (`createSurface` 없음). CLI 는 `v0.9` JSONL 을 line errors 로 거부합니다.
- 빠른 smoke: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.

### `nodes`

paired nodes 를 discover 및 target. notifications 전송. camera/screen capture.

핵심 작업:

- `status`, `describe`
- `pending`, `approve`, `reject` (pairing)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_list`, `camera_snap`, `camera_clip`, `screen_record`
- `location_get`, `notifications_list`, `notifications_action`
- `device_status`, `device_info`, `device_permissions`, `device_health`

참고:

- Camera/screen 명령은 node app 을 foregrounded 로 요구합니다.
- Images 는 image blocks + `MEDIA:<path>` 반환.
- Videos 는 `FILE:<path>` (mp4) 반환.
- Location 은 JSON payload (lat/lon/accuracy/timestamp) 반환.
- `run` params: `command` argv array. optional `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.

예제 (`run`):

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

configured image model 로 image 분석.

핵심 매개변수:

- `image` (필수 path 또는 URL)
- `prompt` (선택 사항. 기본값 "Describe the image.")
- `model` (선택 사항 재정의)
- `maxBytesMb` (선택 사항 크기 제한)

참고:

- `agents.defaults.imageModel` 이 configured (primary 또는 fallbacks) 될 때만 사용 가능, 또는 default model + configured auth (best-effort pairing) 에서 implicit image model 을 infer 할 수 있을 때.
- image model 을 직접 사용합니다 (main chat model 과 독립적).

### `message`

Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams 전체에서 메시지 및 채널 작업을 전송합니다.

핵심 작업:

- `send` (text + optional media. MS Teams 는 Adaptive Cards 에 대해 `card` 도 지원)
- `poll` (WhatsApp/Discord/MS Teams polls)
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

- `send` 는 WhatsApp 을 Gateway 를 통해 라우팅. 다른 채널은 direct.
- `poll` 는 WhatsApp 및 MS Teams 에 대해 Gateway 를 사용. Discord polls 는 direct.
- message tool call 이 활성 chat 세션에 바인딩되면 sends 는 cross-context leaks 를 피하기 위해 해당 세션의 target 으로 제한됩니다.

### `cron`

Gateway cron jobs 및 wakeups 를 관리합니다.

핵심 작업:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (enqueue system event + optional immediate heartbeat)

참고:

- `add` 는 전체 cron job object 를 기대합니다 (`cron.add` RPC 와 같은 스키마).
- `update` 는 `{ jobId, patch }` 를 사용합니다 (호환성을 위해 `id` 허용).

### `gateway`

running Gateway process 를 재시작하거나 in-place 업데이트를 적용합니다.

핵심 작업:

- `restart` (authorize + `SIGUSR1` 을 in-process restart 에 전송. `openclaw gateway` in-place restart)
- `config.get` / `config.schema`
- `config.apply` (validate + write config + restart + wake)
- `config.patch` (merge partial update + restart + wake)
- `update.run` (run update + restart + wake)

참고:

- `delayMs` (기본값 2000) 을 사용하여 in-flight reply 를 interrupting 피하세요.
- `restart` 는 기본값으로 활성화. `commands.restart: false` 로 설정하여 비활성화.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

List sessions, inspect transcript history, 또는 another session 에 전송합니다.

핵심 매개변수:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = none)
- `sessions_history`: `sessionKey` (또는 `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (또는 `sessionId`), `message`, `timeoutSeconds?` (0 = fire-and-forget)
- `sessions_spawn`: `task`, `label?`, `runtime?`, `agentId?`, `model?`, `thinking?`, `cwd?`, `runTimeoutSeconds?`, `thread?`, `mode?`, `cleanup?`, `sandbox?`
- `session_status`: `sessionKey?` (기본값 current. `sessionId` 수락), `model?` (`default` clears override)

참고:

- `main` 은 canonical direct-chat key. global/unknown 은 hidden.
- `messageLimit > 0` 는 session 당 last N messages 를 가져옵니다 (tool messages filtered).
- Session targeting 은 `tools.sessions.visibility` 로 제어됩니다 (기본값 `tree`: current session + spawned subagent sessions). shared agent 를 여러 사용자에게 실행하면 cross-session browsing 를 방지하기 위해 `tools.sessions.visibility: "self"` 로 설정을 고려하세요.
- `sessions_send` 는 `timeoutSeconds > 0` 일 때 최종 완료를 기다립니다.
- Delivery/announce 는 완료 후 발생하며 best-effort. `status: "ok"` 는 agent run 이 완료되었음을 확인하지만 announce 가 전달되었음은 아닙니다.
- `sessions_spawn` 은 `runtime: "subagent" | "acp"` 를 지원합니다 (`subagent` 기본값). ACP runtime behavior 는 [ACP Agents](/tools/acp-agents) 를 참고하세요.
- `sessions_spawn` 은 sub-agent run 을 시작하고 requester chat 으로 announce reply 를 게시합니다.
  - One-shot mode (`mode: "run"`) 및 persistent thread-bound mode (`mode: "session"` with `thread: true`) 지원.
  - `thread: true` 이고 `mode` 이 생략되면 mode 기본값 `session`.
  - `mode: "session"` 은 `thread: true` 필요.
  - `runTimeoutSeconds` 이 생략되면 OpenClaw 는 설정될 때 `agents.defaults.subagents.runTimeoutSeconds` 를 사용. 그렇지 않으면 timeout 기본값 `0` (no timeout).
  - Discord thread-bound flows 는 `session.threadBindings.*` 및 `channels.discord.threadBindings.*` 를 depend.
  - Reply format 은 `Status`, `Result` 및 compact stats 를 포함합니다.
  - `Result` 는 assistant completion text. 누락되면 latest `toolResult` 를 fallback 으로 사용합니다.
- Manual completion-mode spawns 는 directly first 를 send 한 후 queue fallback 및 retry (transient failures. `status: "ok"` 는 run 완료를 의미하며 announce 전달이 아님).
- `sessions_spawn` 은 non-blocking 이며 `status: "accepted"` 를 즉시 반환합니다.
- `sessions_send` 는 reply‑back ping‑pong 을 실행합니다 (`REPLY_SKIP` 을 reply 하여 stop. max turns via `session.agentToAgent.maxPingPongTurns`, 0–5).
- ping‑pong 이후 target agent 는 **announce step** 을 실행합니다. `ANNOUNCE_SKIP` 을 reply 하여 announcement 를 suppress합니다.
- Sandbox clamp: current session 이 샌드박스되고 `agents.defaults.sandbox.sessionToolsVisibility: "spawned"` 일 때 OpenClaw 는 `tools.sessions.visibility` 를 `tree` 로 clamps합니다.

### `agents_list`

current session 이 `sessions_spawn` 으로 target 할 수 있는 agent ids 를 나열합니다.

참고:

- 결과는 per-agent allowlists 로 제한됩니다 (`agents.list[].subagents.allowAgents`).
- `["*"]` 이 configured 되면 tool 은 모든 configured agents 를 포함하고 `allowAny: true` 로 표시합니다.

## 매개변수 (공통)

Gateway-backed tools (`canvas`, `nodes`, `cron`):

- `gatewayUrl` (기본 `ws://127.0.0.1:18789`)
- `gatewayToken` (auth enabled 경우)
- `timeoutMs`

참고: `gatewayUrl` 이 설정되면 명시적으로 `gatewayToken` 포함. Tools 는 config 또는 environment credentials 을 override 에 대해 상속하지 않으며 missing explicit credentials 는 error.

Browser tool:

- `profile` (선택 사항. 기본값 `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (선택 사항. specific node id/name pin)

## 권장 agent flows

Browser automation:

1. `browser` → `status` / `start`
2. `snapshot` (ai 또는 aria)
3. `act` (click/type/press)
4. `screenshot` (visual confirmation 필요한 경우)

Canvas render:

1. `canvas` → `present`
2. `a2ui_push` (선택 사항)
3. `snapshot`

Node targeting:

1. `nodes` → `status`
2. chosen node 에 `describe`
3. `notify` / `run` / `camera_snap` / `screen_record`

## 보안

- direct `system.run` 을 피하세요. `nodes` → `run` 은 명시적 user consent 로만 사용하세요.
- camera/screen capture 에 대해 user consent 를 존중합니다.
- `status/describe` 을 사용하여 media 명령을 invoke 전에 permissions 를 확보합니다.

## tools 가 agent 에 제시되는 방식

Tools 은 두 가지 parallel channels 에서 노출됩니다:

1. **System prompt text**: 사람이 읽을 수 있는 list + guidance.
2. **Tool schema**: model API 에 전송되는 structured function 정의들.

이는 agent 가 "어떤 tools 이 존재하는가" 와 "이들을 호출하는 방법" 을 모두 봅니다. Tool 이
system prompt 또는 schema 에 나타나지 않으면 model 은 이를 호출할 수 없습니다.
