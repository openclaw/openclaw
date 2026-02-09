---
summary: "OpenClaw 플러그인/확장: 디바이스 검색, 구성 및 안전"
read_when:
  - 플러그인/확장을 추가하거나 수정할 때
  - 플러그인 설치 또는 로드 규칙을 문서화할 때
title: "플러그인"
---

# 플러그인 (확장)

## 빠른 시작(플러그인이 처음이신가요?)

플러그인은 OpenClaw 를 추가 기능(명령, 도구, Gateway RPC)으로 확장하는 **작은 코드 모듈**입니다.

대부분의 경우, 아직 핵심 OpenClaw 에 포함되지 않은 기능이 필요하거나(또는 선택적 기능을 메인 설치에서 분리하고 싶을 때) 플러그인을 사용합니다.

빠른 경로:

1. 현재 로드된 항목 확인:

```bash
openclaw plugins list
```

2. 공식 플러그인 설치 (예: 음성 통화):

```bash
openclaw plugins install @openclaw/voice-call
```

3. Gateway 를 재시작한 다음 `plugins.entries.<id>.config` 아래에서 구성합니다.

구체적인 예제 플러그인은 [Voice Call](/plugins/voice-call) 을 참고하십시오.

## 사용 가능한 플러그인 (공식)

- Microsoft Teams 는 2026.1.15 기준으로 플러그인 전용입니다. Teams 를 사용하는 경우 `@openclaw/msteams` 을 설치하십시오.
- Memory (Core) — 번들된 메모리 검색 플러그인 (`plugins.slots.memory` 를 통해 기본 활성화)
- Memory (LanceDB) — 번들된 장기 메모리 플러그인 (자동 회상/캡처; `plugins.slots.memory = "memory-lancedb"` 설정)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (프로바이더 인증) — `google-antigravity-auth` 로 번들됨 (기본 비활성화)
- Gemini CLI OAuth (프로바이더 인증) — `google-gemini-cli-auth` 로 번들됨 (기본 비활성화)
- Qwen OAuth (프로바이더 인증) — `qwen-portal-auth` 로 번들됨 (기본 비활성화)
- Copilot Proxy (프로바이더 인증) — 로컬 VS Code Copilot Proxy 브리지; 내장 `github-copilot` 디바이스 로그인과는 별도 (번들, 기본 비활성화)

OpenClaw 플러그인은 jiti 를 통해 런타임에 로드되는 **TypeScript 모듈**입니다. **구성
유효성 검사는 플러그인 코드를 실행하지 않습니다**; 대신 플러그인 매니페스트와 JSON 스키마를 사용합니다. 자세한 내용은 [Plugin manifest](/plugins/manifest) 를 참고하십시오.

플러그인은 다음을 등록할 수 있습니다:

- Gateway RPC 메서드
- Gateway HTTP 핸들러
- 에이전트 도구
- CLI 명령
- 백그라운드 서비스
- 선택적 구성 검증
- **Skills** (플러그인 매니페스트에 `skills` 디렉토리를 나열하여)
- **자동 응답 명령** (AI 에이전트를 호출하지 않고 실행)

플러그인은 Gateway 와 **프로세스 내**에서 실행되므로 신뢰 가능한 코드로 취급해야 합니다.
도구 작성 가이드: [Plugin agent tools](/plugins/agent-tools).

## 런타임 헬퍼

플러그인은 `api.runtime` 를 통해 선택된 핵심 헬퍼에 접근할 수 있습니다. 전화 TTS 의 경우:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

참고 사항:

- 핵심 `messages.tts` 구성(OpenAI 또는 ElevenLabs)을 사용합니다.
- PCM 오디오 버퍼 + 샘플 레이트를 반환합니다. 플러그인은 프로바이더에 맞게 리샘플링/인코딩해야 합니다.
- Edge TTS 는 전화 통화에 지원되지 않습니다.

## 검색 및 우선순위

OpenClaw 는 다음 순서로 스캔합니다:

1. 구성 경로

- `plugins.load.paths` (파일 또는 디렉토리)

2. 워크스페이스 확장

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. 전역 확장

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. 번들 확장 (OpenClaw 와 함께 제공되며 **기본 비활성화**)

- `<openclaw>/extensions/*`

번들 플러그인은 `plugins.entries.<id>.enabled` 또는 `openclaw plugins enable <id>` 를 통해 명시적으로 활성화해야 합니다. 설치된 플러그인은 기본적으로 활성화되지만, 동일한 방식으로 비활성화할 수 있습니다.

각 플러그인은 루트에 `openclaw.plugin.json` 파일을 포함해야 합니다. 경로가 파일을 가리키는 경우,
플러그인 루트는 해당 파일의 디렉토리이며 매니페스트를 포함해야 합니다.

여러 플러그인이 동일한 id 로 해석되는 경우, 위 순서에서 먼저 일치하는 항목이 우선하며
우선순위가 낮은 사본은 무시됩니다.

### 패키지 팩

플러그인 디렉토리는 `openclaw.extensions` 이 포함된 `package.json` 를 포함할 수 있습니다:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

각 항목은 하나의 플러그인이 됩니다. 팩에 여러 확장이 나열된 경우,
플러그인 id 는 `name/<fileBase>` 가 됩니다.

플러그인이 npm 의존성을 가져오는 경우, 해당 디렉토리에 설치하여
`node_modules` 가 사용 가능하도록 하십시오 (`npm install` / `pnpm install`).

### 채널 카탈로그 메타데이터

채널 플러그인은 `openclaw.channel` 를 통해 온보딩 메타데이터를,
`openclaw.install` 를 통해 설치 힌트를 광고할 수 있습니다. 이를 통해 핵심 카탈로그를 데이터 프리로 유지합니다.

예시:

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

OpenClaw 는 **외부 채널 카탈로그**(예: MPM 레지스트리 내보내기)도 병합할 수 있습니다. 다음 중 하나에 JSON 파일을 두십시오:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

또는 `OPENCLAW_PLUGIN_CATALOG_PATHS` (또는 `OPENCLAW_MPM_CATALOG_PATHS`) 를
하나 이상의 JSON 파일(쉼표/세미콜론/`PATH` 구분)로 지정하십시오. 각 파일에는
`{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }` 가 포함되어야 합니다.

## 플러그인 ID

기본 플러그인 id:

- 패키지 팩: `package.json` `name`
- 단일 파일: 파일 기본 이름 (`~/.../voice-call.ts` → `voice-call`)

플러그인이 `id` 를 내보내는 경우, OpenClaw 는 이를 사용하지만
구성된 id 와 일치하지 않으면 경고를 표시합니다.

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

필드:

- `enabled`: 마스터 토글 (기본값: true)
- `allow`: 허용 목록 (선택)
- `deny`: 차단 목록 (선택; 차단이 우선)
- `load.paths`: 추가 플러그인 파일/디렉토리
- `entries.<id>`: 플러그인별 토글 + 구성

구성 변경은 **Gateway 재시작이 필요합니다**.

검증 규칙 (엄격):

- `entries`, `allow`, `deny`, 또는 `slots` 에서
  알 수 없는 플러그인 id 는 **오류**입니다.
- 알 수 없는 `channels.<id>` 키는 플러그인 매니페스트가
  채널 id 를 선언하지 않는 한 **오류**입니다.
- 플러그인 구성은 `openclaw.plugin.json` (`configSchema`) 에 내장된 JSON Schema 로 검증됩니다.
- 플러그인이 비활성화된 경우, 구성은 보존되며 **경고**가 출력됩니다.

## 플러그인 슬롯 (독점 카테고리)

일부 플러그인 카테고리는 **독점적**입니다(동시에 하나만 활성). 슬롯의 소유 플러그인을 선택하려면
`plugins.slots` 를 사용하십시오:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

여러 플러그인이 `kind: "memory"` 를 선언하는 경우, 선택된 것만 로드됩니다. 나머지는
진단 메시지와 함께 비활성화됩니다.

## Control UI (스키마 + 레이블)

Control UI 는 더 나은 폼 렌더링을 위해 `config.schema` (JSON Schema + `uiHints`) 를 사용합니다.

OpenClaw 는 발견된 플러그인을 기반으로 런타임에 `uiHints` 를 확장합니다:

- `plugins.entries.<id>` / `.enabled` / `.config` 에 대한 플러그인별 레이블 추가
- 다음 위치 아래에 선택적 플러그인 제공 구성 필드 힌트 병합:
  `plugins.entries.<id>.config.<field>`

플러그인 구성 필드에 좋은 레이블/플레이스홀더를 표시하고(비밀값을 민감 정보로 표시하려면),
플러그인 매니페스트에 JSON Schema 와 함께 `uiHints` 를 제공하십시오.

예시:

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

`plugins update` 은 `plugins.installs` 아래에서 추적되는 npm 설치에 대해서만 동작합니다.

플러그인은 자체 최상위 명령을 등록할 수도 있습니다(예: `openclaw voicecall`).

## 플러그인 API (개요)

플러그인은 다음 중 하나를 내보냅니다:

- 함수: `(api) => { ... }`
- 객체: `{ id, name, configSchema, register(api) { ... } }`

## 플러그인 훅

플러그인은 훅을 포함하여 런타임에 등록할 수 있습니다. 이를 통해 별도의 훅 팩 설치 없이
이벤트 기반 자동화를 번들로 제공할 수 있습니다.

### 예시

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

참고 사항:

- 훅 디렉토리는 일반 훅 구조(`HOOK.md` + `handler.ts`)를 따릅니다.
- 훅 자격 규칙(OS/bins/env/config 요구 사항)은 그대로 적용됩니다.
- 플러그인 관리 훅은 `openclaw hooks list` 에 `plugin:<id>` 와 함께 표시됩니다.
- `openclaw hooks` 를 통해 플러그인 관리 훅을 활성화/비활성화할 수 없습니다.

## 프로바이더 플러그인 (모델 인증)

플러그인은 **모델 프로바이더 인증** 플로우를 등록하여 사용자가 OpenClaw 내에서
OAuth 또는 API 키 설정을 실행할 수 있도록 합니다(외부 스크립트 불필요).

`api.registerProvider(...)` 를 통해 프로바이더를 등록하십시오. 각 프로바이더는 하나 이상의 인증 방법
(OAuth, API 키, 디바이스 코드 등)을 노출합니다. 이러한 방법은 다음을 구동합니다:

- `openclaw models auth login --provider <id> [--method <id>]`

예시:

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

참고 사항:

- `run` 는 `prompter`, `runtime`,
  `openUrl`, `oauth.createVpsAwareHandlers` 헬퍼가 포함된 `ProviderAuthContext` 를 수신합니다.
- 기본 모델 또는 프로바이더 구성을 추가해야 할 때 `configPatch` 를 반환하십시오.
- `--set-default` 이 에이전트 기본값을 업데이트할 수 있도록 `defaultModel` 를 반환하십시오.

### 메시징 채널 등록

플러그인은 내장 채널(WhatsApp, Telegram 등)처럼 동작하는 **채널 플러그인**을 등록할 수 있습니다. 채널 구성은 `channels.<id>` 아래에 위치하며, 채널 플러그인 코드로 검증됩니다.

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

참고 사항:

- 구성은 `channels.<id>` 아래에 두십시오(`plugins.entries` 가 아님).
- `meta.label` 는 CLI/UI 목록의 레이블에 사용됩니다.
- `meta.aliases` 는 정규화 및 CLI 입력을 위한 대체 id 를 추가합니다.
- `meta.preferOver` 는 둘 다 구성된 경우 자동 활성화를 건너뛸 채널 id 를 나열합니다.
- `meta.detailLabel` 및 `meta.systemImage` 는 UI 에서 더 풍부한 채널 레이블/아이콘을 표시하게 합니다.

### 새 메시징 채널 작성 (단계별)

모델 프로바이더가 아닌 **새 채팅 표면**(“메시징 채널”)이 필요할 때 사용하십시오.
모델 프로바이더 문서는 `/providers/*` 아래에 있습니다.

1. id + 구성 형태 선택

- 모든 채널 구성은 `channels.<id>` 아래에 위치합니다.
- 다중 계정 설정에는 `channels.<id>.accounts.<accountId>` 를 선호하십시오.

2. 채널 메타데이터 정의

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` 는 CLI/UI 목록을 제어합니다.
- `meta.docsPath` 는 `/channels/<id>` 와 같은 문서 페이지를 가리켜야 합니다.
- `meta.preferOver` 는 플러그인이 다른 채널을 대체하도록 합니다(자동 활성화 시 이를 선호).
- `meta.detailLabel` 및 `meta.systemImage` 는 UI 에서 상세 텍스트/아이콘에 사용됩니다.

3. 필수 어댑터 구현

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (채팅 유형, 미디어, 스레드 등)
- `outbound.deliveryMode` + `outbound.sendText` (기본 전송용)

4. 필요에 따라 선택적 어댑터 추가

- `setup` (마법사), `security` (다이렉트 메시지 정책), `status` (상태/진단)
- `gateway` (시작/중지/로그인), `mentions`, `threading`, `streaming`
- `actions` (메시지 액션), `commands` (네이티브 명령 동작)

5. 플러그인에 채널 등록

- `api.registerChannel({ plugin })`

최소 구성 예시:

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

최소 채널 플러그인(발신 전용):

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

플러그인을 로드(확장 디렉토리 또는 `plugins.load.paths`), Gateway 를 재시작한 다음
구성에서 `channels.<id>` 를 설정하십시오.

### 에이전트 도구

전용 가이드를 참고하십시오: [Plugin agent tools](/plugins/agent-tools).

### Gateway RPC 메서드 등록

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

플러그인은 **AI 에이전트를 호출하지 않고** 실행되는 사용자 정의 슬래시 명령을 등록할 수 있습니다. 이는 토글 명령, 상태 확인, LLM 처리가 필요 없는 빠른 작업에 유용합니다.

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

명령 핸들러 컨텍스트:

- `senderId`: 발신자 ID (가능한 경우)
- `channel`: 명령이 전송된 채널
- `isAuthorizedSender`: 발신자가 인증된 사용자 여부
- `args`: 명령 뒤에 전달된 인자 (`acceptsArgs: true` 인 경우)
- `commandBody`: 전체 명령 텍스트
- `config`: 현재 OpenClaw 구성

명령 옵션:

- `name`: 명령 이름 (선행 `/` 제외)
- `description`: 명령 목록에 표시되는 도움말 텍스트
- `acceptsArgs`: 인자 허용 여부 (기본값: false). false 인데 인자가 제공되면 명령이 매칭되지 않고 메시지는 다른 핸들러로 전달됩니다
- `requireAuth`: 인증된 발신자 요구 여부 (기본값: true)
- `handler`: `{ text: string }` 를 반환하는 함수 (비동기 가능)

권한 및 인자를 사용하는 예시:

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

참고 사항:

- 플러그인 명령은 내장 명령과 AI 에이전트 **이전에** 처리됩니다
- 명령은 전역으로 등록되며 모든 채널에서 동작합니다
- 명령 이름은 대소문자를 구분하지 않습니다(`/MyStatus` 는 `/mystatus` 과 일치)
- 명령 이름은 문자로 시작해야 하며 문자, 숫자, 하이픈, 언더스코어만 포함할 수 있습니다
- 예약된 명령 이름(`help`, `status`, `reset` 등)은 플러그인이 재정의할 수 없습니다 플러그인으로는 재정의할 수 없습니다
- 플러그인 간 중복 명령 등록은 진단 오류로 실패합니다

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

- Gateway 메서드: `pluginId.action` (예: `voicecall.status`)
- 도구: `snake_case` (예: `voice_call`)
- CLI 명령: kebab 또는 camel, 단 핵심 명령과의 충돌을 피하십시오

## Skills

플러그인은 리포지토리에 스킬을 포함할 수 있습니다(`skills/<name>/SKILL.md`).
`plugins.entries.<id>.enabled` (또는 다른 구성 게이트)로 활성화하고,
워크스페이스/관리된 스킬 위치에 존재하는지 확인하십시오.

## 배포 (npm)

권장 패키징:

- 메인 패키지: `openclaw` (이 리포지토리)
- 플러그인: `@openclaw/*` 아래의 별도 npm 패키지 (예: `@openclaw/voice-call`)

게시 계약:

- 플러그인 `package.json` 에는 하나 이상의 엔트리 파일이 포함된 `openclaw.extensions` 가 있어야 합니다.
- 엔트리 파일은 `.js` 또는 `.ts` 일 수 있습니다(jiti 가 런타임에 TS 를 로드).
- `openclaw plugins install <npm-spec>` 는 `npm pack` 를 사용하여 `~/.openclaw/extensions/<id>/` 로 추출하고 구성에서 활성화합니다.
- 구성 키 안정성: 스코프 패키지는 `plugins.entries.*` 를 위해 **스코프 없는** id 로 정규화됩니다.

## 예제 플러그인: Voice Call

이 리포지토리에는 음성 통화 플러그인(Twilio 또는 로그 폴백)이 포함되어 있습니다:

- 소스: `extensions/voice-call`
- Skill: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- 도구: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- 구성 (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (선택: `statusCallbackUrl`, `twimlUrl`)
- 구성 (dev): `provider: "log"` (네트워크 없음)

설정 및 사용법은 [Voice Call](/plugins/voice-call) 과 `extensions/voice-call/README.md` 를 참고하십시오.

## 안전 참고 사항

플러그인은 Gateway 와 프로세스 내에서 실행됩니다. 신뢰 가능한 코드로 취급하십시오:

- 신뢰하는 플러그인만 설치하십시오.
- `plugins.allow` 허용 목록을 선호하십시오.
- 변경 후 Gateway 를 재시작하십시오.

## 플러그인 테스트

플러그인은 테스트를 포함할 수 있으며(그리고 포함해야 합니다):

- 리포지토리 내 플러그인은 `src/**` 아래에 Vitest 테스트를 둘 수 있습니다(예: `src/plugins/voice-call.plugin.test.ts`).
- 별도로 게시된 플러그인은 자체 CI(lint/build/test)를 실행하고 `openclaw.extensions` 가 빌드된 엔트리포인트(`dist/index.js`)를 가리키는지 검증해야 합니다.
