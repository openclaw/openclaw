---
summary: "OpenClaw plugins/extensions: discovery, config, and safety"
read_when:
  - Adding or modifying plugins/extensions
  - Documenting plugin install or load rules
title: "Plugins"
x-i18n:
  source_hash: b36ca6b90ca03eaae25c00f9b12f2717fcd17ac540ba616ee03b398b234c2308
---

# 플러그인(확장)

## 빠른 시작(플러그인을 처음 사용하시나요?)

플러그인은 OpenClaw를 추가 기능으로 확장하는 **작은 코드 모듈**입니다.
기능(명령, 도구 및 게이트웨이 RPC).

대부분의 경우 빌드되지 않은 기능을 원할 때 플러그인을 사용하게 됩니다.
아직 핵심 OpenClaw에 포함되어 있지 않습니다(또는 기본 기능에서 선택적 기능을 유지하려는 경우).
설치).

빠른 경로:

1. 이미 로드된 내용을 확인하세요.

```bash
openclaw plugins list
```

2. 공식 플러그인 설치(예: 음성 통화):

```bash
openclaw plugins install @openclaw/voice-call
```

3. 게이트웨이를 다시 시작한 다음 `plugins.entries.<id>.config`에서 구성합니다.

구체적인 예시 플러그인은 [음성통화](/plugins/voice-call)를 참조하세요.

## 사용 가능한 플러그인(공식)

- Microsoft Teams는 2026.1.15부터 플러그인 전용입니다. Teams를 사용하는 경우 `@openclaw/msteams`를 설치하세요.
- 메모리(코어) — 번들 메모리 검색 플러그인(`plugins.slots.memory`을 통해 기본적으로 활성화됨)
- 메모리(LanceDB) — 번들로 제공되는 장기 메모리 플러그인(자동 호출/캡처; 설정 `plugins.slots.memory = "memory-lancedb"`)
- [음성통화](/plugins/voice-call) — `@openclaw/voice-call`
- [잘로 개인용](/plugins/zalouser) — `@openclaw/zalouser`
- [행렬](/channels/matrix) — `@openclaw/matrix`
- [번호](/channels/nostr) — `@openclaw/nostr`
- [잘로](/channels/zalo) — `@openclaw/zalo`
- [마이크로소프트 팀즈](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth(공급자 인증) — `google-antigravity-auth`로 번들로 제공됨(기본적으로 비활성화됨)
- Gemini CLI OAuth(공급자 인증) — `google-gemini-cli-auth`로 번들로 제공됨(기본적으로 비활성화됨)
- Qwen OAuth(공급자 인증) — `qwen-portal-auth`로 번들로 제공됨(기본적으로 비활성화됨)
- Copilot 프록시(공급자 인증) — 로컬 VS Code Copilot 프록시 브리지. 내장된 `github-copilot` 장치 로그인과 구별됨(번들로 구성되어 있으며 기본적으로 비활성화되어 있음)

OpenClaw 플러그인은 jiti를 통해 런타임에 로드되는 **TypeScript 모듈**입니다. **구성
유효성 검사는 플러그인 코드를 실행하지 않습니다**; 플러그인 매니페스트와 JSON을 사용합니다.
대신 스키마. [플러그인 매니페스트](/plugins/manifest)를 참조하세요.

플러그인은 다음을 등록할 수 있습니다:

- 게이트웨이 RPC 방법
- 게이트웨이 HTTP 핸들러
- 에이전트 도구
- CLI 명령
- 백그라운드 서비스
- 선택적 구성 검증
- **스킬** (플러그인 매니페스트에 `skills` 디렉터리 나열)
- **자동 응답 명령**(AI 에이전트 호출 없이 실행)

플러그인은 게이트웨이와 함께 **in-process** 실행되므로 신뢰할 수 있는 코드로 취급하십시오.
도구 제작 가이드: [플러그인 에이전트 도구](/plugins/agent-tools).

## 런타임 도우미

플러그인은 `api.runtime`를 통해 선택된 핵심 도우미에 접근할 수 있습니다. 전화 TTS의 경우:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

참고:

- 코어 `messages.tts` 구성(OpenAI 또는 ElevenLabs)을 사용합니다.
- PCM 오디오 버퍼 + 샘플 속도를 반환합니다. 플러그인은 공급자에 대해 리샘플링/인코딩해야 합니다.
- Edge TTS는 전화 통신에 지원되지 않습니다.

## 발견 및 우선순위

OpenClaw 스캔 순서:

1. 구성 경로

- `plugins.load.paths` (파일 또는 디렉터리)

2. 작업 공간 확장

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. 글로벌 확장

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. 번들 확장(OpenClaw와 함께 제공, **기본적으로 비활성화됨**)

- `<openclaw>/extensions/*`

번들 플러그인은 `plugins.entries.<id>.enabled`를 통해 명시적으로 활성화되어야 합니다.
또는 `openclaw plugins enable <id>`. 설치된 플러그인은 기본적으로 활성화되어 있습니다.
하지만 같은 방법으로 비활성화할 수 있습니다.

각 플러그인은 루트에 `openclaw.plugin.json` 파일을 포함해야 합니다. 경로인 경우
파일을 가리키는 경우 플러그인 루트는 파일의 디렉터리이며 다음을 포함해야 합니다.
명시하다.

여러 플러그인이 동일한 ID로 확인되는 경우 위 순서대로 첫 번째 일치
승리 및 우선 순위가 낮은 복사본은 무시됩니다.

### 패키지 팩

플러그인 디렉토리에는 `openclaw.extensions`와 함께 `package.json`가 포함될 수 있습니다.

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

각 항목은 플러그인이 됩니다. 팩에 여러 확장이 나열되어 있는 경우 플러그인 ID
`name/<fileBase>`가 됩니다.

플러그인이 npm deps를 가져오는 경우 해당 디렉토리에 설치하여
`node_modules`를 사용할 수 있습니다(`npm install` / `pnpm install`).

### 채널 카탈로그 메타데이터

채널 플러그인은 `openclaw.channel`를 통해 온보딩 메타데이터를 광고할 수 있으며
`openclaw.install`를 통해 힌트를 설치하세요. 이렇게 하면 핵심 카탈로그에 데이터가 없는 상태로 유지됩니다.

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

OpenClaw는 **외부 채널 카탈로그**(예: MPM)도 병합할 수 있습니다.
레지스트리 내보내기). 다음 중 하나에 JSON 파일을 놓습니다.

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

또는 `OPENCLAW_PLUGIN_CATALOG_PATHS`(또는 `OPENCLAW_MPM_CATALOG_PATHS`)를 가리킵니다.
하나 이상의 JSON 파일(쉼표/세미콜론/`PATH`-구분). 각 파일은
`{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`를 포함합니다.

## 플러그인 ID

기본 플러그인 ID:

- 패키지 팩: `package.json` `name`
- 독립형 파일 : 파일베이스명 (`~/.../voice-call.ts` → `voice-call`)

플러그인이 `id`를 내보내면 OpenClaw는 이를 사용하지만 플러그인과 일치하지 않으면 경고합니다.
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

분야:

- `enabled`: 마스터 토글 (기본값: true)
- `allow`: 허용 목록(선택 사항)
- `deny`: 거부 목록(선택 사항, 거부 우선)
- `load.paths`: 추가 플러그인 파일/디렉터리
- `entries.<id>`: 플러그인별 토글 + 구성

구성을 변경하려면 **게이트웨이를 다시 시작해야 합니다**.

유효성 검사 규칙(엄격):

- `entries`, `allow`, `deny` 또는 `slots`에 알 수 없는 플러그인 ID가 **오류**입니다.
- 플러그인 매니페스트가 선언되지 않는 한 알 수 없는 `channels.<id>` 키는 **오류**입니다.
  채널 ID입니다.
- 플러그인 구성은 다음에 포함된 JSON 스키마를 사용하여 검증됩니다.
  `openclaw.plugin.json` (`configSchema`).
- 플러그인이 비활성화되면 해당 구성이 유지되고 **경고**가 표시됩니다.

## 플러그인 슬롯(독점 카테고리)

일부 플러그인 카테고리는 **배타적**입니다(한 번에 하나만 활성화됨). 사용
`plugins.slots` 슬롯을 소유한 플러그인을 선택하려면 다음을 수행하세요.

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

여러 플러그인이 `kind: "memory"`를 선언하면 선택한 플러그인만 로드됩니다. 기타
진단을 통해 비활성화됩니다.

## 컨트롤 UI(스키마 + 라벨)

Control UI는 더 나은 양식을 렌더링하기 위해 `config.schema` (JSON 스키마 + `uiHints`)를 사용합니다.

OpenClaw는 발견된 플러그인을 기반으로 런타임에 `uiHints`를 강화합니다.

- `plugins.entries.<id>` / `.enabled` / `.config`에 대한 플러그인별 라벨을 추가합니다.
- 선택적인 플러그인 제공 구성 필드 힌트를 아래에 병합합니다.
  `plugins.entries.<id>.config.<field>`

플러그인 구성 필드에 좋은 라벨/자리 표시자를 표시하고 비밀을 민감한 정보로 표시하려면,
플러그인 매니페스트에서 JSON 스키마와 함께 `uiHints`를 제공하세요.

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

`plugins update`는 `plugins.installs`에서 추적된 npm 설치에만 작동합니다.

플러그인은 자체 최상위 명령을 등록할 수도 있습니다(예: `openclaw voicecall`).

## 플러그인 API(개요)

플러그인은 다음 중 하나를 내보냅니다.

- 함수 : `(api) => { ... }`
- 개체 : `{ id, name, configSchema, register(api) { ... } }`

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

- 후크 디렉터리는 일반 후크 구조(`HOOK.md` + `handler.ts`)를 따릅니다.
- 후크 자격 규칙이 계속 적용됩니다(OS/bins/env/config 요구 사항).
- 플러그인 관리 후크는 `plugin:<id>`와 함께 `openclaw hooks list`에 표시됩니다.
- `openclaw hooks`를 통해 플러그인 관리 후크를 활성화/비활성화할 수 없습니다. 대신 플러그인을 활성화/비활성화하세요.

## 공급자 플러그인(모델 인증)

플러그인은 **모델 공급자 인증** 흐름을 등록하여 사용자가 OAuth 또는
OpenClaw 내부의 API 키 설정(외부 스크립트 필요 없음)

`api.registerProvider(...)`를 통해 공급자를 등록합니다. 각 공급자는 하나를 노출합니다.
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

- `run`는 `prompter`, `runtime`로 `ProviderAuthContext`를 받습니다.
  `openUrl` 및 `oauth.createVpsAwareHandlers` 도우미.
- 기본 모델이나 공급자 구성을 추가해야 하는 경우 `configPatch`를 반환합니다.
- `defaultModel`를 반환하면 `--set-default`이 에이전트 기본값을 업데이트할 수 있습니다.

### 메시징 채널 등록

플러그인은 내장 채널처럼 작동하는 **채널 플러그인**을 등록할 수 있습니다.
(WhatsApp, 텔레그램 등). 채널 구성은 `channels.<id>` 아래에 있으며
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

- `channels.<id>` 아래에 구성을 넣습니다(`plugins.entries` 아님).
- `meta.label`는 CLI/UI 목록의 레이블에 사용됩니다.
- `meta.aliases` 정규화 및 CLI 입력에 대한 대체 ID를 추가합니다.
- `meta.preferOver`는 둘 다 구성된 경우 자동 활성화를 건너뛸 채널 ID를 나열합니다.
- `meta.detailLabel` 및 `meta.systemImage`를 사용하면 UI에 더 풍부한 채널 라벨/아이콘이 표시됩니다.

### 새 메시징 채널 작성(단계별)

모델 제공자가 아닌 **새로운 채팅 창**('메시징 채널')을 원할 때 이 기능을 사용하세요.
모델 제공자 문서는 `/providers/*`에 있습니다.

1. ID + 구성 형태 선택

- 모든 채널 구성은 `channels.<id>`에 있습니다.
- 다중 계정 설정의 경우 `channels.<id>.accounts.<accountId>`를 선호합니다.

2. 채널 메타데이터 정의

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` CLI/UI 목록을 제어합니다.
- `meta.docsPath`는 `/channels/<id>`와 같은 문서 페이지를 가리켜야 합니다.
- `meta.preferOver` 플러그인이 다른 채널을 대체할 수 있게 해줍니다(자동 활성화가 선호됩니다).
- `meta.detailLabel` 및 `meta.systemImage`는 UI에서 세부 텍스트/아이콘에 사용됩니다.

3. 필요한 어댑터 구현

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (채팅 유형, 미디어, 스레드 등)
- `outbound.deliveryMode` + `outbound.sendText` (기본 전송용)

4. 필요에 따라 옵션 어댑터를 추가합니다.

- `setup`(마법사), `security`(DM 정책), `status`(건강/진단)
- `gateway` (시작/중지/로그인), `mentions`, `threading`, `streaming`
- `actions` (메시지 동작), `commands` (기본 명령 동작)

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

플러그인(확장 dir 또는 `plugins.load.paths`)을 로드하고 게이트웨이를 다시 시작합니다.
그런 다음 구성에서 `channels.<id>`를 구성하십시오.

### 에이전트 도구

전용 가이드: [플러그인 에이전트 도구](/plugins/agent-tools)를 참조하세요.

### 게이트웨이 RPC 메소드 등록

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

플러그인은 **호출 없이 실행되는 사용자 정의 슬래시 명령을 등록할 수 있습니다.
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

- `senderId` : 보낸 사람의 ID (해당되는 경우)
- `channel` : 명령어를 보낸 채널
- `isAuthorizedSender` : 발신자가 인증된 사용자인지 여부
- `args`: 명령 뒤에 전달된 인수(if `acceptsArgs: true`)
- `commandBody`: 전체 명령 텍스트
- `config`: 현재 OpenClaw 구성

명령 옵션:

- `name`: 명령 이름(앞에 `/` 제외)
- `description`: 명령 목록에 표시되는 도움말 텍스트
- `acceptsArgs`: 명령이 인수를 허용하는지 여부(기본값: false). false와 인수가 제공되면 명령이 일치하지 않고 메시지가 다른 처리기로 전달됩니다.
- `requireAuth` : 승인된 발신자를 요구할지 여부 (기본값: true)
- `handler`: `{ text: string }`를 반환하는 함수 (비동기화 가능)

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

- 플러그인 명령은 내장 명령 및 AI 에이전트 **전에** 처리됩니다.
- 명령은 전역적으로 등록되며 모든 채널에서 작동합니다.
- 명령 이름은 대소문자를 구분하지 않습니다(`/MyStatus`는 `/mystatus`와 일치함).
- 명령 이름은 문자로 시작해야 하며 문자, 숫자, 하이픈, 밑줄만 포함할 수 있습니다.
- 예약된 명령 이름(예: `help`, `status`, `reset` 등)은 플러그인으로 재정의할 수 없습니다.
- 진단 오류로 인해 플러그인 전반에 걸쳐 중복 명령 등록이 실패합니다.

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
- CLI 명령: kebab 또는 camel. 단, 핵심 명령과의 충돌은 피하세요.

## 스킬

플러그인은 저장소(`skills/<name>/SKILL.md`)에 스킬을 전달할 수 있습니다.
`plugins.entries.<id>.enabled` (또는 다른 구성 게이트)를 사용하여 활성화하고 확인하십시오.
작업 영역/관리 기술 위치에 있습니다.

## 배포(npm)

권장 포장:

- 메인 패키지: `openclaw` (이 저장소)
- 플러그인: `@openclaw/*` 아래 별도의 npm 패키지(예: `@openclaw/voice-call`)

출판 계약:

- 플러그인 `package.json`에는 하나 이상의 항목 파일과 함께 `openclaw.extensions`가 포함되어야 합니다.
- 항목 파일은 `.js` 또는 `.ts`일 수 있습니다(jiti는 런타임에 TS를 로드합니다).
- `openclaw plugins install <npm-spec>`는 `npm pack`를 사용하여 `~/.openclaw/extensions/<id>/`로 추출하고 구성에서 활성화합니다.
- 구성 키 안정성: 범위가 지정된 패키지는 `plugins.entries.*`에 대한 **범위가 지정되지 않은** ID로 정규화됩니다.

## 플러그인 예시: 음성 통화

이 저장소에는 음성 통화 플러그인(Twilio 또는 로그 대체)이 포함되어 있습니다.

- 출처 : `extensions/voice-call`
- 스킬 : `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- 도구: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- 구성(twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (선택 사항 `statusCallbackUrl`, `twimlUrl`)
- 구성(개발자): `provider: "log"` (네트워크 없음)

설정 및 사용법은 [음성통화](/plugins/voice-call) 및 `extensions/voice-call/README.md`를 참고하세요.

## 안전 참고사항

플러그인은 게이트웨이와 함께 프로세스 내에서 실행됩니다. 신뢰할 수 있는 코드로 취급합니다.

- 신뢰할 수 있는 플러그인만 설치하세요.
- `plugins.allow` 허용 목록을 선호합니다.
- 변경 후 게이트웨이를 다시 시작합니다.

## 플러그인 테스트

플러그인은 테스트를 제공할 수 있고 제공해야 합니다.

- 저장소 내 플러그인은 Vitest 테스트를 `src/**`(예: `src/plugins/voice-call.plugin.test.ts`) 아래에 유지할 수 있습니다.
- 별도로 게시된 플러그인은 자체 CI(lint/build/test)를 실행하고 빌드된 진입점(`dist/index.js`)에서 `openclaw.extensions` 지점을 검증해야 합니다.
