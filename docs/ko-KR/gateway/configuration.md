---
summary: "Configuration overview: common tasks, quick setup, and links to the full reference"
read_when:
  - Setting up OpenClaw for the first time
  - Looking for common configuration patterns
  - Navigating to specific config sections
title: "Configuration"
x-i18n:
  source_hash: ab8095237dd430038cd6639d6beb2a084131a7eb397ff737246bbb7fdf4613cf
---

# 구성

OpenClaw는 `~/.openclaw/openclaw.json`에서 선택적 <Tooltip tip="JSON5 supports comments and trailing commas">**JSON5**</Tooltip> 구성을 읽습니다.

파일이 누락된 경우 OpenClaw는 안전한 기본값을 사용합니다. 구성을 추가하는 일반적인 이유:

- 채널을 연결하고 봇에게 메시지를 보낼 수 있는 사람을 제어하세요.
- 모델, 도구, 샌드박스 또는 자동화(크론, 후크) 설정
- 세션, 미디어, 네트워킹 또는 UI 조정

사용 가능한 모든 필드에 대해서는 [전체 참조](/gateway/configuration-reference)를 확인하세요.

<Tip>
**구성이 처음이신가요?** 대화형 설정을 위해 `openclaw onboard`로 시작하거나 전체 복사-붙여넣기 구성을 보려면 [구성 예](/gateway/configuration-examples) 가이드를 확인하세요.
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
  <Tab title="Interactive wizard">
    ```bash
    openclaw onboard       # full setup wizard
    openclaw configure     # config wizard
    ```
  </Tab>
  <Tab title="CLI (one-liners)">
    ```bash
    openclaw config get agents.defaults.workspace
    openclaw config set agents.defaults.heartbeat.every "2h"
    openclaw config unset tools.web.search.apiKey
    ```
  </Tab>
  <Tab title="Control UI">
    [http://127.0.0.1:18789](http://127.0.0.1:18789)를 열고 **구성** 탭을 사용합니다.
    Control UI는 탈출구로 **Raw JSON** 편집기를 사용하여 구성 스키마의 양식을 렌더링합니다.
  </Tab>
  <Tab title="Direct edit">
    `~/.openclaw/openclaw.json`를 직접 편집하세요. 게이트웨이는 파일을 감시하고 변경 사항을 자동으로 적용합니다([핫 리로드](#config-hot-reload) 참조).
  </Tab>
</Tabs>

## 엄격한 검증

<Warning>
OpenClaw는 스키마와 완전히 일치하는 구성만 허용합니다. 알 수 없는 키, 잘못된 유형 또는 잘못된 값으로 인해 게이트웨이가 **시작을 거부**합니다.
</Warning>

검증이 실패하는 경우:

- 게이트웨이가 부팅되지 않습니다.
- 진단 명령만 작동합니다. (`openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`)
- 정확한 문제를 확인하려면 `openclaw doctor`를 실행하세요.
- `openclaw doctor --fix`(또는 `--yes`)를 실행하여 수리를 적용합니다.

## 일반적인 작업

<AccordionGroup>
  <Accordion title="Set up a channel (WhatsApp, Telegram, Discord, etc.)">
    각 채널에는 `channels.<provider>` 아래에 자체 구성 섹션이 있습니다. 설정 단계는 전용 채널 페이지를 참조하세요.

    - [WhatsApp](/channels/whatsapp) — `channels.whatsapp`
    - [텔레그램](/channels/telegram) — `channels.telegram`
    - [불화](/channels/discord) — `channels.discord`
    - [슬랙](/channels/slack) — `channels.slack`
    - [신호](/channels/signal) — `channels.signal`
    - [iMessage](/channels/imessage) — `channels.imessage`
    - [구글 채팅](/channels/googlechat) — `channels.googlechat`
    - [가장 중요한](/channels/mattermost) — `channels.mattermost`
    - [MS 팀](/channels/msteams) — `channels.msteams`

    모든 채널은 동일한 DM 정책 패턴을 공유합니다.

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

  <Accordion title="Choose and configure models">
    기본 모델과 선택적 대체를 설정합니다.

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

    - `agents.defaults.models`는 모델 카탈로그를 정의하고 `/model`에 대한 허용 목록 역할을 합니다.
    - 모델 참조는 `provider/model` 형식(예: `anthropic/claude-opus-4-6`)을 사용합니다.
    - 채팅에서 모델을 전환하려면 [모델 CLI](/concepts/models)를, 인증 순환 및 대체 동작은 [모델 장애 조치](/concepts/model-failover)를 참조하세요.
    - 사용자 정의/자체 호스팅 공급자에 대해서는 참조의 [사용자 정의 공급자](/gateway/configuration-reference#custom-providers-and-base-urls)를 참조하세요.

  </Accordion>

  <Accordion title="Control who can message the bot">
    DM 액세스는 `dmPolicy`를 통해 채널별로 제어됩니다.

    - `"pairing"` (기본값): 알 수 없는 발신자가 승인을 위해 일회성 페어링 코드를 받습니다.
    - `"allowlist"`: `allowFrom` (또는 페어링된 허용 저장소)의 발신자만
    - `"open"`: 모든 인바운드 DM 허용(`allowFrom: ["*"]` 필요)
    - `"disabled"`: 모든 DM을 무시합니다.

    그룹의 경우 `groupPolicy` + `groupAllowFrom` 또는 채널별 허용 목록을 사용하세요.

    채널별 자세한 내용은 [전체 참조](/gateway/configuration-reference#dm-and-group-access)를 참조하세요.

  </Accordion>

  <Accordion title="Set up group chat mention gating">
    그룹 메시지는 기본적으로 **멘션 필요**로 설정되어 있습니다. 에이전트별로 패턴을 구성합니다.

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

    - **메타데이터 멘션**: 기본 @멘션(WhatsApp 탭하여 멘션, Telegram @bot 등)
    - **텍스트 패턴**: `mentionPatterns`의 정규식 패턴
    - 채널별 재정의 및 셀프 채팅 모드에 대해서는 [전체 참조](/gateway/configuration-reference#group-chat-mention-gating)를 참조하세요.

  </Accordion>

  <Accordion title="Configure sessions and resets">
    세션은 대화 연속성과 격리를 제어합니다.

    ```json5
    {
      session: {
        dmScope: "per-channel-peer",  // recommended for multi-user
        reset: {
          mode: "daily",
          atHour: 4,
          idleMinutes: 120,
        },
      },
    }
    ```

    - `dmScope`: `main` (공유) | `per-peer` | `per-channel-peer` | `per-account-channel-peer`
    - 범위 지정, ID 링크 및 전송 정책은 [세션 관리](/concepts/session)를 참조하세요.
    - 모든 필드에 대해서는 [전체 참조](/gateway/configuration-reference#session)를 참조하세요.

  </Accordion>

  <Accordion title="Enable sandboxing">
    격리된 Docker 컨테이너에서 에이전트 세션을 실행합니다.

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

    전체 가이드는 [샌드박싱](/gateway/sandboxing)을, 모든 옵션은 [전체 참조](/gateway/configuration-reference#sandbox)를 참조하세요.

  </Accordion>

  <Accordion title="Set up heartbeat (periodic check-ins)">
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

    - `every`: 기간 문자열(`30m`, `2h`). 비활성화하려면 `0m`를 설정하세요.
    - `target`: `last` | `whatsapp` | `telegram` | `discord` | `none`
    - 전체 가이드는 [하트비트](/gateway/heartbeat)를 참조하세요.

  </Accordion>

  <Accordion title="Configure cron jobs">
    ```json5
    {
      cron: {
        enabled: true,
        maxConcurrentRuns: 2,
        sessionRetention: "24h",
      },
    }
    ```

    기능 개요 및 CLI 예시는 [Cron 작업](/automation/cron-jobs)을 참조하세요.

  </Accordion>

  <Accordion title="Set up webhooks (hooks)">
    게이트웨이에서 HTTP 웹훅 엔드포인트를 활성화합니다.

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

    모든 매핑 옵션 및 Gmail 통합은 [전체 참조](/gateway/configuration-reference#hooks)를 참조하세요.

  </Accordion>

  <Accordion title="Configure multi-agent routing">
    별도의 작업 영역 및 세션을 사용하여 격리된 여러 에이전트를 실행합니다.

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

    바인딩 규칙 및 에이전트별 액세스 프로필은 [다중 에이전트](/concepts/multi-agent) 및 [전체 참조](/gateway/configuration-reference#multi-agent-routing)를 참조하세요.

  </Accordion>

  <Accordion title="Split config into multiple files ($include)">
    대규모 구성을 구성하려면 `$include`를 사용하세요.

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

    - **단일 파일**: 포함 개체를 대체합니다.
    - **파일 배열**: 순서대로 심층 병합(나중에 승리)
    - **동위 키**: 포함 후 병합됨(포함된 값 재정의)
    - **중첩 포함**: 최대 10레벨까지 지원
    - **상대 경로**: 포함 파일을 기준으로 확인됩니다.
    - **오류 처리**: 누락된 파일, 구문 분석 오류 및 순환 포함에 대한 오류 지우기

  </Accordion>
</AccordionGroup>

## 핫 리로드 구성

게이트웨이는 `~/.openclaw/openclaw.json`을 감시하고 자동으로 변경 사항을 적용합니다. 대부분의 설정에서는 수동으로 다시 시작할 필요가 없습니다.

### 새로고침 모드

| 모드                  | 행동                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| **`hybrid`** (기본값) | 안전한 변경 사항을 즉시 핫 적용합니다. 중요한 항목의 경우 자동으로 다시 시작됩니다.              |
| **`hot`**             | 핫 적용 안전 변경 사항만 적용됩니다. 다시 시작해야 할 때 경고를 기록합니다. 사용자가 처리합니다. |
| **`restart`**         | 안전 여부에 관계없이 구성 변경 시 게이트웨이를 다시 시작합니다.                                  |
| **`off`**             | 파일 감시를 비활성화합니다. 변경 사항은 다음에 수동으로 다시 시작할 때 적용됩니다.               |

```json5
{
  gateway: {
    reload: { mode: "hybrid", debounceMs: 300 },
  },
}
```

### 긴급 적용 대상과 재시작이 필요한 대상

대부분의 필드는 가동 중지 시간 없이 핫 적용됩니다. `hybrid` 모드에서는 재시작이 필요한 변경 사항이 자동으로 처리됩니다.

| 카테고리         | 필드                                                    | 다시 시작해야 합니까? |
| ---------------- | ------------------------------------------------------- | --------------------- |
| 채널             | `channels.*`, `web` (WhatsApp) — 모든 내장 및 확장 채널 | 아니요                |
| 에이전트 및 모델 | `agent`, `agents`, `models`, `routing`                  | 아니요                |
| 자동화           | `hooks`, `cron`, `agent.heartbeat`                      | 아니요                |
| 세션 및 메시지   | `session`, `messages`                                   | 아니요                |
| 도구 및 미디어   | `tools`, `browser`, `skills`, `audio`, `talk`           | 아니요                |
| UI 및 기타       | `ui`, `logging`, `identity`, `bindings`                 | 아니요                |
| 게이트웨이 서버  | `gateway.*` (포트, 바인딩, 인증, tailscale, TLS, HTTP)  | **예**                |
| 인프라           | `discovery`, `canvasHost`, `plugins`                    | **예**                |

<Note>
`gateway.reload` 및 `gateway.remote`는 예외입니다. 이를 변경해도 재시작이 트리거되지 **않습니다**.
</Note>

## 구성 RPC(프로그래밍 방식 업데이트)

<AccordionGroup>
  <Accordion title="config.apply (full replace)">
    유효성을 검사하고 전체 구성을 작성하고 한 단계로 게이트웨이를 다시 시작합니다.

    <Warning>
    `config.apply`는 **전체 구성**을 대체합니다. 부분 업데이트의 경우 `config.patch`를 사용하고 단일 키의 경우 `openclaw config set`를 사용합니다.
    </Warning>

    매개변수:

    - `raw` (문자열) — 전체 구성에 대한 JSON5 페이로드
    - `baseHash` (선택 사항) — `config.get`의 구성 해시(구성이 존재할 때 필요)
    - `sessionKey` (선택 사항) — 재시작 후 웨이크업 핑을 위한 세션 키
    - `note` (선택 사항) — 센티널 재시작을 위한 참고 사항
    - `restartDelayMs` (선택 사항) — 다시 시작하기 전 지연(기본값 2000)

    ```bash
    openclaw gateway call config.get --params '{}'  # capture payload.hash
    openclaw gateway call config.apply --params '{
      "raw": "{ agents: { defaults: { workspace: \"~/.openclaw/workspace\" } } }",
      "baseHash": "<hash>",
      "sessionKey": "agent:main:whatsapp:dm:+15555550123"
    }'
    ```

  </Accordion>

<Accordion title="config.patch (partial update)">
    부분 업데이트를 기존 구성에 병합합니다(JSON 병합 패치 의미 체계).

    - 객체가 재귀적으로 병합됩니다.
    - `null` 키를 삭제합니다.
    - 어레이 교체

    매개변수:

    - `raw` (문자열) — 변경할 키만 포함된 JSON5
    - `baseHash` (필수) — `config.get`의 구성 해시
    - `sessionKey`, `note`, `restartDelayMs` — `config.apply`와 동일

    ```bash
    openclaw gateway call config.patch --params '{
      "raw": "{ channels: { telegram: { groups: { \"*\": { requireMention: false } } } } }",
      "baseHash": "<hash>"
    }'
    ```

  </Accordion>
</AccordionGroup>

## 환경 변수

OpenClaw는 상위 프로세스에서 환경 변수와 다음을 읽습니다.

- 현재 작업 디렉터리의 `.env` (있는 경우)
- `~/.openclaw/.env` (전역 폴백)

두 파일 모두 기존 환경 변수를 재정의하지 않습니다. 구성에서 인라인 환경 변수를 설정할 수도 있습니다.

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

<Accordion title="Shell env import (optional)">
  활성화된 키와 예상 키가 설정되지 않은 경우 OpenClaw는 로그인 셸을 실행하고 누락된 키만 가져옵니다.

```json5
{
  env: {
    shellEnv: { enabled: true, timeoutMs: 15000 },
  },
}
```

Env var에 해당: `OPENCLAW_LOAD_SHELL_ENV=1`
</Accordion>

<Accordion title="Env var substitution in config values">
  `${VAR_NAME}`를 사용하여 모든 구성 문자열 값에서 환경 변수를 참조하세요.

```json5
{
  gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
  models: { providers: { custom: { apiKey: "${CUSTOM_API_KEY}" } } },
}
```

규칙:

    - 대문자만 일치: `[A-Z_][A-Z0-9_]*`
    - 누락되거나 비어 있는 변수는 로드 시 오류를 발생시킵니다.
    - 리터럴 출력의 경우 `$${VAR}`로 탈출합니다.
    - `$include` 파일 내에서 작동
    - 인라인 치환: `"${BASE}/v1"` → `"https://api.example.com/v1"`

</Accordion>

전체 우선순위와 소스는 [환경](/help/environment)을 참조하세요.

## 전체 참조

전체 필드별 참조는 **[구성 참조](/gateway/configuration-reference)**를 참조하세요.

---

_관련: [구성 예](/gateway/configuration-examples) · [구성 참조](/gateway/configuration-reference) · [닥터](/gateway/doctor)_
