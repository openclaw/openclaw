---
summary: "Sub-agents: spawning isolated agent runs that announce results back to the requester chat"
read_when:
  - You want background/parallel work via the agent
  - You are changing sessions_spawn or sub-agent tool policy
title: "Sub-Agents"
x-i18n:
  source_hash: fea34771770edef10e03fbf3065b57af5e6f5a61cf1dc2e80a384bd99b52aca4
---

# 하위 에이전트

하위 에이전트를 사용하면 기본 대화를 차단하지 않고 백그라운드 작업을 실행할 수 있습니다. 하위 에이전트를 생성하면 자체 격리된 세션에서 실행되고 작업을 수행하며 완료되면 결과를 다시 채팅에 알립니다.

**사용 사례:**

- 주체가 계속해서 질문에 답하는 동안 주제를 조사하세요.
- 여러 개의 긴 작업을 병렬로 실행(웹 스크래핑, 코드 분석, 파일 처리)
- 다중 에이전트 설정에서 전문 에이전트에게 작업 위임

## 빠른 시작

하위 에이전트를 사용하는 가장 간단한 방법은 에이전트에게 자연스럽게 물어봅니다.

> "최신 Node.js 릴리스 노트를 조사하기 위해 하위 에이전트를 생성합니다."

에이전트는 뒤에서 `sessions_spawn` 도구를 호출합니다. 하위 에이전트가 완료되면 결과를 채팅에 다시 알립니다.

옵션에 대해 명시적으로 지정할 수도 있습니다.

> "오늘부터 서버 로그를 분석하기 위해 하위 에이전트를 생성합니다. gpt-5.2를 사용하고 5분 제한 시간을 설정하세요."

## 작동 방식

<Steps>
  <Step title="Main agent spawns">
    주 에이전트는 작업 설명과 함께 `sessions_spawn`를 호출합니다. 통화는 **비차단**입니다. 주 상담원이 `{ status: "accepted", runId, childSessionKey }` 즉시 응답합니다.
  </Step>
  <Step title="Sub-agent runs in the background">
    전용 `subagent` 대기열 레인에 새로운 격리 세션(`agent:<agentId>:subagent:<uuid>`)이 생성됩니다.
  </Step>
  <Step title="Result is announced">
    하위 에이전트가 완료되면 결과를 요청자 채팅에 다시 알립니다. 주체는 자연어 요약을 게시합니다.
  </Step>
  <Step title="Session is archived">
    하위 에이전트 세션은 60분 후에 자동으로 보관됩니다(구성 가능). 성적표는 보존됩니다.
  </Step>
</Steps>

<Tip>
각 하위 에이전트에는 **자체** 컨텍스트와 토큰 사용법이 있습니다. 비용 절감을 위해 하위 에이전트에 대해 더 저렴한 모델을 설정하세요. 아래의 [기본 모델 설정](#setting-a-default-model)을 참조하세요.
</Tip>

## 구성

하위 에이전트는 구성 없이 즉시 작동합니다. 기본값:

- 모델 : 대상 에이전트의 일반 모델 선택 (`subagents.model`가 설정되지 않은 경우)
- 생각: 하위 에이전트 재정의 없음(`subagents.thinking`가 설정되지 않은 한)
- 최대 동시 : 8
- 자동 보관 : 60분 후

### 기본 모델 설정

토큰 비용을 절약하려면 하위 에이전트에 대해 더 저렴한 모델을 사용하세요.

```json5
{
  agents: {
    defaults: {
      subagents: {
        model: "minimax/MiniMax-M2.1",
      },
    },
  },
}
```

### 기본 사고 수준 설정하기

```json5
{
  agents: {
    defaults: {
      subagents: {
        thinking: "low",
      },
    },
  },
}
```

### 에이전트별 재정의

다중 에이전트 설정에서는 에이전트별로 하위 에이전트 기본값을 설정할 수 있습니다.

```json5
{
  agents: {
    list: [
      {
        id: "researcher",
        subagents: {
          model: "anthropic/claude-sonnet-4",
        },
      },
      {
        id: "assistant",
        subagents: {
          model: "minimax/MiniMax-M2.1",
        },
      },
    ],
  },
}
```

### 동시성

동시에 실행할 수 있는 하위 에이전트 수를 제어합니다.

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 4, // default: 8
      },
    },
  },
}
```

하위 에이전트는 기본 에이전트 대기열과 별도로 전용 대기열 레인(`subagent`)을 사용하므로 하위 에이전트 실행은 인바운드 응답을 차단하지 않습니다.

### 자동 보관

하위 에이전트 세션은 구성 가능한 기간이 지나면 자동으로 보관됩니다.

```json5
{
  agents: {
    defaults: {
      subagents: {
        archiveAfterMinutes: 120, // default: 60
      },
    },
  },
}
```

<Note>
아카이브는 기록의 이름을 `*.deleted.<timestamp>`(동일 폴더)로 변경합니다. 기록은 삭제되지 않고 보존됩니다. 자동 보관 타이머는 최선의 노력입니다. 게이트웨이가 다시 시작되면 보류 중인 타이머가 손실됩니다.
</Note>

## `sessions_spawn` 도구

에이전트가 하위 에이전트를 생성하기 위해 호출하는 도구입니다.

### 매개변수

| 매개변수            | 유형                   | 기본값              | 설명                                               |
| ------------------- | ---------------------- | ------------------- | -------------------------------------------------- |
| `task`              | 문자열                 | _(필수)_            | 하위 에이전트가 수행해야 하는 작업                 |
| `label`             | 문자열                 | —                   | 식별용 짧은 라벨                                   |
| `agentId`           | 문자열                 | _(발신자의 대리인)_ | 다른 에이전트 ID로 생성(허용되어야 함)             |
| `model`             | 문자열                 | _(선택사항)_        | 이 하위 에이전트의 모델 재정의                     |
| `thinking`          | 문자열                 | _(선택사항)_        | 사고 수준 무시 (`off`, `low`, `medium`, `high` 등) |
| `runTimeoutSeconds` | 번호                   | `0` (제한 없음)     | N초 후 하위 에이전트 중단                          |
| `cleanup`           | `"delete"` \| `"keep"` | `"keep"`            | `"delete"` 발표 직후 아카이브                      |

### 모델 해결 순서

하위 에이전트 모델은 다음 순서로 해결됩니다(첫 번째 일치 항목 승리).

1. `sessions_spawn` 호출의 명시적 `model` 매개변수
2. 에이전트별 구성: `agents.list[].subagents.model`
3. 전역 기본값: `agents.defaults.subagents.model`
4. 해당 새 세션에 대한 대상 에이전트의 일반 모델 해결

사고 수준은 다음 순서로 해결됩니다.

1. `sessions_spawn` 호출의 명시적 `thinking` 매개변수
2. 에이전트별 구성: `agents.list[].subagents.thinking`
3. 전역 기본값 : `agents.defaults.subagents.thinking`
4. 그렇지 않으면 하위 에이전트별 사고 무시가 적용되지 않습니다.

<Note>
잘못된 모델 값은 자동으로 건너뜁니다. 하위 에이전트는 도구 결과에 경고가 표시되면서 다음으로 유효한 기본값으로 실행됩니다.
</Note>

### 교차 에이전트 생성

기본적으로 하위 에이전트는 자신의 에이전트 ID로만 생성될 수 있습니다. 에이전트가 다른 에이전트 ID로 하위 에이전트를 생성하도록 허용하려면 다음을 수행하세요.

```json5
{
  agents: {
    list: [
      {
        id: "orchestrator",
        subagents: {
          allowAgents: ["researcher", "coder"], // or ["*"] to allow any
        },
      },
    ],
  },
}
```

<Tip>
`agents_list` 도구를 사용하여 현재 `sessions_spawn`에 허용되는 에이전트 ID를 알아보세요.
</Tip>

## 하위 에이전트 관리 (`/subagents`)

현재 세션에 대한 하위 에이전트 실행을 검사하고 제어하려면 `/subagents` 슬래시 명령을 사용하십시오.

| 명령                                     | 설명                                       |
| ---------------------------------------- | ------------------------------------------ |
| `/subagents list`                        | 모든 하위 에이전트 실행 나열(활성 및 완료) |
| `/subagents stop <id\|#\|all>`           | 실행 중인 하위 에이전트 중지               |
| `/subagents log <id\|#> [limit] [tools]` | 하위 에이전트 기록 보기                    |
| `/subagents info <id\|#>`                | 자세한 실행 메타데이터 표시                |
| `/subagents send <id\|#> <message>`      | 실행 중인 하위 에이전트에 메시지 보내기    |

목록 인덱스(`1`, `2`), 실행 ID 접두사, 전체 세션 키 또는 `last`를 기준으로 하위 에이전트를 참조할 수 있습니다.

<AccordionGroup>
  <Accordion title="Example: list and stop a sub-agent">
    ```
    /subagents list
    ```

    ```
    🧭 Subagents (current session)
    Active: 1 · Done: 2
    1) ✅ · research logs · 2m31s · run a1b2c3d4 · agent:main:subagent:...
    2) ✅ · check deps · 45s · run e5f6g7h8 · agent:main:subagent:...
    3) 🔄 · deploy staging · 1m12s · run i9j0k1l2 · agent:main:subagent:...
    ```

    ```
    /subagents stop 3
    ```

    ```
    ⚙️ Stop requested for deploy staging.
    ```

  </Accordion>
  <Accordion title="Example: inspect a sub-agent">
    ```
    /subagents info 1
    ```

    ```
    ℹ️ Subagent info
    Status: ✅
    Label: research logs
    Task: Research the latest server error logs and summarize findings
    Run: a1b2c3d4-...
    Session: agent:main:subagent:...
    Runtime: 2m31s
    Cleanup: keep
    Outcome: ok
    ```

  </Accordion>
  <Accordion title="Example: view sub-agent log">
    ```
    /subagents log 1 10
    ```

    하위 에이전트의 기록에서 마지막 10개 메시지를 표시합니다. 도구 호출 메시지를 포함하려면 `tools`를 추가하세요.

    ```
    /subagents log 1 10 tools
    ```

  </Accordion>
  <Accordion title="Example: send a follow-up message">
    ```
    /subagents send 3 "Also check the staging environment"
    ```

    실행 중인 하위 에이전트의 세션에 메시지를 보내고 최대 30초 동안 응답을 기다립니다.

  </Accordion>
</AccordionGroup>

## 발표(결과가 어떻게 나오는지)

하위 에이전트가 완료되면 **알림** 단계를 거칩니다.

1. 하위 에이전트의 최종 답변을 캡처합니다.
2. 결과, 상태, 통계와 함께 요약 메시지가 메인 에이전트의 세션으로 전송됩니다.
3. 상담원이 채팅에 자연어 요약을 게시합니다.

응답 발표는 사용 가능한 경우 스레드/주제 라우팅을 유지합니다(Slack 스레드, Telegram 주제, Matrix 스레드).

### 통계 발표

각 발표에는 다음과 같은 통계 표시줄이 포함됩니다.

- 런타임 기간
- 토큰 사용량(입력/출력/전체)
- 예상 비용(모델 가격이 `models.providers.*.models[].cost`를 통해 구성된 경우)
- 세션 키, 세션 ID, 기록 경로

### 상태 발표

공지 메시지에는 런타임 결과(모델 출력이 아님)에서 파생된 상태가 포함됩니다.

- **성공적인 완료** (`ok`) — 작업이 정상적으로 완료되었습니다.
- **오류** — 작업 실패(오류 세부정보는 메모에 있음)
- **시간 초과** — 작업이 초과되었습니다 `runTimeoutSeconds`
- **알 수 없음** — 상태를 확인할 수 없습니다.

<Tip>
사용자에게 표시되는 알림이 필요하지 않은 경우 주 에이전트 요약 단계는 `NO_REPLY`를 반환할 수 있으며 아무것도 게시되지 않습니다.
이는 에이전트 간 공지 흐름(`sessions_send`)에서 사용되는 `ANNOUNCE_SKIP`와 다릅니다.
</Tip>

## 도구 정책

기본적으로 하위 에이전트는 백그라운드 작업에 안전하지 않거나 불필요한 거부된 도구 세트를 제외한 **모든 도구**를 가져옵니다.

<AccordionGroup>
  <Accordion title="Default denied tools">
    | 거부된 도구 | 이유 |
    |-------------|---------|
    | `sessions_list` | 세션 관리 — 주 에이전트가 조정 |
    | `sessions_history` | 세션 관리 — 주 에이전트가 조정 |
    | `sessions_send` | 세션 관리 — 주 에이전트가 조정 |
    | `sessions_spawn` | 중첩된 팬아웃 없음(하위 에이전트는 하위 에이전트를 생성할 수 없음) |
    | `gateway` | 시스템 관리자 - 하위 에이전트로 인해 위험함 |
    | `agents_list` | 시스템 관리자 |
    | `whatsapp_login` | 대화형 설정 - 작업이 아님 |
    | `session_status` | 상태/스케줄 - 주요 에이전트 좌표 |
    | `cron` | 상태/스케줄 - 주요 에이전트 좌표 |
    | `memory_search` | 대신 생성 프롬프트에 관련 정보를 전달 |
    | `memory_get` | 대신 생성 프롬프트에 관련 정보를 전달 |
  </Accordion>
</AccordionGroup>

### 하위 에이전트 도구 사용자 정의

하위 에이전트 도구를 추가로 제한할 수 있습니다.

```json5
{
  tools: {
    subagents: {
      tools: {
        // deny always wins over allow
        deny: ["browser", "firecrawl"],
      },
    },
  },
}
```

하위 에이전트를 특정 도구 **만**으로 제한하려면 다음을 수행하세요.

```json5
{
  tools: {
    subagents: {
      tools: {
        allow: ["read", "exec", "process", "write", "edit", "apply_patch"],
        // deny still wins if set
      },
    },
  },
}
```

<Note>
사용자 정의 거부 항목이 기본 거부 목록에 **추가**됩니다. `allow`가 설정된 경우 해당 도구만 사용할 수 있습니다(기본 거부 목록은 여전히 ​​맨 위에 적용됩니다).
</Note>

## 인증

하위 에이전트 인증은 세션 유형이 아닌 **에이전트 ID**로 확인됩니다.

- 인증 저장소는 대상 에이전트의 `agentDir`에서 로드됩니다.
- 기본 에이전트의 인증 프로필이 **대체**로 병합됩니다(충돌 시 에이전트 프로필이 승리함).
- 병합은 추가됩니다. 기본 프로필은 항상 대체 항목으로 사용 가능합니다.

<Note>
하위 에이전트별로 완전히 격리된 인증은 현재 지원되지 않습니다.
</Note>

## 컨텍스트 및 시스템 프롬프트

하위 에이전트는 기본 에이전트에 비해 시스템 프롬프트가 줄어듭니다.

- **포함됨:** 도구, 작업 공간, 런타임 섹션과 `AGENTS.md` 및 `TOOLS.md`
- **포함되지 않음:** `SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`

또한 하위 에이전트는 할당된 작업에 계속 집중하고 완료하며 주 에이전트 역할을 하지 않도록 지시하는 작업 중심 시스템 프롬프트를 받습니다.

## 하위 에이전트 중지

| 방법                   | 효과                                                                        |
| ---------------------- | --------------------------------------------------------------------------- |
| `/stop` 채팅           | 기본 세션 **및** 여기에서 생성된 모든 활성 하위 에이전트 실행을 중단합니다. |
| `/subagents stop <id>` | 기본 세션에 영향을 주지 않고 특정 하위 에이전트를 중지합니다.               |
| `runTimeoutSeconds`    | 지정된 시간 이후 하위 에이전트 실행을 자동으로 중단                         |

<Note>
`runTimeoutSeconds`는 세션을 자동 보관하지 **않습니다**. 세션은 일반 보관 타이머가 실행될 때까지 유지됩니다.
</Note>

## 전체 구성 예

<Accordion title="Complete sub-agent configuration">
```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-sonnet-4" },
      subagents: {
        model: "minimax/MiniMax-M2.1",
        thinking: "low",
        maxConcurrent: 4,
        archiveAfterMinutes: 30,
      },
    },
    list: [
      {
        id: "main",
        default: true,
        name: "Personal Assistant",
      },
      {
        id: "ops",
        name: "Ops Agent",
        subagents: {
          model: "anthropic/claude-sonnet-4",
          allowAgents: ["main"], // ops can spawn sub-agents under "main"
        },
      },
    ],
  },
  tools: {
    subagents: {
      tools: {
        deny: ["browser"], // sub-agents can't use the browser
      },
    },
  },
}
```
</Accordion>

## 제한사항

<Warning>
- **최선의 알림:** 게이트웨이가 다시 시작되면 보류 중인 알림 작업이 손실됩니다.
- **중첩 생성 없음:** 하위 에이전트는 자체 하위 에이전트를 생성할 수 없습니다.
- **공유 리소스:** 하위 에이전트는 게이트웨이 프로세스를 공유합니다. `maxConcurrent`를 안전 밸브로 사용하세요.
- **자동 보관이 최선입니다.** 대기 중인 보관 타이머는 게이트웨이를 다시 시작하면 손실됩니다.
</Warning>

## 참고 항목

- [세션 도구](/concepts/session-tool) — `sessions_spawn` 및 기타 세션 도구에 대한 세부 정보
- [다중 에이전트 샌드박스 및 도구](/tools/multi-agent-sandbox-tools) — 에이전트별 도구 제한 및 샌드박싱
- [구성](/gateway/configuration) — `agents.defaults.subagents` 참조
- [Queue](/concepts/queue) — `subagent` 차선 작동 방식
