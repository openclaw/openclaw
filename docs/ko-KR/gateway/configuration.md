---
summary: "구성 개요: 일반적인 작업, 빠른 설정, 전체 레퍼런스 링크"
read_when:
  - OpenClaw 를 처음 설정할 때
  - 일반적인 구성 패턴을 찾을 때
  - 특정 구성 섹션으로 이동할 때
title: "구성"
---

# 구성

OpenClaw 는 `~/.openclaw/openclaw.json` 에서 선택적 <Tooltip tip="JSON5는 주석과 후행 쉼표를 지원합니다">**JSON5**</Tooltip> 구성을 읽습니다.

파일이 없으면 OpenClaw 는 안전한 기본값을 사용합니다. 구성을 추가하는 일반적인 이유:

- 채널을 연결하고 봇에 메시지를 보낼 수 있는 사용자를 제어
- 모델, 도구, 샌드박스 또는 자동화(cron, 훅) 설정
- 세션, 미디어, 네트워킹 또는 UI 조정

모든 사용 가능한 필드는 [전체 레퍼런스](/ko-KR/gateway/configuration-reference)를 참조하세요.

<Tip>
**구성이 처음이신가요?** 대화형 설정을 위해 `openclaw onboard` 로 시작하거나, 복사하여 붙여넣기 가능한 완전한 구성은 [구성 예제](/ko-KR/gateway/configuration-examples) 가이드를 확인하세요.
</Tip>

## 최소 구성

```json5
// ~/.openclaw/openclaw.json
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

## 구성 편집

<Tabs>
  <Tab title="대화형 마법사">
    ```bash
    openclaw onboard       # full setup wizard
    openclaw configure     # config wizard
    ```
  </Tab>
  <Tab title="CLI (한 줄 명령)">
    ```bash
    openclaw config get agents.defaults.workspace
    openclaw config set agents.defaults.heartbeat.every "2h"
    openclaw config unset tools.web.search.apiKey
    ```
  </Tab>
  <Tab title="Control UI">
    [http://127.0.0.1:18789](http://127.0.0.1:18789) 를 열고 **Config** 탭을 사용하세요.
    Control UI 는 구성 스키마에서 폼을 렌더링하며, **Raw JSON** 편집기를 보조 수단으로 제공합니다.
  </Tab>
  <Tab title="직접 편집">
    `~/.openclaw/openclaw.json` 을 직접 편집하세요. 게이트웨이가 파일을 감시하고 변경 사항을 자동으로 적용합니다([핫 리로드](#config-hot-reload) 참조).
  </Tab>
</Tabs>

## 엄격한 유효성 검사

<Warning>
OpenClaw 는 스키마와 완전히 일치하는 구성만 허용합니다. 알 수 없는 키, 잘못된 타입 또는 유효하지 않은 값은 게이트웨이가 **시작을 거부**하게 합니다. 유일한 루트 수준 예외는 `$schema` (문자열)이며, 편집기가 JSON Schema 메타데이터를 첨부할 수 있도록 합니다.
</Warning>

유효성 검사가 실패하면:

- 게이트웨이가 부팅되지 않음
- 진단 명령만 작동 (`openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`)
- `openclaw doctor` 를 실행하여 정확한 문제를 확인
- `openclaw doctor --fix` (또는 `--yes`)를 실행하여 수리 적용

## 일반적인 작업

<AccordionGroup>
  <Accordion title="채널 설정 (WhatsApp, Telegram, Discord 등)">
    각 채널에는 `channels.<provider>` 아래에 고유한 구성 섹션이 있습니다. 설정 단계는 해당 채널 페이지를 참조하세요:

    - [WhatsApp](/ko-KR/channels/whatsapp) — `channels.whatsapp`
    - [Telegram](/ko-KR/channels/telegram) — `channels.telegram`
    - [Discord](/ko-KR/channels/discord) — `channels.discord`
    - [Slack](/ko-KR/channels/slack) — `channels.slack`
    - [Signal](/ko-KR/channels/signal) — `channels.signal`
    - [iMessage](/ko-KR/channels/imessage) — `channels.imessage`
    - [Google Chat](/ko-KR/channels/googlechat) — `channels.googlechat`
    - [Mattermost](/ko-KR/channels/mattermost) — `channels.mattermost`
    - [MS Teams](/ko-KR/channels/msteams) — `channels.msteams`

    모든 채널은 동일한 DM 정책 패턴을 공유합니다:

    ```json5
    {
      channels: {
        telegram: {
          enabled: true,
          botToken: "123:abc",
          dmPolicy: "pairing",   // pairing | allowlist | open | disabled
          allowFrom: ["tg:123"], // only for allowlist/open
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="모델 선택 및 구성">
    기본 모델과 선택적 대체 모델을 설정합니다:

    ```json5
    {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-5",
            fallbacks: ["openai/gpt-5.2"],
          },
          models: {
            "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
            "openai/gpt-5.2": { alias: "GPT" },
          },
        },
      },
    }
    ```

    - `agents.defaults.models` 는 모델 카탈로그를 정의하며 `/model` 의 허용 목록으로 작동합니다.
    - 모델 참조는 `provider/model` 형식을 사용합니다 (예: `anthropic/claude-opus-4-6`).
    - `agents.defaults.imageMaxDimensionPx` 는 전사본/도구 이미지 다운스케일링을 제어합니다 (기본값 `1200`); 낮은 값은 일반적으로 스크린샷이 많은 실행에서 비전 토큰 사용량을 줄입니다.
    - 채팅에서 모델 전환은 [Models CLI](/ko-KR/concepts/models)를, 인증 로테이션 및 대체 동작은 [Model Failover](/ko-KR/concepts/model-failover)를 참조하세요.
    - 커스텀/자체 호스팅 프로바이더는 레퍼런스의 [Custom providers](/ko-KR/gateway/configuration-reference#custom-providers-and-base-urls)를 참조하세요.

  </Accordion>

  <Accordion title="봇에 메시지를 보낼 수 있는 사용자 제어">
    DM 접근은 채널별로 `dmPolicy` 를 통해 제어됩니다:

    - `"pairing"` (기본값): 알 수 없는 발신자에게 승인을 위한 일회성 페어링 코드 제공
    - `"allowlist"`: `allowFrom` (또는 페어링된 허용 저장소)에 있는 발신자만 허용
    - `"open"`: 모든 수신 DM 허용 (`allowFrom: ["*"]` 필요)
    - `"disabled"`: 모든 DM 무시

    그룹의 경우 `groupPolicy` + `groupAllowFrom` 또는 채널별 허용 목록을 사용합니다.

    채널별 세부 사항은 [전체 레퍼런스](/ko-KR/gateway/configuration-reference#dm-and-group-access)를 참조하세요.

  </Accordion>

  <Accordion title="그룹 채팅 멘션 게이팅 설정">
    그룹 메시지는 기본적으로 **멘션 필수**입니다. 에이전트별 패턴을 구성합니다:

    ```json5
    {
      agents: {
        list: [
          {
            id: "main",
            groupChat: {
              mentionPatterns: ["@openclaw", "openclaw"],
            },
          },
        ],
      },
      channels: {
        whatsapp: {
          groups: { "*": { requireMention: true } },
        },
      },
    }
    ```

    - **메타데이터 멘션**: 네이티브 @-멘션 (WhatsApp 탭하여 멘션, Telegram @bot 등)
    - **텍스트 패턴**: `mentionPatterns` 의 정규식 패턴
    - 채널별 오버라이드 및 셀프 채팅 모드는 [전체 레퍼런스](/ko-KR/gateway/configuration-reference#group-chat-mention-gating)를 참조하세요.

  </Accordion>

  <Accordion title="세션 및 초기화 구성">
    세션은 대화 연속성과 격리를 제어합니다:

    ```json5
    {
      session: {
        dmScope: "per-channel-peer",  // recommended for multi-user
        threadBindings: {
          enabled: true,
          ttlHours: 24,
        },
        reset: {
          mode: "daily",
          atHour: 4,
          idleMinutes: 120,
        },
      },
    }
    ```

    - `dmScope`: `main` (공유) | `per-peer` | `per-channel-peer` | `per-account-channel-peer`
    - `threadBindings`: 스레드 바인딩 세션 라우팅의 글로벌 기본값 (Discord는 `/focus`, `/unfocus`, `/agents`, `/session ttl` 지원).
    - 범위 지정, ID 링크 및 전송 정책은 [Session Management](/ko-KR/concepts/session)를 참조하세요.
    - 모든 필드는 [전체 레퍼런스](/ko-KR/gateway/configuration-reference#session)를 참조하세요.

  </Accordion>

  <Accordion title="샌드박스 활성화">
    에이전트 세션을 격리된 Docker 컨테이너에서 실행합니다:

    ```json5
    {
      agents: {
        defaults: {
          sandbox: {
            mode: "non-main",  // off | non-main | all
            scope: "agent",    // session | agent | shared
          },
        },
      },
    }
    ```

    먼저 이미지를 빌드하세요: `scripts/sandbox-setup.sh`

    전체 가이드는 [Sandboxing](/ko-KR/gateway/sandboxing)을, 모든 옵션은 [전체 레퍼런스](/ko-KR/gateway/configuration-reference#sandbox)를 참조하세요.

  </Accordion>

  <Accordion title="하트비트 설정 (주기적 체크인)">
    ```json5
    {
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            target: "last",
          },
        },
      },
    }
    ```

    - `every`: 기간 문자열 (`30m`, `2h`). 비활성화하려면 `0m` 으로 설정.
    - `target`: `last` | `whatsapp` | `telegram` | `discord` | `none`
    - 전체 가이드는 [Heartbeat](/ko-KR/gateway/heartbeat)를 참조하세요.

  </Accordion>

  <Accordion title="cron 작업 구성">
    ```json5
    {
      cron: {
        enabled: true,
        maxConcurrentRuns: 2,
        sessionRetention: "24h",
      },
    }
    ```

    기능 개요 및 CLI 예제는 [Cron jobs](/ko-KR/automation/cron-jobs)를 참조하세요.

  </Accordion>

  <Accordion title="웹훅 (훅) 설정">
    게이트웨이에서 HTTP 웹훅 엔드포인트를 활성화합니다:

    ```json5
    {
      hooks: {
        enabled: true,
        token: "shared-secret",
        path: "/hooks",
        defaultSessionKey: "hook:ingress",
        allowRequestSessionKey: false,
        allowedSessionKeyPrefixes: ["hook:"],
        mappings: [
          {
            match: { path: "gmail" },
            action: "agent",
            agentId: "main",
            deliver: true,
          },
        ],
      },
    }
    ```

    모든 매핑 옵션 및 Gmail 통합은 [전체 레퍼런스](/ko-KR/gateway/configuration-reference#hooks)를 참조하세요.

  </Accordion>

  <Accordion title="멀티 에이전트 라우팅 구성">
    별도의 워크스페이스와 세션으로 여러 격리된 에이전트를 실행합니다:

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
    }
    ```

    바인딩 규칙 및 에이전트별 접근 프로필은 [Multi-Agent](/ko-KR/concepts/multi-agent) 및 [전체 레퍼런스](/ko-KR/gateway/configuration-reference#multi-agent-routing)를 참조하세요.

  </Accordion>

  <Accordion title="구성을 여러 파일로 분할 ($include)">
    대규모 구성을 정리하려면 `$include` 를 사용하세요:

    ```json5
    // ~/.openclaw/openclaw.json
    {
      gateway: { port: 18789 },
      agents: { $include: "./agents.json5" },
      broadcast: {
        $include: ["./clients/a.json5", "./clients/b.json5"],
      },
    }
    ```

    - **단일 파일**: 포함하는 객체를 대체
    - **파일 배열**: 순서대로 딥 머지 (나중 것이 우선)
    - **형제 키**: include 이후에 병합 (포함된 값을 오버라이드)
    - **중첩 include**: 최대 10단계 깊이까지 지원
    - **상대 경로**: 포함하는 파일 기준으로 해석
    - **오류 처리**: 누락된 파일, 파싱 오류, 순환 include 에 대한 명확한 오류

  </Accordion>
</AccordionGroup>

## 구성 핫 리로드

게이트웨이는 `~/.openclaw/openclaw.json` 을 감시하고 변경 사항을 자동으로 적용합니다 — 대부분의 설정에서 수동 재시작이 필요하지 않습니다.

### 리로드 모드

| 모드                  | 동작                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------- |
| **`hybrid`** (기본값) | 안전한 변경을 즉시 핫 적용합니다. 중요한 변경은 자동으로 재시작합니다.                    |
| **`hot`**             | 안전한 변경만 핫 적용합니다. 재시작이 필요할 때 경고를 기록합니다 — 직접 처리해야 합니다. |
| **`restart`**         | 안전 여부와 관계없이 모든 구성 변경 시 게이트웨이를 재시작합니다.                         |
| **`off`**             | 파일 감시를 비활성화합니다. 변경 사항은 다음 수동 재시작 시 적용됩니다.                   |

```json5
{
  gateway: {
    reload: { mode: "hybrid", debounceMs: 300 },
  },
}
```

### 핫 적용 vs 재시작 필요

대부분의 필드는 다운타임 없이 핫 적용됩니다. `hybrid` 모드에서는 재시작이 필요한 변경이 자동으로 처리됩니다.

| 카테고리        | 필드                                                    | 재시작 필요? |
| --------------- | ------------------------------------------------------- | ------------ |
| 채널            | `channels.*`, `web` (WhatsApp) — 모든 내장 및 확장 채널 | 아니오       |
| 에이전트 & 모델 | `agent`, `agents`, `models`, `routing`                  | 아니오       |
| 자동화          | `hooks`, `cron`, `agent.heartbeat`                      | 아니오       |
| 세션 & 메시지   | `session`, `messages`                                   | 아니오       |
| 도구 & 미디어   | `tools`, `browser`, `skills`, `audio`, `talk`           | 아니오       |
| UI & 기타       | `ui`, `logging`, `identity`, `bindings`                 | 아니오       |
| 게이트웨이 서버 | `gateway.*` (port, bind, auth, tailscale, TLS, HTTP)    | **예**       |
| 인프라          | `discovery`, `canvasHost`, `plugins`                    | **예**       |

<Note>
`gateway.reload` 와 `gateway.remote` 는 예외입니다 — 이들을 변경해도 재시작이 트리거되지 **않습니다**.
</Note>

## 구성 RPC (프로그래밍 방식 업데이트)

<Note>
제어 플레인 쓰기 RPC (`config.apply`, `config.patch`, `update.run`)는 `deviceId+clientIp`당 **60초에 3개 요청**으로 속도 제한됩니다. 제한이 걸리면 RPC가 `retryAfterMs`와 함께 `UNAVAILABLE`을 반환합니다.
</Note>

<AccordionGroup>
  <Accordion title="config.apply (전체 교체)">
    전체 구성을 검증 + 작성하고 게이트웨이를 한 번에 재시작합니다.

    <Warning>
    `config.apply` 는 **전체 구성**을 교체합니다. 부분 업데이트는 `config.patch` 를, 단일 키는 `openclaw config set` 을 사용하세요.
    </Warning>

    매개변수:

    - `raw` (문자열) — 전체 구성을 위한 JSON5 페이로드
    - `baseHash` (선택 사항) — `config.get` 에서 가져온 구성 해시 (구성이 존재할 때 필수)
    - `sessionKey` (선택 사항) — 재시작 후 웨이크업 핑을 위한 세션 키
    - `note` (선택 사항) — 재시작 센티널을 위한 메모
    - `restartDelayMs` (선택 사항) — 재시작 전 지연 (기본값 2000)

    재시작 요청은 하나가 이미 대기/진행 중일 때 통합되며, 재시작 사이클 사이에 30초의 쿨다운이 적용됩니다.

    ```bash
    openclaw gateway call config.get --params '{}'  # capture payload.hash
    openclaw gateway call config.apply --params '{
      "raw": "{ agents: { defaults: { workspace: \"~/.openclaw/workspace\" } } }",
      "baseHash": "<hash>",
      "sessionKey": "agent:main:whatsapp:dm:+15555550123"
    }'
    ```

  </Accordion>

  <Accordion title="config.patch (부분 업데이트)">
    기존 구성에 부분 업데이트를 병합합니다 (JSON 머지 패치 시맨틱):

    - 객체는 재귀적으로 병합
    - `null` 은 키를 삭제
    - 배열은 교체

    매개변수:

    - `raw` (문자열) — 변경할 키만 포함된 JSON5
    - `baseHash` (필수) — `config.get` 에서 가져온 구성 해시
    - `sessionKey`, `note`, `restartDelayMs` — `config.apply` 와 동일

    재시작 동작은 `config.apply`와 동일합니다: 대기 중인 재시작이 통합되며 재시작 사이클 사이에 30초의 쿨다운이 적용됩니다.

    ```bash
    openclaw gateway call config.patch --params '{
      "raw": "{ channels: { telegram: { groups: { \"*\": { requireMention: false } } } } }",
      "baseHash": "<hash>"
    }'
    ```

  </Accordion>
</AccordionGroup>

## 환경 변수

OpenClaw 는 부모 프로세스의 환경 변수와 함께 다음을 읽습니다:

- 현재 작업 디렉토리의 `.env` (있는 경우)
- `~/.openclaw/.env` (전역 대체)

어느 파일도 기존 환경 변수를 오버라이드하지 않습니다. 구성에서 인라인 환경 변수를 설정할 수도 있습니다:

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

<Accordion title="셸 환경 가져오기 (선택 사항)">
  활성화되어 있고 예상 키가 설정되지 않은 경우, OpenClaw 는 로그인 셸을 실행하고 누락된 키만 가져옵니다:

```json5
{
  env: {
    shellEnv: { enabled: true, timeoutMs: 15000 },
  },
}
```

환경 변수 동등 항목: `OPENCLAW_LOAD_SHELL_ENV=1`
</Accordion>

<Accordion title="구성 값에서 환경 변수 치환">
  `${VAR_NAME}` 으로 모든 구성 문자열 값에서 환경 변수를 참조할 수 있습니다:

```json5
{
  gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
  models: { providers: { custom: { apiKey: "${CUSTOM_API_KEY}" } } },
}
```

규칙:

- 대문자 이름만 매칭: `[A-Z_][A-Z0-9_]*`
- 누락되거나 비어있는 변수는 로드 시 오류 발생
- 리터럴 출력을 위해 `$${VAR}` 로 이스케이프
- `$include` 파일 내에서도 작동
- 인라인 치환: `"${BASE}/v1"` → `"https://api.example.com/v1"`

</Accordion>

전체 우선순위 및 소스는 [환경](/ko-KR/help/environment)을 참조하세요.

## 전체 레퍼런스

필드별 전체 레퍼런스는 **[구성 레퍼런스](/ko-KR/gateway/configuration-reference)**를 참조하세요.

---

_관련: [구성 예제](/ko-KR/gateway/configuration-examples) · [구성 레퍼런스](/ko-KR/gateway/configuration-reference) · [Doctor](/ko-KR/gateway/doctor)_
