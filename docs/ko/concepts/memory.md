---
summary: "OpenClaw 메모리가 작동하는 방식 (워크스페이스 파일 + 자동 메모리 플러시)"
read_when:
  - 메모리 파일 레이아웃과 워크플로를 알고 싶을 때
  - 자동 사전 컴팩션 메모리 플러시를 조정하고 싶을 때
x-i18n:
  source_path: concepts/memory.md
  source_hash: e160dc678bb8fda2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:25:25Z
---

# Memory

OpenClaw 메모리는 **에이전트 워크스페이스에 있는 순수 Markdown**입니다. 파일이
단일한 진실의 원천이며, 모델은 디스크에 기록된 것만을 '기억'합니다.

메모리 검색 도구는 활성 메모리 플러그인에서 제공됩니다 (기본값:
`memory-core`). `plugins.slots.memory = "none"` 로 메모리 플러그인을 비활성화할 수 있습니다.

## 메모리 파일 (Markdown)

기본 워크스페이스 레이아웃은 두 개의 메모리 계층을 사용합니다:

- `memory/YYYY-MM-DD.md`
  - 일일 로그 (append-only).
  - 세션 시작 시 오늘 + 어제 내용을 읽습니다.
- `MEMORY.md` (선택 사항)
  - 큐레이션된 장기 메모리.
  - **메인, 개인 세션에서만 로드**됩니다 (그룹 컨텍스트에서는 절대 로드되지 않음).

이 파일들은 워크스페이스 아래에 있습니다 (`agents.defaults.workspace`, 기본값
`~/.openclaw/workspace`). 전체 레이아웃은 [Agent workspace](/concepts/agent-workspace)를 참고하십시오.

## 메모리를 기록해야 할 때

- 결정 사항, 선호도, 지속적인 사실은 `MEMORY.md` 에 기록합니다.
- 일상적인 노트와 실행 중인 컨텍스트는 `memory/YYYY-MM-DD.md` 에 기록합니다.
- 누군가가 '이것을 기억해 달라'고 말하면, 반드시 기록하십시오 (RAM 에만 두지 마십시오).
- 이 영역은 아직 발전 중입니다. 모델에게 메모리를 저장하라고 상기시키는 것이 도움이 되며, 모델은 무엇을 해야 할지 알고 있습니다.
- 어떤 내용이 확실히 남아야 한다면, **봇에게 메모리에 기록하라고 요청하십시오**.

## 자동 메모리 플러시 (사전 컴팩션 핑)

세션이 **자동 컴팩션에 가까워지면**, OpenClaw 는 컨텍스트가 컴팩트되기 **이전**에
지속적인 메모리를 기록하도록 모델에게 상기시키는 **무음의 에이전트 턴**을 트리거합니다.
기본 프롬프트는 모델이 _응답할 수 있음_ 을 명시적으로 말하지만, 보통은
`NO_REPLY` 가 올바른 응답이므로 사용자는 이 턴을 보지 않게 됩니다.

이는 `agents.defaults.compaction.memoryFlush` 로 제어됩니다:

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

- **소프트 임계값**: 세션 토큰 추정치가 `contextWindow - reserveTokensFloor - softThresholdTokens` 을 넘으면 플러시가 트리거됩니다.
- **기본적으로 무음**: 프롬프트에 `NO_REPLY` 가 포함되어 전달되는 것이 없습니다.
- **두 개의 프롬프트**: 사용자 프롬프트와 시스템 프롬프트가 상기 내용을 추가합니다.
- **컴팩션 사이클당 한 번의 플러시** (`sessions.json` 에서 추적).
- **워크스페이스는 쓰기 가능해야 함**: 세션이 `workspaceAccess: "ro"` 또는
  `"none"` 로 샌드박스화되어 실행되면 플러시를 건너뜁니다.

전체 컴팩션 라이프사이클은
[Session management + compaction](/reference/session-management-compaction)을 참고하십시오.

## 벡터 메모리 검색

OpenClaw 는 `MEMORY.md` 과 `memory/*.md` 에 대해 작은 벡터 인덱스를 생성할 수 있어,
표현이 달라도 의미적으로 관련된 노트를 찾을 수 있습니다.

기본값:

- 기본적으로 활성화됨.
- 메모리 파일 변경을 감시합니다 (디바운스).
- 기본적으로 원격 임베딩을 사용합니다. `memorySearch.provider` 이 설정되지 않은 경우,
  OpenClaw 는 다음 순서로 자동 선택합니다:
  1. `memorySearch.local.modelPath` 가 구성되어 있고 파일이 존재하면 `local`.
  2. OpenAI 키를 확인할 수 있으면 `openai`.
  3. Gemini 키를 확인할 수 있으면 `gemini`.
  4. Voyage 키를 확인할 수 있으면 `voyage`.
  5. 그 외에는 구성될 때까지 메모리 검색이 비활성화된 상태로 유지됩니다.
- 로컬 모드는 node-llama-cpp 를 사용하며 `pnpm approve-builds` 이 필요할 수 있습니다.
- 사용 가능한 경우 sqlite-vec 를 사용해 SQLite 내부에서 벡터 검색을 가속합니다.

원격 임베딩은 임베딩 프로바이더의 API 키가 **필수**입니다. OpenClaw 는
인증 프로필, `models.providers.*.apiKey`, 또는 환경 변수에서 키를 확인합니다.
Codex OAuth 는 채팅/완성만 포함하며 메모리 검색용 임베딩에는 **충분하지 않습니다**.
Gemini 의 경우 `GEMINI_API_KEY` 또는 `models.providers.google.apiKey` 를 사용하십시오.
Voyage 의 경우 `VOYAGE_API_KEY` 또는 `models.providers.voyage.apiKey` 를 사용하십시오.
사용자 정의 OpenAI 호환 엔드포인트를 사용할 때는 `memorySearch.remote.apiKey`
(선택적으로 `memorySearch.remote.headers`)를 설정하십시오.

### QMD 백엔드 (실험적)

`memory.backend = "qmd"` 를 설정하면 내장 SQLite 인덱서를
[QMD](https://github.com/tobi/qmd)로 교체합니다. QMD 는
BM25 + 벡터 + 재랭킹을 결합한 로컬 우선 검색 사이드카입니다.
Markdown 은 여전히 단일한 진실의 원천이며, OpenClaw 는 검색을 위해 QMD 를 호출합니다.
핵심 사항:

**사전 요구 사항**

- 기본적으로 비활성화됨. 구성별로 옵트인합니다 (`memory.backend = "qmd"`).
- QMD CLI 를 별도로 설치하고 (`bun install -g https://github.com/tobi/qmd` 또는 릴리스 다운로드),
  `qmd` 바이너리가 게이트웨이의 `PATH` 에 있도록 하십시오.
- QMD 는 확장을 허용하는 SQLite 빌드가 필요합니다 (macOS 에서는 `brew install sqlite`).
- QMD 는 Bun + `node-llama-cpp` 를 통해 완전히 로컬에서 실행되며,
  최초 사용 시 HuggingFace 에서 GGUF 모델을 자동 다운로드합니다
  (별도의 Ollama 데몬 불필요).
- Gateway(게이트웨이) 는 `XDG_CONFIG_HOME` 와
  `XDG_CACHE_HOME` 를 설정하여 `~/.openclaw/agents/<agentId>/qmd/` 아래의
  독립적인 XDG 홈에서 QMD 를 실행합니다.
- OS 지원: macOS 와 Linux 는 Bun + SQLite 설치 후 바로 동작합니다.
  Windows 는 WSL2 를 통해 가장 잘 지원됩니다.

**사이드카 실행 방식**

- Gateway(게이트웨이) 는 `~/.openclaw/agents/<agentId>/qmd/` 아래에
  자체 포함된 QMD 홈 (구성 + 캐시 + sqlite DB)을 작성합니다.
- 컬렉션은 `memory.qmd.paths` (기본 워크스페이스 메모리 파일 포함)에서
  `qmd collection add` 로 생성된 후,
  부팅 시와 구성 가능한 간격 (`memory.qmd.update.interval`, 기본값 5 분)마다
  `qmd update` + `qmd embed` 가 실행됩니다.
- 이제 부팅 시 새로고침은 기본적으로 백그라운드에서 실행되어
  채팅 시작이 차단되지 않습니다. 이전의 차단 동작을 유지하려면
  `memory.qmd.update.waitForBootSync = true` 을 설정하십시오.
- 검색은 `qmd query --json` 를 통해 실행됩니다. QMD 가 실패하거나 바이너리가
  없으면, OpenClaw 는 자동으로 내장 SQLite 관리자로 폴백하여
  메모리 도구가 계속 작동하도록 합니다.
- OpenClaw 는 현재 QMD 임베드 배치 크기 조정을 노출하지 않습니다.
  배치 동작은 QMD 자체에서 제어됩니다.
- **첫 검색은 느릴 수 있음**: QMD 는 첫 `qmd query` 실행 시
  로컬 GGUF 모델 (재랭커/쿼리 확장)을 다운로드할 수 있습니다.
  - OpenClaw 는 QMD 실행 시 `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` 를 자동 설정합니다.
  - 모델을 수동으로 사전 다운로드하고 (OpenClaw 와 동일한 인덱스를 워밍업하려면),
    에이전트의 XDG 디렉토리를 사용해 일회성 쿼리를 실행하십시오.

    OpenClaw 의 QMD 상태는 **state dir** 아래에 있습니다 (기본값 `~/.openclaw`).
    OpenClaw 가 사용하는 동일한 XDG 변수를 내보내어,
    `qmd` 이 정확히 같은 인덱스를 가리키도록 할 수 있습니다:

    ```bash
    # Pick the same state dir OpenClaw uses
    STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    if [ -d "$HOME/.moltbot" ] && [ ! -d "$HOME/.openclaw" ] \
      && [ -z "${OPENCLAW_STATE_DIR:-}" ]; then
      STATE_DIR="$HOME/.moltbot"
    fi

    export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"

    # (Optional) force an index refresh + embeddings
    qmd update
    qmd embed

    # Warm up / trigger first-time model downloads
    qmd query "test" -c memory-root --json >/dev/null 2>&1
    ```

**구성 표면 (`memory.qmd.*`)**

- `command` (기본값 `qmd`): 실행 파일 경로를 재정의합니다.
- `includeDefaultMemory` (기본값 `true`): `MEMORY.md` + `memory/**/*.md` 자동 인덱싱.
- `paths[]`: 추가 디렉토리/파일을 추가합니다
  (`path`, 선택적 `pattern`, 선택적 안정 `name`).
- `sessions`: 세션 JSONL 인덱싱에 옵트인합니다
  (`enabled`, `retentionDays`, `exportDir`).
- `update`: 새로고침 주기와 유지 관리 실행을 제어합니다:
  (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`,
  `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`).
- `limits`: 회상 페이로드를 제한합니다
  (`maxResults`, `maxSnippetChars`, `maxInjectedChars`, `timeoutMs`).
- `scope`: [`session.sendPolicy`](/gateway/configuration#session)과 동일한 스키마입니다.
  기본값은 다이렉트 메시지 전용입니다 (`deny` 전체, `allow` 다이렉트 채팅).
  이를 완화하면 그룹/채널에서 QMD 결과를 노출할 수 있습니다.
- 워크스페이스 외부에서 가져온 스니펫은 `memory_search` 결과에서
  `qmd/<collection>/<relative-path>` 로 표시됩니다. `memory_get` 는 이 접두사를 이해하고
  구성된 QMD 컬렉션 루트에서 읽습니다.
- `memory.qmd.sessions.enabled = true` 인 경우, OpenClaw 는 정제된 세션 전사본
  (User/Assistant 턴)을 `~/.openclaw/agents/<id>/qmd/sessions/` 아래의 전용 QMD 컬렉션으로 내보내어,
  `memory_search` 가 내장 SQLite 인덱스를 건드리지 않고도
  최근 대화를 회상할 수 있게 합니다.
- `memory_search` 스니펫은 이제 `memory.citations` 이
  `auto`/`on` 일 때
  `Source: <path#line>` 푸터를 포함합니다. 경로 메타데이터를 내부용으로만
  유지하려면 `memory.citations = "off"` 를 설정하십시오
  (에이전트는 `memory_get` 를 위해 경로를 여전히 받지만,
  스니펫 텍스트에는 푸터가 없고 시스템 프롬프트는 이를 인용하지 말라고 경고합니다).

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
      rules: [{ action: "allow", match: { chatType: "direct" } }]
    },
    paths: [
      { name: "docs", path: "~/notes", pattern: "**/*.md" }
    ]
  }
}
```

**인용 및 폴백**

- `memory.citations` 는 백엔드에 관계없이 적용됩니다
  (`auto`/`on`/`off`).
- `qmd` 이 실행되면, 진단에서 어떤 엔진이 결과를 제공했는지
  표시하기 위해 `status().backend = "qmd"` 을 태그합니다.
  QMD 서브프로세스가 종료되거나 JSON 출력이 파싱되지 않으면,
  검색 관리자는 경고를 기록하고 QMD 가 복구될 때까지
  내장 프로바이더 (기존 Markdown 임베딩)를 반환합니다.

### 추가 메모리 경로

기본 워크스페이스 레이아웃 외부의 Markdown 파일을 인덱싱하려면,
명시적인 경로를 추가하십시오:

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

참고 사항:

- 경로는 절대 경로 또는 워크스페이스 상대 경로일 수 있습니다.
- 디렉토리는 `.md` 파일을 재귀적으로 스캔합니다.
- Markdown 파일만 인덱싱됩니다.
- 심볼릭 링크 (파일 또는 디렉토리)는 무시됩니다.

### Gemini 임베딩 (네이티브)

프로바이더를 `gemini` 으로 설정하면 Gemini 임베딩 API 를 직접 사용합니다:

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

참고 사항:

- `remote.baseUrl` 는 선택 사항입니다 (기본값은 Gemini API 기본 URL).
- `remote.headers` 로 필요 시 추가 헤더를 설정할 수 있습니다.
- 기본 모델: `gemini-embedding-001`.

**사용자 정의 OpenAI 호환 엔드포인트** (OpenRouter, vLLM, 프록시)를 사용하려면,
OpenAI 프로바이더와 함께 `remote` 구성을 사용할 수 있습니다:

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

API 키를 설정하고 싶지 않다면 `memorySearch.provider = "local"` 를 사용하거나
`memorySearch.fallback = "none"` 을 설정하십시오.

폴백:

- `memorySearch.fallback` 는 `openai`, `gemini`,
  `local`, 또는 `none` 이 될 수 있습니다.
- 폴백 프로바이더는 기본 임베딩 프로바이더가 실패할 때만 사용됩니다.

배치 인덱싱 (OpenAI + Gemini):

- OpenAI 와 Gemini 임베딩에 대해 기본적으로 활성화되어 있습니다.
  비활성화하려면 `agents.defaults.memorySearch.remote.batch.enabled = false` 를 설정하십시오.
- 기본 동작은 배치 완료를 기다립니다. 필요 시
  `remote.batch.wait`, `remote.batch.pollIntervalMs`, `remote.batch.timeoutMinutes` 를 조정하십시오.
- 병렬로 제출할 배치 작업 수는 `remote.batch.concurrency` 로 제어합니다 (기본값: 2).
- 배치 모드는 `memorySearch.provider = "openai"` 또는 `"gemini"` 인 경우 적용되며,
  해당 API 키를 사용합니다.
- Gemini 배치 작업은 비동기 임베딩 배치 엔드포인트를 사용하며,
  Gemini Batch API 사용 가능성이 필요합니다.

왜 OpenAI 배치는 빠르고 저렴한가:

- 대규모 백필의 경우, OpenAI 는 단일 배치 작업으로 많은 임베딩 요청을 제출하고
  비동기로 처리할 수 있기 때문에 일반적으로 가장 빠른 옵션입니다.
- OpenAI 는 Batch API 워크로드에 대해 할인된 가격을 제공하므로,
  동일한 요청을 동기적으로 보내는 것보다 대규모 인덱싱 실행이 보통 더 저렴합니다.
- 자세한 내용은 OpenAI Batch API 문서와 가격을 참고하십시오:
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

구성 예시:

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

- `memory_search` — 파일 + 라인 범위를 포함한 스니펫을 반환합니다.
- `memory_get` — 경로로 메모리 파일 내용을 읽습니다.

로컬 모드:

- `agents.defaults.memorySearch.provider = "local"` 을 설정합니다.
- `agents.defaults.memorySearch.local.modelPath` (GGUF 또는 `hf:` URI)를 제공합니다.
- 선택 사항: 원격 폴백을 피하려면 `agents.defaults.memorySearch.fallback = "none"` 를 설정하십시오.

### 메모리 도구가 작동하는 방식

- `memory_search` 는 `MEMORY.md` + `memory/**/*.md` 에서
  Markdown 청크 (~400 토큰 목표, 80 토큰 오버랩)를 의미적으로 검색합니다.
  스니펫 텍스트 (약 700 자로 제한), 파일 경로, 라인 범위, 점수,
  프로바이더/모델, 로컬 → 원격 임베딩으로 폴백했는지 여부를 반환합니다.
  전체 파일 페이로드는 반환되지 않습니다.
- `memory_get` 는 특정 메모리 Markdown 파일을
  (워크스페이스 상대 경로로) 읽으며, 시작 라인과 N 라인을 선택적으로 지정할 수 있습니다.
  `MEMORY.md` / `memory/` 외부의 경로는 거부됩니다.
- 두 도구 모두 에이전트에 대해 `memorySearch.enabled` 이 true 로 해석될 때만 활성화됩니다.

### 무엇이 (언제) 인덱싱되는가

- 파일 유형: Markdown 만 (`MEMORY.md`, `memory/**/*.md`).
- 인덱스 저장소: 에이전트별 SQLite, 위치는 `~/.openclaw/memory/<agentId>.sqlite`
  (`agents.defaults.memorySearch.store.path` 로 구성 가능, `{agentId}` 토큰 지원).
- 최신성: `MEMORY.md` + `memory/` 에 대한 워처가
  인덱스를 더티로 표시합니다 (디바운스 1.5초).
  동기화는 세션 시작 시, 검색 시, 또는 간격 기반으로 예약되며 비동기로 실행됩니다.
  세션 전사본은 델타 임계값을 사용해 백그라운드 동기화를 트리거합니다.
- 재인덱싱 트리거: 인덱스는 임베딩 **프로바이더/모델 + 엔드포인트 지문 + 청킹 파라미터**를
  저장합니다. 이 중 하나라도 변경되면 OpenClaw 는 자동으로 전체 저장소를
  리셋하고 재인덱싱합니다.

### 하이브리드 검색 (BM25 + 벡터)

활성화되면 OpenClaw 는 다음을 결합합니다:

- **벡터 유사도** (의미적 일치, 표현이 달라도 됨)
- **BM25 키워드 관련성** (ID, 환경 변수, 코드 심볼과 같은 정확한 토큰)

플랫폼에서 전체 텍스트 검색을 사용할 수 없으면,
OpenClaw 는 벡터 전용 검색으로 폴백합니다.

#### 왜 하이브리드인가?

벡터 검색은 '의미가 같다'를 찾는 데 뛰어납니다:

- 'Mac Studio gateway host' vs '게이트웨이를 실행하는 머신'
- 'debounce file updates' vs '모든 쓰기마다 인덱싱을 피하기'

하지만 정확하고 신호가 강한 토큰에는 약할 수 있습니다:

- ID (`a828e60`, `b3b9895a…`)
- 코드 심볼 (`memorySearch.query.hybrid`)
- 오류 문자열 ('sqlite-vec unavailable')

BM25 (전체 텍스트)는 그 반대입니다. 정확한 토큰에는 강하지만,
의역에는 약합니다. 하이브리드 검색은 실용적인 중간 지점으로,
**두 가지 검색 신호를 모두 사용**하여
'자연어' 쿼리와 '건초 더미 속 바늘' 쿼리 모두에서
좋은 결과를 제공합니다.

#### 결과를 병합하는 방법 (현재 설계)

구현 개요:

1. 양쪽에서 후보 풀을 가져옵니다:

- **벡터**: 코사인 유사도로 상위 `maxResults * candidateMultiplier`.
- **BM25**: FTS5 BM25 랭크 기준 상위 `maxResults * candidateMultiplier` (낮을수록 좋음).

2. BM25 랭크를 0..1 정도의 점수로 변환합니다:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. 청크 ID 기준으로 후보를 합치고 가중 점수를 계산합니다:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

참고 사항:

- `vectorWeight` + `textWeight` 는 구성 해석 시 1.0 으로 정규화되므로,
  가중치는 백분율처럼 동작합니다.
- 임베딩을 사용할 수 없거나 (또는 프로바이더가 제로 벡터를 반환하면),
  BM25 는 여전히 실행되며 키워드 일치를 반환합니다.
- FTS5 를 생성할 수 없으면, 벡터 전용 검색을 유지합니다 (하드 실패 없음).

이는 'IR 이론적으로 완벽'하지는 않지만,
단순하고 빠르며 실제 노트에서 재현율/정확도를 개선하는 경향이 있습니다.
나중에 더 고급화한다면, 일반적인 다음 단계는
Reciprocal Rank Fusion (RRF) 이나 점수 정규화
(min/max 또는 z-score) 후 혼합입니다.

구성:

```json5
agents: {
  defaults: {
    memorySearch: {
      query: {
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4
        }
      }
    }
  }
}
```

### 임베딩 캐시

OpenClaw 는 SQLite 에 **청크 임베딩**을 캐시할 수 있어,
재인덱싱과 빈번한 업데이트 (특히 세션 전사본) 시
변경되지 않은 텍스트를 다시 임베딩하지 않도록 합니다.

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

선택적으로 **세션 전사본**을 인덱싱하여 `memory_search` 를 통해
노출할 수 있습니다. 이는 실험적 플래그 뒤에 있습니다.

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

참고 사항:

- 세션 인덱싱은 **옵트인**입니다 (기본값 비활성).
- 세션 업데이트는 디바운스되며 델타 임계값을 넘으면
  **비동기적으로 인덱싱**됩니다 (best-effort).
- `memory_search` 는 인덱싱을 기다리지 않습니다.
  백그라운드 동기화가 끝날 때까지 결과가 약간 오래될 수 있습니다.
- 결과는 여전히 스니펫만 포함하며,
  `memory_get` 는 메모리 파일로만 제한됩니다.
- 세션 인덱싱은 에이전트별로 격리됩니다
  (해당 에이전트의 세션 로그만 인덱싱).
- 세션 로그는 디스크에 존재합니다 (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`).
  파일 시스템 접근 권한이 있는 모든 프로세스/사용자가 읽을 수 있으므로,
  디스크 접근을 신뢰 경계로 취급하십시오.
  더 엄격한 격리를 원하면 에이전트를
  별도의 OS 사용자 또는 호스트에서 실행하십시오.

델타 임계값 (기본값 표시):

```json5
agents: {
  defaults: {
    memorySearch: {
      sync: {
        sessions: {
          deltaBytes: 100000,   // ~100 KB
          deltaMessages: 50     // JSONL lines
        }
      }
    }
  }
}
```

### SQLite 벡터 가속 (sqlite-vec)

sqlite-vec 확장을 사용할 수 있으면, OpenClaw 는 임베딩을
SQLite 가상 테이블 (`vec0`)에 저장하고,
데이터베이스 내에서 벡터 거리 쿼리를 수행합니다.
이로써 모든 임베딩을 JS 로 로드하지 않고도
검색을 빠르게 유지할 수 있습니다.

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

참고 사항:

- `enabled` 의 기본값은 true 입니다.
  비활성화되면 검색은 저장된 임베딩에 대한
  프로세스 내 코사인 유사도로 폴백합니다.
- sqlite-vec 확장이 없거나 로드에 실패하면,
  OpenClaw 는 오류를 기록하고 JS 폴백으로 계속 진행합니다
  (벡터 테이블 없음).
- `extensionPath` 는 번들된 sqlite-vec 경로를 재정의합니다
  (커스텀 빌드 또는 비표준 설치 위치에 유용).

### 로컬 임베딩 자동 다운로드

- 기본 로컬 임베딩 모델: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` (~0.6 GB).
- `memorySearch.provider = "local"` 인 경우, `node-llama-cpp` 는
  `modelPath` 를 해석합니다.
  GGUF 가 없으면 캐시로 **자동 다운로드**한 뒤
  (또는 `local.modelCacheDir` 가 설정된 경우 그 위치로)
  로드합니다. 다운로드는 재시도 시 이어서 진행됩니다.
- 네이티브 빌드 요구 사항:
  `pnpm approve-builds` 실행 → `node-llama-cpp` 선택 → `pnpm rebuild node-llama-cpp`.
- 폴백: 로컬 설정이 실패하고 `memorySearch.fallback = "openai"` 인 경우,
  자동으로 원격 임베딩 (`openai/text-embedding-3-small` 기본값, 재정의 가능)으로
  전환하며 그 이유를 기록합니다.

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

참고 사항:

- `remote.*` 는 `models.providers.openai.*` 보다 우선합니다.
- `remote.headers` 은 OpenAI 헤더와 병합되며,
  키 충돌 시 원격이 우선합니다.
  OpenAI 기본값을 사용하려면 `remote.headers` 을 생략하십시오.
