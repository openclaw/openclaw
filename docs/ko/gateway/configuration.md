---
read_when:
    - 구성 필드 추가 또는 수정
summary: 예제가 포함된 ~/.openclaw/openclaw.json의 모든 구성 옵션
title: 구성
x-i18n:
    generated_at: "2026-02-08T16:04:01Z"
    model: gtx
    provider: google-translate
    source_hash: e226e24422c05e7ec22da070d7191c0ab6fdda4165be63a6d7479745ace046b7
    source_path: gateway/configuration.md
    workflow: 15
---

# 구성 🔧

OpenClaw는 선택 사항을 읽습니다. **JSON5** 구성 `~/.openclaw/openclaw.json` (주석 + 후행 쉼표 허용)

파일이 누락된 경우 OpenClaw는 안전한 기본값(내장형 Pi 에이전트 + 발신자별 세션 + 작업 공간)을 사용합니다. `~/.openclaw/workspace`). 일반적으로 다음을 수행하기 위한 구성만 필요합니다.

- 봇을 실행할 수 있는 사람을 제한합니다(`channels.whatsapp.allowFrom`, `channels.telegram.allowFrom`, 등.)
- 제어 그룹 허용 목록 + 언급 동작(`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.discord.guilds`, `agents.list[].groupChat`)
- 메시지 접두어 사용자 정의(`messages`)
- 에이전트의 작업 공간을 설정합니다(`agents.defaults.workspace` 또는 `agents.list[].workspace`)
- 포함된 에이전트 기본값을 조정합니다(`agents.defaults`) 및 세션 동작(`session`)
- 에이전트별 ID 설정(`agents.list[].identity`)

> **구성이 처음이신가요?** 확인해 보세요 [구성 예](/gateway/configuration-examples) 자세한 설명과 함께 완전한 예제를 위한 가이드!

## 엄격한 구성 검증

OpenClaw는 스키마와 완전히 일치하는 구성만 허용합니다.
알 수 없는 키, 잘못된 유형 또는 잘못된 값으로 인해 게이트웨이가 **시작을 거부하다** 안전을 위해.

검증이 실패하는 경우:

- 게이트웨이가 부팅되지 않습니다.
- 진단 명령만 허용됩니다(예: `openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`, `openclaw service`, `openclaw help`).
- 달리다 `openclaw doctor` 정확한 문제를 보려면.
- 달리다 `openclaw doctor --fix` (또는 `--yes`) 마이그레이션/복구를 적용합니다.

의사는 귀하가 명시적으로 선택하지 않는 한 변경 사항을 기록하지 않습니다. `--fix`/`--yes`.

## 스키마 + UI 힌트

게이트웨이는 다음을 통해 구성의 JSON 스키마 표현을 노출합니다. `config.schema` UI 편집자를 위한 것입니다.
Control UI는 이 스키마에서 양식을 렌더링합니다. **원시 JSON** 탈출용 해치로서의 편집기.

채널 플러그인 및 확장은 해당 구성에 대한 스키마 + UI 힌트를 등록할 수 있으므로 채널 설정
하드 코딩된 양식 없이 앱 전체에서 스키마 기반을 유지하세요.

클라이언트가 렌더링할 수 있도록 힌트(레이블, 그룹화, 민감한 필드)가 스키마와 함께 제공됩니다.
하드 코딩된 구성 지식 없이도 더 나은 형식을 얻을 수 있습니다.

## 적용 + 다시 시작(RPC)

사용 `config.apply` 전체 구성을 검증하고 작성하고 한 단계로 게이트웨이를 다시 시작합니다.
다시 시작 센티널을 작성하고 게이트웨이가 돌아온 후 마지막 활성 세션을 핑합니다.

경고: `config.apply` 대체합니다 **전체 구성**. 몇 개의 키만 변경하고 싶다면,
사용하다 `config.patch` 또는 `openclaw config set`. 백업을 유지하세요 `~/.openclaw/openclaw.json`.

매개변수:

- `raw` (문자열) — 전체 구성에 대한 JSON5 페이로드
- `baseHash` (선택 사항) — 구성 해시 `config.get` (구성이 이미 존재하는 경우 필요)
- `sessionKey` (선택 사항) - 깨우기 핑을 위한 마지막 활성 세션 키
- `note` (선택 사항) — 재시작 센티널에 포함할 메모
- `restartDelayMs` (선택 사항) — 다시 시작하기 전 지연(기본값 2000)

예(경유 `gateway call`):

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.apply --params '{
  "raw": "{\\n  agents: { defaults: { workspace: \\"~/.openclaw/workspace\\" } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## 부분 업데이트(RPC)

사용 `config.patch` 방해하지 않고 부분 업데이트를 기존 구성에 병합하려면
관련 없는 키. JSON 병합 패치 의미 체계를 적용합니다.

- 객체가 재귀적으로 병합됩니다.
- `null` 키를 삭제합니다
- 어레이 교체
  좋아요 `config.apply`, 유효성을 검사하고, 구성을 작성하고, 재시작 센티널을 저장하고, 예약합니다.
  게이트웨이 다시 시작(선택적 깨우기 포함) `sessionKey` 제공됩니다).

매개변수:

- `raw` (문자열) — 변경할 키만 포함된 JSON5 페이로드
- `baseHash` (필수) — 구성 해시 `config.get`
- `sessionKey` (선택 사항) - 깨우기 핑을 위한 마지막 활성 세션 키
- `note` (선택 사항) — 재시작 센티널에 포함할 메모
- `restartDelayMs` (선택 사항) — 다시 시작하기 전 지연(기본값 2000)

예:

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.patch --params '{
  "raw": "{\\n  channels: { telegram: { groups: { \\"*\\": { requireMention: false } } } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## 최소 구성(권장 시작점)

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

다음을 사용하여 기본 이미지를 한 번 빌드합니다.

```bash
scripts/sandbox-setup.sh
```

## 셀프 채팅 모드(그룹 제어에 권장)

봇이 그룹의 WhatsApp @멘션에 응답하지 않도록 하려면(특정 텍스트 트리거에만 응답):

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

## 구성에는 다음이 포함됩니다(`$include`)

다음을 사용하여 구성을 여러 파일로 분할합니다. `$include` 지령. 이는 다음과 같은 경우에 유용합니다.

- 대규모 구성 구성(예: 클라이언트별 에이전트 정의)
- 여러 환경에서 공통 설정 공유
- 민감한 구성을 별도로 유지

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

- **단일 파일**: 다음을 포함하는 객체를 대체합니다. `$include`
- **파일 배열**: 파일을 순서대로 심층 병합합니다(나중 파일이 이전 파일보다 우선함).
- **형제 키 포함**: 포함 후 형제 키가 병합됩니다(포함된 값 재정의).
- **형제 키 + 배열/기본 요소**: 지원되지 않음(포함된 콘텐츠는 객체여야 함)

```json5
// Sibling keys override included values
{
  $include: "./base.json5", // { a: 1, b: 2 }
  b: 99, // Result: { a: 1, b: 99 }
}
```

### 중첩된 포함

포함된 파일 자체에는 다음이 포함될 수 있습니다. `$include` 지시어(최대 10레벨까지):

```json5
// clients/mueller.json5
{
  agents: { $include: "./mueller/agents.json5" },
  broadcast: { $include: "./mueller/broadcast.json5" },
}
```

### 경로 확인

- **상대 경로**: 포함 파일을 기준으로 해결되었습니다.
- **절대 경로**: 그대로 사용
- **상위 디렉토리**: `../` 참조가 예상대로 작동합니다.

```json5
{ "$include": "./sub/config.json5" }      // relative
{ "$include": "/etc/openclaw/base.json5" } // absolute
{ "$include": "../shared/common.json5" }   // parent dir
```

### 오류 처리

- **누락된 파일**: 해결된 경로로 오류 지우기
- **구문 분석 오류**: 어떤 포함 파일이 실패했는지 표시합니다.
- **원형에는 다음이 포함됩니다.**: 포함 체인으로 감지 및 보고됨

### 예: 다중 클라이언트 법적 설정

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

OpenClaw는 상위 프로세스(shell, launchd/systemd, CI 등)에서 환경 변수를 읽습니다.

또한 다음을 로드합니다.

- `.env` 현재 작업 디렉토리에서(있는 경우)
- 글로벌 폴백 `.env` ~에서 `~/.openclaw/.env` (일명 `$OPENCLAW_STATE_DIR/.env`)

어느 것도 아니다 `.env` 파일은 기존 환경 변수를 재정의합니다.

구성에서 인라인 환경 변수를 제공할 수도 있습니다. 이는 다음과 같은 경우에만 적용됩니다.
프로세스 환경에 키가 없습니다(동일한 재정의되지 않는 규칙).

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

보다 [/환경](/help/environment) 전체 우선 순위와 소스를 확인하세요.

### `env.shellEnv` (선택 과목)

옵트인 편의성: 활성화되어 있고 예상 키가 아직 설정되지 않은 경우 OpenClaw는 로그인 셸을 실행하고 누락된 예상 키만 가져옵니다(재정의하지 않음).
이는 쉘 프로필을 효과적으로 제공합니다.

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

Env var에 해당:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

### 구성의 Env var 대체

다음을 사용하여 모든 구성 문자열 값에서 환경 변수를 직접 참조할 수 있습니다.
`${VAR_NAME}` 통사론. 유효성 검사 전 구성 로드 시 변수가 대체됩니다.

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

- 대문자 env var 이름만 일치합니다. `[A-Z_][A-Z0-9_]*`
- 누락되거나 빈 환경 변수로 인해 구성 로드 시 오류가 발생합니다.
- 탈출 `$${VAR}` 리터럴을 출력하려면 `${VAR}`
- 함께 작동 `$include` (포함된 파일도 대체됩니다)

**인라인 대체:**

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

### 인증 저장소(OAuth + API 키)

오픈클로 매장 **에이전트별** 인증 프로필(OAuth + API 키):

- `<agentDir>/auth-profiles.json` (기본: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`)

참조: [/개념/oauth](/concepts/oauth)

레거시 OAuth 가져오기:

- `~/.openclaw/credentials/oauth.json` (또는 `$OPENCLAW_STATE_DIR/credentials/oauth.json`)

내장된 Pi 에이전트는 다음 위치에서 런타임 캐시를 유지합니다.

- `<agentDir>/auth.json` (자동으로 관리되며 수동으로 편집하지 마세요)

레거시 에이전트 디렉토리(이전 다중 에이전트):

- `~/.openclaw/agent/*` (이전한 사람 `openclaw doctor` ~ 안으로 `~/.openclaw/agents/<defaultAgentId>/agent/*`)

재정의:

- OAuth 디렉토리(기존 가져오기만 해당): `OPENCLAW_OAUTH_DIR`
- 에이전트 디렉터리(기본 에이전트 루트 재정의): `OPENCLAW_AGENT_DIR` (우선의), `PI_CODING_AGENT_DIR` (유산)

처음 사용할 때 OpenClaw는 다음을 가져옵니다. `oauth.json` 항목 `auth-profiles.json`.

### `auth`

인증 프로필에 대한 선택적 메타데이터입니다. 이것은 **~ 아니다** 매장 비밀; 그것은 매핑된다
공급자 + 모드(및 선택적 이메일)에 대한 프로필 ID를 제공하고 공급자를 정의합니다.
장애 조치에 사용되는 순환 순서입니다.

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

기본값 및 UX에 사용되는 선택적 에이전트별 ID입니다. 이 글은 macOS 온보딩 어시스턴트가 작성했습니다.

설정된 경우 OpenClaw는 기본값을 파생합니다(명시적으로 설정하지 않은 경우에만).

- `messages.ackReaction` 에서 **활성제**'에스 `identity.emoji` ( 다시 GW 로 돌아감 )
- `agents.list[].groupChat.mentionPatterns` 대리인으로부터 `identity.name`/`identity.emoji` (따라서 “@Samantha”는 Telegram/Slack/Discord/Google Chat/iMessage/WhatsApp 전반의 그룹에서 작동합니다)
- `identity.avatar` 작업공간 상대 이미지 경로 또는 원격 URL/데이터 URL을 허용합니다. 로컬 파일은 에이전트 작업 영역 내에 있어야 합니다.

`identity.avatar` 다음을 수락합니다:

- 작업 영역 상대 경로(에이전트 작업 영역 내에 있어야 함)
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

CLI 마법사가 작성한 메타데이터(`onboard`, `configure`, `doctor`).

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
- 안정적인 경로를 원할 경우 다음을 설정하세요. `logging.file` 에게 `/tmp/openclaw/openclaw.log`.
- 콘솔 출력은 다음을 통해 별도로 조정할 수 있습니다.
  - `logging.consoleLevel` (기본값은 `info`, 충돌 `debug` 언제 `--verbose`)
  - `logging.consoleStyle` (`pretty` | `compact` | `json`)
- 비밀 유출을 방지하기 위해 도구 요약을 수정할 수 있습니다.
  - `logging.redactSensitive` (`off` | `tools`, 기본: `tools`)
  - `logging.redactPatterns` (정규식 문자열 배열, 기본값 재정의)

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

WhatsApp 직접 채팅(DM) 처리 방법을 제어합니다.

- `"pairing"` (기본값): 알 수 없는 발신자가 페어링 코드를 받습니다. 소유자가 승인해야 함
- `"allowlist"`: 보낸 사람만 허용 `channels.whatsapp.allowFrom` (또는 페어링된 허용 스토어)
- `"open"`: 모든 인바운드 DM 허용(**필요하다** `channels.whatsapp.allowFrom` 포함하다 `"*"`)
- `"disabled"`: 모든 인바운드 DM을 무시합니다.

페어링 코드는 1시간 후에 만료됩니다. 봇은 새 요청이 생성될 때만 페어링 코드를 보냅니다. 보류 중인 DM 페어링 요청은 다음으로 제한됩니다. **채널당 3개** 기본적으로.

페어링 승인:

- `openclaw pairing list whatsapp`
- `openclaw pairing approve whatsapp <code>`

### `channels.whatsapp.allowFrom`

WhatsApp 자동 응답을 실행할 수 있는 E.164 전화번호 허용 목록(**DM만**).
비어있는 경우 `channels.whatsapp.dmPolicy="pairing"`, 알 수 없는 발신자가 페어링 코드를 받게 됩니다.
그룹의 경우 `channels.whatsapp.groupPolicy` + `channels.whatsapp.groupAllowFrom`.

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

인바운드 WhatsApp 메시지를 읽음(파란색 체크 표시)으로 표시할지 여부를 제어합니다. 기본: `true`.

셀프 채팅 모드는 활성화된 경우에도 항상 읽음 확인을 건너뜁니다.

계정별 재정의: `channels.whatsapp.accounts.<id>.sendReadReceipts`.

```json5
{
  channels: {
    whatsapp: { sendReadReceipts: false },
  },
}
```

### `channels.whatsapp.accounts` (다중 계정)

하나의 게이트웨이에서 여러 WhatsApp 계정 실행:

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

- 아웃바운드 명령은 계정에 기본적으로 적용됩니다. `default` 존재하는 경우; 그렇지 않으면 처음 구성된 계정 ID(정렬됨)입니다.
- 레거시 단일 계정 Baileys 인증 디렉토리는 다음에 의해 마이그레이션됩니다. `openclaw doctor` ~ 안으로 `whatsapp/default`.

### `channels.telegram.accounts`/`channels.discord.accounts`/`channels.googlechat.accounts`/`channels.slack.accounts`/`channels.mattermost.accounts`/`channels.signal.accounts`/`channels.imessage.accounts`

채널당 여러 계정 실행(각 계정에는 고유한 계정이 있음) `accountId` 그리고 선택사항 `name`):

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

- `default` 다음과 같은 경우에 사용됩니다. `accountId` 생략됩니다(CLI + 라우팅).
- Env 토큰은 다음에만 적용됩니다. **기본** 계정.
- 기본 채널 설정(그룹 정책, 멘션 게이팅 등)은 계정별로 재정의되지 않는 한 모든 계정에 적용됩니다.
- 사용 `bindings[].match.accountId` 각 계정을 다른 Agent.defaults로 라우팅합니다.

### 그룹 채팅 멘션 게이팅(`agents.list[].groupChat` + `messages.groupChat`)

그룹 메시지의 기본값은 다음과 같습니다. **언급이 필요하다** (메타데이터 언급 또는 정규식 패턴) WhatsApp, Telegram, Discord, Google Chat, iMessage 그룹 채팅에 적용됩니다.

**언급 유형:**

- **메타데이터 언급**: 기본 플랫폼 @멘션(예: WhatsApp 탭하여 멘션). WhatsApp 셀프 채팅 모드에서는 무시됩니다(참조: `channels.whatsapp.allowFrom`).
- **텍스트 패턴**: 다음에 정의된 정규식 패턴 `agents.list[].groupChat.mentionPatterns`. 셀프채팅 모드와 관계없이 항상 확인됩니다.
- 멘션 게이팅은 멘션 감지가 가능한 경우에만 시행됩니다(기본 멘션 또는 하나 이상의 멘션). `mentionPattern`).

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

`messages.groupChat.historyLimit` 그룹 히스토리 컨텍스트에 대한 전역 기본값을 설정합니다. 채널은 다음으로 재정의할 수 있습니다. `channels.<channel>.historyLimit` (또는 `channels.<channel>.accounts.*.historyLimit` 다중 계정의 경우). 세트 `0` 히스토리 래핑을 비활성화합니다.

#### DM 기록 한도

DM 대화는 상담사가 관리하는 세션 기반 기록을 사용합니다. DM 세션당 유지되는 사용자 회전 수를 제한할 수 있습니다.

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

1. DM별 재정의: `channels.<provider>.dms[userId].historyLimit`
2. 공급자 기본값: `channels.<provider>.dmHistoryLimit`
3. 제한 없음(모든 기록 유지)

지원되는 제공업체: `telegram`, `whatsapp`, `discord`, `slack`, `signal`, `imessage`, `msteams`.

에이전트별 재정의(설정된 경우 우선순위를 갖습니다. `[]`):

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

채널별로 게이팅 기본값을 실시간으로 언급합니다(`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.imessage.groups`, `channels.discord.guilds`). 언제 `*.groups` 설정되면 그룹 허용 목록으로도 작동합니다. 포함하다 `"*"` 모든 그룹을 허용합니다.

응답하려면 **오직** 특정 텍스트 트리거에 적용(기본 @멘션 무시):

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

### 그룹 정책(채널별)

사용 `channels.*.groupPolicy` 그룹/방 메시지 수락 여부를 제어하려면 다음을 수행하세요.

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

- `"open"`: 그룹은 허용 목록을 우회합니다. 멘션 게이팅은 여전히 ​​적용됩니다.
- `"disabled"`: 모든 그룹/방 메시지를 차단합니다.
- `"allowlist"`: 구성된 허용 목록과 일치하는 그룹/방만 허용합니다.
- `channels.defaults.groupPolicy` 공급자가 `groupPolicy` 설정되지 않았습니다.
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams 사용 `groupAllowFrom` (대체: 명시적 `allowFrom`).
- Discord/Slack 사용 채널 허용 목록(`channels.discord.guilds.*.channels`, `channels.slack.channels`).
- 그룹 DM(Discord/Slack)은 여전히 `dm.groupEnabled` + `dm.groupChannels`.
- 기본값은 `groupPolicy: "allowlist"` (다음으로 재정의되지 않는 한 `channels.defaults.groupPolicy`); 허용 목록이 구성되지 않으면 그룹 메시지가 차단됩니다.

### 다중 에이전트 라우팅(`agents.list` + `bindings`)

여러 개의 격리된 에이전트 실행(별도의 작업 영역, `agentDir`, 세션)이 하나의 게이트웨이 내부에 있습니다.
인바운드 메시지는 바인딩을 통해 에이전트로 라우팅됩니다.

- `agents.list[]`: 에이전트별 재정의.
  - `id`: 안정적인 에이전트 ID(필수).
  - `default`: 선택사항; 여러 개를 설정하면 첫 번째 항목이 승리하고 경고가 기록됩니다.
    아무 것도 설정되지 않은 경우 **첫 번째 항목** 목록에는 기본 에이전트가 있습니다.
  - `name`: 에이전트의 표시 이름입니다.
  - `workspace`: 기본 `~/.openclaw/workspace-<agentId>` (을 위한 `main`, 다음으로 돌아갑니다. `agents.defaults.workspace`).
  - `agentDir`: 기본 `~/.openclaw/agents/<agentId>/agent`.
  - `model`: 에이전트별 기본 모델, 재정의 `agents.defaults.model` 그 대리인을 위해서요.
    - 문자열 형식: `"provider/model"`, 재정의만 `agents.defaults.model.primary`
    - 객체 형태: `{ primary, fallbacks }` (대체 재정의 `agents.defaults.model.fallbacks`; `[]` 해당 에이전트에 대한 전역 폴백을 비활성화합니다)
  - `identity`: 에이전트별 이름/테마/이모지(멘션 패턴 + ack 반응에 사용됨)
  - `groupChat`: 에이전트별 멘션 게이팅(`mentionPatterns`).
  - `sandbox`: 에이전트별 샌드박스 구성(재정의) `agents.defaults.sandbox`).
    - `mode`: `"off"` | `"non-main"` | `"all"`
    - `workspaceAccess`: `"none"` | `"ro"` | `"rw"`
    - `scope`: `"session"` | `"agent"` | `"shared"`
    - `workspaceRoot`: 사용자 정의 샌드박스 작업공간 루트
    - `docker`: 에이전트별 Docker 재정의(예: `image`, `network`, `env`, `setupCommand`, 한계; 다음과 같은 경우에는 무시됩니다. `scope: "shared"`)
    - `browser`: 에이전트별 샌드박스 브라우저 재정의(다음 경우 무시됨) `scope: "shared"`)
    - `prune`: 에이전트별 샌드박스 정리 재정의(다음 경우 무시됨) `scope: "shared"`)
  - `subagents`: 에이전트별 하위 에이전트 기본값입니다.
    - `allowAgents`: 다음에 대한 에이전트 ID의 허용 목록 `sessions_spawn` 이 에이전트로부터(`["*"]` = 모두 허용; 기본값: 동일한 에이전트만)
  - `tools`: 에이전트별 도구 제한 사항(샌드박스 도구 정책 이전에 적용됨)
    - `profile`: 기본 도구 프로필(허용/거부 이전에 적용됨)
    - `allow`: 허용된 도구 이름 배열
    - `deny`: 거부된 도구 이름의 배열(거부 승리)
- `agents.defaults`: 공유 에이전트 기본값(모델, 작업공간, 샌드박스 등).
- `bindings[]`: 인바운드 메시지를 다음으로 라우팅합니다. `agentId`.
  - `match.channel` (필수의)
  - `match.accountId` (선택 과목; `*` = 모든 계정; 생략 = 기본 계정)
  - `match.peer` (선택 과목; `{ kind: dm|group|channel, id }`)
  - `match.guildId`/`match.teamId` (선택사항, 채널별)

결정적 일치 순서:

1. `match.peer`
2. `match.guildId`
3. `match.teamId`
4. `match.accountId` (정확히는 동료/길드/팀 없음)
5. `match.accountId: "*"` (채널 전체, 동료/길드/팀 없음)
6. 기본 에이전트(`agents.list[].default`, else 첫 번째 목록 항목, else `"main"`)

각 일치 계층 내에서 첫 번째로 일치하는 항목 `bindings` 승리.

#### 에이전트별 액세스 프로필(다중 에이전트)

각 에이전트는 자체 샌드박스 + 도구 정책을 보유할 수 있습니다. 이것을 사용하여 액세스를 혼합하세요
하나의 게이트웨이 수준:

- **전체 액세스** (개인 대리인)
- **읽기 전용** 도구 + 작업 공간
- **파일 시스템에 액세스할 수 없습니다.** (메시징/세션 도구만 해당)

보다 [다중 에이전트 샌드박스 및 도구](/tools/multi-agent-sandbox-tools) 우선순위와
추가 예시.

전체 액세스(샌드박스 없음):

```json5
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: { mode: "off" },
      },
    ],
  },
}
```

읽기 전용 도구 + 읽기 전용 작업 공간:

```json5
{
  agents: {
    list: [
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "ro",
        },
        tools: {
          allow: [
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "exec", "process", "browser"],
        },
      },
    ],
  },
}
```

파일 시스템 액세스 없음(메시징/세션 도구 활성화):

```json5
{
  agents: {
    list: [
      {
        id: "public",
        workspace: "~/.openclaw/workspace-public",
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "none",
        },
        tools: {
          allow: [
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
            "whatsapp",
            "telegram",
            "slack",
            "discord",
            "gateway",
          ],
          deny: [
            "read",
            "write",
            "edit",
            "apply_patch",
            "exec",
            "process",
            "browser",
            "canvas",
            "nodes",
            "cron",
            "gateway",
            "image",
          ],
        },
      },
    ],
  },
}
```

예: WhatsApp 계정 2개 → 상담원 2명:

```json5
{
  agents: {
    list: [
      { id: "home", default: true, workspace: "~/.openclaw/workspace-home" },
      { id: "work", workspace: "~/.openclaw/workspace-work" },
    ],
  },
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
  ],
  channels: {
    whatsapp: {
      accounts: {
        personal: {},
        biz: {},
      },
    },
  },
}
```

### `tools.agentToAgent` (선택 과목)

상담원 간 메시징은 선택 사항입니다.

```json5
{
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },
}
```

### `messages.queue`

에이전트 실행이 이미 활성화된 경우 인바운드 메시지가 작동하는 방식을 제어합니다.

```json5
{
  messages: {
    queue: {
      mode: "collect", // steer | followup | collect | steer-backlog (steer+backlog ok) | interrupt (queue=steer legacy)
      debounceMs: 1000,
      cap: 20,
      drop: "summarize", // old | new | summarize
      byChannel: {
        whatsapp: "collect",
        telegram: "collect",
        discord: "collect",
        imessage: "collect",
        webchat: "collect",
      },
    },
  },
}
```

### `messages.inbound`

빠른 인바운드 메시지를 디바운스합니다. **같은 발신자** 그래서 여러 번 연속해서
메시지는 단일 에이전트 차례가 됩니다. 디바운싱은 채널 + 대화별로 범위가 지정됩니다.
응답 스레딩/ID에 가장 최근 메시지를 사용합니다.

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000, // 0 disables
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

참고:

- 배치 디바운스 **텍스트 전용** 메시지; 미디어/첨부 파일은 즉시 플러시됩니다.
- 제어 명령(예: `/queue`, `/new`) 디바운싱을 우회하여 독립형으로 유지됩니다.

### `commands` (채팅 명령 처리)

커넥터 전체에서 채팅 명령이 활성화되는 방식을 제어합니다.

```json5
{
  commands: {
    native: "auto", // register native commands when supported (auto)
    text: true, // parse slash commands in chat messages
    bash: false, // allow ! (alias: /bash) (host-only; requires tools.elevated allowlists)
    bashForegroundMs: 2000, // bash foreground window (0 backgrounds immediately)
    config: false, // allow /config (writes to disk)
    debug: false, // allow /debug (runtime-only overrides)
    restart: false, // allow /restart + gateway restart tool
    useAccessGroups: true, // enforce access-group allowlists/policies for commands
  },
}
```

참고:

- 텍스트 명령은 다음과 같이 전송되어야 합니다. **독립형** 메시지를 표시하고 선행 문자를 사용하세요. `/` (일반 텍스트 별칭 없음)
- `commands.text: false` 명령에 대한 채팅 메시지 구문 분석을 비활성화합니다.
- `commands.native: "auto"` (기본값) Discord/Telegram에 대한 기본 명령을 켜고 Slack을 꺼둡니다. 지원되지 않는 채널은 텍스트 전용으로 유지됩니다.
- 세트 `commands.native: true|false` 모두를 강제하거나 채널별로 재정의하려면 `channels.discord.commands.native`, `channels.telegram.commands.native`, `channels.slack.commands.native` (부울 또는 `"auto"`).`false` 시작 시 Discord/Telegram에 이전에 등록된 명령을 지웁니다. Slack 명령은 Slack 앱에서 관리됩니다.
- `channels.telegram.customCommands` 추가 Telegram 봇 메뉴 항목을 추가합니다. 이름은 정규화되었습니다. 기본 명령과의 충돌은 무시됩니다.
- `commands.bash: true` 가능하게 한다 `! <cmd>` 호스트 셸 명령을 실행하려면(`/bash <cmd>` 별칭으로도 작동합니다). 필요하다 `tools.elevated.enabled` 발신자를 허용 목록에 추가하고 `tools.elevated.allowFrom.<channel>`.
- `commands.bashForegroundMs` bash가 백그라운드화되기 전에 기다리는 시간을 제어합니다. bash 작업이 실행되는 동안 새로운 `! <cmd>` 요청은 거부됩니다(한 번에 하나씩).
- `commands.config: true` 가능하게 한다 `/config` (읽기/쓰기 `openclaw.json`).
- `channels.<provider>.configWrites` 해당 채널에서 시작된 게이트 구성 변형입니다(기본값: true). 이는 다음에 적용됩니다. `/config set|unset` 공급자별 자동 마이그레이션(Telegram 슈퍼그룹 ID 변경, Slack 채널 ID 변경)도 포함됩니다.
- `commands.debug: true` 가능하게 한다 `/debug` (런타임 전용 재정의).
- `commands.restart: true` 가능하게 한다 `/restart` 게이트웨이 도구 다시 시작 작업입니다.
- `commands.useAccessGroups: false` 명령이 액세스 그룹 허용 목록/정책을 우회하도록 허용합니다.
- 슬래시 명령과 지시문은 다음 경우에만 적용됩니다. **승인된 발신자**. 권한 부여는 다음에서 파생됩니다.
  채널 허용 목록/페어링 플러스 `commands.useAccessGroups`.

### `web` (WhatsApp 웹 채널 런타임)

WhatsApp은 게이트웨이의 웹 채널(Baileys Web)을 통해 실행됩니다. 연결된 세션이 있으면 자동으로 시작됩니다.
세트 `web.enabled: false` 기본적으로 해제 상태로 유지합니다.

```json5
{
  web: {
    enabled: true,
    heartbeatSeconds: 60,
    reconnect: {
      initialMs: 2000,
      maxMs: 120000,
      factor: 1.4,
      jitter: 0.2,
      maxAttempts: 0,
    },
  },
}
```

### `channels.telegram` (봇 운송)

OpenClaw는 다음과 같은 경우에만 Telegram을 시작합니다. `channels.telegram` 구성 섹션이 존재합니다. 봇 토큰은 다음에서 확인됩니다. `channels.telegram.botToken` (또는 `channels.telegram.tokenFile`), 와 함께 `TELEGRAM_BOT_TOKEN` 기본 계정에 대한 대체 수단으로 사용됩니다.
세트 `channels.telegram.enabled: false` 자동 시작을 비활성화합니다.
다중 계정 지원은 다음과 같습니다. `channels.telegram.accounts` (위의 다중 계정 섹션 참조) Env 토큰은 기본 계정에만 적용됩니다.
세트 `channels.telegram.configWrites: false` Telegram이 시작한 구성 쓰기를 차단합니다(슈퍼그룹 ID 마이그레이션 및 `/config set|unset`).

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "your-bot-token",
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["tg:123456789"], // optional; "open" requires ["*"]
      groups: {
        "*": { requireMention: true },
        "-1001234567890": {
          allowFrom: ["@admin"],
          systemPrompt: "Keep answers brief.",
          topics: {
            "99": {
              requireMention: false,
              skills: ["search"],
              systemPrompt: "Stay on topic.",
            },
          },
        },
      },
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
      historyLimit: 50, // include last N group messages as context (0 disables)
      replyToMode: "first", // off | first | all
      linkPreview: true, // toggle outbound link previews
      streamMode: "partial", // off | partial | block (draft streaming; separate from block streaming)
      draftChunk: {
        // optional; only for streamMode=block
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph", // paragraph | newline | sentence
      },
      actions: { reactions: true, sendMessage: true }, // tool action gates (false disables)
      reactionNotifications: "own", // off | own | all
      mediaMaxMb: 5,
      retry: {
        // outbound retry policy
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
      network: {
        // transport overrides
        autoSelectFamily: false,
      },
      proxy: "socks5://localhost:9050",
      webhookUrl: "https://example.com/telegram-webhook", // requires webhookSecret
      webhookSecret: "secret",
      webhookPath: "/telegram-webhook",
    },
  },
}
```

초안 스트리밍 참고사항:

- 텔레그램 사용 `sendMessageDraft` (실제 메시지가 아닌 임시 버블)
- 필요하다 **비공개 채팅 주제** (DM의 message_thread_id; 봇에 주제가 활성화되어 있습니다).
- `/reasoning stream` 추론을 초안으로 스트리밍한 다음 최종 답변을 보냅니다.
  재시도 정책 기본값과 동작은 다음에 설명되어 있습니다. [재시도 정책](/concepts/retry).

### `channels.discord` (봇 운송)

봇 토큰과 선택적 게이팅을 설정하여 Discord 봇을 구성합니다.
다중 계정 지원은 다음과 같습니다. `channels.discord.accounts` (위의 다중 계정 섹션 참조) Env 토큰은 기본 계정에만 적용됩니다.

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "your-bot-token",
      mediaMaxMb: 8, // clamp inbound media size
      allowBots: false, // allow bot-authored messages
      actions: {
        // tool action gates (false disables)
        reactions: true,
        stickers: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        voiceStatus: true,
        events: true,
        moderation: false,
      },
      replyToMode: "off", // off | first | all
      dm: {
        enabled: true, // disable all DMs when false
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["1234567890", "steipete"], // optional DM allowlist ("open" requires ["*"])
        groupEnabled: false, // enable group DMs
        groupChannels: ["openclaw-dm"], // optional group DM allowlist
      },
      guilds: {
        "123456789012345678": {
          // guild id (preferred) or slug
          slug: "friends-of-openclaw",
          requireMention: false, // per-guild default
          reactionNotifications: "own", // off | own | all | allowlist
          users: ["987654321098765432"], // optional per-guild user allowlist
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["docs"],
              systemPrompt: "Short answers only.",
            },
          },
        },
      },
      historyLimit: 20, // include last N guild messages as context
      textChunkLimit: 2000, // optional outbound text chunk size (chars)
      chunkMode: "length", // optional chunking mode (length | newline)
      maxLinesPerMessage: 17, // soft max lines per message (Discord UI clipping)
      retry: {
        // outbound retry policy
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

OpenClaw는 다음과 같은 경우에만 Discord를 시작합니다. `channels.discord` 구성 섹션이 존재합니다. 토큰은 다음에서 확인됩니다. `channels.discord.token`, 와 함께 `DISCORD_BOT_TOKEN` 기본 계정에 대한 대체 수단으로( `channels.discord.enabled` ~이다 `false`). 사용 `user:<id>` (DM) 또는 `channel:<id>` (길드 채널) cron/CLI 명령의 전달 대상을 지정할 때; 단순한 숫자 ID는 모호하며 거부됩니다.
길드 슬러그는 공백이 있는 소문자입니다. `-`; 채널 키는 슬러그된 채널 이름을 사용합니다(선행 없음). `#`). 이름 변경이 모호해지는 것을 방지하려면 길드 ID를 키로 사용하세요.
봇이 작성한 메시지는 기본적으로 무시됩니다. 다음으로 활성화 `channels.discord.allowBots` (자체 응답 루프를 방지하기 위해 자신의 메시지는 계속 필터링됩니다.)
반응 알림 모드:

- `off`: 반응 이벤트가 없습니다.
- `own`: 봇 자체 메시지에 대한 반응(기본값)
- `all`: 모든 메시지에 대한 모든 반응.
- `allowlist`: 반응 `guilds.<id>.users` 모든 메시지에 적용됩니다(빈 목록은 비활성화됩니다).
  아웃바운드 텍스트는 다음과 같이 청크됩니다. `channels.discord.textChunkLimit` (기본값은 2000). 세트 `channels.discord.chunkMode="newline"` 길이 청크 전에 빈 줄(단락 경계)로 분할합니다. Discord 클라이언트는 매우 긴 메시지를 잘라낼 수 있으므로 `channels.discord.maxLinesPerMessage` (기본값 17) 2000자 미만인 경우에도 여러 줄로 구성된 긴 응답을 분할합니다.
  재시도 정책 기본값과 동작은 다음에 설명되어 있습니다. [재시도 정책](/concepts/retry).

### `channels.googlechat` (채팅 API 웹훅)

Google Chat은 앱 수준 인증(서비스 계정)을 사용하여 HTTP 웹훅을 통해 실행됩니다.
다중 계정 지원은 다음과 같습니다. `channels.googlechat.accounts` (위의 다중 계정 섹션 참조) 환경 변수는 기본 계정에만 적용됩니다.

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url", // app-url | project-number
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; improves mention detection
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["users/1234567890"], // optional; "open" requires ["*"]
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": { allow: true, requireMention: true },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

참고:

- 서비스 계정 JSON은 인라인일 수 있습니다(`serviceAccount`) 또는 파일 기반(`serviceAccountFile`).
- 기본 계정에 대한 환경 대체: `GOOGLE_CHAT_SERVICE_ACCOUNT` 또는 `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE`.
- `audienceType` + `audience` Chat 앱의 웹훅 인증 구성과 일치해야 합니다.
- 사용 `spaces/<spaceId>` 또는 `users/<userId|email>` 배송 목표를 설정할 때

### `channels.slack` (소켓 모드)

Slack은 소켓 모드에서 실행되며 봇 토큰과 앱 토큰이 모두 필요합니다.

```json5
{
  channels: {
    slack: {
      enabled: true,
      botToken: "xoxb-...",
      appToken: "xapp-...",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["U123", "U456", "*"], // optional; "open" requires ["*"]
        groupEnabled: false,
        groupChannels: ["G123"],
      },
      channels: {
        C123: { allow: true, requireMention: true, allowBots: false },
        "#general": {
          allow: true,
          requireMention: true,
          allowBots: false,
          users: ["U123"],
          skills: ["docs"],
          systemPrompt: "Short answers only.",
        },
      },
      historyLimit: 50, // include last N channel/group messages as context (0 disables)
      allowBots: false,
      reactionNotifications: "own", // off | own | all | allowlist
      reactionAllowlist: ["U123"],
      replyToMode: "off", // off | first | all
      thread: {
        historyScope: "thread", // thread | channel
        inheritParent: false,
      },
      actions: {
        reactions: true,
        messages: true,
        pins: true,
        memberInfo: true,
        emojiList: true,
      },
      slashCommand: {
        enabled: true,
        name: "openclaw",
        sessionPrefix: "slack:slash",
        ephemeral: true,
      },
      textChunkLimit: 4000,
      chunkMode: "length",
      mediaMaxMb: 20,
    },
  },
}
```

다중 계정 지원은 다음과 같습니다. `channels.slack.accounts` (위의 다중 계정 섹션 참조) Env 토큰은 기본 계정에만 적용됩니다.

OpenClaw는 공급자가 활성화되고 두 토큰이 모두 설정되면(config 또는 `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`). 사용 `user:<id>` (DM) 또는 `channel:<id>` cron/CLI 명령의 전달 대상을 지정할 때.
세트 `channels.slack.configWrites: false` Slack에서 시작한 구성 쓰기(채널 ID 마이그레이션 및 `/config set|unset`).

봇이 작성한 메시지는 기본적으로 무시됩니다. 다음으로 활성화 `channels.slack.allowBots` 또는 `channels.slack.channels.<id>.allowBots`.

반응 알림 모드:

- `off`: 반응 이벤트가 없습니다.
- `own`: 봇 자체 메시지에 대한 반응(기본값)
- `all`: 모든 메시지에 대한 모든 반응.
- `allowlist`: 반응 `channels.slack.reactionAllowlist` 모든 메시지에 적용됩니다(빈 목록은 비활성화됩니다).

스레드 세션 격리:

- `channels.slack.thread.historyScope` 스레드 기록이 스레드별인지 여부를 제어합니다(`thread`, 기본값) 또는 채널 전체에서 공유됨(`channel`).
- `channels.slack.thread.inheritParent` 새 스레드 세션이 상위 채널 기록을 상속하는지 여부를 제어합니다(기본값: false).

Slack 작업 그룹(게이트 `slack` 도구 작업):

| Action group | Default | Notes                  |
| ------------ | ------- | ---------------------- |
| reactions    | enabled | React + list reactions |
| messages     | enabled | Read/send/edit/delete  |
| pins         | enabled | Pin/unpin/list         |
| memberInfo   | enabled | Member info            |
| emojiList    | enabled | Custom emoji list      |

### `channels.mattermost` (봇 토큰)

Mattermost는 플러그인으로 제공되며 핵심 설치와 함께 번들로 제공되지 않습니다.
먼저 설치하세요: `openclaw plugins install @openclaw/mattermost` (또는 `./extensions/mattermost` git 체크아웃에서).

Mattermost에는 봇 토큰과 서버의 기본 URL이 필요합니다.

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
      chatmode: "oncall", // oncall | onmessage | onchar
      oncharPrefixes: [">", "!"],
      textChunkLimit: 4000,
      chunkMode: "length",
    },
  },
}
```

OpenClaw는 계정이 구성되고(봇 토큰 + 기본 URL) 활성화되면 Mattermost를 시작합니다. 토큰 + 기본 URL은 다음에서 확인됩니다. `channels.mattermost.botToken` + `channels.mattermost.baseUrl` 또는 `MATTERMOST_BOT_TOKEN` + `MATTERMOST_URL` 기본 계정의 경우(예외 `channels.mattermost.enabled` ~이다 `false`).

채팅 모드:

- `oncall` (기본값): @멘션된 경우에만 채널 메시지에 응답합니다.
- `onmessage`: 모든 채널 메시지에 응답합니다.
- `onchar`: 메시지가 트리거 접두사(`channels.mattermost.oncharPrefixes`, 기본 `[">", "!"]`).

액세스 제어:

- 기본 DM: `channels.mattermost.dmPolicy="pairing"` (알 수 없는 발신자는 페어링 코드를 받습니다.)
- 공개 DM: `channels.mattermost.dmPolicy="open"` ...을 더한 `channels.mattermost.allowFrom=["*"]`.
- 여러 떼: `channels.mattermost.groupPolicy="allowlist"` 기본적으로(언급 제한). 사용 `channels.mattermost.groupAllowFrom` 발신자를 제한합니다.

다중 계정 지원은 다음과 같습니다. `channels.mattermost.accounts` (위의 다중 계정 섹션 참조) 환경 변수는 기본 계정에만 적용됩니다.
사용 `channel:<id>` 또는 `user:<id>` (또는 `@username`) 전달 대상을 지정할 때; 기본 ID는 채널 ID로 처리됩니다.

### `channels.signal` (신호 CLI)

신호 반응은 시스템 이벤트를 생성할 수 있습니다(공유 반응 도구).

```json5
{
  channels: {
    signal: {
      reactionNotifications: "own", // off | own | all | allowlist
      reactionAllowlist: ["+15551234567", "uuid:123e4567-e89b-12d3-a456-426614174000"],
      historyLimit: 50, // include last N group messages as context (0 disables)
    },
  },
}
```

반응 알림 모드:

- `off`: 반응 이벤트가 없습니다.
- `own`: 봇 자체 메시지에 대한 반응(기본값)
- `all`: 모든 메시지에 대한 모든 반응.
- `allowlist`: 반응 `channels.signal.reactionAllowlist` 모든 메시지에 적용됩니다(빈 목록은 비활성화됩니다).

### `channels.imessage` (imsg CLI)

OpenClaw가 생성됩니다. `imsg rpc` (stdio를 통한 JSON-RPC). 데몬이나 포트가 필요하지 않습니다.

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "imsg",
      dbPath: "~/Library/Messages/chat.db",
      remoteHost: "user@gateway-host", // SCP for remote attachments when using SSH wrapper
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["+15555550123", "user@example.com", "chat_id:123"],
      historyLimit: 50, // include last N group messages as context (0 disables)
      includeAttachments: false,
      mediaMaxMb: 16,
      service: "auto",
      region: "US",
    },
  },
}
```

다중 계정 지원은 다음과 같습니다. `channels.imessage.accounts` (위의 다중 계정 섹션 참조)

참고:

- 메시지 DB에 대한 전체 디스크 액세스가 필요합니다.
- 첫 번째 전송에서는 메시지 자동화 권한을 묻는 메시지가 표시됩니다.
- 선호하다 `chat_id:<id>` 목표. 사용 `imsg chats --limit 20` 채팅 목록을 표시합니다.
- `channels.imessage.cliPath` 래퍼 스크립트를 가리킬 수 있습니다(예: `ssh` 실행되는 다른 Mac으로 `imsg rpc`); 비밀번호 프롬프트를 방지하려면 SSH 키를 사용하세요.
- 원격 SSH 래퍼의 경우 다음을 설정합니다. `channels.imessage.remoteHost` SCP를 통해 첨부 파일을 가져오는 경우 `includeAttachments` 활성화되었습니다.

예시 래퍼:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

### `agents.defaults.workspace`

설정 **단일 전역 작업공간 디렉토리** 파일 작업을 위해 에이전트에서 사용됩니다.

기본: `~/.openclaw/workspace`.

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

만약에 `agents.defaults.sandbox` 활성화되면 기본이 아닌 세션이 이를 재정의할 수 있습니다.
자신의 범위별 작업 공간 `agents.defaults.sandbox.workspaceRoot`.

### `agents.defaults.repoRoot`

시스템 프롬프트의 런타임 라인에 표시할 선택적 저장소 루트입니다. 설정하지 않으면 OpenClaw
감지하려고 시도합니다. `.git` 작업 공간에서 위쪽으로 이동하여 디렉터리(및 현재
작업 디렉토리). 경로가 존재해야 사용할 수 있습니다.

```json5
{
  agents: { defaults: { repoRoot: "~/Projects/openclaw" } },
}
```

### `agents.defaults.skipBootstrap`

작업공간 부트스트랩 파일의 자동 생성을 비활성화합니다(`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, 그리고 `BOOTSTRAP.md`).

작업공간 파일이 저장소에서 제공되는 사전 시드 배포에 이 기능을 사용하세요.

```json5
{
  agents: { defaults: { skipBootstrap: true } },
}
```

### `agents.defaults.bootstrapMaxChars`

시스템 프롬프트에 삽입된 각 작업 공간 부트스트랩 파일의 최대 문자 수
자르기 전. 기본: `20000`.

파일이 이 제한을 초과하면 OpenClaw는 경고를 기록하고 잘린 파일을 삽입합니다.
마커가 있는 머리/꼬리.

```json5
{
  agents: { defaults: { bootstrapMaxChars: 20000 } },
}
```

### `agents.defaults.userTimezone`

사용자의 시간대를 설정합니다. **시스템 프롬프트 컨텍스트** (타임스탬프에는 해당되지 않습니다.
메시지 봉투). 설정하지 않으면 OpenClaw는 런타임 시 호스트 시간대를 사용합니다.

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

### `agents.defaults.timeFormat`

제어합니다 **시간 형식** 시스템 프롬프트의 현재 날짜 및 시간 섹션에 표시됩니다.
기본: `auto` (OS 기본 설정).

```json5
{
  agents: { defaults: { timeFormat: "auto" } }, // auto | 12 | 24
}
```

### `messages`

인바운드/아웃바운드 접두사 및 선택적 확인 반응을 제어합니다.
보다 [메시지](/concepts/messages) 대기열, 세션 및 스트리밍 컨텍스트에 대한 것입니다.

```json5
{
  messages: {
    responsePrefix: "🦞", // or "auto"
    ackReaction: "👀",
    ackReactionScope: "group-mentions",
    removeAckAfterReply: false,
  },
}
```

`responsePrefix` 에 적용됩니다 **모든 아웃바운드 응답** (도구 요약, 블록
스트리밍, 최종 응답)은 이미 존재하지 않는 한 채널 전반에 걸쳐 이루어집니다.

재정의는 채널 및 계정별로 구성할 수 있습니다.

- `channels.<channel>.responsePrefix`
- `channels.<channel>.accounts.<id>.responsePrefix`

해결 순서(가장 구체적인 승리):

1. `channels.<channel>.accounts.<id>.responsePrefix`
2. `channels.<channel>.responsePrefix`
3. `messages.responsePrefix`

의미론:

- `undefined` 다음 레벨로 넘어갑니다.
- `""` 접두사를 명시적으로 비활성화하고 계단식 배열을 중지합니다.
- `"auto"` 파생 `[{identity.name}]` 라우팅된 에이전트의 경우.

재정의는 내선 번호를 포함한 모든 채널과 모든 아웃바운드 회신 종류에 적용됩니다.

만약에 `messages.responsePrefix` 설정되지 않은 경우 기본적으로 접두사가 적용되지 않습니다. WhatsApp 셀프 채팅
답글은 예외입니다. 기본적으로는 `[{identity.name}]` 설정되면 그렇지 않으면
`[openclaw]`, 동일한 전화 통화를 읽을 수 있도록 유지합니다.
다음으로 설정하세요 `"auto"` 파생하다 `[{identity.name}]` 라우팅된 에이전트의 경우(설정된 경우)

#### 템플릿 변수

그만큼 `responsePrefix` 문자열에는 동적으로 확인되는 템플릿 변수가 포함될 수 있습니다.

| Variable          | Description            | Example                     |
| ----------------- | ---------------------- | --------------------------- |
| `{model}`         | Short model name       | `claude-opus-4-6`, `gpt-4o` |
| `{modelFull}`     | Full model identifier  | `anthropic/claude-opus-4-6` |
| `{provider}`      | Provider name          | `anthropic`, `openai`       |
| `{thinkingLevel}` | Current thinking level | `high`, `low`, `off`        |
| `{identity.name}` | Agent identity name    | (same as `"auto"` mode)     |

변수는 대소문자를 구분하지 않습니다(`{MODEL}` = `{model}`).`{think}` 의 별칭입니다 `{thinkingLevel}`.
해결되지 않은 변수는 리터럴 텍스트로 유지됩니다.

```json5
{
  messages: {
    responsePrefix: "[{model} | think:{thinkingLevel}]",
  },
}
```

예제 출력: `[claude-opus-4-6 | think:high] Here's my response...`

WhatsApp 인바운드 접두사는 다음을 통해 구성됩니다. `channels.whatsapp.messagePrefix` (더 이상 사용되지 않음:
`messages.messagePrefix`). 기본 숙박 **변하지 않은**: `"[openclaw]"` 언제 
`channels.whatsapp.allowFrom` 비어 있습니다. 그렇지 않으면 `""` (접두사 없음). 사용시
`"[openclaw]"`, OpenClaw는 대신 `[{identity.name}]` 라우팅되었을 때
대리인이 `identity.name` 세트.

`ackReaction` 인바운드 메시지를 확인하기 위해 최선의 이모티콘 반응을 보냅니다.
반응을 지원하는 채널(Slack/Discord/Telegram/Google Chat)에서. 기본값은
활성 에이전트 `identity.emoji` 설정되면 그렇지 않으면`"👀"`. 다음으로 설정하세요 `""` 비활성화합니다.

`ackReactionScope` 반응이 발생하는 시기를 제어합니다.

- `group-mentions` (기본값): 그룹/방에 멘션이 필요한 경우에만 **그리고** 봇이 언급됐어요
- `group-all`: 모든 그룹/방 메시지
- `direct`: 다이렉트 메시지만
- `all`: 모든 메시지

`removeAckAfterReply` 응답이 전송된 후 봇의 승인 반응을 제거합니다.
(Slack/Discord/Telegram/Google Chat에만 해당) 기본: `false`.

#### `messages.tts`

아웃바운드 응답에 대해 텍스트 음성 변환을 활성화합니다. 켜져 있으면 OpenClaw가 오디오를 생성합니다.
ElevenLabs 또는 OpenAI를 사용하여 이를 응답에 첨부합니다. 텔레그램은 Opus를 사용합니다
음성 메모; 다른 채널은 MP3 오디오를 보냅니다.

```json5
{
  messages: {
    tts: {
      auto: "always", // off | always | inbound | tagged
      mode: "final", // final | all (include tool/block replies)
      provider: "elevenlabs",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: {
        enabled: true,
      },
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
      elevenlabs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "voice_id",
        modelId: "eleven_multilingual_v2",
        seed: 42,
        applyTextNormalization: "auto",
        languageCode: "en",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0.0,
          useSpeakerBoost: true,
          speed: 1.0,
        },
      },
      openai: {
        apiKey: "openai_api_key",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
    },
  },
}
```

참고:

- `messages.tts.auto` 자동 TTS 제어(`off`, `always`, `inbound`, `tagged`).
- `/tts off|always|inbound|tagged` 세션별 ​​자동 모드를 설정합니다(구성 재정의).
- `messages.tts.enabled` 유산이다; 의사가 그것을 다음으로 옮겼습니다. `messages.tts.auto`.
- `prefsPath` 로컬 재정의(공급자/제한/요약)를 저장합니다.
- `maxTextLength` TTS 입력에 대한 하드 캡입니다. 요약은 맞게 잘립니다.
- `summaryModel` 재정의 `agents.defaults.model.primary` 자동 요약용.
  - 수락 `provider/model` 또는 다음의 별칭 `agents.defaults.models`.
- `modelOverrides` 다음과 같은 모델 기반 재정의를 가능하게 합니다. `[[tts:...]]` 태그(기본적으로 켜져 있음).
- `/tts limit`그리고`/tts summary` 사용자별 요약 설정을 제어합니다.
- `apiKey` 가치는 다음으로 돌아간다 `ELEVENLABS_API_KEY`/`XI_API_KEY`그리고`OPENAI_API_KEY`.
- `elevenlabs.baseUrl` ElevenLabs API 기본 URL을 재정의합니다.
- `elevenlabs.voiceSettings` 지원하다 `stability`/`similarityBoost`/`style` (0..1),
  `useSpeakerBoost`, 그리고 `speed` (0.5..2.0).

### `talk`

토크 모드(macOS/iOS/Android)의 기본값입니다. 음성 ID는 다음으로 대체됩니다. `ELEVENLABS_VOICE_ID` 또는 `SAG_VOICE_ID` 설정되지 않은 경우.
`apiKey` 다시 떨어진다 `ELEVENLABS_API_KEY` (또는 게이트웨이의 셸 프로필)이 설정되지 않은 경우.
`voiceAliases` Talk 지시문에 친숙한 이름을 사용할 수 있습니다(예: `"voice":"Clawd"`).

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    voiceAliases: {
      Clawd: "EXAVITQu4vr4xnSDxMaL",
      Roger: "CwhRBWXzGAHq8TQ4Fs17",
    },
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: true,
  },
}
```

### `agents.defaults`

내장된 에이전트 런타임(모델/사고/상세/시간 초과)을 제어합니다.
`agents.defaults.models` 구성된 모델 카탈로그를 정의합니다. `/model`).
`agents.defaults.model.primary` 기본 모델을 설정합니다. `agents.defaults.model.fallbacks` 전역 장애 조치입니다.
`agents.defaults.imageModel` 선택 사항이며 **기본 모델에 이미지 입력이 없는 경우에만 사용됩니다.**.
각 `agents.defaults.models` 항목에는 다음이 포함될 수 있습니다.

- `alias` (선택적 모델 단축키, 예: `/opus`).
- `params` (선택적인 공급자별 API 매개변수가 모델 요청에 전달됨)

`params` 스트리밍 실행(내장 에이전트 + 압축)에도 적용됩니다. 현재 지원되는 키: `temperature`, `maxTokens`. 이는 통화 시간 옵션과 병합됩니다. 호출자가 제공한 값이 승리합니다. `temperature` 고급 손잡이입니다. 모델의 기본값을 알고 변경이 필요한 경우가 아니면 설정하지 않은 채로 두십시오.

예:

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-sonnet-4-5-20250929": {
          params: { temperature: 0.6 },
        },
        "openai/gpt-5.2": {
          params: { maxTokens: 8192 },
        },
      },
    },
  },
}
```

Z.AI GLM-4.x 모델은 다음과 같은 경우를 제외하고 자동으로 사고 모드를 활성화합니다.

- 세트 `--thinking off`, 또는
- 정의하다 `agents.defaults.models["zai/<model>"].params.thinking` 당신 자신.

OpenClaw에는 몇 가지 내장 별칭 속기도 제공됩니다. 기본값은 모델이
에 이미 존재합니다. `agents.defaults.models`: 

- `opus` -> `anthropic/claude-opus-4-6`
- `sonnet` -> `anthropic/claude-sonnet-4-5`
- `gpt` -> `openai/gpt-5.2`
- `gpt-mini` -> `openai/gpt-5-mini`
- `gemini` -> `google/gemini-3-pro-preview`
- `gemini-flash` -> `google/gemini-3-flash-preview`

동일한 별칭 이름(대소문자 구분 안 함)을 직접 구성하는 경우 해당 값이 적용됩니다(기본값은 재정의되지 않음).

예: MiniMax M2.1 대체 기능을 갖춘 Opus 4.6 기본(호스팅 MiniMax):

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

MiniMax 인증: 설정 `MINIMAX_API_KEY` (env) 또는 구성 `models.providers.minimax`.

#### `agents.defaults.cliBackends` (CLI 대체)

텍스트 전용 대체 실행을 위한 선택적 CLI 백엔드(도구 호출 없음). 이것들은 다음과 같이 유용합니다.
API 공급자가 실패할 경우의 백업 경로입니다. 구성할 때 이미지 통과가 지원됩니다.
안 `imageArg` 파일 경로를 허용합니다.

참고:

- CLI 백엔드는 **텍스트 우선**; 도구는 항상 비활성화되어 있습니다.
- 세션은 다음과 같은 경우에 지원됩니다. `sessionArg` 설정되었습니다. 세션 ID는 백엔드별로 유지됩니다.
- 을 위한 `claude-cli`, 기본값이 연결되어 있습니다. PATH가 최소인 경우 명령 경로를 재정의하세요.
  (launchd/systemd).

예:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          modelArg: "--model",
          sessionArg: "--session",
          sessionMode: "existing",
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
        },
      },
    },
  },
}
```

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "anthropic/claude-sonnet-4-1": { alias: "Sonnet" },
        "openrouter/deepseek/deepseek-r1:free": {},
        "zai/glm-4.7": {
          alias: "GLM",
          params: {
            thinking: {
              type: "enabled",
              clear_thinking: false,
            },
          },
        },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: [
          "openrouter/deepseek/deepseek-r1:free",
          "openrouter/meta-llama/llama-3.3-70b-instruct:free",
        ],
      },
      imageModel: {
        primary: "openrouter/qwen/qwen-2.5-vl-72b-instruct:free",
        fallbacks: ["openrouter/google/gemini-2.0-flash-vision:free"],
      },
      thinkingDefault: "low",
      verboseDefault: "off",
      elevatedDefault: "on",
      timeoutSeconds: 600,
      mediaMaxMb: 5,
      heartbeat: {
        every: "30m",
        target: "last",
      },
      maxConcurrent: 3,
      subagents: {
        model: "minimax/MiniMax-M2.1",
        maxConcurrent: 1,
        archiveAfterMinutes: 60,
      },
      exec: {
        backgroundMs: 10000,
        timeoutSec: 1800,
        cleanupMs: 1800000,
      },
      contextTokens: 200000,
    },
  },
}
```

#### `agents.defaults.contextPruning` (도구 결과 가지치기)

`agents.defaults.contextPruning` 서양 자두 **오래된 도구 결과** 요청이 LLM으로 전송되기 직전에 메모리 내 컨텍스트에서.
그렇습니다 **~ 아니다** 디스크의 세션 기록을 수정합니다(`*.jsonl` 완전한 상태로 유지됩니다).

이는 시간이 지남에 따라 대규모 도구 출력을 축적하는 수다스러운 에이전트의 토큰 사용량을 줄이기 위한 것입니다.

높은 수준:

- 사용자/보조 메시지를 절대 건드리지 마세요.
- 마지막을 보호합니다 `keepLastAssistants` 보조 메시지(해당 지점 이후에는 도구 결과가 정리되지 않음)
- 부트스트랩 접두사를 보호합니다(첫 번째 사용자 메시지가 정리되기 전에는 아무것도 보호되지 않음).
- 모드:
  - `adaptive`: 추정된 컨텍스트 비율이 교차할 때 대형 도구 결과(머리/꼬리 유지)를 소프트 트림합니다. `softTrimRatio`.
    그런 다음 예상 컨텍스트 비율이 초과되면 가장 오래된 적격 도구 결과를 하드 클리어합니다. `hardClearRatio` **그리고**
    정리 가능한 도구 결과 대량이 충분합니다(`minPrunableToolChars`).
  - `aggressive`: 항상 컷오프 전에 적합한 도구 결과를 다음으로 대체합니다. `hardClear.placeholder` (비율 확인 없음).

소프트 프루닝과 하드 프루닝(LLM으로 전송된 컨텍스트의 변경 사항):

- **소프트 트림**: 전용 _대형_ 도구 결과. 시작 + 끝을 유지하고 삽입합니다. `...` 중간에.
  - 전에: `toolResult("…very long output…")`
  - 후에: `toolResult("HEAD…\n...\n…TAIL\n\n[Tool result trimmed: …]")`
- **하드클리어**: 전체 도구 결과를 자리 표시자로 바꿉니다.
  - 전에: `toolResult("…very long output…")`
  - 후에: `toolResult("[Old tool result content cleared]")`

참고/현재 제한사항:

- 다음을 포함하는 도구 결과 **이미지 블록을 건너뜁니다.** (절대로 다듬어지거나 지워지지 않음) 지금 당장.
- 추정된 "컨텍스트 비율"은 다음을 기반으로 합니다. **문자** (대략), 정확한 토큰은 아닙니다.
- 세션에 최소한 `keepLastAssistants` 보조 메시지가 아직 없으면 정리를 건너뜁니다.
- ~ 안에 `aggressive` 방법, `hardClear.enabled` 무시됩니다(적격한 도구 결과는 항상 다음으로 대체됩니다). `hardClear.placeholder`).

기본값(적응형):

```json5
{
  agents: { defaults: { contextPruning: { mode: "adaptive" } } },
}
```

비활성화하려면:

```json5
{
  agents: { defaults: { contextPruning: { mode: "off" } } },
}
```

기본값(때 `mode` ~이다 `"adaptive"` 또는 `"aggressive"`):

- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3` (적응형만 해당)
- `hardClearRatio`: `0.5` (적응형만 해당)
- `minPrunableToolChars`: `50000` (적응형만 해당)
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }` (적응형만 해당)
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

예(공격적, 최소):

```json5
{
  agents: { defaults: { contextPruning: { mode: "aggressive" } } },
}
```

예(적응형 조정):

```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "adaptive",
        keepLastAssistants: 3,
        softTrimRatio: 0.3,
        hardClearRatio: 0.5,
        minPrunableToolChars: 50000,
        softTrim: { maxChars: 4000, headChars: 1500, tailChars: 1500 },
        hardClear: { enabled: true, placeholder: "[Old tool result content cleared]" },
        // Optional: restrict pruning to specific tools (deny wins; supports "*" wildcards)
        tools: { deny: ["browser", "canvas"] },
      },
    },
  },
}
```

보다 [/개념/세션 가지치기](/concepts/session-pruning) 행동 세부정보를 확인하세요.

#### `agents.defaults.compaction` (예비 헤드룸 + 메모리 플러시)

`agents.defaults.compaction.mode` 압축 요약 전략을 선택합니다. 기본값은 `default`; 세트 `safeguard` 매우 긴 기록에 대해 청크 요약을 가능하게 합니다. 보다 [/개념/압축](/concepts/compaction).

`agents.defaults.compaction.reserveTokensFloor` 최소한의 조치를 취함 `reserveTokens`
Pi 압축 값(기본값: `20000`). 다음으로 설정하세요 `0` 바닥을 비활성화합니다.

`agents.defaults.compaction.memoryFlush` 실행 **조용한** 이전에 에이전트 턴
자동 압축, 디스크에 내구성 있는 메모리를 저장하도록 모델에 지시(예:
`memory/YYYY-MM-DD.md`). 세션 토큰 추정치가
압축 한계보다 낮은 소프트 임계값.

레거시 기본값:

- `memoryFlush.enabled`: `true`
- `memoryFlush.softThresholdTokens`: `4000`
- `memoryFlush.prompt`/`memoryFlush.systemPrompt`: 내장된 기본값 `NO_REPLY`
- 참고: 세션 작업 공간이 읽기 전용인 경우 메모리 플러시를 건너뜁니다.
  (`agents.defaults.sandbox.workspaceAccess: "ro"` 또는 `"none"`).

예(조정됨):

```json5
{
  agents: {
    defaults: {
      compaction: {
        mode: "safeguard",
        reserveTokensFloor: 24000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 6000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

스트리밍 차단:

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (기본값은 꺼짐).
- 채널 재정의: `*.blockStreaming` (및 계정별 변형) 블록 스트리밍을 강제로 켜거나 끌 수 있습니다.
  텔레그램이 아닌 채널에는 명시적인 `*.blockStreaming: true` 차단 답장을 활성화합니다.
- `agents.defaults.blockStreamingBreak`: `"text_end"` 또는 `"message_end"` (기본값: text_end).
- `agents.defaults.blockStreamingChunk`: 스트리밍된 블록에 대한 소프트 청킹. 기본값은
  800~1200자, 단락 나누기를 선호합니다(`\n\n`), 개행 문자, 문장 순입니다.
  예:

  ```json5
  {
    agents: { defaults: { blockStreamingChunk: { minChars: 800, maxChars: 1200 } } },
  }
  ```

- `agents.defaults.blockStreamingCoalesce`: 전송하기 전에 스트리밍된 블록을 병합합니다.
  기본값은 `{ idleMs: 1000 }` 그리고 상속받다 `minChars` ~에서 `blockStreamingChunk`
  ~와 함께 `maxChars` 채널 텍스트 제한으로 제한됩니다. Signal/Slack/Discord/Google Chat 기본
  에 `minChars: 1500` 재정의되지 않는 한.
  채널 재정의: `channels.whatsapp.blockStreamingCoalesce`, `channels.telegram.blockStreamingCoalesce`, 
  `channels.discord.blockStreamingCoalesce`, `channels.slack.blockStreamingCoalesce`, `channels.mattermost.blockStreamingCoalesce`, 
  `channels.signal.blockStreamingCoalesce`, `channels.imessage.blockStreamingCoalesce`, `channels.msteams.blockStreamingCoalesce`, 
  `channels.googlechat.blockStreamingCoalesce`
  (및 계정별 변형).
- `agents.defaults.humanDelay`: 다음 사이의 무작위 일시중지 **답글 차단** 첫 번째 이후.
  모드: `off` (기본), `natural` (800~2500ms), `custom` (사용 `minMs`/`maxMs`).
  에이전트별 재정의: `agents.list[].humanDelay`.
  예:

  ```json5
  {
    agents: { defaults: { humanDelay: { mode: "natural" } } },
  }
  ```

  보다 [/개념/스트리밍](/concepts/streaming) 동작 + 청킹 세부정보

입력 표시기:

- `agents.defaults.typingMode`: `"never" | "instant" | "thinking" | "message"`. 기본값은
  `instant` 직접 채팅/멘션 및 `message` 언급되지 않은 그룹 채팅의 경우.
- `session.typingMode`: 모드에 대한 세션별 재정의.
- `agents.defaults.typingIntervalSeconds`: 입력 신호가 새로 고쳐지는 빈도(기본값: 6초)
- `session.typingIntervalSeconds`: 새로 고침 간격에 대한 세션별 재정의입니다.
  보다 [/개념/입력 표시기](/concepts/typing-indicators) 행동 세부정보를 확인하세요.

`agents.defaults.model.primary` 다음과 같이 설정해야 합니다. `provider/model` (예: `anthropic/claude-opus-4-6`).
별칭은 다음에서 유래합니다. `agents.defaults.models.*.alias` (예: `Opus`).
공급자를 생략하면 OpenClaw는 현재 `anthropic` 일시적으로
지원 중단 대체.
Z.AI 모델은 다음과 같이 제공됩니다. `zai/<model>` (예: `zai/glm-4.7`) 그리고 요구
`ZAI_API_KEY` (또는 유산 `Z_AI_API_KEY`) 환경에서.

`agents.defaults.heartbeat` 주기적인 하트비트 실행을 구성합니다.

- `every`: 기간 문자열(`ms`, `s`, `m`, `h`); 기본 단위는 분입니다. 기본:
  `30m`. 세트 `0m` 비활성화합니다.
- `model`: 하트비트 실행을 위한 선택적 재정의 모델(`provider/model`).
- `includeReasoning`: 언제 `true`, 하트비트도 별도로 전달됩니다. `Reasoning:` 사용 가능한 경우 메시지(와 같은 모양) `/reasoning on`). 기본: `false`.
- `session`: 하트비트가 실행되는 세션을 제어하는 ​​선택적 세션 키입니다. 기본값: `main`.
- `to`: 선택적 수신자 재정의(채널별 ID, 예: WhatsApp의 경우 E.164, Telegram의 채팅 ID).
- `target`: 선택적 전달 채널(`last`, `whatsapp`, `telegram`, `discord`, `slack`, `msteams`, `signal`, `imessage`, `none`). 기본: `last`.
- `prompt`: 하트비트 본문에 대한 선택적 재정의(기본값: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). 재정의는 그대로 전송됩니다. 포함하다 `Read HEARTBEAT.md` 여전히 파일을 읽으려면 줄을 선택하십시오.
- `ackMaxChars`: 이후에 허용되는 최대 문자 수 `HEARTBEAT_OK` 배송 전(기본값: 300).

에이전트별 하트비트:

- 세트 `agents.list[].heartbeat` 특정 에이전트에 대한 하트비트 설정을 활성화하거나 재정의합니다.
- 에이전트 항목이 정의된 경우 `heartbeat`, **그 요원들만** 심장박동을 뛰다; 기본값
  해당 상담원의 공유 기준이 됩니다.

하트비트는 전체 에이전트 회전을 실행합니다. 간격이 짧을수록 더 많은 토큰이 소모됩니다. 조심해라
의 `every`, 유지하다 `HEARTBEAT.md` 아주 작거나 더 싼 것을 선택하세요 `model`.

`tools.exec` 백그라운드 실행 기본값을 구성합니다.

- `backgroundMs`: 자동 백그라운드 전 시간(ms, 기본값 10000)
- `timeoutSec`: 이 런타임 이후 자동 종료(초, 기본값 1800)
- `cleanupMs`: 완료된 세션을 메모리에 보관하는 기간(ms, 기본값 1800000)
- `notifyOnExit`: 시스템 이벤트를 대기열에 추가하고 백그라운드 exec가 종료될 때 하트비트를 요청합니다(기본값은 true).
- `applyPatch.enabled`: 실험적 활성화 `apply_patch` (OpenAI/OpenAI Codex에만 해당, 기본값은 false)
- `applyPatch.allowModels`: 모델 ID의 선택적 허용 목록(예: `gpt-5.2` 또는 `openai/gpt-5.2`)
  메모: `applyPatch` 아래에만 있습니다 `tools.exec`.

`tools.web` 웹 검색 + 가져오기 도구 구성:

- `tools.web.search.enabled` (기본값: 키가 있으면 true)
- `tools.web.search.apiKey` (권장: 다음을 통해 설정 `openclaw configure --section web`, 또는 사용 `BRAVE_API_KEY` 환경 변수)
- `tools.web.search.maxResults` (1~10, 기본값 5)
- `tools.web.search.timeoutSeconds` (기본값 30)
- `tools.web.search.cacheTtlMinutes` (기본값 15)
- `tools.web.fetch.enabled` (기본값은 참)
- `tools.web.fetch.maxChars` (기본값 50000)
- `tools.web.fetch.maxCharsCap` (기본값 50000; 구성/도구 호출에서 maxChars를 고정합니다)
- `tools.web.fetch.timeoutSeconds` (기본값 30)
- `tools.web.fetch.cacheTtlMinutes` (기본값 15)
- `tools.web.fetch.userAgent` (선택적 재정의)
- `tools.web.fetch.readability` (기본값은 true, 기본 HTML 정리만 사용하려면 비활성화)
- `tools.web.fetch.firecrawl.enabled` (API 키가 설정된 경우 기본값은 true)
- `tools.web.fetch.firecrawl.apiKey` (선택 사항; 기본값은 `FIRECRAWL_API_KEY`)
- `tools.web.fetch.firecrawl.baseUrl` (기본 [https://api.firecrawl.dev](https://api.firecrawl.dev))
- `tools.web.fetch.firecrawl.onlyMainContent` (기본값은 참)
- `tools.web.fetch.firecrawl.maxAgeMs` (선택 과목)
- `tools.web.fetch.firecrawl.timeoutSeconds` (선택 과목)

`tools.media` 인바운드 미디어 이해(이미지/오디오/비디오)를 구성합니다.

- `tools.media.models`: 공유 모델 목록(기능 태그가 지정됨, 캡별 목록 뒤에 사용됨)
- `tools.media.concurrency`: 최대 동시 기능이 실행됩니다(기본값 2).
- `tools.media.image`/`tools.media.audio`/`tools.media.video`: 
  - `enabled`: 옵트아웃 스위치(모델이 구성된 경우 기본값은 true).
  - `prompt`: 선택적 프롬프트 재정의(이미지/비디오 추가 `maxChars` 자동으로 힌트를 줍니다).
  - `maxChars`: 최대 출력 문자(이미지/비디오의 경우 기본값은 500, 오디오의 경우 설정되지 않음)
  - `maxBytes`: 전송할 최대 미디어 크기(기본값: 이미지 10MB, 오디오 20MB, 비디오 50MB)
  - `timeoutSeconds`: 요청 시간 초과(기본값: 이미지 60초, 오디오 60초, 비디오 120초).
  - `language`: 선택적 오디오 힌트.
  - `attachments`: 첨부파일 정책(`mode`, `maxAttachments`, `prefer`).
  - `scope`: 선택적 게이팅(첫 번째 매치 승리) `match.channel`, `match.chatType`, 또는`match.keyPrefix`.
  - `models`: 모델 항목의 정렬된 목록; 오류가 발생하거나 크기가 너무 큰 미디어는 다음 항목으로 대체됩니다.
- 각 `models[]` 기입:
  - 공급자 항목(`type: "provider"` 또는 생략됨):
    - `provider`: API 제공자 ID(`openai`, `anthropic`, `google`/`gemini`, `groq`, 등).
    - `model`: 모델 ID 재정의(이미지에 필수, 기본값은 `gpt-4o-mini-transcribe`/`whisper-large-v3-turbo` 오디오 제공업체의 경우 `gemini-3-flash-preview` 비디오용).
    - `profile`/`preferredProfile`: 인증 프로필 선택.
  - CLI 항목(`type: "cli"`):
    - `command`: 실행할 수 있는 실행 파일입니다.
    - `args`: 템플릿 인수(지원 `{{MediaPath}}`, `{{Prompt}}`, `{{MaxChars}}`, 등).
  - `capabilities`: 선택적 목록(`image`, `audio`, `video`) 공유 항목을 게이트합니다. 생략 시 기본값: `openai`/`anthropic`/`minimax` → 이미지, `google` → 이미지+오디오+비디오, `groq` → 오디오.
  - `prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language` 항목별로 재정의될 수 있습니다.

모델이 구성되지 않은 경우(또는 `enabled: false`), 이해를 건너뜁니다. 모델은 여전히 ​​원본 첨부 파일을 받습니다.

공급자 인증은 표준 모델 인증 순서(인증 프로필, 환경 변수 등)를 따릅니다. `OPENAI_API_KEY`/`GROQ_API_KEY`/`GEMINI_API_KEY`, 또는`models.providers.*.apiKey`).

예:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        scope: {
          default: "deny",
          rules: [{ action: "allow", match: { chatType: "direct" } }],
        },
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          { type: "cli", command: "whisper", args: ["--model", "base", "{{MediaPath}}"] },
        ],
      },
      video: {
        enabled: true,
        maxBytes: 52428800,
        models: [{ provider: "google", model: "gemini-3-flash-preview" }],
      },
    },
  },
}
```

`agents.defaults.subagents` 하위 에이전트 기본값을 구성합니다.

- `model`: 생성된 하위 에이전트의 기본 모델(문자열 또는 `{ primary, fallbacks }`). 생략하면 하위 에이전트는 에이전트별 또는 호출별로 재정의되지 않는 한 호출자의 모델을 상속합니다.
- `maxConcurrent`: 최대 동시 하위 에이전트 실행(기본값 1)
- `archiveAfterMinutes`: N분 후 하위 에이전트 세션 자동 보관(기본값 60, 설정) `0` 비활성화)
- 하위 에이전트별 도구 정책: `tools.subagents.tools.allow`/`tools.subagents.tools.deny` (승리 거부)

`tools.profile` 세트하다 **기본 도구 허용 목록** ~ 전에 `tools.allow`/`tools.deny`: 

- `minimal`: `session_status`오직
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: 제한 없음(설정되지 않은 것과 동일)

에이전트별 재정의: `agents.list[].tools.profile`.

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

`tools.byProvider` 당신을 할 수 있습니다 **더욱 제한하다** 특정 공급자(또는 단일 공급자)를 위한 도구 `provider/model`).
  에이전트별 재정의: `agents.list[].tools.byProvider`.

순서: 기본 프로필 → 공급자 프로필 → 정책 허용/거부.
공급자 키는 다음 중 하나를 허용합니다. `provider` (예: `google-antigravity`) 또는 `provider/model`
 (예: `openai/gpt-5.2`).

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

예(공급업체/모델별 허용 목록):

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

`tools.allow`/`tools.deny` 전역 도구 허용/거부 정책(거부 승리)을 구성합니다.
일치는 대소문자를 구분하지 않으며 다음을 지원합니다. `*` 와일드카드(`"*"` 모든 도구를 의미합니다.)
이는 Docker 샌드박스가 설치된 경우에도 적용됩니다. **끄다**.

예(모든 곳에서 브라우저/캔버스 비활성화):

```json5
{
  tools: { deny: ["browser", "canvas"] },
}
```

도구 그룹(약칭)은 다음에서 작동합니다. **글로벌**그리고**에이전트별** 도구 정책:

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

`tools.elevated` 승격된(호스트) exec 액세스를 제어합니다.

- `enabled`: 관리자 모드 허용(기본값은 true)
- `allowFrom`: 채널별 허용 목록(비어 있음 = 비활성화됨)
  - `whatsapp`: E.164 번호
  - `telegram`: 채팅 ID 또는 사용자 이름
  - `discord`: 사용자 ID 또는 사용자 이름(대체 `channels.discord.dm.allowFrom` 생략된 경우)
  - `signal`: E.164 번호
  - `imessage`: 핸들/채팅 ID
  - `webchat`: 세션 ID 또는 사용자 이름

예:

```json5
{
  tools: {
    elevated: {
      enabled: true,
      allowFrom: {
        whatsapp: ["+15555550123"],
        discord: ["steipete", "1234567890123"],
      },
    },
  },
}
```

에이전트별 재정의(추가 제한):

```json5
{
  agents: {
    list: [
      {
        id: "family",
        tools: {
          elevated: { enabled: false },
        },
      },
    ],
  },
}
```

참고:

- `tools.elevated` 글로벌 기준선입니다. `agents.list[].tools.elevated` 추가로 제한할 수만 있습니다(둘 다 허용해야 함).
- `/elevated on|off|ask|full` 세션 키당 상태를 저장합니다. 인라인 지시문은 단일 메시지에 적용됩니다.
- 높은 `exec` 호스트에서 실행되며 샌드박스를 우회합니다.
- 도구 정책은 계속 적용됩니다. 만약에 `exec` 거부되면 승격된 기능을 사용할 수 없습니다.

`agents.defaults.maxConcurrent` 포함된 에이전트 실행의 최대 수를 설정합니다.
여러 세션에서 병렬로 실행됩니다. 각 세션은 여전히 직렬화됩니다(한 번 실행
한 번에 세션 키당). 기본값: 1.

### `agents.defaults.sandbox`

선택 과목 **도커 샌드박싱** 임베디드 에이전트의 경우. 비주요용
세션을 실행하여 호스트 시스템에 액세스할 수 없도록 합니다.

세부: [샌드박싱](/gateway/sandboxing)

기본값(활성화된 경우):

- 범위: `"agent"` (에이전트당 컨테이너 1개 + 작업공간)
- 데비안 책벌레 슬림 기반 이미지
- 상담원 작업 영역 액세스: `workspaceAccess: "none"` (기본)
  - `"none"`: 범위별 샌드박스 작업 공간을 사용합니다. `~/.openclaw/sandboxes`
- `"ro"`: 샌드박스 작업 공간을 다음으로 유지합니다. `/workspace`, 그리고 에이전트 작업 영역을 읽기 전용으로 마운트합니다. `/agent` (비활성화 `write`/`edit`/`apply_patch`)
  - `"rw"`: 에이전트 작업 영역 읽기/쓰기 마운트 `/workspace`
- 자동 정리: 유휴 > 24시간 또는 기간 > 7일
- 도구 정책: 허용만 `exec`, `process`, `read`, `write`, `edit`, `apply_patch`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status` (승리 거부)
  - 다음을 통해 구성 `tools.sandbox.tools`, 다음을 통해 에이전트별 재정의 `agents.list[].tools.sandbox.tools`
  - 샌드박스 정책에서 지원되는 도구 그룹 속기: `group:runtime`, `group:fs`, `group:sessions`, `group:memory` (보다 [샌드박스 vs 도구 정책 vs 상승](/gateway/sandbox-vs-tool-policy-vs-elevated#tool-groups-shorthands))
- 선택적 샌드박스 브라우저(Chromium + CDP, noVNC 관찰자)
- 경화 손잡이: `network`, `user`, `pidsLimit`, `memory`, `cpus`, `ulimits`, `seccompProfile`, `apparmorProfile`

경고: `scope: "shared"` 공유 컨테이너, 공유 작업 공간을 의미합니다. 아니요
세션 간 격리. 사용 `scope: "session"` 세션별 ​​격리를 위해.

유산: `perSession` 여전히 지원됩니다(`true` → `scope: "session"`, 
`false` → `scope: "shared"`).

`setupCommand` 달린다 **한 번** 컨테이너가 생성된 후(다음을 통해 컨테이너 내부) `sh -lc`).
패키지 설치의 경우 네트워크 송신, 쓰기 가능한 루트 FS 및 루트 사용자를 확인하십시오.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent is default)
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          containerPrefix: "openclaw-sbx-",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          // Per-agent override (multi-agent): agents.list[].sandbox.docker.*
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
          binds: ["/var/run/docker.sock:/var/run/docker.sock", "/home/user/source:/source:rw"],
        },
        browser: {
          enabled: false,
          image: "openclaw-sandbox-browser:bookworm-slim",
          containerPrefix: "openclaw-sbx-browser-",
          cdpPort: 9222,
          vncPort: 5900,
          noVncPort: 6080,
          headless: false,
          enableNoVnc: true,
          allowHostControl: false,
          allowedControlUrls: ["http://10.0.0.42:18791"],
          allowedControlHosts: ["browser.lab.local", "10.0.0.42"],
          allowedControlPorts: [18791],
          autoStart: true,
          autoStartTimeoutMs: 12000,
        },
        prune: {
          idleHours: 24, // 0 disables idle pruning
          maxAgeDays: 7, // 0 disables max-age pruning
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "apply_patch",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

다음을 사용하여 기본 샌드박스 이미지를 한 번 빌드합니다.

```bash
scripts/sandbox-setup.sh
```

참고: 샌드박스 컨테이너의 기본값은 `network: "none"`; 세트 `agents.defaults.sandbox.docker.network`
 에게 `"bridge"` (또는 사용자 지정 네트워크) 에이전트에 아웃바운드 액세스가 필요한 경우.

참고: 인바운드 첨부 파일은 활성 작업 공간에 준비됩니다. `media/inbound/*`. 와 함께 `workspaceAccess: "rw"`, 이는 파일이 에이전트 작업 영역에 기록된다는 의미입니다.

메모: `docker.binds` 추가 호스트 디렉토리를 마운트합니다. 전역 및 에이전트별 바인딩이 병합됩니다.

다음을 사용하여 선택적 브라우저 이미지를 빌드합니다.

```bash
scripts/sandbox-browser-setup.sh
```

언제 `agents.defaults.sandbox.browser.enabled=true`, 브라우저 도구는 샌드박스를 사용합니다.
크롬 인스턴스(CDP). noVNC가 활성화된 경우(headless=false인 경우 기본값)
noVNC URL은 에이전트가 참조할 수 있도록 시스템 프롬프트에 삽입됩니다.
이것은 필요하지 않습니다 `browser.enabled` 기본 구성에서; 샌드박스 컨트롤
URL은 세션별로 삽입됩니다.

`agents.defaults.sandbox.browser.allowHostControl` (기본값: false) 허용
명시적으로 대상을 지정하는 샌드박스 세션 **주인** 브라우저 제어 서버
브라우저 도구(`target: "host"`). 엄격하게 하려면 이것을 끄십시오.
샌드박스 격리.

원격 제어 허용 목록:

- `allowedControlUrls`: 정확한 제어 URL이 허용됩니다. `target: "custom"`.
- `allowedControlHosts`: 호스트 이름이 허용됩니다(호스트 이름만, 포트 없음).
- `allowedControlPorts`: 허용되는 포트(기본값: http=80, https=443).
  기본값: 모든 허용 목록이 설정되지 않습니다(제한 없음). `allowHostControl` 기본값은 false입니다.

### `models` (맞춤 공급자 + 기본 URL)

OpenClaw는 다음을 사용합니다. **파이 코딩 에이전트** 모델 카탈로그. 맞춤 공급자를 추가할 수 있습니다.
(LiteLLM, 로컬 OpenAI 호환 서버, Anthropic 프록시 등)을 작성하여
`~/.openclaw/agents/<agentId>/agent/models.json` 또는 내부에 동일한 스키마를 정의하여
OpenClaw 구성 `models.providers`.
제공자별 개요 + 예: [/개념/모델 제공자](/concepts/model-providers).

언제 `models.providers` 존재하는 경우 OpenClaw는 다음을 작성/병합합니다. `models.json` ~ 안으로 
`~/.openclaw/agents/<agentId>/agent/` 시작 시:

- 기본 동작: **병합** (기존 공급자를 유지하고 이름을 재정의함)
- 세트 `models.mode: "replace"` 파일 내용을 덮어쓰려면

다음을 통해 모델을 선택하세요. `agents.defaults.model.primary` (공급자/모델).

```json5
{
  agents: {
    defaults: {
      model: { primary: "custom-proxy/llama-3.1-8b" },
      models: {
        "custom-proxy/llama-3.1-8b": {},
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "LITELLM_KEY",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.1-8b",
            name: "Llama 3.1 8B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000,
          },
        ],
      },
    },
  },
}
```

### OpenCode Zen(다중 모델 프록시)

OpenCode Zen은 모델별 엔드포인트가 있는 다중 모델 게이트웨이입니다. OpenClaw는 다음을 사용합니다.
내장 `opencode` pi-ai의 공급자; 세트 `OPENCODE_API_KEY`  (또는 
`OPENCODE_ZEN_API_KEY`) 에서 [https://opencode.ai/auth](https://opencode.ai/auth).

참고:

- 모델 참조 사용 `opencode/<modelId>` (예: `opencode/claude-opus-4-6`).
- 다음을 통해 허용 목록을 활성화하는 경우 `agents.defaults.models`에서 사용하려는 각 모델을 추가하세요.
- 지름길: `openclaw onboard --auth-choice opencode-zen`.

```json5
{
  agents: {
    defaults: {
      model: { primary: "opencode/claude-opus-4-6" },
      models: { "opencode/claude-opus-4-6": { alias: "Opus" } },
    },
  },
}
```

### Z.AI (GLM-4.7) — 공급자 별칭 지원

Z.AI 모델은 내장된 `zai` 공급자. 세트 `ZAI_API_KEY`
귀하의 환경에서 공급자/모델별로 모델을 참조하십시오.

지름길: `openclaw onboard --auth-choice zai-api-key`.

```json5
{
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} },
    },
  },
}
```

참고:

- `z.ai/*`그리고`z-ai/*` 별칭이 허용되고 정규화됩니다. `zai/*`.
- 만약에 `ZAI_API_KEY` 누락되었습니다. 요청 사항은 다음과 같습니다. `zai/*` 런타임 시 인증 오류로 인해 실패합니다.
- 오류 예: `No API key found for provider "zai".`
- Z.AI의 일반 API 엔드포인트는 `https://api.z.ai/api/paas/v4`. GLM 코딩
  요청은 전용 코딩 엔드포인트를 사용합니다. `https://api.z.ai/api/coding/paas/v4`.
  내장 `zai` 공급자는 코딩 끝점을 사용합니다. 일반이 필요한 경우
  끝점에서 사용자 지정 공급자를 정의합니다. `models.providers` 기본 URL 포함
  재정의합니다(위의 사용자 지정 공급자 섹션 참조).
- 문서/구성에 가짜 자리 표시자를 사용하십시오. 실제 API 키를 커밋하지 마세요.

### 문샷 AI(키미)

Moonshot의 OpenAI 호환 엔드포인트를 사용하세요.

```json5
{
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2.5" },
      models: { "moonshot/kimi-k2.5": { alias: "Kimi K2.5" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

참고:

- 세트 `MOONSHOT_API_KEY` 환경이나 사용에 `openclaw onboard --auth-choice moonshot-api-key`.
- 모델 참조: `moonshot/kimi-k2.5`.
- 중국 엔드포인트의 경우 다음 중 하나를 수행합니다.
  - 달리다 `openclaw onboard --auth-choice moonshot-api-key-cn` (마법사가 설정합니다 `https://api.moonshot.cn/v1`), 또는
  - 수동으로 설정 `baseUrl: "https://api.moonshot.cn/v1"` ~에 `models.providers.moonshot`.

### 키미코딩

Moonshot AI의 Kimi Coding 엔드포인트(Anthropic 호환, 내장 공급자)를 사용하세요.

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kimi-coding/k2p5" },
      models: { "kimi-coding/k2p5": { alias: "Kimi K2.5" } },
    },
  },
}
```

참고:

- 세트 `KIMI_API_KEY` 환경이나 사용에 `openclaw onboard --auth-choice kimi-code-api-key`.
- 모델 참조: `kimi-coding/k2p5`.

### 합성(인류 친화적)

Synthetic의 Anthropic 호환 엔드포인트를 사용하세요.

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.1": { alias: "MiniMax M2.1" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "hf:MiniMaxAI/MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 192000,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

참고:

- 세트 `SYNTHETIC_API_KEY` 또는 사용 `openclaw onboard --auth-choice synthetic-api-key`.
- 모델 참조: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`.
- 기본 URL은 생략되어야 합니다. `/v1` Anthropic 클라이언트가 그것을 추가하기 때문입니다.

### 로컬 모델(LM Studio) - 권장 설정

보다 [/게이트웨이/로컬 모델](/gateway/local-models) 현재 지역 안내를 위해. 핵심요약: 심각한 하드웨어에서 LM Studio Responses API를 통해 MiniMax M2.1을 실행하세요. 대체를 위해 호스팅된 모델을 병합된 상태로 유지합니다.

### 미니맥스 M2.1

LM Studio 없이 MiniMax M2.1을 직접 사용하세요.

```json5
{
  agent: {
    model: { primary: "minimax/MiniMax-M2.1" },
    models: {
      "anthropic/claude-opus-4-6": { alias: "Opus" },
      "minimax/MiniMax-M2.1": { alias: "Minimax" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            // Pricing: update in models.json if you need exact cost tracking.
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

참고:

- 세트 `MINIMAX_API_KEY` 환경 변수 또는 사용 `openclaw onboard --auth-choice minimax-api`.
- 사용 가능한 모델: `MiniMax-M2.1` (기본).
- 가격 업데이트 `models.json` 정확한 비용 추적이 필요한 경우.

### 대뇌 (GLM 4.6 / 4.7)

OpenAI 호환 엔드포인트를 통해 Cerebras를 사용하세요.

```json5
{
  env: { CEREBRAS_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: {
        primary: "cerebras/zai-glm-4.7",
        fallbacks: ["cerebras/zai-glm-4.6"],
      },
      models: {
        "cerebras/zai-glm-4.7": { alias: "GLM 4.7 (Cerebras)" },
        "cerebras/zai-glm-4.6": { alias: "GLM 4.6 (Cerebras)" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      cerebras: {
        baseUrl: "https://api.cerebras.ai/v1",
        apiKey: "${CEREBRAS_API_KEY}",
        api: "openai-completions",
        models: [
          { id: "zai-glm-4.7", name: "GLM 4.7 (Cerebras)" },
          { id: "zai-glm-4.6", name: "GLM 4.6 (Cerebras)" },
        ],
      },
    },
  },
}
```

참고:

- 사용 `cerebras/zai-glm-4.7` 대뇌의 경우; 사용 `zai/glm-4.7` Z.AI 다이렉트용.
- 세트 `CEREBRAS_API_KEY` 환경이나 구성에서.

참고:

- 지원되는 API: `openai-completions`, `openai-responses`, `anthropic-messages`, 
  `google-generative-ai`
- 사용 `authHeader: true` + `headers` 사용자 정의 인증 요구 사항을 위해.
- 다음으로 에이전트 구성 루트를 재정의합니다. `OPENCLAW_AGENT_DIR` (또는 `PI_CODING_AGENT_DIR`)
  당신이 원한다면 `models.json` 다른 곳에 저장됨(기본값: `~/.openclaw/agents/main/agent`).

### `session`

세션 범위 지정, 정책 재설정, 트리거 재설정 및 세션 저장소가 기록되는 위치를 제어합니다.

```json5
{
  session: {
    scope: "per-sender",
    dmScope: "main",
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 60,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      dm: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetTriggers: ["/new", "/reset"],
    // Default is already per-agent under ~/.openclaw/agents/<agentId>/sessions/sessions.json
    // You can override with {agentId} templating:
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    // Direct chats collapse to agent:<agentId>:<mainKey> (default: "main").
    mainKey: "main",
    agentToAgent: {
      // Max ping-pong reply turns between requester/target (0–5).
      maxPingPongTurns: 5,
    },
    sendPolicy: {
      rules: [{ action: "deny", match: { channel: "discord", chatType: "group" } }],
      default: "allow",
    },
  },
}
```

전지:

- `mainKey`: 직접 채팅 버킷 키(기본값: `"main"`). 변경하지 않고 기본 DM 스레드의 "이름을 바꾸"려는 경우 유용합니다. `agentId`.
  - 샌드박스 참고: `agents.defaults.sandbox.mode: "non-main"` 이 키를 사용하여 기본 세션을 감지합니다. 일치하지 않는 세션 키 `mainKey` (그룹/채널)은 샌드박스 처리됩니다.
- `dmScope`: DM 세션을 그룹화하는 방법(기본값: `"main"`).
  - `main`: 모든 DM은 연속성을 위해 기본 세션을 공유합니다.
  - `per-peer`: 채널 전체에서 보낸 사람 ID별로 DM을 격리합니다.
  - `per-channel-peer`: 채널 + 발신자별로 DM을 격리합니다(다중 사용자 받은 편지함에 권장).
  - `per-account-channel-peer`: 계정 + 채널 + 발신자별로 DM을 격리합니다(다중 계정 받은 편지함에 권장).
  - 보안 DM 모드(권장): 설정 `session.dmScope: "per-channel-peer"` 여러 사람이 봇에게 DM을 보낼 수 있는 경우(공유 받은 편지함, 여러 사람이 사용할 수 있는 허용 목록 또는 `dmPolicy: "open"`).
- `identityLinks`: 표준 ID를 공급자 접두사가 붙은 피어에 매핑하여 동일한 사람이 사용할 때 채널 간에 DM 세션을 공유하도록 합니다. `per-peer`, `per-channel-peer`, 또는`per-account-channel-peer`.
  - 예:`alice: ["telegram:123456789", "discord:987654321012345678"]`.
- `reset`: 기본 재설정 정책. 기본값은 게이트웨이 호스트에서 현지 시간 오전 4시에 매일 재설정되는 것입니다.
  - `mode`: `daily` 또는 `idle` (기본: `daily` 언제 `reset` 존재합니다).
  - `atHour`: 일일 재설정 경계의 현지 시간(0-23)입니다.
  - `idleMinutes`: 몇 분 안에 유휴 기간을 슬라이딩합니다. 일일 + 유휴가 모두 구성된 경우 먼저 만료되는 것이 승리합니다.
- `resetByType`: 세션별 재정의 `dm`, `group`, 그리고 `thread`.
  - 레거시 만 설정하는 경우 `session.idleMinutes` 아무 것도 없이 `reset`/`resetByType`, OpenClaw는 이전 버전과의 호환성을 위해 유휴 전용 모드로 유지됩니다.
- `heartbeatIdleMinutes`: 하트비트 확인을 위한 선택적 유휴 재정의(활성화된 경우에도 일일 재설정이 계속 적용됩니다).
- `agentToAgent.maxPingPongTurns`: 요청자/대상 간 최대 회신 횟수(0-5, 기본값 5).
- `sendPolicy.default`: `allow` 또는 `deny` 일치하는 규칙이 없을 때 대체됩니다.
- `sendPolicy.rules[]`: 일치 기준 `channel`, `chatType` (`direct|group|room`), 또는`keyPrefix` (예: `cron:`). 먼저 거부하면 승리합니다. 그렇지 않으면 허용합니다.

### `skills` (스킬 구성)

번들 허용 목록, 설치 기본 설정, 추가 기술 폴더 및 기술별 제어
재정의. 적용대상 **번들로 제공** 기술과 `~/.openclaw/skills` (작업 공간 기술
이름 충돌에서는 여전히 승리합니다.)

전지:

- `allowBundled`: 선택적 허용 목록 **번들로 제공** 스킬만. 설정된 경우 해당 항목만
  번들 기술은 적격합니다(관리/작업 공간 기술은 영향을 받지 않음).
- `load.extraDirs`: 스캔할 추가 스킬 디렉토리(최하위 우선순위).
- `install.preferBrew`: 가능한 경우 Brew 설치 프로그램을 선호합니다(기본값: true).
- `install.nodeManager`: 노드 설치 프로그램 기본 설정(`npm` | `pnpm` | `yarn`, 기본값: npm).
- `entries.<skillKey>`: 스킬별 구성이 재정의됩니다.

기술별 필드:

- `enabled`: 세트 `false` 번들/설치된 스킬이라도 비활성화하려면
- `env`: 에이전트 실행을 위해 삽입된 환경 변수입니다(아직 설정되지 않은 경우에만).
- `apiKey`: 기본 환경 변수를 선언하는 기술에 대한 선택적 편의입니다(예: `nano-banana-pro` → `GEMINI_API_KEY`).

예:

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
    },
    install: {
      preferBrew: true,
      nodeManager: "npm",
    },
    entries: {
      "nano-banana-pro": {
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

### `plugins` (확장)

플러그인 검색, 허용/거부, 플러그인별 구성을 제어합니다. 플러그인이 로드되었습니다.
에서 `~/.openclaw/extensions`, `<workspace>/.openclaw/extensions`, 게다가 무엇이든
`plugins.load.paths` 항목. **구성을 변경하려면 게이트웨이를 다시 시작해야 합니다.**
보다 [/플러그인](/tools/plugin) 전체 사용을 위해.

전지:

- `enabled`: 플러그인 로딩을 위한 마스터 토글(기본값: true)
- `allow`: 플러그인 ID의 선택적 허용 목록; 설정되면 나열된 플러그인만 로드됩니다.
- `deny`: 플러그인 ID의 선택적 거부 목록(거부 승리).
- `load.paths`: 로드할 추가 플러그인 파일 또는 디렉토리(절대 또는 `~`).
- `entries.<pluginId>`: 플러그인별 재정의.
  - `enabled`: 세트 `false` 비활성화합니다.
  - `config`: 플러그인별 구성 개체(제공된 경우 플러그인에 의해 검증됨)

예:

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    load: {
      paths: ["~/Projects/oss/voice-call-extension"],
    },
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio",
        },
      },
    },
  },
}
```

### `browser` (openclaw 관리 브라우저)

OpenClaw는 **헌신적인, 고립된** Openclaw용 Chrome/Brave/Edge/Chromium 인스턴스이며 소규모 루프백 제어 서비스를 노출합니다.
프로필은 다음을 가리킬 수 있습니다. **원격** Chromium 기반 브라우저를 통해 `profiles.<name>.cdpUrl`. 원격
프로필은 연결 전용입니다(시작/중지/재설정은 비활성화됨).

`browser.cdpUrl` 레거시 단일 프로필 구성용으로 남아 있으며 기본으로 사용됩니다.
설정만 하는 프로필의 구성표/호스트 `cdpPort`.

기본값:

- 활성화됨: `true`
- 평가활성화됨: `true` (세트 `false` 비활성화하다 `act:evaluate`그리고`wait --fn`)
- 제어 서비스: 루프백 전용(다음에서 파생된 포트) `gateway.port`, 기본 `18791`)
- CDP URL: `http://127.0.0.1:18792` (제어 서비스 + 1, 레거시 단일 프로파일)
- 프로필 색상: `#FF4500` (랍스터-오렌지)
- 참고: 제어 서버는 실행 중인 게이트웨이(OpenClaw.app 메뉴 모음 또는 `openclaw gateway`).
- 자동 감지 순서: Chromium 기반인 경우 기본 브라우저입니다. 그렇지 않으면 Chrome → Brave → Edge → Chromium → Chrome Canary.

```json5
{
  browser: {
    enabled: true,
    evaluateEnabled: true,
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    defaultProfile: "chrome",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
    color: "#FF4500",
    // Advanced:
    // headless: false,
    // noSandbox: false,
    // executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    // attachOnly: false, // set true when tunneling a remote CDP to localhost
  },
}
```

### `ui` (모습)

UI 크롬용 기본 앱에서 사용하는 선택적인 강조 색상입니다(예: 대화 모드 풍선 색조).

설정하지 않으면 클라이언트가 음소거된 연한 파란색으로 돌아갑니다.

```json5
{
  ui: {
    seamColor: "#FF4500", // hex (RRGGBB or #RRGGBB)
    // Optional: Control UI assistant identity override.
    // If unset, the Control UI uses the active agent identity (config or IDENTITY.md).
    assistant: {
      name: "OpenClaw",
      avatar: "CB", // emoji, short text, or image URL/data URI
    },
  },
}
```

### `gateway` (게이트웨이 서버 모드 + 바인딩)

사용 `gateway.mode` 이 시스템이 게이트웨이를 실행해야 하는지 여부를 명시적으로 선언합니다.

기본값:

- 방법: **설정되지 않음** ("자동 시작 안 함"으로 처리)
- 묶다: `loopback`
- 포트: `18789` (WS + HTTP용 단일 포트)

```json5
{
  gateway: {
    mode: "local", // or "remote"
    port: 18789, // WS + HTTP multiplex
    bind: "loopback",
    // controlUi: { enabled: true, basePath: "/openclaw" }
    // auth: { mode: "token", token: "your-token" } // token gates WS + Control UI access
    // tailscale: { mode: "off" | "serve" | "funnel" }
  },
}
```

컨트롤 UI 기본 경로:

- `gateway.controlUi.basePath` 컨트롤 UI가 제공되는 URL 접두사를 설정합니다.
- 예: `"/ui"`, `"/openclaw"`, `"/apps/openclaw"`.
- 기본값: 루트(`/`) (변경되지 않음).
- `gateway.controlUi.root` Control UI 자산의 파일 시스템 루트를 설정합니다(기본값: `dist/control-ui`).
- `gateway.controlUi.allowInsecureAuth` 다음 경우에 Control UI에 대한 토큰 전용 인증을 허용합니다.
  장치 ID는 생략됩니다(일반적으로 HTTP를 통해). 기본: `false`. HTTPS 선호
  (테일스케일 서브) 또는 `127.0.0.1`.
- `gateway.controlUi.dangerouslyDisableDeviceAuth` 다음에 대한 장치 ID 확인을 비활성화합니다.
  제어 UI(토큰/비밀번호만). 기본: `false`. 깨진 유리만 가능합니다.

관련 문서:

- [컨트롤 UI](/web/control-ui)
- [웹 개요](/web)
- [테일스케일](/gateway/tailscale)
- [원격 액세스](/gateway/remote)

신뢰할 수 있는 프록시:

- `gateway.trustedProxies`: 게이트웨이 앞에서 TLS를 종료하는 역방향 프록시 IP 목록입니다.
- 이러한 IP 중 하나에서 연결이 이루어지면 OpenClaw는 다음을 사용합니다. `x-forwarded-for` (또는 `x-real-ip`) 로컬 페어링 확인 및 HTTP 인증/로컬 확인을 위한 클라이언트 IP를 결정합니다.
- 귀하가 완전히 제어할 수 있는 프록시만 나열하고 해당 프록시가 있는지 확인하세요. **덮어쓰기** 들어오는 `x-forwarded-for`.

참고:

- `openclaw gateway` 않는 한 시작을 거부합니다. `gateway.mode` 로 설정되었습니다 `local` (또는 재정의 플래그를 전달합니다).
- `gateway.port` WebSocket + HTTP(제어 UI, 후크, A2UI)에 사용되는 단일 다중화 포트를 제어합니다.
- OpenAI 채팅 완료 엔드포인트: **기본적으로 비활성화됨**; 활성화 `gateway.http.endpoints.chatCompletions.enabled: true`.
- 상위: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > 기본값 `18789`.
- 기본적으로 게이트웨이 인증이 필요합니다(토큰/비밀번호 또는 Tailscale Serve ID). 비루프백 바인딩에는 공유 토큰/비밀번호가 필요합니다.
- 온보딩 마법사는 기본적으로(루프백에서도) 게이트웨이 토큰을 생성합니다.
- `gateway.remote.token` ~이다 **오직** 원격 CLI 호출의 경우; 로컬 게이트웨이 인증은 활성화되지 않습니다. `gateway.token` 무시됩니다.

인증 및 Tailscale:

- `gateway.auth.mode` 핸드셰이크 요구 사항을 설정합니다(`token` 또는 `password`). 설정하지 않으면 토큰 인증이 가정됩니다.
- `gateway.auth.token` 토큰 인증을 위한 공유 토큰을 저장합니다(동일한 시스템의 CLI에서 사용).
- 언제 `gateway.auth.mode` 설정되면 해당 방법만 허용됩니다(선택 사항인 Tailscale 헤더 포함).
- `gateway.auth.password` 여기에서 설정하거나 다음을 통해 설정할 수 있습니다. `OPENCLAW_GATEWAY_PASSWORD` (권장).
- `gateway.auth.allowTailscale` Tailscale Serve ID 헤더를 허용합니다.
  (`tailscale-user-login`) 요청이 루프백에 도착할 때 인증을 충족하기 위해
  와 `x-forwarded-for`, `x-forwarded-proto`, 그리고 `x-forwarded-host`. 오픈클로
  문제를 해결하여 신원을 확인합니다. `x-forwarded-for` 주소를 통해
  `tailscale whois` 받아들이기 전에. 언제 `true`, 서비스 요청은 필요하지 않습니다
  토큰/비밀번호; 세트 `false` 명시적인 자격 증명을 요구합니다. 기본값은
  `true` 언제 `tailscale.mode = "serve"` 인증 모드는 그렇지 않습니다. `password`.
- `gateway.tailscale.mode: "serve"` Tailscale Serve(tailnet 전용, 루프백 바인드)를 사용합니다.
- `gateway.tailscale.mode: "funnel"` 대시보드를 공개적으로 노출합니다. 인증이 필요합니다.
- `gateway.tailscale.resetOnExit` 종료 시 서비스/퍼널 구성을 재설정합니다.

원격 클라이언트 기본값(CLI):

- `gateway.remote.url` 다음 경우 CLI 호출에 대한 기본 게이트웨이 WebSocket URL을 설정합니다. `gateway.mode = "remote"`.
- `gateway.remote.transport` macOS 원격 전송을 선택합니다(`ssh` 기본, `direct` ws/wss의 경우). 언제 `direct`, `gateway.remote.url` 이어야 한다 `ws://` 또는 `wss://`.`ws://host` 기본값은 포트 `18789`.
- `gateway.remote.token` 원격 호출을 위한 토큰을 제공합니다(인증이 없는 경우 설정하지 않은 상태로 둡니다).
- `gateway.remote.password` 원격 호출을 위한 비밀번호를 제공합니다(인증이 없는 경우 설정하지 않은 상태로 둡니다).

macOS 앱 동작:

- OpenClaw.app 시계 `~/.openclaw/openclaw.json` 다음과 같은 경우 실시간으로 모드를 전환합니다. `gateway.mode` 또는 `gateway.remote.url` 변화.
- 만약에 `gateway.mode` 설정되지 않았지만 `gateway.remote.url` 설정되면 macOS 앱은 이를 원격 모드로 처리합니다.
- macOS 앱에서 연결 모드를 변경하면 다음과 같이 기록됩니다. `gateway.mode` (그리고 `gateway.remote.url` + `gateway.remote.transport` 원격 모드에서) 구성 파일로 돌아갑니다.

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      password: "your-password",
    },
  },
}
```

직접 전송 예(macOS 앱):

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      transport: "direct",
      url: "wss://gateway.example.ts.net",
      token: "your-token",
    },
  },
}
```

### `gateway.reload` (핫 리로드 구성)

게이트웨이 시계 `~/.openclaw/openclaw.json` (또는 `OPENCLAW_CONFIG_PATH`) 변경 사항을 자동으로 적용합니다.

모드:

- `hybrid` (기본값): 안전한 변경 사항을 즉시 적용합니다. 중요한 변경 사항이 있는 경우 게이트웨이를 다시 시작하세요.
- `hot`: 핫세이프 변경 사항만 적용합니다. 다시 시작해야 할 때 기록합니다.
- `restart`: 구성이 변경되면 게이트웨이를 다시 시작합니다.
- `off`: 핫 리로드를 비활성화합니다.

```json5
{
  gateway: {
    reload: {
      mode: "hybrid",
      debounceMs: 300,
    },
  },
}
```

#### 핫 리로드 매트릭스(파일 + 영향)

시청한 파일:

- `~/.openclaw/openclaw.json` (또는 `OPENCLAW_CONFIG_PATH`)

즉시 적용(전체 게이트웨이를 다시 시작하지 않음):

- `hooks` (웹훅 인증/경로/매핑) + `hooks.gmail` (Gmail 감시자가 다시 시작되었습니다)
- `browser` (브라우저 제어 서버 재시작)
- `cron` (cron 서비스 재시작 + 동시성 업데이트)
- `agents.defaults.heartbeat` (하트비트 러너 재시작)
- `web` (WhatsApp 웹 채널 다시 시작)
- `telegram`, `discord`, `signal`, `imessage` (채널이 다시 시작됩니다)
- `agent`, `models`, `routing`, `messages`, `session`, `whatsapp`, `logging`, `skills`, `ui`, `talk`, `identity`, `wizard` (동적 읽기)

전체 게이트웨이를 다시 시작해야 합니다.

- `gateway` (포트/바인딩/인증/제어 UI/tailscale)
- `bridge` (유산)
- `discovery`
- `canvasHost`
- `plugins`
- 알 수 없거나 지원되지 않는 구성 경로(안전을 위해 기본값은 다시 시작)

### 다중 인스턴스 격리

하나의 호스트에서 여러 게이트웨이를 실행하려면(중복성 또는 구조 봇을 위해) 인스턴스별 상태 + 구성을 격리하고 고유한 포트를 사용하십시오.

- `OPENCLAW_CONFIG_PATH` (인스턴스별 구성)
- `OPENCLAW_STATE_DIR` (세션/크레딧)
- `agents.defaults.workspace` (추억)
- `gateway.port` (인스턴스별로 고유함)

편의 플래그(CLI):

- `openclaw --dev …` → 사용 `~/.openclaw-dev` + 베이스에서 포트 이동 `19001`
- `openclaw --profile <name> …` → 사용 `~/.openclaw-<name>` (config/env/flags를 통한 포트)

보다 [게이트웨이 런북](/gateway) 파생된 포트 매핑(게이트웨이/브라우저/캔버스)의 경우.
보다 [다중 게이트웨이](/gateway/multiple-gateways) 브라우저/CDP 포트 격리 세부정보는

예:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json \
OPENCLAW_STATE_DIR=~/.openclaw-a \
openclaw gateway --port 19001
```

### `hooks` (게이트웨이 웹훅)

게이트웨이 HTTP 서버에서 간단한 HTTP 웹훅 엔드포인트를 활성화합니다.

기본값:

- 활성화됨: `false`
- 길: `/hooks`
- 최대BodyBytes: `262144` (256KB)

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
    presets: ["gmail"],
    transformsDir: "~/.openclaw/hooks",
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "From: {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}",
        deliver: true,
        channel: "last",
        model: "openai/gpt-5.2-mini",
      },
    ],
  },
}
```

요청에는 후크 토큰이 포함되어야 합니다.

- `Authorization: Bearer <token>` ** 또는 **
- `x-openclaw-token: <token>`

엔드포인트:

- `POST /hooks/wake` → `{ text, mode?: "now"|"next-heartbeat" }`
- `POST /hooks/agent` → `{ message, name?, sessionKey?, wakeMode?, deliver?, channel?, to?, model?, thinking?, timeoutSeconds? }`
- `POST /hooks/<name>` → 다음을 통해 해결됨 `hooks.mappings`

`/hooks/agent` 항상 기본 세션에 요약을 게시합니다(선택적으로 다음을 통해 즉시 하트비트를 트리거할 수 있음). `wakeMode: "now"`).

매핑 참고사항:

- `match.path` 다음 하위 경로와 일치합니다. `/hooks` (예: `/hooks/gmail` → `gmail`).
- `match.source` 페이로드 필드와 일치합니다(예: `{ source: "gmail" }`) 그래서 당신은 일반을 사용할 수 있습니다 `/hooks/ingest` 길.
- 다음과 같은 템플릿 `{{messages[0].subject}}` 페이로드에서 읽습니다.
- `transform` 후크 작업을 반환하는 JS/TS 모듈을 가리킬 수 있습니다.
- `deliver: true` 최종 응답을 채널로 보냅니다. `channel` 기본값은 `last` (WhatsApp으로 대체)
- 사전 배송 경로가 없는 경우 설정 `channel` + `to` 명시적으로(Telegram/Discord/Google Chat/Slack/Signal/iMessage/MS Teams에 필요)
- `model` 이 후크 실행에 대한 LLM을 재정의합니다(`provider/model` 또는 별칭; 다음과 같은 경우 허용되어야 합니다. `agents.defaults.models` 설정됨).

Gmail 도우미 구성(다음에서 사용됨) `openclaw webhooks gmail setup`/`run`):

```json5
{
  hooks: {
    gmail: {
      account: "openclaw@gmail.com",
      topic: "projects/<project-id>/topics/gog-gmail-watch",
      subscription: "gog-gmail-watch-push",
      pushToken: "shared-push-token",
      hookUrl: "http://127.0.0.1:18789/hooks/gmail",
      includeBody: true,
      maxBytes: 20000,
      renewEveryMinutes: 720,
      serve: { bind: "127.0.0.1", port: 8788, path: "/" },
      tailscale: { mode: "funnel", path: "/gmail-pubsub" },

      // Optional: use a cheaper model for Gmail hook processing
      // Falls back to agents.defaults.model.fallbacks, then primary, on auth/rate-limit/timeout
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      // Optional: default thinking level for Gmail hooks
      thinking: "off",
    },
  },
}
```

Gmail 후크에 대한 모델 재정의:

- `hooks.gmail.model` Gmail 후크 처리에 사용할 모델을 지정합니다(기본값은 세션 기본).
- 수락 `provider/model` 참조 또는 별칭 `agents.defaults.models`.
- 다음으로 돌아갑니다. `agents.defaults.model.fallbacks`, 그 다음에 `agents.defaults.model.primary`, 인증/속도 제한/시간 초과 시.
- 만약에 `agents.defaults.models` 설정되면 허용 목록에 후크 모델을 포함합니다.
- 시작 시 구성된 모델이 모델 카탈로그 또는 허용 목록에 없으면 경고합니다.
- `hooks.gmail.thinking` Gmail 후크에 대한 기본 사고 수준을 설정하고 후크별로 재정의됩니다. `thinking`.

게이트웨이 자동 시작:

- 만약에 `hooks.enabled=true`그리고`hooks.gmail.account` 설정되면 게이트웨이가 시작됩니다.
  `gog gmail watch serve` 부팅 시 시계를 자동 갱신합니다.
- 세트 `OPENCLAW_SKIP_GMAIL_WATCHER=1` 자동 시작을 비활성화합니다(수동 실행의 경우).
- 별도의 실행을 피하세요. `gog gmail watch serve` 게이트웨이와 함께; 그럴 것이다
  실패하다 `listen tcp 127.0.0.1:8788: bind: address already in use`.

참고: 언제 `tailscale.mode` 켜져 있음, OpenClaw 기본값 `serve.path` 에게 `/` 그래서
Tailscale은 프록시를 사용할 수 있습니다. `/gmail-pubsub` 올바르게(set-path 접두어를 제거합니다).
접두사가 붙은 경로를 수신하기 위해 백엔드가 필요한 경우 다음을 설정하세요.
`hooks.gmail.tailscale.target` 전체 URL로 이동(및 정렬 `serve.path`).

### `canvasHost` (LAN/테일넷 캔버스 파일 서버 + 라이브 리로드)

게이트웨이는 HTTP를 통해 HTML/CSS/JS 디렉터리를 제공하므로 iOS/Android 노드는 간단히 `canvas.navigate` 그것에.

기본 루트: `~/.openclaw/workspace/canvas`  
기본 포트: `18793` (openclaw 브라우저 CDP 포트를 피하기 위해 선택됨 `18792`)  
서버는 다음을 수신합니다. **게이트웨이 바인드 호스트** (LAN 또는 Tailnet) 노드가 도달할 수 있도록 합니다.

서버:

- 아래의 파일을 제공합니다. `canvasHost.root`
- 제공된 HTML에 작은 라이브 다시 로드 클라이언트를 삽입합니다.
- 디렉터리를 감시하고 다음 위치에서 WebSocket 끝점을 통해 다시 로드를 브로드캐스트합니다. `/__openclaw__/ws`
- 스타터를 자동으로 생성합니다. `index.html` 디렉토리가 비어 있을 때(즉시 무언가를 볼 수 있도록)
- 또한 A2UI를 제공합니다. `/__openclaw__/a2ui/` 노드에 다음과 같이 광고됩니다. `canvasHostUrl`
  (항상 Canvas/A2UI용 노드에서 사용됨)

디렉토리가 크거나 다음을 누르는 경우 실시간 재로드(및 파일 감시)를 비활성화합니다. `EMFILE`: 

- 구성: `canvasHost: { liveReload: false }`

```json5
{
  canvasHost: {
    root: "~/.openclaw/workspace/canvas",
    port: 18793,
    liveReload: true,
  },
}
```

변경 사항 `canvasHost.*` 게이트웨이를 다시 시작해야 합니다(구성 다시 로드가 다시 시작됨).

다음을 사용하여 비활성화:

- 구성: `canvasHost: { enabled: false }`
- 환경: `OPENCLAW_SKIP_CANVAS_HOST=1`

### `bridge` (레거시 TCP 브리지, 제거됨)

현재 빌드에는 더 이상 TCP 브리지 리스너가 포함되지 않습니다. `bridge.*` 구성 키는 무시됩니다.
노드는 Gateway WebSocket을 통해 연결됩니다. 이 섹션은 역사적 참고를 위해 보관됩니다.

레거시 동작:

- 게이트웨이는 일반적으로 포트에서 노드(iOS/Android)에 대한 간단한 TCP 브리지를 노출할 수 있습니다. `18790`.

기본값:

- 활성화됨: `true`
- 포트: `18790`
- 묶다: `lan` (에 바인딩 `0.0.0.0`)

바인딩 모드:

- `lan`: `0.0.0.0` (LAN/Wi-Fi 및 Tailscale을 포함한 모든 인터페이스에서 연결 가능)
- `tailnet`: 머신의 Tailscale IP에만 바인딩(Vienna ⇄ London에 권장)
- `loopback`: `127.0.0.1` (로컬 전용)
- `auto`: tailnet IP가 있으면 선호하고, 그렇지 않으면 선호합니다. `lan`

TLS:

- `bridge.tls.enabled`: 브리지 연결에 TLS를 활성화합니다(활성화된 경우 TLS만 해당).
- `bridge.tls.autoGenerate`: 인증서/키가 없을 때 자체 서명된 인증서를 생성합니다(기본값: true).
- `bridge.tls.certPath`/`bridge.tls.keyPath`: 브리지 인증서 + 개인 키에 대한 PEM 경로입니다.
- `bridge.tls.caPath`: 선택적 PEM CA 번들(사용자 지정 루트 또는 향후 mTLS).

TLS가 활성화되면 게이트웨이는 `bridgeTls=1`그리고`bridgeTlsSha256` 검색 TXT에서
노드가 인증서를 고정할 수 있도록 기록합니다. 수동 연결에서는 그렇지 않은 경우 처음 사용할 때 신뢰를 사용합니다.
지문이 아직 저장되어 있습니다.
자동 생성된 인증서에는 다음이 필요합니다. `openssl` 경로에; 생성이 실패하면 브리지가 시작되지 않습니다.

```json5
{
  bridge: {
    enabled: true,
    port: 18790,
    bind: "tailnet",
    tls: {
      enabled: true,
      // Uses ~/.openclaw/bridge/tls/bridge-{cert,key}.pem when omitted.
      // certPath: "~/.openclaw/bridge/tls/bridge-cert.pem",
      // keyPath: "~/.openclaw/bridge/tls/bridge-key.pem"
    },
  },
}
```

### `discovery.mdns` (봉쥬르/mDNS 브로드캐스트 모드)

LAN mDNS 검색 브로드캐스트 제어(`_openclaw-gw._tcp`).

- `minimal` (기본값): 생략 `cliPath` + `sshPort` TXT 레코드에서
- `full`: 포함하다 `cliPath` + `sshPort` TXT 레코드에서
- `off`: mDNS 브로드캐스트를 완전히 비활성화합니다.
- 호스트 이름: 기본값은 `openclaw` (광고 `openclaw.local`). 다음으로 재정의 `OPENCLAW_MDNS_HOSTNAME`.

```json5
{
  discovery: { mdns: { mode: "minimal" } },
}
```

### `discovery.wideArea` (광역 Bonjour / 유니캐스트 DNS‑SD)

활성화되면 게이트웨이는 다음에 대한 유니캐스트 DNS-SD 영역을 작성합니다. `_openclaw-gw._tcp` 아래에 `~/.openclaw/dns/` 구성된 검색 도메인 사용(예: `openclaw.internal.`).

iOS/Android가 네트워크(비엔나 ⇄ 런던)에서 검색하도록 하려면 다음과 페어링하세요.

- 선택한 도메인을 서비스하는 게이트웨이 호스트의 DNS 서버(CoreDNS 권장)
- 테일스케일**분할 DNS** 클라이언트가 게이트웨이 DNS 서버를 통해 해당 도메인을 확인하도록 합니다.

일회성 설정 도우미(게이트웨이 호스트):

```bash
openclaw dns setup --apply
```

```json5
{
  discovery: { wideArea: { enabled: true } },
}
```

## 미디어 모델 템플릿 변수

템플릿 자리 표시자는 다음으로 확장됩니다. `tools.media.*.models[].args`그리고`tools.media.models[].args` (및 향후 템플릿 인수 필드).

| Variable           | Description                                                                     |
| ------------------ | ------------------------------------------------------------------------------- | -------- | ------- | ---------- | ----- | ------ | -------- | ------- | ------- | --- |
| `{{Body}}`         | Full inbound message body                                                       |
| `{{RawBody}}`      | Raw inbound message body (no history/sender wrappers; best for command parsing) |
| `{{BodyStripped}}` | Body with group mentions stripped (best default for agents)                     |
| `{{From}}`         | Sender identifier (E.164 for WhatsApp; may differ per channel)                  |
| `{{To}}`           | Destination identifier                                                          |
| `{{MessageSid}}`   | Channel message id (when available)                                             |
| `{{SessionId}}`    | Current session UUID                                                            |
| `{{IsNewSession}}` | `"true"` when a new session was created                                         |
| `{{MediaUrl}}`     | Inbound media pseudo-URL (if present)                                           |
| `{{MediaPath}}`    | Local media path (if downloaded)                                                |
| `{{MediaType}}`    | Media type (image/audio/document/…)                                             |
| `{{Transcript}}`   | Audio transcript (when enabled)                                                 |
| `{{Prompt}}`       | Resolved media prompt for CLI entries                                           |
| `{{MaxChars}}`     | Resolved max output chars for CLI entries                                       |
| `{{ChatType}}`     | `"direct"` or `"group"`                                                         |
| `{{GroupSubject}}` | Group subject (best effort)                                                     |
| `{{GroupMembers}}` | Group members preview (best effort)                                             |
| `{{SenderName}}`   | Sender display name (best effort)                                               |
| `{{SenderE164}}`   | Sender phone number (best effort)                                               |
| `{{Provider}}`     | Provider hint (whatsapp                                                         | telegram | discord | googlechat | slack | signal | imessage | msteams | webchat | …)  |

## Cron(게이트웨이 스케줄러)

Cron은 웨이크업 및 예약된 작업을 위한 게이트웨이 소유 스케줄러입니다. 보다 [크론 작업](/automation/cron-jobs) 기능 개요 및 CLI 예시를 참조하세요.

```json5
{
  cron: {
    enabled: true,
    maxConcurrentRuns: 2,
  },
}
```

---

_다음: [에이전트 런타임](/concepts/agent)_ 🦞
