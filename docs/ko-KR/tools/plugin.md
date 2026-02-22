---
summary: "OpenClaw 플러그인/확장: 디바이스 검색, 설정 및 안전성"
read_when:
  - 플러그인/확장 추가 또는 수정 시
  - 플러그인 설치 또는 로드 규칙 문서화 시
title: "플러그인"
---

# 플러그인 (확장)

## 빠른 시작 (플러그인을 처음 사용하시나요?)

플러그인은 OpenClaw에 추가 기능(명령어, 도구 및 게이트웨이 RPC)을 확장하는 **작은 코드 모듈**입니다.

대부분의 경우, 플러그인은 OpenClaw 핵심에 아직 통합되지 않은 기능을 원하거나, 메인 설치에서 선택적 기능을 배제하고 싶을 때 사용됩니다.

빠른 경로:

1. 이미 로드된 플러그인 확인:

```bash
openclaw plugins list
```

2. 공식 플러그인 설치 (예시: 음성통화):

```bash
openclaw plugins install @openclaw/voice-call
```

Npm 사양은 **레지스트리 전용**입니다 (패키지 이름 + 선택적 버전/태그). Git/URL/파일 사양은 거부됩니다.

3. 게이트웨이를 재시작한 다음 `plugins.entries.<id>.config`에서 구성합니다.

구체적인 플러그인 예시는 [Voice Call](/ko-KR/plugins/voice-call)을 참조하세요.
타사 목록을 찾고 계신가요? [커뮤니티 플러그인](/ko-KR/plugins/community)을 참조하세요.

## 사용 가능한 공식 플러그인

- Microsoft Teams는 2026.1.15부터 플러그인으로만 제공됩니다. Teams를 사용한다면 `@openclaw/msteams`를 설치하세요.
- Memory (Core) — 번들 메모리 검색 플러그인 (`plugins.slots.memory`를 통해 기본 활성화)
- Memory (LanceDB) — 번들 장기 메모리 플러그인 (자동 회수/캡처; `plugins.slots.memory = "memory-lancedb"`로 설정)
- [Voice Call](/ko-KR/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/ko-KR/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/ko-KR/channels/matrix) — `@openclaw/matrix`
- [Nostr](/ko-KR/channels/nostr) — `@openclaw/nostr`
- [Zalo](/ko-KR/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/ko-KR/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (프로바이더 인증) — `google-antigravity-auth`로 번들화 (기본 비활성화)
- Gemini CLI OAuth (프로바이더 인증) — `google-gemini-cli-auth`로 번들화 (기본 비활성화)
- Qwen OAuth (프로바이더 인증) — `qwen-portal-auth`로 번들화 (기본 비활성화)
- Copilot Proxy (프로바이더 인증) — 로컬 VS Code Copilot Proxy 브릿지; 내장 `github-copilot` 디바이스 로그인과 다름 (번들, 기본 비활성화)

OpenClaw 플러그인은 **jiti를 통해** 런타임에 로드되는 **TypeScript 모듈**입니다. **설정 검증은 플러그인 코드를 실행하지 않습니다**; 대신 플러그인 매니페스트와 JSON 스키마를 사용합니다. [Plugin manifest](/ko-KR/plugins/manifest)를 참조하세요.

플러그인은 다음을 등록할 수 있습니다:

- 게이트웨이 RPC 메서드
- 게이트웨이 HTTP 핸들러
- 에이전트 도구
- CLI 명령어
- 백그라운드 서비스
- 선택적 설정 검증
- **스킬** (플러그인 매니페스트 내 `skills` 디렉터리를 나열하여)
- **자동 응답 명령어** (AI 에이전트를 호출하지 않고 실행됨)

플러그인은 게이트웨이와 **동일한 프로세스 내**에서 실행되므로 신뢰할 수 있는 코드로 취급해야 합니다. 도구 작성 가이드: [Plugin agent tools](/ko-KR/plugins/agent-tools).

## 런타임 도우미

플러그인은 `api.runtime`을 통해 선택된 코어 도우미에 접근할 수 있습니다. 전화 TTS 예시:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

주의사항:

- 코어 `messages.tts` 설정을 사용합니다 (OpenAI 또는 ElevenLabs).
- PCM 오디오 버퍼와 샘플 속도를 반환합니다. 플러그인은 프로바이더에 맞게 재샘플/인코딩해야 합니다.
- Edge TTS는 전화에서 지원되지 않습니다.

## 디바이스 검색 및 우선순위

OpenClaw는 다음 순서로 스캔합니다:

1. 설정 경로

- `plugins.load.paths` (파일 또는 디렉터리)

2. 워크스페이스 확장

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. 글로벌 확장

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. 번들 확장 (OpenClaw와 함께 배송되며, **기본 비활성화**)

- `<openclaw>/extensions/*`

번들 플러그인은 `plugins.entries.<id>.enabled` 또는 `openclaw plugins enable <id>`를 통해 명시적으로 활성화해야 합니다. 설치된 플러그인은 기본적으로 활성화되지만 동일한 방식으로 비활성화할 수 있습니다.

강화 노트:

- `plugins.allow`가 비어 있고 번들이 아닌 플러그인이 검색 가능한 경우, OpenClaw는 플러그인 ID와 소스를 포함한 시작 경고를 기록합니다.
- 후보 경로는 검색 승인 전에 안전 검사를 받습니다. OpenClaw는 다음 경우 후보를 차단합니다:
  - 확장 항목이 심볼릭 링크/경로 탐색 탈출을 포함하여 플러그인 루트 밖으로 해석되는 경우,
  - 플러그인 루트/소스 경로가 전 세계 쓰기 가능한 경우,
  - 번들이 아닌 플러그인에서 경로 소유권이 의심스러운 경우 (POSIX 소유자가 현재 uid나 root가 아닌 경우).
- 설치/로드 경로 출처가 없는 번들이 아닌 로드된 플러그인은 신뢰를 고정(`plugins.allow`)하거나 설치 추적(`plugins.installs`)할 수 있도록 경고를 발생시킵니다.

각 플러그인은 루트에 `openclaw.plugin.json` 파일을 포함해야 합니다. 경로가 파일을 가리키는 경우, 플러그인 루트는 파일의 디렉터리이며 매니페스트를 포함해야 합니다.

동일한 id로 여러 플러그인이 해결되는 경우, 위의 순서에서 첫 번째로 일치하는 것이 우선하며, 우선순위가 낮은 복사본은 무시됩니다.

### 패키지 팩

플러그인 디렉터리는 `openclaw.extensions`가 포함된 `package.json`을 가질 수 있습니다:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

각 항목은 플러그인이 됩니다. 팩이 여러 확장을 나열할 경우, 플러그인 id는 `name/<fileBase>`가 됩니다.

플러그인이 npm 종속성을 가져오는 경우, 해당 디렉터리에 설치하여 `node_modules`가 사용 가능하도록 하십시오 (`npm install` / `pnpm install`).

보안 가드레일: 모든 `openclaw.extensions` 항목은 심볼릭 링크 해석 후 플러그인 디렉터리 내에 있어야 합니다. 패키지 디렉터리를 벗어나는 항목은 거부됩니다.

보안 주의사항: `openclaw plugins install`은 `npm install --ignore-scripts`로 플러그인 종속성을 설치합니다 (라이프사이클 스크립트 없음). 플러그인 종속성 트리를 "순수 JS/TS"로 유지하고, `postinstall` 빌드가 필요한 패키지는 피하십시오.

### 채널 카탈로그 메타데이터

채널 플러그인은 `openclaw.channel`을 통해 온보딩 메타데이터를 광고하고 `openclaw.install`을 통해 설치 힌트를 제공합니다. 이를 통해 핵심 카탈로그를 데이터를 제거합니다.

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

OpenClaw는 **외부 채널 카탈로그**도 병합할 수 있습니다 (예: MPM 레지스트리 내보내기). JSON 파일을 다음 중 하나에 드롭합니다:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

또는 `OPENCLAW_PLUGIN_CATALOG_PATHS` (또는 `OPENCLAW_MPM_CATALOG_PATHS`)를 하나 이상의 JSON 파일에 지정합니다 (콤마/세미콜론/`PATH` 구분). 각 파일은 `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }` 형식을 가져야 합니다.

## 플러그인 IDs

기본 플러그인 ids:

- 패키지 팩: `package.json` `name`
- 독립 파일: 파일 기본 이름 (`~/.../voice-call.ts` → `voice-call`)

플러그인이 `id`를 내보낼 경우, OpenClaw는 이를 사용하지만 설정된 id와 일치하지 않을 때 경고를 표시합니다.

## 설정

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

- `enabled`: 마스터 토글 (기본: true)
- `allow`: 허용 목록 (선택 사항)
- `deny`: 거부 목록 (선택 사항; 거부가 우선)
- `load.paths`: 추가 플러그인 파일/디렉터리
- `entries.<id>`: 플러그인별 토글 및 설정

설정 변경은 **게이트웨이 재시작**이 필요합니다.

검증 규칙 (엄격):

- `entries`, `allow`, `deny`, 또는 `slots`의 알 수 없는 플러그인 ids는 **오류**입니다.
- 알 수 없는 `channels.<id>` 키는 플러그인 매니페스트에서 채널 id를 선언하지 않는 한 **오류**입니다.
- 플러그인 설정은 `openclaw.plugin.json`에 포함된 JSON 스키마를 사용하여 검증됩니다 (`configSchema`).
- 플러그인이 비활성화되면, 그 설정은 보존되며 **경고**가 발생합니다.

## 플러그인 슬롯 (독점적 카테고리)

일부 플러그인 카테고리는 **독점적**입니다 (한 번에 하나만 활성화). `plugins.slots`를 사용하여 슬롯 소유 플러그인을 선택하세요:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // 또는 "none"으로 메모리 플러그인 비활성화
    },
  },
}
```

여러 플러그인이 `kind: "memory"`를 선언하는 경우, 선택된 것만 로드됩니다. 다른 것은 진단과 함께 비활성화됩니다.

## 제어 UI (스키마 + 라벨)

제어 UI는 `config.schema` (JSON 스키마 + `uiHints`)를 사용하여 더 나은 폼을 렌더링합니다.

OpenClaw는 발견된 플러그인을 기반으로 `uiHints`를 런타임에 보강합니다:

- `plugins.entries.<id>` / `.enabled` / `.config`에 플러그인별 라벨 추가
- 선택적 플러그인 제공 설정 필드 힌트를 아래에 병합:
  `plugins.entries.<id>.config.<field>`

플러그인의 설정 필드에 좋은 라벨/플레이스홀더를 표시하고 (비밀을 민감한 것으로 표시하려면), 플러그인 매니페스트의 JSON 스키마와 함께 `uiHints`를 제공하세요.

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
openclaw plugins install <path>                 # 로컬 파일/디렉터리를 ~/.openclaw/extensions/<id>로 복사
openclaw plugins install ./extensions/voice-call # 상대 경로 허용
openclaw plugins install ./plugin.tgz           # 로컬 타볼에서 설치
openclaw plugins install ./plugin.zip           # 로컬 zip에서 설치
openclaw plugins install -l ./extensions/voice-call # 링크 (복사 없음) 개발용
openclaw plugins install @openclaw/voice-call # npm에서 설치
openclaw plugins install @openclaw/voice-call --pin # 정확한 해결된 name@version 저장
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update`는 `plugins.installs`에 추적된 npm 설치에 대해서만 작동합니다.
업데이트 간에 저장된 무결성 메타데이터가 변경되면, OpenClaw는 경고를 발생시키고 확인을 요청합니다 (전역 `--yes`를 사용하여 프롬프트를 건너뛰세요).

플러그인은 자체 상위 수준의 명령어를 등록할 수도 있습니다 (예시: `openclaw voicecall`).

## 플러그인 API (개요)

플러그인은 다음을 내보냅니다:

- 함수: `(api) => { ... }`
- 객체: `{ id, name, configSchema, register(api) { ... } }`

## 플러그인 후크

플러그인은 후크를 제공하고 런타임에 등록할 수 있습니다. 이를 통해 플러그인은 별도의 후크 팩 설치 없이 이벤트 기반 자동화를 번들링할 수 있습니다.

### 예

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

주의사항:

- 후크 디렉터리는 일반적인 후크 구조를 따릅니다 (`HOOK.md` + `handler.ts`).
- 후크 적합성 규칙은 여전히 적용됩니다 (OS/바이너리/환경/설정 요건).
- 플러그인 관리 후크는 `openclaw hooks list`에 `plugin:<id>`로 표시됩니다.
- `openclaw hooks`를 통해 플러그인 관리 후크를 활성화/비활성화할 수 없습니다; 대신 플러그인을 활성화/비활성화하십시오.

## 프로바이더 플러그인 (모델 인증)

플러그인은 **모델 프로바이더 인증** 흐름을 등록하여 사용자가 OpenClaw 내에서 OAuth 또는 API 키 설정을 실행할 수 있도록 할 수 있습니다 (외부 스크립트 필요 없음).

`api.registerProvider(...)`를 통해 프로바이더를 등록하세요. 각 프로바이더는 하나 이상의 인증 방법을 제공합니다 (OAuth, API 키, 디바이스 코드 등). 이러한 방법은 다음에 사용됩니다:

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
        // OAuth 흐름을 실행하고 인증 프로파일을 반환합니다.
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

주의사항:

- `run`은 `prompter`, `runtime`, `openUrl`, `oauth.createVpsAwareHandlers` 도우미와 함께 `ProviderAuthContext`를 받습니다.
- 기본 모델 또는 프로바이더 설정을 추가해야 할 때 `configPatch`를 반환합니다.
- `--set-default`가 에이전트 기본값을 업데이트할 수 있도록 `defaultModel`을 반환합니다.

### 메시징 채널 등록하기

플러그인은 **채널 플러그인**을 등록할 수 있으며, 이러한 플러그인은 내장 채널 (WhatsApp, Telegram 등)과 같은 방식으로 동작합니다. 채널 설정은 `channels.<id>`에 있으며, 채널 플러그인 코드에 의해 검증됩니다.

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

주의사항:

- 설정은 `channels.<id>` 아래에 두십시오 (`plugins.entries`가 아님).
- `meta.label`은 CLI/UI 목록에서 라벨에 사용됩니다.
- `meta.aliases`는 정상화 및 CLI 입력을 위한 대체 id를 추가합니다.
- `meta.preferOver`는 모두 설정된 경우 자동 활성화를 건너뛰기 위해 다른 채널 id를 나열합니다.
- `meta.detailLabel`과 `meta.systemImage`는 UI가 더 풍부한 채널 라벨/아이콘을 표시할 수 있도록 합니다.

### 새로운 메시징 채널 작성하기 (단계별)

새로운 채팅 표면 ("메시징 채널")이 필요한 경우 이 지침을 사용하십시오. 모델 프로바이더에 대한 문서는 `/providers/*`에 있습니다.

1. id 및 설정 모양 선택

- 모든 채널 설정은 `channels.<id>`에 있습니다.
- 다중 계정 설정을 위해 `channels.<id>.accounts.<accountId>`를 선호합니다.

2. 채널 메타데이터 정의

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb`는 CLI/UI 목록을 제어합니다.
- `meta.docsPath`는 `/channels/<id>`와 같은 문서 페이지를 가리켜야 합니다.
- `meta.preferOver`는 플러그인이 다른 채널을 대체할 수 있도록 합니다 (자동 활성화는 선호함).
- `meta.detailLabel`과 `meta.systemImage`는 UI에서 자세한 텍스트/아이콘에 사용됩니다.

3. 필요한 어댑터 구현

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (채팅 유형, 미디어, 스레드 등)
- `outbound.deliveryMode` + `outbound.sendText` (기본 전송용)

4. 필요한 경우 선택적 어댑터 추가

- `setup` (마법사), `security` (다이렉트 메시지 정책), `status` (상태/진단)
- `gateway` (시작/중지/로그인), `mentions`, `threading`, `streaming`
- `actions` (메시지 작업), `commands` (네이티브 명령어 동작)

5. 플러그인에 채널 등록

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

최소 채널 플러그인 (아웃바운드 전용):

```ts
const plugin = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "AcmeChat 메시징 채널.",
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
      // `text`를 채널로 배달하세요
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

플러그인을 로드하십시오 (확장 디렉터리 또는 `plugins.load.paths`), 게이트웨이를 재시작한 다음 `channels.<id>`를 설정해 구성하십시오.

### 에이전트 도구

전용 가이드를 참조하세요: [Plugin agent tools](/ko-KR/plugins/agent-tools).

### 게이트웨이 RPC 메소드 등록하기

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### CLI 명령어 등록하기

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

### 자동 응답 명령어 등록하기

플러그인은 AI 에이전트를 호출하지 않고 실행되는 커스텀 슬래시 명령어를 등록할 수 있습니다. 이는 LLM 처리가 필요 없는 토글 명령어, 상태 점검 또는 빠른 작업에 유용합니다.

```ts
export default function (api) {
  api.registerCommand({
    name: "mystatus",
    description: "플러그인 상태 표시",
    handler: (ctx) => ({
      text: `플러그인이 실행 중입니다! 채널: ${ctx.channel}`,
    }),
  });
}
```

명령어 핸들러 컨텍스트:

- `senderId`: 발신자의 ID (사용 가능한 경우)
- `channel`: 명령어가 전송된 채널
- `isAuthorizedSender`: 발신자가 인증된 사용자인지 여부
- `args`: 명령어 후 전달된 인수 (if `acceptsArgs: true`)
- `commandBody`: 전체 명령어 텍스트
- `config`: 현재 OpenClaw 설정

명령어 옵션:

- `name`: 명령어 이름 (선행 `/` 없이)
- `description`: 명령어 목록에 표시되는 도움말 텍스트
- `acceptsArgs`: 명령어가 인수를 허용하는지 여부 (기본값: false). 인수를 허용하지 않으며 인수가 제공된 경우, 명령어는 일치하지 않으며 메시지는 다른 핸들러로 전달됩니다.
- `requireAuth`: 인증된 발신자를 요구할지 여부 (기본값: true)
- `handler`: `{ text: string }`을 반환하는 함수 (비동기 가능)

승인 및 인수를 포함한 예:

```ts
api.registerCommand({
  name: "setmode",
  description: "플러그인 모드 설정",
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx) => {
    const mode = ctx.args?.trim() || "default";
    await saveMode(mode);
    return { text: `모드 설정: ${mode}` };
  },
});
```

주의사항:

- 플러그인 명령어는 **내장 명령어와 AI 에이전트 이전에** 처리됩니다.
- 명령어는 전역적으로 등록되며 모든 채널에서 작동합니다.
- 명령어 이름은 대소문자를 구분하지 않습니다 (`/MyStatus`는 `/mystatus`와 일치).
- 명령어 이름은 문자로 시작해야 하며 문자, 숫자, 하이픈 및 밑줄만 포함해야 합니다.
- 예약된 명령어 이름 (예: `help`, `status`, `reset` 등)은 플러그인에 의해 재정의될 수 없습니다.
- 플러그인 간 중복 명령어 등록은 진단 오류와 함께 실패합니다.

### 백그라운드 서비스 등록하기

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

- 게이트웨이 메서드: `pluginId.action` (예: `voicecall.status`)
- 도구: `snake_case` (예: `voice_call`)
- CLI 명령어: 케밥 또는 카멜, 하지만 핵심 명령어와 겹치지 않도록 주의하십시오.

## 스킬

플러그인은 리포에 스킬을 포함할 수 있습니다 (`skills/<name>/SKILL.md`).
`plugins.entries.<id>.enabled` (또는 다른 설정 게이트)를 통해 활성화하고,
워크스페이스나 관리되는 스킬 위치에 포함되도록 하십시오.

## 배포 (npm)

권장 패키징:

- 메인 패키지: `openclaw` (이 리포)
- 플러그인: `@openclaw/*` 아래 별도의 npm 패키지 (예: `@openclaw/voice-call`)

발행 계약:

- 플러그인 `package.json`은 하나 이상의 엔트리 파일과 함께 `openclaw.extensions`를 포함해야 합니다.
- 엔트리 파일은 `.js` 또는 `.ts`일 수 있습니다 (jiti는 런타임에 TS를 로드합니다).
- `openclaw plugins install <npm-spec>`은 `npm pack`을 사용하여 `~/.openclaw/extensions/<id>/`로 추출하고 설정에서 활성화합니다.
- 설정 키 안정성: 범위별 패키지는 `plugins.entries.*`에 대해 **비범위** id로 정규화됩니다.

## 예제 플러그인: Voice Call

이 리포에는 voice-call 플러그인이 포함되어 있습니다 (Twilio 또는 로그 대체):

- 소스: `extensions/voice-call`
- 스킬: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- 도구: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- 설정 (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (선택적 `statusCallbackUrl`, `twimlUrl`)
- 설정 (dev): `provider: "log"` (네트워크 없음)

설정 및 사용법에 대한 자세한 내용은 [Voice Call](/ko-KR/plugins/voice-call) 및 `extensions/voice-call/README.md`를 참조하십시오.

## 안전성 주의사항

플러그인은 게이트웨이와 동일한 프로세스 내에서 실행됩니다. 신뢰할 수 있는 코드로 취급하십시오:

- 신뢰할 수 있는 플러그인만 설치하십시오.
- `plugins.allow` 허용 목록을 선호하십시오.
- 변경 사항 후 게이트웨이를 재시작하십시오.

## 플러그인 테스트

플러그인은 (및 권장합니다) 테스트를 제공해야 합니다:

- 리포 내 플러그인은 `src/**` 아래 Vitest 테스트를 유지할 수 있습니다 (예: `src/plugins/voice-call.plugin.test.ts`).
- 별도로 게시된 플러그인은 자체 CI (lint/build/test)를 실행하고 `openclaw.extensions`가 빌드된 엔트리 포인트 (`dist/index.js`)를 가리키는지를 검증해야 합니다.
