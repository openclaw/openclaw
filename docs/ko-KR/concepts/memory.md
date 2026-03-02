---
title: "메모리"
summary: "OpenClaw 메모리 작동 방식 (워크스페이스 파일 + 자동 메모리 플러시)"
read_when:
  - 메모리 파일 레이아웃과 워크플로우를 알고 싶을 때
  - 자동 사전 압축 메모리 플러시를 조정하고 싶을 때
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: concepts/memory.md
  workflow: 15
---

# 메모리

OpenClaw 메모리는 **에이전트 워크스페이스의 순수 Markdown 문서**입니다. 파일이 진실의 원천이며, 모델은 디스크에 쓰인 것만 "기억"합니다.

메모리 검색 도구는 활성 메모리 플러그인 (기본값: `memory-core`)에서 제공됩니다. `plugins.slots.memory = "none"` 설정으로 메모리 플러그인을 비활성화할 수 있습니다.

## 메모리 파일 (Markdown)

기본 워크스페이스 레이아웃은 두 가지 메모리 계층을 사용합니다:

- `memory/YYYY-MM-DD.md`
  - 일일 로그 (추가 전용).
  - 세션 시작 시 오늘과 어제를 읽습니다.
- `MEMORY.md` (선택 사항)
  - 큐레이팅된 장기 메모리.
  - **메인, 개인 세션에서만 로드** (그룹 컨텍스트에서는 절대 아님).

이 파일들은 워크스페이스 (`agents.defaults.workspace`, 기본값 `~/.openclaw/workspace`) 아래에 있습니다. 전체 레이아웃은 [에이전트 워크스페이스](/concepts/agent-workspace)를 참조하세요.

## 메모리 도구

OpenClaw는 이 Markdown 파일들을 위해 두 가지 에이전트 대면 도구를 노출합니다:

- `memory_search` — 색인된 스니펫에 대한 의미론적 회상.
- `memory_get` — 특정 Markdown 파일/라인 범위의 대상 읽기.

`memory_get`은 이제 파일이 없을 때 우아하게 성능 저하됩니다 (예: 첫 번째 쓰기 전 오늘의 일일 로그). 내장 관리자와 QMD 백엔드 모두 ENOENT를 발생시키는 대신 `{ text: "", path }`를 반환하므로, 에이전트는 "아직 아무것도 기록되지 않음"을 처리하고 도구 호출을 try/catch 논리로 래핑하지 않고도 워크플로우를 계속할 수 있습니다.

## 언제 메모리를 쓸 것인가

- 결정, 선호도, 내구적인 사실은 `MEMORY.md`로 이동합니다.
- 일상적인 노트와 실행 중인 컨텍스트는 `memory/YYYY-MM-DD.md`로 이동합니다.
- 누군가 "이걸 기억해"라고 말하면, 기록해 두세요 (RAM에 보관하지 마세요).
- 이 영역은 여전히 진화하고 있습니다. 모델이 메모리를 저장하도록 상기시키는 것이 도움됩니다; 모델은 무엇을 할지 알 것입니다.
- 뭔가 지속되기를 원하면, **봇에게 메모리에 쓰도록 요청하세요**.

## 자동 메모리 플러시 (사전 압축 핑)

세션이 **자동 압축에 가까울 때**, OpenClaw는 모델에게 컨텍스트가 압축되기 **전에** 내구적인 메모리를 쓰도록 상기시키는 **무음 에이전트 턴**을 트리거합니다. 기본 프롬프트는 모델이 _응답할 수 있지만_, 일반적으로 `NO_REPLY`가 정답이므로 사용자는 이 턴을 볼 수 없습니다.

이는 `agents.defaults.compaction.memoryFlush`로 제어됩니다:

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

- **소프트 임계값**: 플러시는 세션 토큰 추정이 `contextWindow - reserveTokensFloor - softThresholdTokens`를 교차할 때 트리거됩니다.
- **무음**: 기본적으로 프롬프트에 `NO_REPLY`가 포함되므로 아무것도 배달되지 않습니다.
- **두 개의 프롬프트**: 사용자 프롬프트와 시스템 프롬프트가 상기를 추가합니다.
- **압축 사이클당 한 번 플러시** (`sessions.json`에서 추적).
- **워크스페이스는 쓰기 가능해야 함**: 세션이 `workspaceAccess: "ro"` 또는 `"none"` 샌드박스로 실행되면, 플러시는 스킵됩니다.

전체 압축 수명주기는 [세션 관리 + 압축](/reference/session-management-compaction)을 참조하세요.

## 벡터 메모리 검색

OpenClaw는 `MEMORY.md`와 `memory/*.md`에 대한 작은 벡터 색인을 구성할 수 있으므로, 의미론적 쿼리는 표현이 달라도 관련 노트를 찾을 수 있습니다.

기본값:

- 기본적으로 활성화됨.
- 메모리 파일의 변경을 감시합니다 (디바운스 처리).
- `agents.defaults.memorySearch` 아래에서 메모리 검색을 구성합니다 (최상위 `memorySearch` 아님).
- 기본적으로 원격 임베딩을 사용합니다. `memorySearch.provider`가 설정되지 않으면, OpenClaw는 자동 선택합니다:
  1. `local`은 `memorySearch.local.modelPath`가 구성되고 파일이 존재하는 경우.
  2. `openai`은 OpenAI 키를 해결할 수 있는 경우.
  3. `gemini`은 Gemini 키를 해결할 수 있는 경우.
  4. `voyage`는 Voyage 키를 해결할 수 있는 경우.
  5. `mistral`은 Mistral 키를 해결할 수 있는 경우.
  6. 그 외에는 메모리 검색이 구성될 때까지 비활성화됨.
- 로컬 모드는 node-llama-cpp를 사용하며 `pnpm approve-builds`가 필요할 수 있습니다.
- 사용 가능한 경우 sqlite-vec를 사용하여 SQLite 내부의 벡터 검색을 가속합니다.

원격 임베딩은 임베딩 공급자를 위한 API 키가 **필수**입니다. OpenClaw는 인증 프로필, `models.providers.*.apiKey`, 또는 환경 변수에서 키를 해결합니다. Codex OAuth는 채팅/완료만 포함하며 메모리 검색을 위한 임베딩을 충족하지 **않습니다**. Gemini의 경우, `GEMINI_API_KEY` 또는 `models.providers.google.apiKey`를 사용합니다. Voyage의 경우, `VOYAGE_API_KEY` 또는 `models.providers.voyage.apiKey`를 사용합니다. Mistral의 경우, `MISTRAL_API_KEY` 또는 `models.providers.mistral.apiKey`를 사용합니다.
사용자 정의 OpenAI 호환 엔드포인트를 사용할 때, `memorySearch.remote.apiKey` (및 선택적 `memorySearch.remote.headers`)를 설정합니다.

### QMD 백엔드 (실험적)

`memory.backend = "qmd"`를 설정하여 내장 SQLite 색인기를 [QMD](https://github.com/tobi/qmd): BM25 + 벡터 + 순위변경을 결합하는 로컬 중심 검색 사이드카로 교체합니다. Markdown은 진실의 원천으로 유지됩니다; OpenClaw는 검색을 위해 QMD로 셸 아웃합니다. 핵심 사항:

**전제조건**

- 기본적으로 비활성화됨. 구성당 선택 (`memory.backend = "qmd"`).
- QMD CLI를 별도로 설치합니다 (`bun install -g https://github.com/tobi/qmd` 또는 릴리스 잡기) 그리고 `qmd` 바이너리가 게이트웨이의 `PATH`에 있는지 확인합니다.
- QMD는 확장을 허용하는 SQLite 빌드가 필요합니다 (macOS에서 `brew install sqlite`).
- QMD는 Bun + `node-llama-cpp`를 통해 완전히 로컬로 실행되며 HuggingFace에서 GGUF 모델을 자동 다운로드합니다 (별도의 Ollama 데몬 불필요).
- 게이트웨이는 `XDG_CONFIG_HOME` 및 `XDG_CACHE_HOME`을 설정하여 QMD를 자체 포함된 XDG 홈 `~/.openclaw/agents/<agentId>/qmd/` 아래에서 실행합니다.
- OS 지원: macOS와 Linux는 Bun + SQLite를 설치한 후 즉시 작동합니다. Windows는 WSL2를 통해 가장 잘 지원됩니다.

**사이드카 실행 방식**

- 게이트웨이는 `~/.openclaw/agents/<agentId>/qmd/` (구성 + 캐시 + sqlite DB) 아래에 자체 포함된 QMD 홈을 씁니다.
- 컬렉션은 `qmd collection add`를 통해 `memory.qmd.paths` (기본 워크스페이스 메모리 파일 포함)에서 생성되며, `qmd update` + `qmd embed`는 부팅 시 그리고 구성 가능한 간격에서 실행됩니다 (`memory.qmd.update.interval`, 기본 5m).
- 게이트웨이는 이제 시작 시 QMD 관리자를 초기화하므로, 첫 번째 `memory_search` 호출 전에도 주기적 업데이트 타이머가 무장됩니다.
- 부팅 새로고침은 이제 기본적으로 백그라운드에서 실행되므로 채팅 시작이 차단되지 않습니다; 이전 차단 동작을 유지하려면 `memory.qmd.update.waitForBootSync = true`를 설정합니다.
- 검색은 `memory.qmd.searchMode`를 통해 실행됩니다 (기본 `qmd search --json`; `vsearch` 및 `query`도 지원). 선택된 모드가 QMD 빌드에 대한 플래그를 거부하면, OpenClaw는 `qmd query`로 다시 시도합니다. QMD가 실패하거나 바이너리가 누락되면, OpenClaw는 자동으로 내장 SQLite 관리자로 폴백하므로 메모리 도구는 계속 작동합니다.
- OpenClaw는 오늘 QMD 임베드 배치 크기 조정을 노출하지 않습니다; 배치 동작은 QMD 자체에서 제어됩니다.
- **첫 번째 검색이 느릴 수 있음**: QMD는 첫 번째 `qmd query` 실행에서 로컬 GGUF 모델 (순위변경자/쿼리 확장)을 다운로드할 수 있습니다.
  - OpenClaw는 QMD를 실행할 때 `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`을 자동으로 설정합니다.
  - 모델을 미리 다운로드하고 싶으면 (그리고 OpenClaw가 사용하는 동일한 색인을 데우려면), 에이전트의 XDG 디렉토리로 1회용 쿼리를 실행합니다.

    OpenClaw의 QMD 상태는 **상태 디렉토리** 아래에 있습니다 (기본값 `~/.openclaw`).
    OpenClaw가 사용하는 동일한 인덱스로 `qmd`를 가리키려면, 동일한 XDG 변수를 내보냅니다
    OpenClaw가 사용합니다:

    ```bash
    # OpenClaw가 사용하는 동일한 상태 디렉토리를 선택합니다
    STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"

    export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"

    # (선택 사항) 인덱스 새로고침 + 임베딩 강제
    qmd update
    qmd embed

    # 워밍 업 / 첫 번째 모델 다운로드 트리거
    qmd query "test" -c memory-root --json >/dev/null 2>&1
    ```

**구성 표면 (`memory.qmd.*`)**

- `command` (기본 `qmd`): 실행 파일 경로 재정의.
- `searchMode` (기본 `search`): `memory_search` (`search`, `vsearch`, `query`)를 지원하는 QMD 명령 선택.
- `includeDefaultMemory` (기본 `true`): `MEMORY.md` + `memory/**/*.md`를 자동 색인.
- `paths[]`: 추가 디렉토리/파일 추가 (`path`, 선택적 `pattern`, 선택적 안정 `name`).
- `sessions`: 세션 JSONL 색인 선택 (`enabled`, `retentionDays`, `exportDir`).
- `update`: 새로고침 카덴스 및 유지보수 실행 제어:
  (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`,
  `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`).
- `limits`: 회상 페이로드 클램프 (`maxResults`, `maxSnippetChars`,
  `maxInjectedChars`, `timeoutMs`).
- `scope`: [`session.sendPolicy`](/gateway/configuration#session)와 동일한 스키마.
  기본값은 DM만 (`deny` 모두, `allow` 직접 채팅); 그룹/채널에서 QMD 히트를 표시하도록 느슨하게 합니다.
  - `match.keyPrefix`는 **정규화된** 세션 키 (소문자, 선행 `agent:<id>:` 제거)와 일치합니다. 예: `discord:channel:`.
  - `match.rawKeyPrefix`는 **원본** 세션 키 (소문자)와 일치하며, `agent:<id>:`를 포함합니다. 예: `agent:main:discord:`.
  - 레거시: `match.keyPrefix: "agent:..."`은 여전히 원본 키 접두사로 취급되지만, 명확성을 위해 `rawKeyPrefix`를 선호합니다.
- `scope`이 검색을 거부할 때, OpenClaw는 파생된 `channel`/`chatType`으로 경고를 기록하므로 빈 결과를 더 쉽게 디버그할 수 있습니다.
- 워크스페이스 외부에서 소싱된 스니펫은 `qmd/<collection>/<relative-path>`로 나타납니다 `memory_search` 결과에서; `memory_get`은 해당 접두사를 이해하고 구성된 QMD 컬렉션 루트에서 읽습니다.
- `memory.qmd.sessions.enabled = true`일 때, OpenClaw는 세정된 세션 대사 (사용자/보조자 턴)를 `~/.openclaw/agents/<id>/qmd/sessions/` 아래의 전용 QMD 컬렉션으로 내보내므로, `memory_search`는 내장 SQLite 색인을 건드리지 않고도 최근 대화를 회상할 수 있습니다.
- `memory_search` 스니펫은 이제 `memory.citations`가 `auto`/`on`일 때 `Source: <path#line>` 바닥글을 포함합니다; `memory.citations = "off"`로 설정하여 경로 메타데이터를 내부로 유지합니다 (에이전트는 여전히 `memory_get`을 위해 경로를 받지만, 스니펫 텍스트는 바닥글을 생략하고 시스템 프롬프트는 에이전트에게 이를 인용하지 않도록 경고합니다).

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
        // 정규화된 세션 키 접두사 (`agent:<id>:` 제거).
        { action: "deny", match: { keyPrefix: "discord:channel:" } },
        // 원본 세션 키 접두사 (`agent:<id>:` 포함).
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

- `memory.citations`는 백엔드와 무관하게 적용됩니다 (`auto`/`on`/`off`).
- QMD를 실행할 때, `status().backend = "qmd"`를 태그하므로 진단이 어떤 엔진이 결과를 제공했는지 표시합니다. QMD 서브프로세스가 종료되거나 JSON 출력을 구문 분석할 수 없으면, 검색 관리자가 경고를 기록하고 QMD가 복구될 때까지 내장 공급자 (기존 Markdown 임베딩)를 반환합니다.

### 추가 메모리 경로

기본 워크스페이스 레이아웃 외부의 Markdown 파일을 색인하려면 명시적 경로를 추가하세요:

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

- 경로는 절대 또는 워크스페이스 상대일 수 있습니다.
- 디렉토리는 `.md` 파일에 대해 재귀적으로 스캔됩니다.
- Markdown 파일만 색인됩니다.
- 심볼릭 링크는 무시됩니다 (파일 또는 디렉토리).

### Gemini 임베딩 (네이티브)

공급자를 `gemini`로 설정하여 Gemini 임베딩 API를 직접 사용합니다:

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

- `remote.baseUrl`는 선택 사항입니다 (Gemini API 기본 URL 기본값).
- `remote.headers`를 사용하면 필요한 경우 추가 헤더를 추가할 수 있습니다.
- 기본 모델: `gemini-embedding-001`.

**사용자 정의 OpenAI 호환 엔드포인트** (OpenRouter, vLLM, 또는 프록시)를 사용하려면, OpenAI 공급자와 함께 `remote` 구성을 사용할 수 있습니다:

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

API 키를 설정하지 않으려면 `memorySearch.provider = "local"`을 사용하거나 `memorySearch.fallback = "none"`을 설정하세요.

폴백:

- `memorySearch.fallback`은 `openai`, `gemini`, `voyage`, `mistral`, `local`, 또는 `none`일 수 있습니다.
- 폴백 공급자는 기본 임베딩 공급자가 실패할 때만 사용됩니다.

배치 색인 (OpenAI + Gemini + Voyage):

- 기본적으로 비활성화됨. 대용량 코퍼스 색인을 위해 `agents.defaults.memorySearch.remote.batch.enabled = true`를 설정하여 활성화 (OpenAI, Gemini, Voyage).
- 기본 동작은 배치 완료를 기다립니다; 필요한 경우 `remote.batch.wait`, `remote.batch.pollIntervalMs`, `remote.batch.timeoutMinutes`를 조정합니다.
- `remote.batch.concurrency`를 설정하여 병렬로 제출하는 배치 작업 수를 제어합니다 (기본: 2).
- 배치 모드는 `memorySearch.provider = "openai"` 또는 `"gemini"`일 때 적용되며 해당 API 키를 사용합니다.
- Gemini 배치 작업은 비동기 임베딩 배치 엔드포인트를 사용하며 Gemini Batch API 가용성이 필요합니다.

OpenAI 배치가 빠르고 저렴한 이유:

- 대용량 백필의 경우, OpenAI는 일반적으로 많은 임베딩 요청을 단일 배치 작업에 제출할 수 있고 OpenAI가 비동기적으로 처리하도록 할 수 있기 때문에 우리가 지원하는 가장 빠른 옵션입니다.
- OpenAI는 Batch API 워크로드에 대한 할인 가격을 제공하므로 대규모 색인 실행은 일반적으로 동일한 요청을 동기적으로 전송하는 것보다 저렴합니다.
- OpenAI Batch API 문서 및 가격을 참조하세요:
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

- `memory_search` — 파일 + 라인 범위가 있는 스니펫 반환.
- `memory_get` — 경로별로 메모리 파일 콘텐츠 읽기.

로컬 모드:

- `agents.defaults.memorySearch.provider = "local"`을 설정합니다.
- `agents.defaults.memorySearch.local.modelPath` (GGUF 또는 `hf:` URI) 제공.
- 선택 사항: `agents.defaults.memorySearch.fallback = "none"`을 설정하여 원격 폴백을 방지합니다.

### 메모리 도구 작동 방식

- `memory_search`는 `MEMORY.md` + `memory/**/*.md`의 Markdown 청크 (~400 토큰 목표, 80 토큰 오버랩)를 의미론적으로 검색합니다. 스니펫 텍스트 (~700 자 한도), 파일 경로, 라인 범위, 점수, 공급자/모델, 로컬 → 원격 임베딩에서 폴백했는지 여부를 반환합니다. 전체 파일 페이로드는 반환되지 않습니다.
- `memory_get`은 특정 메모리 Markdown 파일 (워크스페이스 상대)을 읽으며, 선택적으로 시작 라인에서 N 라인에 대해 읽습니다. `MEMORY.md` / `memory/` 외부의 경로는 거부됩니다.
- 두 도구 모두 `memorySearch.enabled`이 에이전트에 대해 true로 해결될 때만 활성화됩니다.

### 색인되는 것 (그리고 언제)

- 파일 유형: Markdown만 (`MEMORY.md`, `memory/**/*.md`).
- 색인 저장소: 에이전트별 SQLite at `~/.openclaw/memory/<agentId>.sqlite` (구성 가능 via `agents.defaults.memorySearch.store.path`, `{agentId}` 토큰 지원).
- 신선도: `MEMORY.md` + `memory/`에서 감시자가 색인을 더티로 표시합니다 (디바운스 1.5초). 동기화는 세션 시작 시, 검색 시 또는 간격으로 예약되며 비동기적으로 실행됩니다. 세션 대사는 델타 임계값을 사용하여 백그라운드 동기화를 트리거합니다.
- 재색인 트리거: 색인은 임베딩 **공급자/모델 + 엔드포인트 지문 + 청킹 params**를 저장합니다. 이 중 하나가 변경되면, OpenClaw는 자동으로 전체 저장소를 재설정하고 재색인합니다.

### 하이브리드 검색 (BM25 + 벡터)

활성화되면, OpenClaw는 다음을 결합합니다:

- **벡터 유사성** (의미론적 일치, 표현은 달라질 수 있음)
- **BM25 키워드 관련성** (ID, env vars, 코드 심볼과 같은 정확한 토큰)

전체 텍스트 검색을 사용할 수 없으면, OpenClaw는 벡터 전용 검색으로 폴백합니다.

#### 하이브리드를 선택하는 이유?

벡터 검색은 "이는 같은 의미":

- "Mac Studio 게이트웨이 호스트" vs "게이트웨이를 실행하는 머신"
- "파일 업데이트 디바운스" vs "모든 쓰기에서 색인화 방지"

하지만 정확하고 신호가 높은 토큰에서는 약할 수 있습니다:

- ID (`a828e60`, `b3b9895a…`)
- 코드 심볼 (`memorySearch.query.hybrid`)
- 오류 문자열 ("sqlite-vec unavailable")

BM25 (전체 텍스트)는 정반대입니다: 정확한 토큰에는 강하고 의역에는 약합니다.
하이브리드 검색은 실용적인 중간 지점입니다: **두 검색 신호를 모두 사용**하므로 "자연 언어" 쿼리와 "건초 더미 속의 바늘" 쿼리 모두에 대해 좋은 결과를 얻습니다.

#### 결과를 병합하는 방식 (현재 설계)

구현 스케치:

1. 양쪽에서 후보 풀을 검색합니다:

- **벡터**: 코사인 유사성으로 상위 `maxResults * candidateMultiplier`.
- **BM25**: FTS5 BM25 순위로 상위 `maxResults * candidateMultiplier` (낮음이 더 나음).

2. BM25 순위를 0..1-ish 점수로 변환합니다:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. 청크 id별로 후보를 통합하고 가중 점수를 계산합니다:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

노트:

- `vectorWeight` + `textWeight`는 구성 해석에서 1.0으로 정규화되므로, 가중치는 백분율처럼 작동합니다.
- 임베딩을 사용할 수 없으면 (또는 공급자가 0 벡터를 반환하면), BM25를 실행하고 키워드 일치를 반환합니다.
- FTS5를 만들 수 없으면, 벡터 전용 검색을 유지합니다 (하드 실패 없음).

이것은 "IR 이론 완벽"하지 않지만, 간단하고, 빠르고, 실제 노트에서 회상/정밀도를 개선하는 경향이 있습니다.
나중에 더 화려해지고 싶으면, 일반적인 다음 단계는 상호 순위 퓨전 (RRF) 또는 혼합 전 점수 정규화 (최소/최대 또는 z 점수)입니다.

#### 사후 처리 파이프라인

벡터와 키워드 점수를 병합한 후, 두 선택적 사후 처리 단계는 결과 목록을 에이전트에 도달하기 전에 정제합니다:

```
벡터 + 키워드 → 가중 병합 → 시간 붕괴 → 정렬 → MMR → 상위 K 결과
```

두 단계 모두 **기본적으로 비활성화됨**이며 독립적으로 활성화할 수 있습니다.

#### MMR 순위변경 (다양성)

하이브리드 검색이 결과를 반환할 때, 여러 청크는 유사하거나 겹치는 콘텐츠를 포함할 수 있습니다.
예를 들어, "홈 네트워크 설정"을 검색하면 동일한 라우터 구성을 모두 언급하는 다양한 일일 노트에서 5개의 거의 동일한 스니펫을 반환할 수 있습니다.

**MMR (Maximal Marginal Relevance)**는 관련성과 다양성을 균형 있게 유지하도록 결과를 순위변경하므로, 상위 결과는 동일한 정보를 반복하는 대신 쿼리의 다른 측면을 포함합니다.

작동 방식:

1. 결과는 원본 관련성 (벡터 + BM25 가중 점수)으로 점수가 매겨집니다.
2. MMR은 반복적으로 `λ × relevance − (1−λ) × max_similarity_to_selected`를 최대화하는 결과를 선택합니다.
3. 결과 간 유사성은 토큰화된 콘텐츠에 대한 Jaccard 텍스트 유사성으로 측정됩니다.

`lambda` 매개변수는 트레이드오프를 제어합니다:

- `lambda = 1.0` → 순수 관련성 (다양성 페널티 없음)
- `lambda = 0.0` → 최대 다양성 (관련성 무시)
- 기본: `0.7` (균형, 약간의 관련성 편향)

**예 — 쿼리: "홈 네트워크 설정"**

이 메모리 파일이 주어진 경우:

```
memory/2026-02-10.md  → "Omada 라우터 구성, VLAN 10을 IoT 장치로 설정"
memory/2026-02-08.md  → "Omada 라우터 구성, IoT를 VLAN 10으로 이동"
memory/2026-02-05.md  → "192.168.10.2에서 AdGuard DNS 설정"
memory/network.md     → "라우터: Omada ER605, AdGuard: 192.168.10.2, VLAN 10: IoT"
```

MMR 없음 — 상위 3개 결과:

```
1. memory/2026-02-10.md  (점수: 0.92)  ← 라우터 + VLAN
2. memory/2026-02-08.md  (점수: 0.89)  ← 라우터 + VLAN (거의 중복!)
3. memory/network.md     (점수: 0.85)  ← 참조 문서
```

MMR (λ=0.7) 포함 — 상위 3개 결과:

```
1. memory/2026-02-10.md  (점수: 0.92)  ← 라우터 + VLAN
2. memory/network.md     (점수: 0.85)  ← 참조 문서 (다양함!)
3. memory/2026-02-05.md  (점수: 0.78)  ← AdGuard DNS (다양함!)
```

2월 8일의 거의 중복된 것이 빠져 있고, 에이전트는 3가지 고유한 정보를 얻습니다.

**언제 활성화할지**: `memory_search`가 중복되거나 거의 중복된 스니펫을 반환하는 것을 발견하면, 특히 일일 노트가 종종 며칠에 걸쳐 유사한 정보를 반복하는 경우.

#### 시간 붕괴 (최근성 부스트)

일일 노트가 있는 에이전트는 시간이 지남에 따라 수백 개의 일일 파일을 축적합니다. 붕괴가 없으면, 6개월 전의 잘 작성된 노트는 동일한 주제에 대한 어제 업데이트를 능가할 수 있습니다.

**시간 붕괴**는 각 결과의 나이를 기반으로 스코어에 지수 승수를 적용하므로, 최근 메모리는 자연스럽게 더 높은 순위이며 오래된 것은 흐릿해집니다:

```
decayedScore = score × e^(-λ × ageInDays)
```

여기서 `λ = ln(2) / halfLifeDays`.

30일의 기본 반감기:

- 오늘의 노트: 원본 점수의 **100%**
- 7일 전: **~84%**
- 30일 전: **50%**
- 90일 전: **12.5%**
- 180일 전: **~1.6%**

**상록 파일은 절대 붕괴되지 않습니다:**

- `MEMORY.md` (루트 메모리 파일)
- `memory/` (예: `memory/projects.md`, `memory/network.md`)의 일일 이외 파일
- 이들은 항상 정상적으로 순위가 매겨져야 하는 내구적인 참조 정보를 포함합니다.

**일일 파일** (`memory/YYYY-MM-DD.md`)는 파일 이름에서 추출한 날짜를 사용합니다.
다른 소스 (예: 세션 대사)는 파일 수정 시간 (`mtime`)으로 폴백합니다.

**예 — 쿼리: "Rod의 작업 일정은 어떻게 되나요?"**

이 메모리 파일이 주어진 경우 (오늘은 2월 10일):

```
memory/2025-09-15.md  → "Rod는 월-금, 10am 스탠드업, 2pm 페어링"  (148일 전)
memory/2026-02-10.md  → "Rod는 14:15 스탠드업, 14:45 Zeb와 1:1"    (오늘)
memory/2026-02-03.md  → "Rod가 새로운 팀 시작, 스탠드업 14:15로 이동"        (7일 전)
```

붕괴 없음:

```
1. memory/2025-09-15.md  (점수: 0.91)  ← 최고의 의미론적 일치, 하지만 낡음!
2. memory/2026-02-10.md  (점수: 0.82)
3. memory/2026-02-03.md  (점수: 0.80)
```

붕괴 (halfLife=30):

```
1. memory/2026-02-10.md  (점수: 0.82 × 1.00 = 0.82)  ← 오늘, 붕괴 없음
2. memory/2026-02-03.md  (점수: 0.80 × 0.85 = 0.68)  ← 7일, 온화한 붕괴
3. memory/2025-09-15.md  (점수: 0.91 × 0.03 = 0.03)  ← 148일, 거의 없음
```

9월의 낡은 노트는 최고의 원본 의미론적 일치에도 불구하고 하단으로 떨어집니다.

**언제 활성화할지**: 에이전트가 수개월의 일일 노트를 가지고 있고 오래된 낡은 정보가 최근 컨텍스트를 능가하는 것을 발견하면. 30일의 반감기는 일일 노트가 많은 워크플로우에 잘 작동합니다; 더 자주 오래된 노트를 참조하면 증가합니다 (예: 90일).

#### 구성

두 기능 모두 `memorySearch.query.hybrid` 아래에서 구성됩니다:

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
          // 다양성: 중복 결과 감소
          mmr: {
            enabled: true,    // 기본: false
            lambda: 0.7       // 0 = 최대 다양성, 1 = 최대 관련성
          },
          // 최근성: 새로운 메모리 부스트
          temporalDecay: {
            enabled: true,    // 기본: false
            halfLifeDays: 30  // 점수는 30일마다 반감
          }
        }
      }
    }
  }
}
```

두 기능을 독립적으로 활성화할 수 있습니다:

- **MMR만** — 많은 유사한 노트가 있지만 나이가 중요하지 않을 때 유용합니다.
- **시간 붕괴만** — 최근성이 중요하지만 결과가 이미 다양할 때 유용합니다.
- **둘 다** — 대규모 장기 실행 일일 노트 기록이 있는 에이전트에 권장됩니다.

### 임베딩 캐시

OpenClaw는 SQLite에서 **청크 임베딩**을 캐시할 수 있으므로 재색인 및 빈번한 업데이트 (특히 세션 대사)는 변경되지 않은 텍스트를 재 임베드하지 않습니다.

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

선택적으로 **세션 대사**를 색인하고 `memory_search`를 통해 표시할 수 있습니다.
이것은 실험적 플래그 뒤에 게이팅됩니다.

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

- 세션 색인은 **선택 사항** (기본적으로 비활성화됨).
- 세션 업데이트는 디바운스되고 **비동기적으로 색인**됩니다 (델타 임계값을 교차할 때 최선의 노력).
- `memory_search`는 절대 색인화를 차단하지 않습니다; 결과는 배경 동기화가 완료될 때까지 약간 낡을 수 있습니다.
- 결과는 여전히 스니펫만 포함합니다; `memory_get`은 메모리 파일로 제한된 상태를 유지합니다.
- 세션 색인화는 에이전트별로 격리됩니다 (해당 에이전트의 세션 로그만 색인됨).
- 세션 로그는 디스크에 있습니다 (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`). 파일 시스템 액세스가 있는 모든 프로세스/사용자가 읽을 수 있으므로, 파일 시스템 액세스를 신뢰 경계로 취급합니다. 더 엄격한 격리를 위해 별도의 OS 사용자 또는 호스트에서 에이전트를 실행합니다.

델타 임계값 (기본값 표시):

```json5
agents: {
  defaults: {
    memorySearch: {
      sync: {
        sessions: {
          deltaBytes: 100000,   // ~100 KB
          deltaMessages: 50     // JSONL 라인
        }
      }
    }
  }
}
```

### SQLite 벡터 가속 (sqlite-vec)

sqlite-vec 확장을 사용할 수 있으면, OpenClaw는 SQLite 가상 테이블 (`vec0`)에 임베딩을 저장하고 데이터베이스에서 벡터 거리 쿼리를 수행합니다. 이는 모든 임베딩을 JS로 로드하지 않고도 검색을 빠르게 유지합니다.

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

- `enabled`은 기본적으로 true이고; 비활성화되면, 검색은 저장된 임베딩에 대한 인프로세스 코사인 유사성으로 폴백합니다.
- sqlite-vec 확장이 누락되거나 로드되지 못하면, OpenClaw는 오류를 기록하고 JS 폴백을 계속합니다 (벡터 테이블 없음).
- `extensionPath`는 번들 sqlite-vec 경로를 재정의합니다 (사용자 정의 빌드 또는 비표준 설치 위치에 유용).

### 로컬 임베딩 자동 다운로드

- 기본 로컬 임베딩 모델: `hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf` (~0.6 GB).
- `memorySearch.provider = "local"`일 때, `node-llama-cpp`는 `modelPath`를 해석합니다; GGUF가 누락되면 캐시로 **자동 다운로드**합니다 (또는 설정된 경우 `local.modelCacheDir`), 그 다음 로드합니다. 다운로드는 재시도 시 재개됩니다.
- 네이티브 빌드 요구사항: `pnpm approve-builds` 실행, `node-llama-cpp` 선택, 그 다음 `pnpm rebuild node-llama-cpp`.
- 폴백: 로컬 설정이 실패하고 `memorySearch.fallback = "openai"`이면, 자동으로 원격 임베딩 (`openai/text-embedding-3-small` 재정의되지 않으면)으로 전환하고 이유를 기록합니다.

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

- `remote.*`은 `models.providers.openai.*`보다 우선합니다.
- `remote.headers`는 OpenAI 헤더와 병합됩니다; 원격이 키 충돌에서 승리합니다. `remote.headers`를 생략하여 OpenAI 기본값을 사용합니다.
