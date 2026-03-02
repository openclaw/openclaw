---
summary: "구성 개요: 일반적인 작업, 빠른 설정 및 특정 구성 섹션으로의 링크"
read_when:
  - OpenClaw 를 처음으로 설정할 때
  - 일반적인 구성 패턴을 찾을 때
  - 특정 구성 섹션으로 이동할 때
title: "구성"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/configuration.md
  workflow: 15
---

# 구성

OpenClaw 는 `~/.openclaw/openclaw.json` 에서 선택적 <Tooltip tip="JSON5 는 주석과 후행 쉼표를 지원합니다">**JSON5**</Tooltip> 구성을 읽습니다.

파일이 없으면 OpenClaw 는 안전한 기본값을 사용합니다. 구성을 추가하는 일반적인 이유:

- 채널을 연결하고 봇에 메시지를 보낼 수 있는 사람을 제어합니다.
- 모델, 도구, 샌드박싱 또는 자동화 (cron, 훅) 를 설정합니다.
- 세션, 미디어, 네트워킹 또는 UI 를 조정합니다.

전체 참고는 [전체 참고](/gateway/configuration-reference) 를 참조하세요.

<Tip>
**구성이 처음입니까?** 대화식 설정을 위해 `openclaw onboard` 로 시작하거나 [구성 예제](/ko-KR/gateway/configuration-examples) 가이드에서 완전한 복사-붙여넣기 구성을 확인합니다.
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
    openclaw onboard       # 전체 설정 마법사
    openclaw configure     # 구성 마법사
    ```
  </Tab>
  <Tab title="CLI (한 줄)">
    ```bash
    openclaw config get agents.defaults.workspace
    openclaw config set agents.defaults.heartbeat.every "2h"
    openclaw config unset tools.web.search.apiKey
    ```
  </Tab>
  <Tab title="Control UI">
    [http://127.0.0.1:18789](http://127.0.0.1:18789) 를 열고 **Config** 탭을 사용합니다.
    Control UI 는 구성 스키마에서 양식을 렌더링하며 **Raw JSON** 편집기를 탈출 해치로 사용합니다.
  </Tab>
  <Tab title="직접 편집">
    `~/.openclaw/openclaw.json` 를 직접 편집합니다. Gateway 는 파일을 감시하고 변경 사항을 자동으로 적용합니다 ([핫 리로드](#config-hot-reload) 참조).
  </Tab>
</Tabs>

## 엄격한 검증

<Warning>
OpenClaw 는 스키마와 완전히 일치하는 구성만 수락합니다. 알려지지 않은 키, 잘못된 형식 또는 잘못된 값으로 인해 Gateway 는 **시작을 거부**합니다. 유일한 루트 레벨 예외는 `$schema` (문자열)이므로 편집기는 JSON Schema 메타데이터를 첨부할 수 있습니다.
</Warning>

검증이 실패하면:

- Gateway 가 부팅되지 않습니다.
- 진단 명령만 작동합니다 (`openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`).
- 정확한 문제를 보려면 `openclaw doctor` 를 실행합니다.
- 복구를 적용하려면 `openclaw doctor --fix` (또는 `--yes`) 를 실행합니다.

## 일반적인 작업

<AccordionGroup>
  <Accordion title="채널 설정 (WhatsApp, Telegram, Discord 등)">
    각 채널은 `channels.<provider>` 아래에 자신의 구성 섹션을 가집니다. 설정 단계는 전용 채널 페이지를 참조하세요:

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
          allowFrom: ["tg:123"], // allowlist/open 에만
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="모델 선택 및 구성">
    기본 모델과 선택적 대체 항목을 설정합니다:

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

    - `agents.defaults.models` 모델 카탈로그를 정의하고 `/model` 허용 목록으로 작동합니다.
    - 모델 참조는 `provider/model` 형식을 사용합니다 (예: `anthropic/claude-opus-4-6`).
    - `agents.defaults.imageMaxDimensionPx` 전사/도구 이미지 다운스케일링을 제어합니다 (기본값 `1200`); 낮은 값은 일반적으로 스크린샷이 많은 실행에서 비전 토큰 사용을 줄입니다.
    - 채팅에서 모델 전환은 [모델 CLI](/concepts/models) 를 참조하고 [모델 장애 조치](/concepts/model-failover) 인증 회전 및 대체 동작의 경우 참조합니다.
    - 사용자 정의/자체 호스팅 공급자의 경우 참고의 [사용자 정의 공급자 및 기본 URL](/gateway/configuration-reference#custom-providers-and-base-urls) 을 참조합니다.

  </Accordion>

  <Accordion title="봇에 메시지를 보낼 수 있는 사람 제어">
    DM 액세스는 `dmPolicy` 를 통해 채널별로 제어됩니다:

    - `"pairing"` (기본값): 알려지지 않은 발신자는 일회성 페어링 코드를 승인받습니다.
    - `"allowlist"`: `allowFrom` (또는 페어링된 허용 저장소) 의 발신자만
    - `"open"`: 모든 인바운드 DM 허용 (필요 `allowFrom: ["*"]`)
    - `"disabled"`: 모든 DM 무시

    그룹의 경우 `groupPolicy` + `groupAllowFrom` 또는 채널 특정 허용 목록을 사용합니다.

    채널별 세부 사항은 전체 참고의 [DM 및 그룹 액세스](/gateway/configuration-reference#dm-and-group-access) 를 참조하세요.

  </Accordion>

  <Accordion title="그룹 채팅 언급 게이팅 설정">
    그룹 메시지는 기본적으로 **언급 필요**입니다. 에이전트별 패턴을 구성합니다:

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

    - **메타데이터 언급**: 기본 @-언급 (WhatsApp 탭-맨션, Telegram @bot 등)
    - **텍스트 패턴**: `mentionPatterns` 의 정규 표현식 패턴
    - 채널별 오버라이드 및 자체 채팅 모드는 전체 참고의 [그룹 채팅 언급 게이팅](/gateway/configuration-reference#group-chat-mention-gating) 을 참조하세요.

  </Accordion>

  <Accordion title="세션 및 재설정 구성">
    세션은 대화 연속성 및 격리를 제어합니다:

    ```json5
    {
      session: {
        dmScope: "per-channel-peer",  // 다중 사용자 권장
        threadBindings: {
          enabled: true,
          idleHours: 24,
          maxAgeHours: 0,
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
    - `threadBindings`: 스레드 바운드 세션 라우팅의 전역 기본값 (Discord 는 `/focus`, `/unfocus`, `/agents`, `/session idle`, `/session max-age` 를 지원합니다).
    - 범위, 아이덴티티 링크 및 전송 정책은 [세션 관리](/concepts/session) 를 참조하세요.
    - 모든 필드는 전체 참고의 [세션](/gateway/configuration-reference#session) 을 참조하세요.

  </Accordion>

  <Accordion title="샌드박싱 활성화">
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

    이미지를 먼저 빌드합니다: `scripts/sandbox-setup.sh`

    전체 가이드는 [샌드박싱](/ko-KR/gateway/sandboxing) 를 참조하고 모든 옵션은 전체 참고의 [샌드박스](/gateway/configuration-reference#sandbox) 를 참조하세요.

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

    - `every`: 기간 문자열 (`30m`, `2h`). 비활성화하려면 `0m` 으로 설정합니다.
    - `target`: `last` | `whatsapp` | `telegram` | `discord` | `none`
    - `directPolicy`: DM 스타일 하트비트 대상에 `allow` (기본값) 또는 `block`
    - 전체 가이드는 [하트비트](/ko-KR/gateway/heartbeat) 를 참조하세요.

  </Accordion>

  <Accordion title="Cron 작업 구성">
    ```json5
    {
      cron: {
        enabled: true,
        maxConcurrentRuns: 2,
        sessionRetention: "24h",
        runLog: {
          maxBytes: "2mb",
          keepLines: 2000,
        },
      },
    }
    ```

    - `sessionRetention`: `sessions.json` 에서 완료된 격리된 실행 세션을 정리합니다 (기본값 `24h`; 비활성화하려면 `false` 설정).
    - `runLog`: 크기 및 보존된 라인별로 `cron/runs/<jobId>.jsonl` 정리합니다.
    - 기능 개요 및 CLI 예제는 [Cron 작업](/automation/cron-jobs) 를 참조하세요.

  </Accordion>

  <Accordion title="웹훅 설정 (훅)">
    Gateway 에서 HTTP 웹훅 끝점을 활성화합니다:

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

    모든 매핑 옵션 및 Gmail 통합은 전체 참고의 [훅](/gateway/configuration-reference#hooks) 를 참조하세요.

  </Accordion>

  <Accordion title="다중 에이전트 라우팅 구성">
    별도의 작업 영역 및 세션으로 여러 격리된 에이전트를 실행합니다:

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

    바인딩 규칙 및 에이전트별 액세스 프로필은 [다중 에이전트](/concepts/multi-agent) 및 전체 참고의 [다중 에이전트 라우팅](/gateway/configuration-reference#multi-agent-routing) 를 참조하세요.

  </Accordion>

  <Accordion title="구성을 여러 파일로 분할 ($include)">
    `$include` 를 사용하여 대규모 구성을 구성합니다:

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

    - **단일 파일**: 포함 객체를 대체합니다.
    - **파일 배열**: 순서대로 깊은 병합 (나중 승리)
    - **형제 키**: 포함 후 병합 (포함된 값 오버라이드)
    - **중첩된 포함**: 10 단계까지 지원됨
    - **상대 경로**: 포함 파일에 상대적으로 확인됨
    - **오류 처리**: 누락된 파일, 분석 오류 및 순환 포함에 대한 명확한 오류

  </Accordion>
</AccordionGroup>

## 구성 핫 리로드

Gateway 는 `~/.openclaw/openclaw.json` 를 감시하고 변경 사항을 자동으로 적용합니다 — 대부분의 설정에 대해 수동 재시작이 필요하지 않습니다.

### 리로드 모드

| 모드                  | 동작                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------- |
| **`hybrid`** (기본값) | 안전한 변경 사항을 즉시 핫 적용합니다. 중요한 변경 사항에 대해 자동으로 재시작합니다. |
| **`hot`**             | 안전한 변경 사항만 핫 적용합니다. 재시작이 필요할 때 경고를 기록합니다 — 처리합니다.  |
| **`restart`**         | 안전하거나 아니거나 모든 구성 변경에서 Gateway 를 재시작합니다.                       |
| **`off`**             | 파일 감시를 비활성화합니다. 다음 수동 재시작에서 변경 사항이 적용됩니다.              |

```json5
{
  gateway: {
    reload: { mode: "hybrid", debounceMs: 300 },
  },
}
```

### 핫 적용 대 재시작 필요

대부분의 필드는 다운타임 없이 핫 적용됩니다. `hybrid` 모드에서는 재시작 필요 변경 사항이 자동으로 처리됩니다.

| 범주             | 필드                                                    | 재시작 필요? |
| ---------------- | ------------------------------------------------------- | ------------ |
| 채널             | `channels.*`, `web` (WhatsApp) — 모든 내장 및 확장 채널 | 아니요       |
| 에이전트 및 모델 | `agent`, `agents`, `models`, `routing`                  | 아니요       |
| 자동화           | `hooks`, `cron`, `agent.heartbeat`                      | 아니요       |
| 세션 및 메시지   | `session`, `messages`                                   | 아니요       |
| 도구 및 미디어   | `tools`, `browser`, `skills`, `audio`, `talk`           | 아니요       |
| UI 및 기타       | `ui`, `logging`, `identity`, `bindings`                 | 아니요       |
| Gateway 서버     | `gateway.*` (포트, 바인드, 인증, Tailscale, TLS, HTTP)  | **예**       |
| 인프라           | `discovery`, `canvasHost`, `plugins`                    | **예**       |

<Note>
`gateway.reload` 및 `gateway.remote` 는 예외입니다 — 변경해도 재시작이 트리거되지 않습니다.
</Note>

## 구성 RPC (프로그래매틱 업데이트)

<Note>
제어 평면 쓰기 RPC (`config.apply`, `config.patch`, `update.run`) 는 `deviceId+clientIp` 당 **60 초당 3 요청**으로 제한됩니다. 제한되면 RPC 는 `UNAVAILABLE` 과 `retryAfterMs` 를 반환합니다.
</Note>

<AccordionGroup>
  <Accordion title="config.apply (전체 교체)">
    한 단계에서 전체 구성을 검증 및 작성하고 Gateway 를 재시작합니다.

    <Warning>
    `config.apply` 는 **전체 구성**을 대체합니다. 부분 업데이트는 `config.patch` 또는 `openclaw config set` (단일 키 경우) 를 사용합니다.
    </Warning>

    매개변수:

    - `raw` (문자열) — 전체 구성용 JSON5 페이로드
    - `baseHash` (선택적) — `config.get` 의 구성 해시 (구성이 존재할 때 필요)
    - `sessionKey` (선택적) — 재시작 후 깨어나기 핑을 위한 세션 키
    - `note` (선택적) — 재시작 센티널의 참고
    - `restartDelayMs` (선택적) — 재시작 전 지연 (기본값 2000)

    재시작 요청은 하나가 이미 대기 중/진행 중일 때 병합되고 재시작 주기 간에 30 초 쿨다운이 적용됩니다.

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
    부분 업데이트를 기존 구성에 병합합니다 (JSON 병합 패치 의미):

    - 객체 병합 재귀적
    - `null` 키 삭제
    - 배열 교체

    매개변수:

    - `raw` (문자열) — JSON5 변경할 키만 포함
    - `baseHash` (필수) — `config.get` 의 구성 해시
    - `sessionKey`, `note`, `restartDelayMs` — `config.apply` 와 동일

    재시작 동작은 `config.apply` 를 일치: 병합된 대기 중 재시작 + 재시작 주기 간 30 초 쿨다운.

    ```bash
    openclaw gateway call config.patch --params '{
      "raw": "{ channels: { telegram: { groups: { \"*\": { requireMention: false } } } } }",
      "baseHash": "<hash>"
    }'
    ```

  </Accordion>
</AccordionGroup>

## 환경 변수

OpenClaw 는 부모 프로세스의 환경 변수를 읽습니다 추가:

- 현재 작업 디렉토리의 `.env` (있을 경우)
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

<Accordion title="쉘 환경 가져오기 (선택적)">
  활성화되고 예상 키가 설정되지 않으면 OpenClaw 는 로그인 쉘을 실행하고 누락된 키만 가져옵니다:

```json5
{
  env: {
    shellEnv: { enabled: true, timeoutMs: 15000 },
  },
}
```

환경 변수 등가: `OPENCLAW_LOAD_SHELL_ENV=1`
</Accordion>

<Accordion title="구성 값의 환경 변수 치환">
  구성 문자열 값에 `${VAR_NAME}` 으로 환경 변수를 참조합니다:

```json5
{
  gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
  models: { providers: { custom: { apiKey: "${CUSTOM_API_KEY}" } } },
}
```

규칙:

- 대문자 이름만 일치: `[A-Z_][A-Z0-9_]*`
- 누락되었거나 빈 변수는 로드 시 오류를 발생시킵니다.
- `$${VAR}` 로 이스케이프하여 리터럴 출력
- `$include` 파일 내에서 작동합니다.
- 인라인 치환: `"${BASE}/v1"` → `"https://api.example.com/v1"`

</Accordion>

<Accordion title="암호 참조 (env, 파일, exec)">
  SecretRef 객체를 지원하는 필드의 경우 다음을 사용할 수 있습니다:

```json5
{
  models: {
    providers: {
      openai: { apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" } },
    },
  },
  skills: {
    entries: {
      "nano-banana-pro": {
        apiKey: {
          source: "file",
          provider: "filemain",
          id: "/skills/entries/nano-banana-pro/apiKey",
        },
      },
    },
  },
  channels: {
    googlechat: {
      serviceAccountRef: {
        source: "exec",
        provider: "vault",
        id: "channels/googlechat/serviceAccount",
      },
    },
  },
}
```

SecretRef 세부 사항 (`env`/`file`/`exec` 에 대한 `secrets.providers` 포함) 은 [암호 관리](/gateway/secrets) 에 있습니다.
</Accordion>

[환경](/help/environment) 에서 전체 우선순위 및 소스를 참조하세요.

## 전체 참고

전체 필드별 참고를 위해 **[구성 참고](/gateway/configuration-reference)** 를 참조합니다.

---

_관련: [구성 예제](/ko-KR/gateway/configuration-examples) · [구성 참고](/gateway/configuration-reference) · [Doctor](/ko-KR/gateway/doctor)_
