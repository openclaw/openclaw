---
read_when:
    - 플러그인/확장 추가 또는 수정
    - 플러그인 설치 또는 로드 규칙 문서화
summary: 'OpenClaw 플러그인/확장: 검색, 구성 및 안전'
title: 플러그인
x-i18n:
    generated_at: "2026-02-08T16:05:45Z"
    model: gtx
    provider: google-translate
    source_hash: b36ca6b90ca03eaae25c00f9b12f2717fcd17ac540ba616ee03b398b234c2308
    source_path: tools/plugin.md
    workflow: 15
---

# 플러그인(확장)

## 빠른 시작(플러그인을 처음 사용하시나요?)

플러그인은 단지 **작은 코드 모듈** OpenClaw를 추가로 확장합니다.
기능(명령, 도구 및 게이트웨이 RPC).

대부분의 경우 빌드되지 않은 기능을 원할 때 플러그인을 사용하게 됩니다.
아직 핵심 OpenClaw에 포함되어 있지 않습니다(또는 기본 기능에서 선택적 기능을 유지하려는 경우).
설치).

빠른 경로:

1. 이미 로드된 항목을 확인하세요.

```bash
openclaw plugins list
```

2. 공식 플러그인 설치(예: 음성 통화):

```bash
openclaw plugins install @openclaw/voice-call
```

3. 게이트웨이를 다시 시작한 다음 아래에서 구성하십시오. `plugins.entries.<id>.config`.

보다 [음성통화](/plugins/voice-call) 구체적인 예제 플러그인을 보려면.

## 사용 가능한 플러그인(공식)

- Microsoft Teams는 2026.1.15부터 플러그인 전용입니다. 설치하다 `@openclaw/msteams` Teams를 사용하는 경우.
- 메모리(코어) — 번들 메모리 검색 플러그인(기본적으로 다음을 통해 활성화됨) `plugins.slots.memory`)
- 메모리(LanceDB) — 번들로 제공되는 장기 메모리 플러그인(자동 리콜/캡처; 설정 `plugins.slots.memory = "memory-lancedb"`)
- [음성통화](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo 개인](/plugins/zalouser) — `@openclaw/zalouser`
- [행렬](/channels/matrix) — `@openclaw/matrix`
- [노스트르](/channels/nostr) — `@openclaw/nostr`
- [잘로](/channels/zalo) — `@openclaw/zalo`
- [마이크로소프트 팀즈](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth(공급자 인증) — 다음과 같이 번들로 제공됨 `google-antigravity-auth` (기본적으로 비활성화되어 있음)
- Gemini CLI OAuth(공급자 인증) — 다음과 같이 번들로 제공됨 `google-gemini-cli-auth` (기본적으로 비활성화되어 있음)
- Qwen OAuth(공급자 인증) — 다음과 같이 번들로 제공됨 `qwen-portal-auth` (기본적으로 비활성화되어 있음)
- Copilot 프록시(공급자 인증) — 로컬 VS Code Copilot 프록시 브리지. 내장과는 별개 `github-copilot` 장치 로그인(번들로 구성되어 있으며 기본적으로 비활성화되어 있음)

OpenClaw 플러그인은 다음과 같습니다. **TypeScript 모듈** jiti를 통해 런타임에 로드됩니다. **구성
유효성 검사는 플러그인 코드를 실행하지 않습니다.**; 플러그인 매니페스트와 JSON을 사용합니다.
대신 스키마. 보다 [플러그인 매니페스트](/plugins/manifest).

플러그인은 다음을 등록할 수 있습니다:

- 게이트웨이 RPC 방법
- 게이트웨이 HTTP 핸들러
- 에이전트 도구
- CLI 명령
- 백그라운드 서비스
- 선택적 구성 검증
- **기술** (목록으로 `skills` 플러그인 매니페스트의 디렉터리)
- **자동 응답 명령** (AI 에이전트를 호출하지 않고 실행)

플러그인 실행 **진행 중** 게이트웨이와 함께 사용하므로 신뢰할 수 있는 코드로 취급하세요.
도구 제작 가이드: [플러그인 에이전트 도구](/plugins/agent-tools).

## 런타임 도우미

플러그인은 다음을 통해 선택된 핵심 도우미에 액세스할 수 있습니다. `api.runtime`. 전화 TTS의 경우:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

참고:

- 코어 사용 `messages.tts` 구성(OpenAI 또는 ElevenLabs).
- PCM 오디오 버퍼 + 샘플 속도를 반환합니다. 플러그인은 공급자에 대해 리샘플링/인코딩해야 합니다.
- Edge TTS는 전화 통신에 지원되지 않습니다.

## 발견 및 우선순위

OpenClaw 스캔 순서:

1. 구성 경로

- `plugins.load.paths` (파일 또는 디렉터리)

2. 작업 공간 확장

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. 전역 확장

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. 번들 확장(OpenClaw와 함께 제공, **기본적으로 비활성화됨**)

- `<openclaw>/extensions/*`

번들 플러그인은 다음을 통해 명시적으로 활성화되어야 합니다. `plugins.entries.<id>.enabled`
또는 `openclaw plugins enable <id>`. 설치된 플러그인은 기본적으로 활성화되어 있습니다.
하지만 같은 방법으로 비활성화할 수 있습니다.

각 플러그인에는 `openclaw.plugin.json` 루트에 파일이 있습니다. 경로인 경우
파일을 가리키는 경우 플러그인 루트는 파일의 디렉터리이며 다음을 포함해야 합니다.
명시하다.

여러 플러그인이 동일한 ID로 확인되는 경우 위 순서대로 첫 번째 일치
승리 및 우선 순위가 낮은 복사본은 무시됩니다.

### 패키지 팩

플러그인 디렉토리에는 다음이 포함될 수 있습니다. `package.json` ~와 함께 `openclaw.extensions`:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

각 항목은 플러그인이 됩니다. 팩에 여러 확장이 나열되어 있는 경우 플러그인 ID
된다 `name/<fileBase>`.

플러그인이 npm deps를 가져오는 경우 해당 디렉토리에 설치하여
`node_modules` 사용 가능합니다(`npm install` / `pnpm install`).

### 채널 카탈로그 메타데이터

채널 플러그인은 다음을 통해 온보딩 메타데이터를 광고할 수 있습니다. `openclaw.channel` 그리고
다음을 통해 힌트를 설치하세요 `openclaw.install`. 이렇게 하면 핵심 카탈로그에 데이터가 없는 상태로 유지됩니다.

예:

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk (self-hosted)",
      "docsPath": "/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "Self-hosted chat via Nextcloud Talk webhook bots.",
      "order": 65,
      "aliases": ["nc-talk", "nc"]
    },
    "install": {
      "npmSpec": "@openclaw/nextcloud-talk",
      "localPath": "extensions/nextcloud-talk",
      "defaultChoice": "npm"
    }
  }
}
```

OpenClaw도 병합할 수 있습니다. **외부 채널 카탈로그** (예를 들어 MPM
레지스트리 내보내기). 다음 중 하나에 JSON 파일을 놓습니다.

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

아니면 포인트 `OPENCLAW_PLUGIN_CATALOG_PATHS` (또는 `OPENCLAW_MPM_CATALOG_PATHS`) 에
하나 이상의 JSON 파일(쉼표/세미콜론/`PATH`-구분됨). 각 파일은
함유하다 `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`.

## 플러그인 ID

기본 플러그인 ID:

- 패키지 팩: `package.json` `name`
- 독립형 파일: 파일 기본 이름(`~/.../voice-call.ts` → `voice-call`)

플러그인을 내보내는 경우 `id`, OpenClaw는 이를 사용하지만 일치하지 않을 경우 경고합니다.
구성된 ID

## 구성

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-extension"] },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } },
    },
  },
}
```

전지:

- `enabled`: 마스터 토글 (기본값: true)
- `allow`: 허용 목록(선택사항)
- `deny`: 거부 목록(선택 사항, 거부 우선)
- `load.paths`: 추가 플러그인 파일/디렉터리
- `entries.<id>`: 플러그인별 토글 + 구성

구성 변경 **게이트웨이를 다시 시작해야 합니다**.

유효성 검사 규칙(엄격):

- 알 수 없는 플러그인 ID `entries`, `allow`, `deny`, 또는 `slots` ~이다 **오류**.
- 알려지지 않은 `channels.<id>` 열쇠는 **오류** 플러그인 매니페스트가 선언되지 않는 한
  채널 ID입니다.
- 플러그인 구성은 다음에 포함된 JSON 스키마를 사용하여 검증됩니다.
  `openclaw.plugin.json` (`configSchema`).
- 플러그인이 비활성화되면 해당 구성이 유지되고 **경고** 방출됩니다.

## 플러그인 슬롯(전용 카테고리)

일부 플러그인 카테고리는 **독점적인** (한 번에 하나만 활성화됩니다.) 사용
`plugins.slots` 슬롯을 소유한 플러그인을 선택하려면:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

여러 플러그인이 선언된 경우 `kind: "memory"`, 선택한 항목만 로드됩니다. 기타
진단을 통해 비활성화됩니다.

## 컨트롤 UI(스키마 + 라벨)

컨트롤 UI는 다음을 사용합니다. `config.schema` (JSON 스키마 + `uiHints`) 더 나은 형태를 렌더링합니다.

OpenClaw 강화 `uiHints` 검색된 플러그인을 기반으로 런타임 시:

- 다음에 대한 플러그인별 라벨을 추가합니다. `plugins.entries.<id>` / `.enabled` / `.config`
- 선택적인 플러그인 제공 구성 필드 힌트를 다음 위치에 병합합니다.
  `plugins.entries.<id>.config.<field>`

플러그인 구성 필드에 좋은 라벨/자리 표시자를 표시하고 비밀을 민감한 정보로 표시하려면,
제공하다 `uiHints` 플러그인 매니페스트에서 JSON 스키마와 함께.

예:

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": { "type": "string" },
      "region": { "type": "string" }
    }
  },
  "uiHints": {
    "apiKey": { "label": "API Key", "sensitive": true },
    "region": { "label": "Region", "placeholder": "us-east-1" }
  }
}
```

## CLI

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins install <path>                 # copy a local file/dir into ~/.openclaw/extensions/<id>
openclaw plugins install ./extensions/voice-call # relative path ok
openclaw plugins install ./plugin.tgz           # install from a local tarball
openclaw plugins install ./plugin.zip           # install from a local zip
openclaw plugins install -l ./extensions/voice-call # link (no copy) for dev
openclaw plugins install @openclaw/voice-call # install from npm
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` 아래에서 추적되는 npm 설치에서만 작동합니다. `plugins.installs`.

플러그인은 자체 최상위 명령을 등록할 수도 있습니다(예: `openclaw voicecall`).

## 플러그인 API(개요)

플러그인은 다음 중 하나를 내보냅니다.

- 기능: `(api) => { ... }`
- 객체: `{ id, name, configSchema, register(api) { ... } }`

## 플러그인 후크

플러그인은 후크를 제공하고 런타임에 등록할 수 있습니다. 이를 통해 플러그인 번들을 만들 수 있습니다.
별도의 Hook Pack 설치 없이 이벤트 기반 자동화가 가능합니다.

### 예

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

참고:

- 후크 디렉터리는 일반적인 후크 구조를 따릅니다(`HOOK.md` + `handler.ts`).
- 후크 자격 규칙은 계속 적용됩니다(OS/bins/env/config 요구 사항).
- 플러그인 관리 후크가 다음에 표시됩니다. `openclaw hooks list` ~와 함께 `plugin:<id>`.
- 다음을 통해 플러그인 관리 후크를 활성화/비활성화할 수 없습니다. `openclaw hooks`; 대신 플러그인을 활성화/비활성화하세요.

## 공급자 플러그인(모델 인증)

플러그인 등록 가능 **모델 제공자 인증** 사용자가 OAuth를 실행할 수 있도록 흐름을 유지하거나
OpenClaw 내부의 API 키 설정(외부 스크립트 필요 없음)

다음을 통해 공급자를 등록하세요. `api.registerProvider(...)`. 각 공급자는 하나를 노출합니다.
또는 더 많은 인증 방법(OAuth, API 키, 장치 코드 등). 이러한 방법은 다음을 지원합니다.

- `openclaw models auth login --provider <id> [--method <id>]`

예:

```ts
api.registerProvider({
  id: "acme",
  label: "AcmeAI",
  auth: [
    {
      id: "oauth",
      label: "OAuth",
      kind: "oauth",
      run: async (ctx) => {
        // Run OAuth flow and return auth profiles.
        return {
          profiles: [
            {
              profileId: "acme:default",
              credential: {
                type: "oauth",
                provider: "acme",
                access: "...",
                refresh: "...",
                expires: Date.now() + 3600 * 1000,
              },
            },
          ],
          defaultModel: "acme/opus-1",
        };
      },
    },
  ],
});
```

참고:

- `run` 수신하다 `ProviderAuthContext` ~와 함께 `prompter`, `runtime`, 
  `openUrl`, 그리고 `oauth.createVpsAwareHandlers` 도우미.
- 반품 `configPatch` 기본 모델이나 공급자 구성을 추가해야 할 때.
- 반품 `defaultModel` 그래서 `--set-default` 에이전트 기본값을 업데이트할 수 있습니다.

### 메시징 채널 등록

플러그인 등록 가능 **채널 플러그인** 내장 채널처럼 동작하는
(WhatsApp, 텔레그램 등). 채널 구성은 다음과 같습니다. `channels.<id>` 그리고는
채널 플러그인 코드로 검증되었습니다.

```ts
const myChannel = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "demo channel plugin.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async () => ({ ok: true }),
  },
};

export default function (api) {
  api.registerChannel({ plugin: myChannel });
}
```

참고:

- 아래에 구성 넣기 `channels.<id>` (아니다 `plugins.entries`).
- `meta.label` CLI/UI 목록의 레이블에 사용됩니다.
- `meta.aliases` 정규화 및 CLI 입력에 대한 대체 ID를 추가합니다.
- `meta.preferOver` 둘 다 구성된 경우 자동 활성화를 건너뛸 채널 ID를 나열합니다.
- `meta.detailLabel` 그리고 `meta.systemImage` UI에 더 풍부한 채널 라벨/아이콘이 표시되도록 하세요.

### 새 메시징 채널 작성(단계별)

싶을 때 이것을 사용하세요. **새로운 채팅 화면** (“메시징 채널”), 모델 제공자가 아닙니다.
모델 제공자 문서는 다음에 게시됩니다. `/providers/*`.

1. ID + 구성 형태 선택

- 모든 채널 구성은 `channels.<id>`.
- 선호하다 `channels.<id>.accounts.<accountId>` 다중 계정 설정의 경우.

2. 채널 메타데이터 정의

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` CLI/UI 목록을 제어합니다.
- `meta.docsPath` 다음과 같은 문서 페이지를 가리켜야 합니다. `/channels/<id>`.
- `meta.preferOver` 플러그인이 다른 채널을 대체할 수 있습니다(자동 활성화가 선호됨).
- `meta.detailLabel` 그리고 `meta.systemImage` 세부 텍스트/아이콘을 위해 UI에서 사용됩니다.

3. 필수 어댑터 구현

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (채팅 유형, 미디어, 스레드 등)
- `outbound.deliveryMode` + `outbound.sendText` (기본 전송용)

4. 필요에 따라 옵션 어댑터 추가

- `setup` (마법사), `security` (디엠 정책), `status` (건강/진단)
- `gateway` (시작/중지/로그인), `mentions`, `threading`, `streaming`
- `actions` (메시지 작업), `commands` (기본 명령 동작)

5. 플러그인에 채널을 등록하세요

- `api.registerChannel({ plugin })`

최소 구성 예:

```json5
{
  channels: {
    acmechat: {
      accounts: {
        default: { token: "ACME_TOKEN", enabled: true },
      },
    },
  },
}
```

최소 채널 플러그인(아웃바운드 전용):

```ts
const plugin = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "AcmeChat messaging channel.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text }) => {
      // deliver `text` to your channel here
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

플러그인 로드(확장 디렉토리 또는 `plugins.load.paths`), 게이트웨이를 다시 시작하고,
그런 다음 구성 `channels.<id>` 귀하의 구성에서.

### 에이전트 도구

전용 가이드를 참조하세요. [플러그인 에이전트 도구](/plugins/agent-tools).

### 게이트웨이 RPC 방법 등록

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### CLI 명령 등록

```ts
export default function (api) {
  api.registerCli(
    ({ program }) => {
      program.command("mycmd").action(() => {
        console.log("Hello");
      });
    },
    { commands: ["mycmd"] },
  );
}
```

### 자동 응답 명령 등록

플러그인은 다음을 실행하는 사용자 정의 슬래시 명령을 등록할 수 있습니다. **호출하지 않고
AI 에이전트**. 이는 토글 명령, 상태 확인 또는 빠른 작업에 유용합니다.
LLM 처리가 필요하지 않습니다.

```ts
export default function (api) {
  api.registerCommand({
    name: "mystatus",
    description: "Show plugin status",
    handler: (ctx) => ({
      text: `Plugin is running! Channel: ${ctx.channel}`,
    }),
  });
}
```

명령 처리기 컨텍스트:

- `senderId`: 발신자 ID (해당되는 경우)
- `channel`: 명령이 전송된 채널
- `isAuthorizedSender`: 발신자가 승인된 사용자인지 여부
- `args`: 명령 뒤에 전달된 인수(인 경우 `acceptsArgs: true`)
- `commandBody`: 전체 명령 텍스트
- `config`: 현재 OpenClaw 구성

명령 옵션:

- `name`: 명령 이름(선두 문자 제외) `/`)
- `description`: 명령 목록에 표시되는 도움말 텍스트
- `acceptsArgs`: 명령이 인수를 허용하는지 여부(기본값: false). false와 인수가 제공되면 명령이 일치하지 않고 메시지가 다른 처리기로 전달됩니다.
- `requireAuth`: 승인된 발신자를 요구할지 여부 (기본값: true)
- `handler`: 반환하는 함수 `{ text: string }` (비동기화 가능)

승인 및 인수의 예:

```ts
api.registerCommand({
  name: "setmode",
  description: "Set plugin mode",
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx) => {
    const mode = ctx.args?.trim() || "default";
    await saveMode(mode);
    return { text: `Mode set to: ${mode}` };
  },
});
```

참고:

- 플러그인 명령이 처리됩니다. **~ 전에** 내장 명령 및 AI 에이전트
- 명령은 전역적으로 등록되며 모든 채널에서 작동합니다.
- 명령 이름은 대소문자를 구분합니다(`/MyStatus` 성냥 `/mystatus`)
- 명령 이름은 문자로 시작해야 하며 문자, 숫자, 하이픈, 밑줄만 포함할 수 있습니다.
- 예약된 명령 이름(예: `help`, `status`, `reset`등)은 플러그인으로 재정의할 수 없습니다.
- 진단 오류로 인해 플러그인 전체에서 중복 명령 등록이 실패합니다.

### 백그라운드 서비스 등록

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## 명명 규칙

- 게이트웨이 방법: `pluginId.action` (예: `voicecall.status`)
- 도구: `snake_case` (예: `voice_call`)
- CLI 명령: kebab 또는 camel(핵심 명령과의 충돌 방지)

## 기술

플러그인은 저장소에 스킬을 전달할 수 있습니다(`skills/<name>/SKILL.md`).
다음으로 활성화하세요. `plugins.entries.<id>.enabled` (또는 다른 구성 게이트)을 확인하고
작업 영역/관리 기술 위치에 있습니다.

## 배포(npm)

권장 포장:

- 주요 패키지: `openclaw` (이 저장소)
- 플러그인: 아래에 별도의 npm 패키지 `@openclaw/*` (예: `@openclaw/voice-call`)

출판 계약:

- 플러그인 `package.json` 반드시 포함해야 합니다 `openclaw.extensions` 하나 이상의 항목 파일을 사용합니다.
- 항목 파일은 다음과 같습니다. `.js`또는 `.ts` (jiti는 런타임에 TS를 로드합니다).
- `openclaw plugins install <npm-spec>` 용도 `npm pack`, 로 추출 `~/.openclaw/extensions/<id>/`, 구성에서 활성화합니다.
- 구성 키 안정성: 범위가 지정된 패키지는 **범위가 지정되지 않은** 이드에 대한 `plugins.entries.*`.

## 예제 플러그인: 음성 통화

이 저장소에는 음성 통화 플러그인(Twilio 또는 로그 대체)이 포함되어 있습니다.

- 원천: `extensions/voice-call`
- 기능: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- 도구: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- 구성(twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (선택 과목 `statusCallbackUrl`, `twimlUrl`)
- 구성(개발자): `provider: "log"` (네트워크 없음)

보다 [음성통화](/plugins/voice-call) 그리고 `extensions/voice-call/README.md` 설정 및 사용을 위해.

## 안전 참고사항

플러그인은 게이트웨이와 함께 프로세스 내에서 실행됩니다. 신뢰할 수 있는 코드로 취급합니다.

- 신뢰할 수 있는 플러그인만 설치하세요.
- 선호하다 `plugins.allow` 허용 목록.
- 변경 후 게이트웨이를 다시 시작하십시오.

## 플러그인 테스트

플러그인은 테스트를 제공할 수 있고 제공해야 합니다.

- 저장소 내 플러그인은 Vitest 테스트를 다음과 같이 유지할 수 있습니다. `src/**` (예: `src/plugins/voice-call.plugin.test.ts`).
- 별도로 게시된 플러그인은 자체 CI(lint/build/test)를 실행하고 유효성을 검사해야 합니다. `openclaw.extensions` 빌드된 진입점의 지점(`dist/index.js`).
