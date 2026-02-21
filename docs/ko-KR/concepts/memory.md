---
title: "메모리"
summary: "OpenClaw 메모리가 작동하는 방법 (작업 공간 파일 + 자동 메모리 플러시)"
read_when:
  - 메모리 파일 레이아웃과 워크플로를 찾고 싶을 때
  - 자동 사전 압축 메모리 플러시를 조정하고 싶을 때
---

# 메모리

OpenClaw 메모리는 **에이전트 작업 공간의 순수한 Markdown**입니다. 파일은 진실의 원천이며, 모델은 디스크에 기록된 것만 "기억"합니다.

메모리 검색 도구는 활성 메모리 플러그인 (기본값: `memory-core`)에 의해 제공됩니다. `plugins.slots.memory = "none"`을 사용하여 메모리 플러그인을 비활성화할 수 있습니다.

## 메모리 파일 (Markdown)

기본 작업 공간 레이아웃은 두 개의 메모리 레이어를 사용합니다:

- `memory/YYYY-MM-DD.md`
  - 일일 로그 (추가 전용).
  - 세션 시작 시 오늘과 어제 읽기.
- `MEMORY.md` (선택 사항)
  - 큐레이션된 장기 메모리.
  - **주요 개인 세션에서만 로드** (그룹 상황에서는 절대 아님).

이 파일들은 작업 공간 (`agents.defaults.workspace`, 기본 `~/.openclaw/workspace`) 내에 위치합니다. 전체 레이아웃은 [Agent workspace](/ko-KR/concepts/agent-workspace)에서 확인하세요.

## 메모리 도구

OpenClaw는 이러한 Markdown 파일을 위해 에이전트 대상의 두 가지 도구를 제공합니다:

- `memory_search` — 인덱싱된 스니펫에 대한 의미적 회상.
- `memory_get` — 특정 Markdown 파일/라인 범위의 대상 읽기.

`memory_get`은 이제 **파일이 존재하지 않을 때 우아하게 저하됩니다** (예: 첫 번째 쓰기 전 오늘의 일일 로그). 내장 매니저와 QMD 백엔드 모두 `ENOENT`를 던지는 대신 `{ text: "", path }`를 반환하므로, 에이전트는 "아직 기록되지 않음"을 처리하고 도구 호출을 try/catch 로직으로 감쌀 필요 없이 워크플로우를 계속할 수 있습니다.

## 메모리를 쓸 때

- 결정, 선호 및 지속적인 사실은 `MEMORY.md`로 이동합니다.
- 일상적인 메모와 실행 중인 컨텍스트는 `memory/YYYY-MM-DD.md`로 이동합니다.
- 누군가가 "이것을 기억해"라고 말하면, 이를 기록해 둡니다 (RAM에는 유지하지 않습니다).
- 이 영역은 여전히 ​​진화 중입니다. 모델에게 메모리를 저장하도록 상기시키는 것이 도움이 됩니다. 모델은 알아서 처리할 것입니다.
- 무엇인가를 확실히 하고 싶다면, **로봇에게 그것을 메모리에 기록하라고 요청하세요**.

## 자동 메모리 플러시 (사전 압축 핑)

세션이 **자체 압축에 가까워질 때**, OpenClaw는 **조용하고, 에이전트적인 전환**을 활성화하여 모델이 컨텍스트가 압축되기 **전에** 지속적인 메모리를 기록하도록 상기시킵니다. 기본 프롬프트는 모델이 *응답할 수도 있다*고 명시하지만, 일반적으로 `NO_REPLY`가 올바른 응답이므로 사용자는 이 전환을 볼 수 없습니다.

이것은 `agents.defaults.compaction.memoryFlush`에 의해 제어됩니다:

```json5
{
  agents: {
    defaults: {
      compaction: {
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

세부 사항:

- **Soft threshold**: 세션 토큰 추정치가 `contextWindow - reserveTokensFloor - softThresholdTokens`를 넘을 때 플러시가 트리거됩니다.
- 기본적으로 **조용함**: 프롬프트는 `NO_REPLY`를 포함하여 아무것도 전달되지 않습니다.
- **두 개의 프롬프트**: 사용자 프롬프트와 시스템 프롬프트가 상기시킵니다.
- **압축 주기당 한 번의 플러시** (`sessions.json`에서 추적됨).
- **작업 공간은 쓰기가 가능해야 함**: 세션이 `workspaceAccess: "ro"` 또는 `"none"`으로 샌드박스 격리로 실행되면 플러시는 건너뛰어집니다.

전체 압축 생명 주기에 대한 내용은 [Session management + compaction](/ko-KR/reference/session-management-compaction)을 참조하세요.

## 벡터 메모리 검색

OpenClaw는 `MEMORY.md`와 `memory/*.md`에 대해 작은 벡터 인덱스를 작성하여 의미 체계 쿼리가 다른 서술을 찾을 수 있도록 합니다.

기본값:

- 기본적으로 활성화됨.
- 메모리 파일 변경 사항을 감시 (디바운싱).
- `agents.defaults.memorySearch`에서 메모리 검색을 구성하십시오 (상위 수준 `memorySearch`가 아님).
- 기본적으로 원격 임베딩을 사용합니다. `memorySearch.provider`가 설정되어 있지 않은 경우, OpenClaw는 다음을 자동으로 선택합니다:
  1. `memorySearch.local.modelPath`가 구성되어 있고 파일이 존재하면 `local`.
  2. OpenAI 키를 확인할 수 있으면 `openai`.
  3. Gemini 키를 확인할 수 있으면 `gemini`.
  4. Voyage 키를 확인할 수 있으면 `voyage`.
  5. 그렇지 않으면 메모리 검색은 설정될 때까지 비활성 상태로 유지됩니다.
- 로컬 모드는 node-llama-cpp를 사용하며 `pnpm approve-builds`를 필요로 할 수 있습니다.
- sqlite-vec을 사용하여 SQLite 내부에서 벡터 검색을 가속화합니다 (사용 가능한 경우).

원격 임베딩은 임베딩 프로바이더의 API 키가 **필요**합니다. OpenClaw는 인증 프로필, `models.providers.*.apiKey` 또는 환경 변수에서 키를 해석합니다. Codex OAuth는 채팅/완성만 다루며 메모리 검색에 대한 임베딩을 만족시키지 **않습니다**. Gemini의 경우 `GEMINI_API_KEY` 또는 `models.providers.google.apiKey`를 사용합니다. Voyage의 경우 `VOYAGE_API_KEY` 또는 `models.providers.voyage.apiKey`를 사용합니다. 사용자 정의 OpenAI 호환 엔드포인트를 사용하는 경우, `memorySearch.remote.apiKey` (및 선택적 `memorySearch.remote.headers`)를 설정하십시오.

### QMD 백엔드 (실험적)

내장된 SQLite 인덱서를 [QMD](https://github.com/tobi/qmd)로 교체하려면 `memory.backend = "qmd"`로 설정하십시오: 로컬 우선 검색 사이드카로 BM25 + 벡터 + 재랭킹을 결합합니다. Markdown은 진실의 원천으로 남고, OpenClaw는 검색을 위해 QMD를 사용합니다. 주요 포인트:

**Prereqs**

- 기본적으로 비활성화됨. 구성당 옵트인합니다 (`memory.backend = "qmd"`).
- QMD CLI를 별도로 설치하십시오 (`bun install -g https://github.com/tobi/qmd` 또는 릴리스를 다운로드)하고 `qmd` 바이너리가 게이트웨이의 `PATH`에 있는지 확인하십시오.
- QMD는 확장을 허용하는 SQLite 빌드가 필요합니다 (`brew install sqlite`을 사용하여 macOS에 설치).
- QMD는 Bun + `node-llama-cpp`를 통해 완전 로컬로 실행되며 첫 사용 시 HuggingFace에서 GGUF 모델을 자동 다운로드합니다 (별도의 Ollama 데몬은 필요하지 않음).
- 게이트웨이는 `XDG_CONFIG_HOME` 및 `XDG_CACHE_HOME`을 설정하여 QMD를 `~/.openclaw/agents/<agentId>/qmd/` 내에서 자체 포함된 XDG 홈에서 실행합니다.
- 운영 체제 지원: macOS 및 Linux는 SQLite 설치 후 즉시 작동합니다. Windows는 WSL2를 통해 가장 잘 지원됩니다.

**사이드카 실행 방법**

- 게이트웨이는 `~/.openclaw/agents/<agentId>/qmd/` 내에서 자체 포함된 QMD 홈을 작성합니다 (구성 + 캐시 + sqlite DB).
- `memory.qmd.paths` (기본 작업 공간 메모리 파일 포함)에서 `qmd collection add`를 통해 컬렉션이 생성된 후, `qmd update` + `qmd embed`가 부팅 시 및 구성 가능한 간격(`memory.qmd.update.interval`, 기본 5m)으로 실행됩니다.
- 게이트웨이는 이제 부팅 시 QMD 매니저를 초기화하여 주기적 업데이트 타이머가 첫 `memory_search` 호출 전에 무장됩니다.
- 부팅 새로 고침은 기본적으로 백그라운드에서 실행되므로 채팅 시작이 차단되지 않습니다. `memory.qmd.update.waitForBootSync = true`로 설정하여 이전의 차단 동작을 유지할 수 있습니다.
- 검색은 `memory.qmd.searchMode`(기본 `qmd search --json`; `vsearch` 및 `query`도 지원)로 실행됩니다. 선택한 모드가 QMD 빌드에서 플래그를 거부하면, OpenClaw는 `qmd query`로 재시도합니다. QMD가 실패하거나 바이너리가 없으면, OpenClaw는 자동으로 내장 SQLite 매니저로 폴백하여 메모리 도구가 계속 작동할 수 있게 합니다.
- OpenClaw는 현재 QMD 임베드 배치 크기 조정을 노출하지 않습니다; 배치 동작은 QMD 자체에 의해 제어됩니다.
- **첫 검색 시 느릴 수 있음**: QMD는 로컬 GGUF 모델(재랭커/쿼리 확장)을 첫 `qmd query` 실행 시 다운로드할 수 있습니다.
  - OpenClaw는 QMD를 실행할 때 자동으로 `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`을 설정합니다.
  - 수동으로 모델을 미리 다운로드하고 OpenClaw가 사용하는 동일한 인덱스를 미리 로드하려면, 에이전트의 XDG 디렉토리로 일회성 쿼리를 실행하십시오.

    OpenClaw의 QMD 상태는 **상태 디렉토리** (기본 `~/.openclaw`) 내에 있습니다. OpenClaw가 사용하는 동일한 XDG 변수를 내보내어 `qmd`를 정확히 동일한 인덱스로 지정할 수 있습니다:

    ```bash
    # OpenClaw가 사용하는 동일한 상태 디렉토리 선택
    STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"

    export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"

    # (선택 사항) 인덱스 새로 고침 + 임베딩 강제
    qmd update
    qmd embed

    # 첫 모델 다운로드 가열/트리거
    qmd query "test" -c memory-root --json >/dev/null 2>&1
    ```

**구성 표면 (`memory.qmd.*`)**

- `command` (기본 `qmd`): 실행 파일 경로를 재정의합니다.
- `searchMode` (기본 `search`): `memory_search` 백에서 사용할 QMD 명령어를 선택합니다 (`search`, `vsearch`, `query`).
- `includeDefaultMemory` (기본 `true`): `MEMORY.md` + `memory/**/*.md`를 자동으로 인덱스 설정합니다.
- `paths[]`: 추가 디렉터리/파일 추가 (`path`, 선택적 `pattern`, 선택적 안정적인 `name`).
- `sessions`: 세션 JSONL 인덱싱을 선택 (`enabled`, `retentionDays`, `exportDir`).
- `update`: 갱신 주기 및 유지 보수 실행을 제어합니다: (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`, `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`).
- `limits`: 회상 페이로드 클램프 (`maxResults`, `maxSnippetChars`, `maxInjectedChars`, `timeoutMs`).
- `scope`: [`session.sendPolicy`](/ko-KR/gateway/configuration#session)와 동일한 스키마. 기본 DM 전용 (`deny` 모두, `allow` 직접 채팅); 그룹/채널에서 QMD 히트를 노출하려면 이를 완화합니다.
  - `match.keyPrefix`는 **일반화된** 세션 키를 매칭합니다 (소문자, `agent:<id>:` 삭제). 예: `discord:channel:`.
  - `match.rawKeyPrefix`는 **원본** 세션 키를 매칭합니다 (소문자 포함). 예: `agent:main:discord:`.
  - 레거시: `match.keyPrefix: "agent:..."`는 여전히 원본 키 접두사로 처리되지만, 명확성을 위해 `rawKeyPrefix`를 선호하십시오.
- 검색이 `scope`에 의해 거부되면, OpenClaw는 파생된 `channel`/`chatType`과 함께 경고를 기록하여 빈 결과를 디버그하기 쉽게 합니다.
- 작업 공간 외부에서 얻은 단편은 `memory_search` 결과에서 `qmd/<collection>/<relative-path>`로 표시됩니다. `memory_get`은 해당 접두사를 이해하고 구성된 QMD 컬렉션 루트에서 읽습니다.
- `memory.qmd.sessions.enabled = true`일 때, OpenClaw는 QMD 컬렉션 하에 세션 기록(User/Assistant 전환)을 내보내어 `memory_search`가 내장된 SQLite 인덱스를 건드리지 않고 최근 대화를 회상할 수 있도록 합니다.
- `memory_search` 단편은 이제 `memory.citations`가 `auto`/`on`일 때 `Source: <path#line>` 바닥글을 포함합니다. `memory.citations = "off"`로 설정하여 경로 메타데이터를 내부에 유지하고 에이전트는 여전히 `memory_get`을 위한 경로를 받지만, 단편 텍스트는 바닥글을 생략하고 시스템 프롬프트는 에이전트가 이를 인용하지 않도록 경고합니다.

**예시**

```json5
memory: {
  backend: "qmd",
  citations: "auto",
  qmd: {
    includeDefaultMemory: true,
    update: { interval: "5m", debounceMs: 15000 },
    limits: { maxResults: 6, timeoutMs: 4000 },
    scope: {
      default: "deny",
      rules: [
        { action: "allow", match: { chatType: "direct" } },
        // 일반화된 세션 키 접두사 (strips `agent:<id>:`).
        { action: "deny", match: { keyPrefix: "discord:channel:" } },
        // 원본 세션 키 접두사 (includes `agent:<id>:`).
        { action: "deny", match: { rawKeyPrefix: "agent:main:discord:" } },
      ]
    },
    paths: [
      { name: "docs", path: "~/notes", pattern: "**/*.md" }
    ]
  }
}
```

**인용 및 폴백**

- `memory.citations`은 백엔드에 관계없이 적용됩니다 (`auto`/`on`/`off`).
- `qmd`가 실행되었을 때, 우리는 `status().backend = "qmd"`로 태그하여 진단으로 어떤 엔진이 결과를 제공했는지 보여줍니다. QMD 하위 프로세스가 종료되거나 JSON 출력을 구문 분석할 수 없으면 검색 관리자는 경고를 기록하고 QMD가 복구될 때까지 내장 제공자(기존 Markdown 임베딩)를 반환합니다.

### 추가 메모리 경로

기본 작업 공간 레이아웃 외부의 Markdown 파일을 인덱스하려면 명시적인 경로를 추가하세요:

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

노트:

- 경로는 절대적이거나 작업 공간 상대적인 값일 수 있습니다.
- 디렉터리는 `.md` 파일을 재귀적으로 탐색합니다.
- Markdown 파일만 인덱스됩니다.
- 심볼릭 링크는 무시됩니다 (파일 또는 디렉터리).

### Gemini 임베딩 (네이티브)

직접적인 Gemini 임베딩 API를 사용하려면 프로바이더를 `gemini`로 설정하십시오:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "gemini",
      model: "gemini-embedding-001",
      remote: {
        apiKey: "YOUR_GEMINI_API_KEY"
      }
    }
  }
}
```

노트:

- `remote.baseUrl`은 선택 사항입니다 (기본적으로 Gemini API 기본 URL로 설정).
- `remote.headers`를 사용하여 필요한 경우 추가 헤더를 추가할 수 있습니다.
- 기본 모델: `gemini-embedding-001`.

사용자 정의 OpenAI 호환 엔드포인트(OpenRouter, vLLM, 또는 프록시)를 사용하려면, OpenAI 프로바이더와 `remote` 구성을 사용할 수 있습니다:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_OPENAI_COMPAT_API_KEY",
        headers: { "X-Custom-Header": "value" }
      }
    }
  }
}
```

API 키를 설정하지 않으려면 `memorySearch.provider = "local"`을 사용하거나 `memorySearch.fallback = "none"`으로 설정하십시오.

폴백:

- `memorySearch.fallback`은 `openai`, `gemini`, `local`, `none`이 될 수 있습니다.
- 폴백 프로바이더는 주 임베딩 프로바이더가 실패할 때만 사용됩니다.

배치 인덱싱 (OpenAI + Gemini + Voyage):

- 기본적으로 비활성화됨. 대용량 인덱싱을 위해 `agents.defaults.memorySearch.remote.batch.enabled = true`로 설정하여 활성화합니다 (OpenAI, Gemini, Voyage).
- 기본 동작은 배치 완료를 대기합니다. 필요한 경우 `remote.batch.wait`, `remote.batch.pollIntervalMs`, 및 `remote.batch.timeoutMinutes`를 조정합니다.
- `remote.batch.concurrency`를 설정하여 동시에 제출할 배치 작업 수를 제어합니다 (기본: 2).
- 배치 모드는 `memorySearch.provider = "openai"` 또는 `"gemini"`일 때 적용되며 해당 API 키를 사용합니다.
- Gemini 배치 작업은 비동기 임베딩 배치 엔드포인트를 사용하며 Gemini Batch API 가용성을 요구합니다.

OpenAI 배치가 빠르고 저렴한 이유:

- 대규모 백필 작업의 경우, OpenAI는 일반적으로 우리가 지원하는 가장 빠른 옵션입니다. 많은 임베딩 요청을 단일 배치 작업으로 제출하고 OpenAI가 비동기적으로 처리할 수 있기 때문입니다.
- OpenAI는 배치 API 작업에 대해 할인된 가격을 제공하므로, 대규모 인덱싱 작업이 동일한 요청을 동기적으로 보내는 것보다 일반적으로 저렴합니다.
- OpenAI Batch API 문서와 가격에 대한 자세한 내용은 다음을 참조하세요:
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

구성 예:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "openai",
      remote: {
        batch: { enabled: true, concurrency: 2 }
      },
      sync: { watch: true }
    }
  }
}
```

도구:

- `memory_search` — 파일 + 라인 범위가 있는 스니펫을 반환합니다.
- `memory_get` — 경로별로 메모리 파일 내용을 읽습니다.

로컬 모드:

- `agents.defaults.memorySearch.provider = "local"`로 설정합니다.
- `agents.defaults.memorySearch.local.modelPath` (GGUF 또는 `hf:` URI)를 제공합니다.
- 선택 사항: 원격 폴백을 피하려면 `agents.defaults.memorySearch.fallback = "none"`을 설정합니다.

### 메모리 도구 작동 방식

- `memory_search`는 `MEMORY.md` + `memory/**/*.md`에서 Markdown 청크 (~400 토큰 목표, 80 토큰 겹침)를 의미적으로 검색합니다. 스니펫 텍스트 (~700자 제한), 파일 경로, 라인 범위, 점수, 프로바이더/모델, 로컬 → 원격 임베딩 폴백 여부를 반환합니다. 전체 파일 페이로드는 반환되지 않습니다.
- `memory_get`은 작업 공간 상대적 특정 메모리 Markdown 파일을 읽고, 선택적으로 시작 라인과 N 라인을 지정합니다. `MEMORY.md` / `memory/` 외부 경로는 거부됩니다.
- 두 도구는 `memorySearch.enabled`가 에이전트에 대해 true로 분석될 때만 활성화됩니다.

### 무엇이 인덱싱되는지 (언제)

- 파일 유형: Markdown 전용 (`MEMORY.md`, `memory/**/*.md`).
- 인덱스 저장소: 에이전트별로 `~/.openclaw/memory/<agentId>.sqlite`에 저장 (구성 가능한 `agents.defaults.memorySearch.store.path`를 통해 구성 가능, `{agentId}` 토큰을 지원).
- 신선도: `MEMORY.md` + `memory/`의 감시자는 인덱스를 더럽게 표시합니다 (디바운스 1.5초). 세션 시작 시, 검색 시 또는 간격으로 동기화가 예약되며 비동기적으로 실행됩니다. 세션 전사는 델타 임계치를 사용하여 백그라운드 동기를 트리거합니다.
- 재인덱싱 트리거: 인덱스는 임베딩 **프로바이더/모델 + 엔드포인트 핑거프린트 + 청크 매개변수**를 저장합니다. 이러한 항목 중 하나라도 변경되면 OpenClaw는 자동으로 전체 저장소를 재설정 및 재인덱싱합니다.

### 하이브리드 검색 (BM25 + 벡터)

활성화되면, OpenClaw는 다음을 결합합니다:

- **벡터 유사성** (의미 일치, 서술이 다를 수 있음)
- **BM25 키워드 관련성** (ID, 환경 변수, 코드 심볼 등의 정확한 토큰)

귀하의 플랫폼에서 전체 텍스트 검색을 사용할 수 없는 경우, OpenClaw는 벡터 전용 검색으로 폴백합니다.

#### 하이브리드를 사용하는 이유?

벡터 검색은 "이것이 같은 것을 의미한다"에 뛰어납니다:

- "Mac Studio 게이트웨이 호스트" vs "게이트웨이를 설치한 기기"
- "파일 업데이트 디바운스" vs "매 쓰기 시 인덱싱을 피하는 것"

그러나 이는 정확도가 높고 신호가 높은 토큰에는 약할 수 있습니다:

- ID (`a828e60`, `b3b9895a…`)
- 코드 심볼 (`memorySearch.query.hybrid`)
- 오류 문자열 ("sqlite-vec unavailable")

BM25 (전체 텍스트)는 반대입니다: 정확한 토큰 문자열에는 강하지만, 재구성에서는 약합니다.
하이브리드 검색은 실용적인 중간 지점입니다: **두 검색 신호를 모두 사용하여** 자연어 쿼리와 "건초 더미 속의 바늘" 검색에서 좋은 결과를 얻을 수 있습니다.

#### 결과를 병합하는 방법 (현재 설계)

구현 스케치:

1. 두 개의 저장소에서 후보 풀을 검색합니다:

- **벡터**: 코사인 유사도에 의해 `maxResults * candidateMultiplier`에 상위.
- **BM25**: FTS5 BM25 순위로 `maxResults * candidateMultiplier`에 상위 (낮을수록 좋음).

2. BM25 순위를 0..1-ish 점수로 변환합니다:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. 청크 ID별로 후보를 통합하고 가중치 점수를 계산합니다:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

노트:

- `vectorWeight` + `textWeight`는 구성 해석에서 1.0으로 정규화되므로, 가중치는 비율로 작동합니다.
- 임베딩이 없으면 (또는 프로바이더가 0-벡터를 반환하면) 여전히 BM25를 실행하고 키워드 일치를 반환합니다.
- FTS5를 생성할 수 없으면 벡터 전용 검색을 유지합니다 (강제 실패 없음).

이것은 "IR 이론적으로 완벽한" 것은 아니지만, 간단하고 빠르며 실제 메모에서 회상/정밀성을 개선하는 경향이 있습니다.
나중에 더 정교하게 만들고 싶다면, 일반적인 다음 단계는 상호 평가 융합 (RRF) 또는 스코어 정규화
(최소/최대 또는 z-점수)입니다.

#### 사후 처리 파이프라인

벡터 및 키워드 점수를 병합한 후, 두 가지 선택적 후처리 단계가 에이전트에게 도달하기 전에 결과 목록을 정제합니다:

```
Vector + Keyword → Weighted Merge → Temporal Decay → Sort → MMR → Top-K Results
```

두 단계는 **기본적으로 꺼져** 있으며, 독립적으로 활성화할 수 있습니다.

#### MMR 재랭킹 (다양성)

하이브리드 검색이 결과를 반환할 때, 여러 청크가 비슷하거나 중복되는 내용을 포함할 수 있습니다.
예를 들어, "홈 네트워크 설정" 검색은 동일한 라우터 구성을 언급하는 서로 다른 일일 메모에서 거의 동일한 다섯 가지 단편을 반환할 수 있습니다.

**MMR (Maximal Marginal Relevance)**는 결과의 중요성과 다양성을 균형 잡기 위해 결과를 재랭킹합니다,
질문의 다른 측면을 다루면서 동일한 정보를 반복하는 대신 상위 결과가 균형을 이룹니다.

작동 방식:

1. 결과는 원래의 관련성 (벡터 + BM25 가중치 점수)으로 평가됩니다.
2. MMR는 `λ × relevance − (1−λ) × max_similarity_to_selected`를 최대화하는 결과를 선택합니다.
3. 결과 간 유사성은 토큰 분할된 콘텐츠의 자카드 텍스트 유사성을 사용하여 측정됩니다.

`lambda` 매개변수는 트레이드오프를 제어합니다:

- `lambda = 1.0` → 순수 관련성 (다양성 패널티 없음)
- `lambda = 0.0` → 최대 다양성 (관련성 무시)
- 기본값: `0.7` (균형, 약간의 관련성 편향)

**예시 — 쿼리: "가정 네트워크 설정"**

다음 메모리 파일이 있는 경우:

```
memory/2026-02-10.md  → "Omada 라우터 구성, IoT 장치를 위한 VLAN 10 설정"
memory/2026-02-08.md  → "Omada 라우터 구성, IoT VLAN 10으로 이동"
memory/2026-02-05.md  → "192.168.10.2에서 AdGuard DNS 설정"
memory/network.md     → "라우터: Omada ER605, AdGuard: 192.168.10.2, VLAN 10: IoT"
```

MMR 없음 — 상위 3개 결과:

```
1. memory/2026-02-10.md  (점수: 0.92)  ← 라우터 + VLAN
2. memory/2026-02-08.md  (점수: 0.89)  ← 라우터 + VLAN (거의 중복!)
3. memory/network.md     (점수: 0.85)  ← 참조 문서
```

MMR (λ=0.7) 사용 — 상위 3개 결과:

```
1. memory/2026-02-10.md  (점수: 0.92)  ← 라우터 + VLAN
2. memory/network.md     (점수: 0.85)  ← 참조 문서 (다양!)
3. memory/2026-02-05.md  (점수: 0.78)  ← AdGuard DNS (다양!)
```

2월 8일의 거의 중복 항목이 제외되며, 에이전트는 세 가지 서로 다른 정보를 얻습니다.

**활성화 시기:** `memory_search`가 중복되거나 거의 중복되는 스니펫을 반환하는 경우, 특히 일일 메모에서 날짜가 다른 유사한 정보가 여러 날에 걸쳐 반복되는 경우에 유용합니다.

#### 시간적 감쇄 (최신성 부여)

일일 메모가 있는 에이전트는 시간이 지남에 따라 수백 개의 날짜가 기록된 파일을 가집니다. 감쇄가 없을 경우,
6개월 전에 잘 작성된 메모가 동일한 주제의 어제 업데이트보다 우선할 수 있습니다.

**시간적 감쇄**는 각 결과의 연령에 따라 점수에 지수적 곱셈을 적용하여,
최근 메모가 자연스럽게 높은 순위를 차지하고 오래된 메모는 페이드 아웃되도록 합니다:

```
decayedScore = score × e^(-λ × ageInDays)
```

여기서 `λ = ln(2) / halfLifeDays`입니다.

기본 반감기 30일:

- 오늘의 메모: **100%** 원래 점수
- 7일 전: **~84%**
- 30일 전: **50%**
- 90일 전: **12.5%**
- 180일 전: **~1.6%**

**영구 파일은 절대 감쇄되지 않습니다:**

- `MEMORY.md` (루트 메모리 파일)
- `memory/`의 날짜가 없는 파일 (예: `memory/projects.md`, `memory/network.md`)
- 이러한 파일에는 항상 정상적으로 순위가 매겨져야 하는 지속적인 참조 정보가 포함되어 있습니다.

**날짜가 있는 일별 파일** (`memory/YYYY-MM-DD.md`)은 파일명에서 추출한 날짜를 사용합니다.
다른 소스(예: 세션 전사)는 파일 수정 시간(`mtime`)으로 대체됩니다.

**예시 — 쿼리: "Rod의 작업 일정은 무엇인가?"**

다음 메모리 파일이 있는 경우 (오늘은 2월 10일):

```
memory/2025-09-15.md  → "Rod는 월-금 업무, 10시에 스탠드업, 14시에 페어링"  (148일 전)
memory/2026-02-10.md  → "Rod는 14:15에 스탠드업, 14:45에 Zeb와 1:1"    (오늘)
memory/2026-02-03.md  → "Rod가 새 팀에 합류, 스탠드업 14:15로 이동"        (7일 전)
```

감쇄 없이:

```
1. memory/2025-09-15.md  (점수: 0.91)  ← 최상의 의 문체 일치, 그러나 오래됨!
2. memory/2026-02-10.md  (점수: 0.82)
3. memory/2026-02-03.md  (점수: 0.80)
```

감쇄와 함께 (halfLife=30):

```
1. memory/2026-02-10.md  (점수: 0.82 × 1.00 = 0.82)  ← 오늘, 감쇄 없음
2. memory/2026-02-03.md  (점수: 0.80 × 0.85 = 0.68)  ← 7일, 약한 감쇄
3. memory/2025-09-15.md  (점수: 0.91 × 0.03 = 0.03)  ← 148일, 거의 사라짐
```

9월의 오래된 노트는 비록 가장 좋은 원시 의미 일치를 가지고 있지만 맨 아래로 떨어집니다.

**활성화 시기:** 에이전트가 수개월에 걸친 일일 메모를 가지고 있고 오래된 정보가 최신 컨텍스트보다 우선되는 경우.
일일 메모가 많은 워크플로우에서 30일의 반감기는 잘 작동합니다. 이전 메모를 자주 참조할 경우 반감기를 늘리십시오 (예: 90일).

#### 구성

두 기능은 `memorySearch.query.hybrid`하에 구성됩니다:

```json5
agents: {
  defaults: {
    memorySearch: {
      query: {
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4,
          // 다양성: 중복 결과 줄이기
          mmr: {
            enabled: true,    // 기본값: false
            lambda: 0.7       // 0 = 최대 다양성, 1 = 최대 관련성
          },
          // 최신성: 새로운 메모리에 부스트 부여
          temporalDecay: {
            enabled: true,    // 기본값: false
            halfLifeDays: 30  // 점수가 30일마다 절반이 됩니다
          }
        }
      }
    }
  }
}
```

독립적으로 기능을 켤 수 있습니다:

- **MMR만** — 유사한 노트가 많지만 나이가 중요하지 않을 때 유용.
- **시간적 감쇄만** — 최신성이 중요하지만 결과가 이미 다양할 때 유용.
- **둘 다** — 많은 일일 메모 기록을 가진 에이전트에게 권장.

### 임베딩 캐시

OpenClaw는 SQLite에서 **청크 임베딩**을 캐시에 저장하여 다시 인덱싱 및 빈번한 업데이트 (특히 세션 전사)가 변경되지 않은 텍스트를 다시 임베딩하지 않도록 할 수 있습니다.

구성:

```json5
agents: {
  defaults: {
    memorySearch: {
      cache: {
        enabled: true,
        maxEntries: 50000
      }
    }
  }
}
```

### 세션 메모리 검색 (실험적)

세션 전사를 선택적으로 **인덱스**하고 이를 `memory_search`를 통해 노출할 수 있습니다.
이는 실험적 플래그 뒤에 갇혀 있습니다.

```json5
agents: {
  defaults: {
    memorySearch: {
      experimental: { sessionMemory: true },
      sources: ["memory", "sessions"]
    }
  }
}
```

노트:

- 세션 인덱싱은 **옵트인**입니다 (기본적으로 비활성화됨).
- 세션 업데이트는 디바운스되고 **델타 임계치를 넘으면 비동기적으로 인덱싱**됩니다 (최선의 노력을 다 함).
- `memory_search`는 인덱싱으로 차단되지 않습니다. 결과는 백그라운드 동기화가 완료될 때까지 약간 오래될 수 있습니다.
- 결과는 여전히 스니펫만 포함합니다; `memory_get`은 여전히 ​​메모리 파일로 제한됩니다.
- 세션 인덱싱은 에이전트별로 고립되어 있습니다 (해당 에이전트의 세션 로그만 인덱싱됨).
- 세션 로그는 디스크 (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`)에 저장됩니다. 파일 시스템 액세스 권한이 있는 모든 프로세스/사용자가 이를 읽을 수 있으므로 디스크 접근을 신뢰 경계로 처리해야 합니다. 더 강력한 격리를 위해, 에이전트를 별도의 OS 사용자나 호스트에서 실행하십시오.

델타 임계값 (기본값 표시):

```json5
agents: {
  defaults: {
    memorySearch: {
      sync: {
        sessions: {
          deltaBytes: 100000,   // ~100 KB
          deltaMessages: 50     // JSONL 라인 수
        }
      }
    }
  }
}
```

### SQLite 벡터 가속 (sqlite-vec)

sqlite-vec 확장이 가능할 때, OpenClaw는 SQLite 가상 테이블(`vec0`)에 임베딩을 저장하고
데이터베이스에서 벡터 거리 쿼리를 수행합니다. 이는 모든 임베딩을 JS로 로드하지 않고도 검색을 빠르게 유지합니다.

구성 (선택 사항):

```json5
agents: {
  defaults: {
    memorySearch: {
      store: {
        vector: {
          enabled: true,
          extensionPath: "/path/to/sqlite-vec"
        }
      }
    }
  }
}
```

노트:

- `enabled`는 기본적으로 true입니다. 비활성화되면 검색은 저장된 임베딩에 대한 형상 유사도로 폴백됩니다.
- sqlite-vec 확장이 누락되거나 로드에 실패하면, OpenClaw는 오류를 기록하고 JS 폴백(벡터 테이블 없음)을 계속 사용합니다.
- `extensionPath`는 번들된 sqlite-vec 경로를 오버라이드합니다 (사용자 정의 빌드 또는 비정규 설치 위치에 유용).

### 로컬 임베딩 자동 다운로드

- 기본 로컬 임베딩 모델: `hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf` (~0.6 GB).
- `memorySearch.provider = "local"`일 때, `node-llama-cpp`가 `modelPath`를 해결합니다. GGUF가 누락되면 **자동 다운로드**되어 캐시에 저장됩니다 (또는 설정되어 있으면 `local.modelCacheDir`로). 그런 다음 로드합니다. 다운로드는 다시 시도 시 재개됩니다.
- 네이티브 빌드 요구 사항: `pnpm approve-builds`를 실행하고, `node-llama-cpp`를 선택한 후 `pnpm rebuild node-llama-cpp`를 실행합니다.
- 폴백: 로컬 설정에 실패하고 `memorySearch.fallback = "openai"`인 경우, 원격 임베딩 (`openai/text-embedding-3-small`로 자동 전환)으로 자동 전환하고 이유를 기록합니다.

### 사용자 정의 OpenAI 호환 엔드포인트 예시

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_REMOTE_API_KEY",
        headers: {
          "X-Organization": "org-id",
          "X-Project": "project-id"
        }
      }
    }
  }
}
```

노트:

- `remote.*`는 `models.providers.openai.*`보다 우선됩니다.
- `remote.headers`는 OpenAI 헤더와 병합됩니다; 원격이 키 충돌에서 이깁니다. `remote.headers`를 생략하여 OpenAI 기본값을 사용하십시오.
