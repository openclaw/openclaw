---
summary: "OpenClaw 플러그인/확장: 발견, 구성 및 안전"
read_when:
  - 플러그인/확장을 추가하거나 수정할 때
  - 플러그인 설치 또는 로드 규칙 문서화할 때
title: "플러그인"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: tools/plugin.md
workflow: 15
---

# 플러그인(확장)

## 빠른 시작(플러그인이 새로우신가요?)

플러그인은 OpenClaw를 추가 기능(커맨드, 도구 및 Gateway RPC)으로 확장하는 작은 **코드 모듈**입니다.

대부분의 경우 아직 OpenClaw의 핵심에 내장되지 않은 기능을 원하거나 선택적 기능을 주요
설치에서 제외하려는 경우 플러그인을 사용합니다.

빠른 경로:

1. 이미 로드된 것 확인:

```bash
openclaw plugins list
```

2. 공식 플러그인 설치(예: Voice Call):

```bash
openclaw plugins install @openclaw/voice-call
```

npm 스펙은 **registry만**(패키지 이름 + 선택적 버전/태그). Git/URL/파일
스펙은 거부됩니다.

3. Gateway 다시 시작한 다음 `plugins.entries.<id>.config` 아래서 구성합니다.

구체적인 예제 플러그인은 [Voice Call](/plugins/voice-call)을 참고합니다.
타사 목록을 찾고 있으신가요? [커뮤니티 플러그인](/plugins/community)을 참고합니다.

## 사용 가능한 플러그인(공식)

- Microsoft Teams는 2026.1.15부터 플러그인만 해당; Teams를 사용하면 `@openclaw/msteams`을 설치하세요.
- Memory (Core) — 번들 메모리 검색 플러그인(기본적으로 `plugins.slots.memory`를 통해 활성화)
- Memory (LanceDB) — 번들 장기 메모리 플러그인(자동 회상/캡처; `plugins.slots.memory = "memory-lancedb"` 설정)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (제공자 인증) — `google-antigravity-auth`로 번들(기본적으로 비활성화)
- Gemini CLI OAuth (제공자 인증) — `google-gemini-cli-auth`로 번들(기본적으로 비활성화)
- Qwen OAuth (제공자 인증) — `qwen-portal-auth`로 번들(기본적으로 비활성화)
- Copilot Proxy (제공자 인증) — 로컬 VS Code Copilot Proxy 브릿지; 내장 `github-copilot` 디바이스 로그인과 별개(번들, 기본적으로 비활성화)

OpenClaw 플러그인은 **TypeScript 모듈**로서 jiti를 통해 런타임에 로드됩니다. **구성 검증은 플러그인 코드를 실행하지 않습니다**; 플러그인 manifest 및 JSON
Schema를 대신 사용합니다. [플러그인 manifest](/plugins/manifest)를 참고합니다.

플러그인은 다음을 등록할 수 있습니다:

- Gateway RPC 메서드
- Gateway HTTP 핸들러
- 에이전트 도구
- CLI 커맨드
- 백그라운드 서비스
- 선택적 구성 검증
- **Skills**(플러그인 manifest에서 `skills` 디렉터리 나열)
- **자동 회신 커맨드**(AI 에이전트 호출 없이 실행)

플러그인은 Gateway와 **in-process**에서 실행되므로 신뢰하는 코드로 취급하세요.
도구 작성 가이드: [플러그인 에이전트 도구](/plugins/agent-tools).

## 런타임 헬퍼

플러그인은 `api.runtime`을 통해 선택된 핵심 헬퍼에 액세스할 수 있습니다. 전화 TTS:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

참고:

- 핵심 `messages.tts` 구성(OpenAI 또는 ElevenLabs)을 사용합니다.
- PCM 오디오 버퍼 + 샘플 속도를 반환합니다. 플러그인은 제공자를 위해 재샘플링/인코딩해야 합니다.
- Edge TTS는 전화용으로 지원되지 않습니다.

## 발견 및 우선순위

OpenClaw는 순서대로 스캔합니다:

1. 구성 경로

- `plugins.load.paths`(파일 또는 디렉터리)

2. 작업 공간 확장

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. 전역 확장

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. 번들 확장(OpenClaw와 함께 배송, **기본적으로 비활성화**)

- `<openclaw>/extensions/*`

번들 플러그인은 `plugins.entries.<id>.enabled`
또는 `openclaw plugins enable <id>`를 통해 명시적으로 활성화되어야 합니다. 설치된 플러그인은 기본적으로 활성화되지만
같은 방식으로 비활성화될 수 있습니다.

경화 참고:

- `plugins.allow`이 비어있고 번들이 아닌 플러그인이 검색 가능하면 OpenClaw는 시작 경고를 플러그인 ID 및 소스와 함께 로깅합니다.
- 후보 경로는 발견 승인 전에 안전 확인됩니다. OpenClaw는 다음 경우 후보를 차단합니다:
  - 확장 항목이 플러그인 루트 외부에서 해결(symlink/경로 트래버설 탈출 포함),
  - 플러그인 루트/소스 경로는 세계 쓰기 가능,
  - 번들이 아닌 플러그인의 경로 소유권은 의심스러움(POSIX 소유자는 현재 uid도 root도 아님).
- 설치/로드 경로 출처 없이 로드된 번들이 아닌 플러그인은 신뢰를 고정할 수 있도록 경고를 내보냅니다(`plugins.allow`) 또는 설치 추적(`plugins.installs`).

각 플러그인은 루트에 `openclaw.plugin.json` 파일을 포함해야 합니다. 경로가
파일을 가리키면 플러그인 루트는 파일의 디렉터리이며 manifest를 포함해야 합니다.

여러 플러그인이 동일한 ID로 해결되면 위의 순서에서 첫 일치가 승리하고 낮은 우선순위 사본은 무시됩니다.

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

- `enabled`: 주 전환(기본값: true)
- `allow`: 허용 목록(선택 사항)
- `deny`: 거부 목록(선택 사항; deny 승리)
- `load.paths`: 추가 플러그인 파일/디렉터리
- `entries.<id>`: 플러그인별 전환 + 구성

구성 변경은 **Gateway 다시 시작**이 필요합니다.

검증 규칙(엄격):

- `entries`, `allow`, `deny` 또는 `slots`의 알 수 없는 플러그인 ID는 **오류**입니다.
- 플러그인 manifest가 채널 ID를 선언하지 않는 한 알 수 없는 `channels.<id>` 키는 **오류**입니다.
- 플러그인 구성은 `openclaw.plugin.json`에 포함된 JSON Schema(`configSchema`)를 사용하여 검증됩니다.
- 플러그인이 비활성화되면 구성이 유지되고 **경고**가 내보내집니다.

## 플러그인 슬롯(배타적 범주)

일부 플러그인 범주는 **배타적**(한 번에 하나만 활성화). `plugins.slots`를 사용하여 플러그인이 슬롯을 소유하도록 선택합니다:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // 또는 "none"을 비활성화하려면 memory 플러그인
    },
  },
}
```

여러 플러그인이 `kind: "memory"`를 선언하면 선택된 것만 로드합니다. 다른 것들은
진단과 함께 비활성화됩니다.

## Control UI(스키마 + 레이블)

Control UI는 `config.schema`(JSON Schema + `uiHints`)를 사용하여 더 나은 형식을 렌더링합니다.

OpenClaw는 런타임에 발견된 플러그인을 기반으로 `uiHints`를 확대합니다:

- `plugins.entries.<id>` / `.enabled` / `.config`용 플러그인별 레이블 추가
- `plugins.entries.<id>.config.<field>` 아래에서 선택적 플러그인 제공 구성 필드 힌트를 병합합니다

플러그인 구성 필드가 좋은 레이블/플레이스홀더(및 비밀로 표시 민감함)를 표시하도록 하려면
플러그인 manifest에서 `uiHints`를 JSON Schema와 함께 제공합니다.

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
openclaw plugins install <path>                 # 로컬 파일/디렉터리를 ~/.openclaw/extensions/<id>로 복사
openclaw plugins install ./extensions/voice-call # 상대 경로 확인
openclaw plugins install ./plugin.tgz           # 로컬 tarball에서 설치
openclaw plugins install ./plugin.zip           # 로컬 zip에서 설치
openclaw plugins install -l ./extensions/voice-call # 링크(복사 없음) 개발용
openclaw plugins install @openclaw/voice-call # npm에서 설치
openclaw plugins install @openclaw/voice-call --pin # 정확한 해결 name@version 저장
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update`는 `plugins.installs` 아래 추적되는 npm 설치에만 작동합니다.
업데이트 사이에 저장된 무결성 메타데이터가 변경되면 OpenClaw는 경고하고 확인을 요청합니다(전역 `--yes`로 프롬프트 우회).

플러그인은 또한 자신의 최상위 커맨드를 등록할 수 있습니다(예: `openclaw voicecall`).

## 플러그인 API(개요)

플러그인은 다음 중 하나를 내보냅니다:

- 함수: `(api) => { ... }`
- 객체: `{ id, name, configSchema, register(api) { ... } }`

더 많은 정보는 공식 문서를 참고합니다.
