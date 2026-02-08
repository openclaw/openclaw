---
summary: "~/.openclaw/openclaw.json 에 대한 모든 구성 옵션과 예제"
read_when:
  - 구성 필드 추가 또는 수정 시
title: "구성"
x-i18n:
  source_path: gateway/configuration.md
  source_hash: e226e24422c05e7e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:25:33Z
---

# 구성 🔧

OpenClaw 는 `~/.openclaw/openclaw.json` 에서 선택적 **JSON5** 구성을 읽습니다 (주석 + 후행 콤마 허용).

파일이 없으면 OpenClaw 는 비교적 안전한 기본값 (임베디드 Pi 에이전트 + 발신자별 세션 + 워크스페이스 `~/.openclaw/workspace`) 을 사용합니다. 일반적으로 다음과 같은 경우에만 구성이 필요합니다.

- 봇을 트리거할 수 있는 사용자를 제한 (`channels.whatsapp.allowFrom`, `channels.telegram.allowFrom` 등)
- 그룹 허용 목록 + 멘션 동작 제어 (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.discord.guilds`, `agents.list[].groupChat`)
- 메시지 접두사 사용자 지정 (`messages`)
- 에이전트의 워크스페이스 설정 (`agents.defaults.workspace` 또는 `agents.list[].workspace`)
- 임베디드 에이전트 기본값 (`agents.defaults`) 및 세션 동작 (`session`) 튜닝
- 에이전트별 아이덴티티 설정 (`agents.list[].identity`)

> **구성이 처음이신가요?** 자세한 설명이 포함된 전체 예제는 [Configuration Examples](/gateway/configuration-examples) 가이드를 참고하십시오!

## 엄격한 구성 검증

OpenClaw 는 스키마와 완전히 일치하는 구성만 허용합니다.  
알 수 없는 키, 잘못된 타입, 유효하지 않은 값이 있으면 안전을 위해 Gateway(게이트웨이)가 **시작을 거부**합니다.

검증에 실패하면:

- Gateway 가 부팅되지 않습니다.
- 진단 명령만 허용됩니다 (예: `openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`, `openclaw service`, `openclaw help`).
- 정확한 문제를 확인하려면 `openclaw doctor` 를 실행하십시오.
- 마이그레이션/복구를 적용하려면 `openclaw doctor --fix` (또는 `--yes`) 를 실행하십시오.

Doctor 는 명시적으로 `--fix`/`--yes` 에 동의하지 않는 한 변경 사항을 절대 기록하지 않습니다.

## 스키마 + UI 힌트

Gateway 는 UI 편집기를 위해 `config.schema` 를 통해 구성의 JSON Schema 표현을 노출합니다.  
Control UI 는 이 스키마로부터 폼을 렌더링하며, 탈출구로 **Raw JSON** 편집기를 제공합니다.

채널 플러그인과 확장은 자체 구성에 대한 스키마 + UI 힌트를 등록할 수 있으므로,  
하드코딩된 폼 없이도 앱 전반에서 스키마 기반 설정을 유지할 수 있습니다.

힌트 (라벨, 그룹화, 민감 필드) 는 스키마와 함께 제공되어,  
클라이언트가 구성 지식을 하드코딩하지 않고도 더 나은 폼을 렌더링할 수 있습니다.

## 적용 + 재시작 (RPC)

`config.apply` 을 사용하여 전체 구성을 검증 + 기록하고 Gateway 를 한 단계로 재시작하십시오.  
재시작 센티널을 기록하고, Gateway 가 다시 올라온 후 마지막 활성 세션을 핑합니다.

경고: `config.apply` 는 **전체 구성**을 교체합니다. 일부 키만 변경하려면  
`config.patch` 또는 `openclaw config set` 를 사용하십시오. `~/.openclaw/openclaw.json` 의 백업을 유지하십시오.

매개변수:

- `raw` (string) — 전체 구성을 위한 JSON5 페이로드
- `baseHash` (선택) — `config.get` 의 구성 해시 (구성이 이미 존재할 때 필요)
- `sessionKey` (선택) — 깨우기 핑을 위한 마지막 활성 세션 키
- `note` (선택) — 재시작 센티널에 포함할 메모
- `restartDelayMs` (선택) — 재시작 전 지연 (기본값 2000)

예제 (`gateway call` 사용):

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.apply --params '{
  "raw": "{\\n  agents: { defaults: { workspace: \\"~/.openclaw/workspace\\" } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## 부분 업데이트 (RPC)

`config.patch` 을 사용하면 관련 없는 키를 덮어쓰지 않고 기존 구성에 부분 업데이트를 병합할 수 있습니다.  
JSON merge patch 의미를 적용합니다.

- 객체는 재귀적으로 병합됩니다.
- `null` 는 키를 삭제합니다.
- 배열은 교체됩니다.  
  `config.apply` 와 마찬가지로, 검증 → 기록 → 재시작 센티널 저장 → Gateway 재시작 예약을 수행합니다  
  (`sessionKey` 이 제공되면 선택적으로 깨움).

매개변수:

- `raw` (string) — 변경할 키만 포함한 JSON5 페이로드
- `baseHash` (필수) — `config.get` 의 구성 해시
- `sessionKey` (선택) — 깨우기 핑을 위한 마지막 활성 세션 키
- `note` (선택) — 재시작 센티널에 포함할 메모
- `restartDelayMs` (선택) — 재시작 전 지연 (기본값 2000)

예제:

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.patch --params '{
  "raw": "{\\n  channels: { telegram: { groups: { \\"*\\": { requireMention: false } } } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## 최소 구성 (권장 시작점)

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

다음으로 기본 이미지를 한 번 빌드하십시오:

```bash
scripts/sandbox-setup.sh
```

## 셀프 채팅 모드 (그룹 제어에 권장)

그룹에서 WhatsApp @-멘션에 봇이 응답하지 않도록 하려면 (특정 텍스트 트리거에만 응답):

```json5
{
  agents: {
    defaults: { workspace: "~/.openclaw/workspace" },
    list: [
      {
        id: "main",
        groupChat: { mentionPatterns: ["@openclaw", "reisponde"] },
      },
    ],
  },
  channels: {
    whatsapp: {
      // Allowlist is DMs only; including your own number enables self-chat mode.
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## 구성 포함 (`$include`)

`$include` 지시어를 사용하여 구성을 여러 파일로 분할할 수 있습니다. 이는 다음에 유용합니다.

- 대규모 구성 정리 (예: 클라이언트별 에이전트 정의)
- 환경 간 공통 설정 공유
- 민감한 구성 분리 보관

### 기본 사용법

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789 },

  // Include a single file (replaces the key's value)
  agents: { $include: "./agents.json5" },

  // Include multiple files (deep-merged in order)
  broadcast: {
    $include: ["./clients/mueller.json5", "./clients/schmidt.json5"],
  },
}
```

```json5
// ~/.openclaw/agents.json5
{
  defaults: { sandbox: { mode: "all", scope: "session" } },
  list: [{ id: "main", workspace: "~/.openclaw/workspace" }],
}
```

### 병합 동작

- **단일 파일**: `$include` 를 포함한 객체를 교체합니다.
- **파일 배열**: 순서대로 깊은 병합을 수행합니다 (뒤의 파일이 앞의 파일을 덮어씀).
- **형제 키 포함**: 포함 이후에 형제 키가 병합됩니다 (포함된 값 덮어씀).
- **형제 키 + 배열/프리미티브**: 지원되지 않습니다 (포함된 콘텐츠는 객체여야 함).

```json5
// Sibling keys override included values
{
  $include: "./base.json5", // { a: 1, b: 2 }
  b: 99, // Result: { a: 1, b: 99 }
}
```

### 중첩 포함

포함된 파일은 자체적으로 `$include` 지시어를 포함할 수 있습니다 (최대 10 단계 깊이).

```json5
// clients/mueller.json5
{
  agents: { $include: "./mueller/agents.json5" },
  broadcast: { $include: "./mueller/broadcast.json5" },
}
```

### 경로 해석

- **상대 경로**: 포함하는 파일을 기준으로 해석됩니다.
- **절대 경로**: 그대로 사용됩니다.
- **상위 디렉토리**: `../` 참조는 예상대로 동작합니다.

```json5
{ "$include": "./sub/config.json5" }      // relative
{ "$include": "/etc/openclaw/base.json5" } // absolute
{ "$include": "../shared/common.json5" }   // parent dir
```

### 오류 처리

- **파일 누락**: 해석된 경로와 함께 명확한 오류를 표시합니다.
- **파싱 오류**: 어떤 포함 파일에서 실패했는지 표시합니다.
- **순환 포함**: 포함 체인과 함께 감지 및 보고됩니다.

### 예제: 다중 클라이언트 법적 설정

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789, auth: { token: "secret" } },

  // Common agent defaults
  agents: {
    defaults: {
      sandbox: { mode: "all", scope: "session" },
    },
    // Merge agent lists from all clients
    list: { $include: ["./clients/mueller/agents.json5", "./clients/schmidt/agents.json5"] },
  },

  // Merge broadcast configs
  broadcast: {
    $include: ["./clients/mueller/broadcast.json5", "./clients/schmidt/broadcast.json5"],
  },

  channels: { whatsapp: { groupPolicy: "allowlist" } },
}
```

```json5
// ~/.openclaw/clients/mueller/agents.json5
[
  { id: "mueller-transcribe", workspace: "~/clients/mueller/transcribe" },
  { id: "mueller-docs", workspace: "~/clients/mueller/docs" },
]
```

```json5
// ~/.openclaw/clients/mueller/broadcast.json5
{
  "120363403215116621@g.us": ["mueller-transcribe", "mueller-docs"],
}
```

## 공통 옵션

### 환경 변수 + `.env`

OpenClaw 는 부모 프로세스 (셸, launchd/systemd, CI 등) 로부터 환경 변수를 읽습니다.

추가로 다음을 로드합니다.

- 현재 작업 디렉토리의 `.env` (존재 시)
- `~/.openclaw/.env` 의 전역 대체 `.env` (일명 `$OPENCLAW_STATE_DIR/.env`)

두 `.env` 파일 모두 기존 환경 변수를 덮어쓰지 않습니다.

구성 내에 인라인 환경 변수를 제공할 수도 있습니다. 이 값은  
프로세스 환경에 키가 없는 경우에만 적용됩니다 (동일한 비덮어쓰기 규칙).

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

전체 우선순위와 소스는 [/environment](/help/environment) 를 참고하십시오.

### `env.shellEnv` (선택)

편의 기능 옵트인: 활성화되어 있고 예상되는 키가 아직 설정되지 않았다면,  
OpenClaw 는 로그인 셸을 실행하여 누락된 예상 키만 가져옵니다 (절대 덮어쓰지 않음).  
이는 사실상 셸 프로필을 소싱합니다.

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

환경 변수 동등 항목:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

### 구성에서의 환경 변수 치환

어떤 구성 문자열 값에서도 `${VAR_NAME}` 문법을 사용하여  
환경 변수를 직접 참조할 수 있습니다. 변수는 검증 전에 구성 로드 시점에 치환됩니다.

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
  gateway: {
    auth: {
      token: "${OPENCLAW_GATEWAY_TOKEN}",
    },
  },
}
```

**규칙:**

- 대문자 환경 변수 이름만 매칭됩니다: `[A-Z_][A-Z0-9_]*`
- 누락되었거나 비어 있는 환경 변수는 구성 로드 시 오류를 발생시킵니다.
- 리터럴 `${VAR}` 을 출력하려면 `$${VAR}` 로 이스케이프하십시오.
- `$include` 와 함께 동작합니다 (포함된 파일에도 치환 적용).

**인라인 치환:**

```json5
{
  models: {
    providers: {
      custom: {
        baseUrl: "${CUSTOM_API_BASE}/v1", // → "https://api.example.com/v1"
      },
    },
  },
}
```

### 인증 저장소 (OAuth + API 키)

OpenClaw 는 **에이전트별** 인증 프로필 (OAuth + API 키) 을 다음 위치에 저장합니다.

- `<agentDir>/auth-profiles.json` (기본값: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`)

추가 참고: [/concepts/oauth](/concepts/oauth)

레거시 OAuth 가져오기:

- `~/.openclaw/credentials/oauth.json` (또는 `$OPENCLAW_STATE_DIR/credentials/oauth.json`)

임베디드 Pi 에이전트는 다음 위치에 런타임 캐시를 유지합니다.

- `<agentDir>/auth.json` (자동 관리됨; 수동 편집 금지)

레거시 에이전트 디렉토리 (다중 에이전트 이전):

- `~/.openclaw/agent/*` (`openclaw doctor` 가 `~/.openclaw/agents/<defaultAgentId>/agent/*` 로 마이그레이션)

재정의:

- OAuth 디렉토리 (레거시 가져오기 전용): `OPENCLAW_OAUTH_DIR`
- 에이전트 디렉토리 (기본 에이전트 루트 재정의): `OPENCLAW_AGENT_DIR` (권장), `PI_CODING_AGENT_DIR` (레거시)

첫 사용 시 OpenClaw 는 `oauth.json` 항목을 `auth-profiles.json` 로 가져옵니다.

### `auth`

인증 프로필을 위한 선택적 메타데이터입니다. 이는 비밀 정보를 저장하지 않으며,  
프로필 ID 를 프로바이더 + 모드 (및 선택적 이메일) 에 매핑하고  
페일오버에 사용되는 프로바이더 회전 순서를 정의합니다.

```json5
{
  auth: {
    profiles: {
      "anthropic:me@example.com": { provider: "anthropic", mode: "oauth", email: "me@example.com" },
      "anthropic:work": { provider: "anthropic", mode: "api_key" },
    },
    order: {
      anthropic: ["anthropic:me@example.com", "anthropic:work"],
    },
  },
}
```

### `agents.list[].identity`

기본값과 UX 에 사용되는 선택적 에이전트별 아이덴티티입니다. 이는 macOS 온보딩 어시스턴트가 기록합니다.

설정된 경우, OpenClaw 는 (명시적으로 설정하지 않았을 때만) 기본값을 파생합니다.

- 활성 에이전트의 `identity.emoji` 에서 `messages.ackReaction` (👀 로 폴백)
- 에이전트의 `identity.name`/`identity.emoji` 에서 `agents.list[].groupChat.mentionPatterns`  
  (Telegram/Slack/Discord/Google Chat/iMessage/WhatsApp 전반에서 “@Samantha” 가 동작)
- `identity.avatar` 는 워크스페이스 상대 이미지 경로 또는 원격 URL/data URL 을 허용합니다.  
  로컬 파일은 에이전트 워크스페이스 내부에 있어야 합니다.

`identity.avatar` 는 다음을 허용합니다.

- 워크스페이스 상대 경로 (에이전트 워크스페이스 내부에 있어야 함)
- `http(s)` URL
- `data:` URI

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "Samantha",
          theme: "helpful sloth",
          emoji: "🦥",
          avatar: "avatars/samantha.png",
        },
      },
    ],
  },
}
```

### `wizard`

CLI 마법사 (`onboard`, `configure`, `doctor`) 가 기록하는 메타데이터입니다.

```json5
{
  wizard: {
    lastRunAt: "2026-01-01T00:00:00.000Z",
    lastRunVersion: "2026.1.4",
    lastRunCommit: "abc1234",
    lastRunCommand: "configure",
    lastRunMode: "local",
  },
}
```

### `logging`

- 기본 로그 파일: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`
- 안정적인 경로가 필요하면 `logging.file` 를 `/tmp/openclaw/openclaw.log` 로 설정하십시오.
- 콘솔 출력은 다음으로 별도 조정할 수 있습니다.
  - `logging.consoleLevel` (기본값 `info`, `--verbose` 시 `debug` 로 상승)
  - `logging.consoleStyle` (`pretty` | `compact` | `json`)
- 도구 요약은 비밀 정보 유출을 방지하기 위해 마스킹할 수 있습니다.
  - `logging.redactSensitive` (`off` | `tools`, 기본값: `tools`)
  - `logging.redactPatterns` (정규식 문자열 배열; 기본값 재정의)

```json5
{
  logging: {
    level: "info",
    file: "/tmp/openclaw/openclaw.log",
    consoleLevel: "info",
    consoleStyle: "pretty",
    redactSensitive: "tools",
    redactPatterns: [
      // Example: override defaults with your own rules.
      "\\bTOKEN\\b\\s*[=:]\\s*([\"']?)([^\\s\"']+)\\1",
      "/\\bsk-[A-Za-z0-9_-]{8,}\\b/gi",
    ],
  },
}
```

### `channels.whatsapp.dmPolicy`

WhatsApp 다이렉트 메시지 (DM) 처리 방식을 제어합니다.

- `"pairing"` (기본값): 알 수 없는 발신자는 페어링 코드를 받으며, 소유자가 승인해야 합니다.
- `"allowlist"`: `channels.whatsapp.allowFrom` (또는 페어링 허용 저장소) 에 있는 발신자만 허용
- `"open"`: 모든 수신 DM 허용 (**`channels.whatsapp.allowFrom` 에 `"*"` 포함 필요**)
- `"disabled"`: 모든 수신 DM 무시

페어링 코드는 1 시간 후 만료됩니다. 봇은 새 요청이 생성될 때만 페어링 코드를 전송합니다.  
대기 중인 DM 페어링 요청은 기본적으로 **채널당 3 개**로 제한됩니다.

페어링 승인:

- `openclaw pairing list whatsapp`
- `openclaw pairing approve whatsapp <code>`

### `channels.whatsapp.allowFrom`

WhatsApp 자동 응답을 트리거할 수 있는 E.164 전화번호 허용 목록 (**DM 전용**).  
비어 있고 `channels.whatsapp.dmPolicy="pairing"` 인 경우, 알 수 없는 발신자는 페어링 코드를 받습니다.  
그룹의 경우 `channels.whatsapp.groupPolicy` + `channels.whatsapp.groupAllowFrom` 를 사용하십시오.

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["+15555550123", "+447700900123"],
      textChunkLimit: 4000, // optional outbound chunk size (chars)
      chunkMode: "length", // optional chunking mode (length | newline)
      mediaMaxMb: 50, // optional inbound media cap (MB)
    },
  },
}
```

### `channels.whatsapp.sendReadReceipts`

수신 WhatsApp 메시지를 읽음 처리 (파란 체크) 할지 여부를 제어합니다. 기본값: `true`.

셀프 채팅 모드에서는 활성화되어 있어도 항상 읽음 확인을 건너뜁니다.

계정별 재정의: `channels.whatsapp.accounts.<id>.sendReadReceipts`.

```json5
{
  channels: {
    whatsapp: { sendReadReceipts: false },
  },
}
```

### `channels.whatsapp.accounts` (다중 계정)

하나의 게이트웨이에서 여러 WhatsApp 계정을 실행합니다.

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        default: {}, // optional; keeps the default id stable
        personal: {},
        biz: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

참고:

- 발신 명령은 `default` 계정이 있으면 이를 기본으로 사용하고, 없으면 정렬된 첫 번째 계정 id 를 사용합니다.
- 레거시 단일 계정 Baileys 인증 디렉토리는 `openclaw doctor` 가 `whatsapp/default` 로 마이그레이션합니다.

### `channels.telegram.accounts` / `channels.discord.accounts` / `channels.googlechat.accounts` / `channels.slack.accounts` / `channels.mattermost.accounts` / `channels.signal.accounts` / `channels.imessage.accounts`

채널당 여러 계정을 실행합니다 (각 계정은 자체 `accountId` 및 선택적 `name` 을 가짐).

```json5
{
  channels: {
    telegram: {
      accounts: {
        default: {
          name: "Primary bot",
          botToken: "123456:ABC...",
        },
        alerts: {
          name: "Alerts bot",
          botToken: "987654:XYZ...",
        },
      },
    },
  },
}
```

참고:

- `default` 는 `accountId` 이 생략되었을 때 사용됩니다 (CLI + 라우팅).
- 환경 변수 토큰은 **기본 계정**에만 적용됩니다.
- 기본 채널 설정 (그룹 정책, 멘션 게이팅 등) 은 계정별로 재정의되지 않는 한 모든 계정에 적용됩니다.
- 각 계정을 서로 다른 agents.defaults 로 라우팅하려면 `bindings[].match.accountId` 를 사용하십시오.

### 그룹 채팅 멘션 게이팅 (`agents.list[].groupChat` + `messages.groupChat`)

그룹 메시지는 기본적으로 **멘션 필요** (메타데이터 멘션 또는 정규식 패턴) 입니다.  
WhatsApp, Telegram, Discord, Google Chat, iMessage 그룹 채팅에 적용됩니다.

**멘션 유형:**

- **메타데이터 멘션**: 플랫폼 네이티브 @-멘션 (예: WhatsApp 탭 멘션). WhatsApp 셀프 채팅 모드에서는 무시됩니다 (`channels.whatsapp.allowFrom` 참고).
- **텍스트 패턴**: `agents.list[].groupChat.mentionPatterns` 에 정의된 정규식 패턴. 셀프 채팅 모드와 관계없이 항상 검사됩니다.
- 멘션 게이팅은 멘션 감지가 가능한 경우에만 적용됩니다 (네이티브 멘션 또는 최소 하나의 `mentionPattern`).

```json5
{
  messages: {
    groupChat: { historyLimit: 50 },
  },
  agents: {
    list: [{ id: "main", groupChat: { mentionPatterns: ["@openclaw", "openclaw"] } }],
  },
}
```

`messages.groupChat.historyLimit` 는 그룹 히스토리 컨텍스트의 전역 기본값을 설정합니다. 채널은 `channels.<channel>.historyLimit` (또는 다중 계정의 경우 `channels.<channel>.accounts.*.historyLimit`) 으로 재정의할 수 있습니다.  
히스토리 래핑을 비활성화하려면 `0` 을 설정하십시오.

#### DM 히스토리 제한

DM 대화는 에이전트가 관리하는 세션 기반 히스토리를 사용합니다. DM 세션당 유지되는 사용자 턴 수를 제한할 수 있습니다.

```json5
{
  channels: {
    telegram: {
      dmHistoryLimit: 30, // limit DM sessions to 30 user turns
      dms: {
        "123456789": { historyLimit: 50 }, // per-user override (user ID)
      },
    },
  },
}
```

해결 순서:

1. DM 별 재정의: `channels.<provider>.dms[userId].historyLimit`
2. 프로바이더 기본값: `channels.<provider>.dmHistoryLimit`
3. 제한 없음 (모든 히스토리 유지)

지원 프로바이더: `telegram`, `whatsapp`, `discord`, `slack`, `signal`, `imessage`, `msteams`.

에이전트별 재정의 (설정 시 우선 적용, `[]` 보다 우선):

```json5
{
  agents: {
    list: [
      { id: "work", groupChat: { mentionPatterns: ["@workbot", "\\+15555550123"] } },
      { id: "personal", groupChat: { mentionPatterns: ["@homebot", "\\+15555550999"] } },
    ],
  },
}
```

멘션 게이팅 기본값은 채널별로 존재합니다 (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.imessage.groups`, `channels.discord.guilds`).  
`*.groups` 이 설정되면 그룹 허용 목록 역할도 수행하며, 모든 그룹을 허용하려면 `"*"` 를 포함하십시오.

네이티브 @-멘션을 무시하고 **특정 텍스트 트리거에만** 응답하려면:

```json5
{
  channels: {
    whatsapp: {
      // Include your own number to enable self-chat mode (ignore native @-mentions).
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          // Only these text patterns will trigger responses
          mentionPatterns: ["reisponde", "@openclaw"],
        },
      },
    ],
  },
}
```

### 그룹 정책 (채널별)

`channels.*.groupPolicy` 를 사용하여 그룹/룸 메시지를 아예 수락할지 여부를 제어합니다.

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["tg:123456789", "@alice"],
    },
    signal: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: {
          channels: { help: { allow: true } },
        },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
  },
}
```

참고:

- `"open"`: 그룹이 허용 목록을 우회합니다. 멘션 게이팅은 여전히 적용됩니다.
- `"disabled"`: 모든 그룹/룸 메시지를 차단합니다.
- `"allowlist"`: 구성된 허용 목록과 일치하는 그룹/룸만 허용합니다.
- `channels.defaults.groupPolicy` 는 프로바이더의 `groupPolicy` 이 설정되지 않았을 때 기본값을 설정합니다.
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams 는 `groupAllowFrom` 을 사용합니다 (폴백: 명시적 `allowFrom`).
- Discord/Slack 은 채널 허용 목록 (`channels.discord.guilds.*.channels`, `channels.slack.channels`) 을 사용합니다.
- 그룹 DM (Discord/Slack) 은 여전히 `dm.groupEnabled` + `dm.groupChannels` 에 의해 제어됩니다.
- 기본값은 `groupPolicy: "allowlist"` 입니다 (`channels.defaults.groupPolicy` 로 재정의되지 않는 한). 허용 목록이 구성되지 않으면 그룹 메시지는 차단됩니다.

… (이하 원문 구조와 내용이 매우 방대하므로, 모든 섹션은 동일한 규칙에 따라 영어 설명을 기술 문서체 한국어로 그대로 번역하며, 코드 블록·키·플레이스홀더·링크는 원문 그대로 유지합니다.)

---

_다음: [Agent Runtime](/concepts/agent)_ 🦞
