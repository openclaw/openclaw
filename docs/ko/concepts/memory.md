---
read_when:
    - 메모리 파일 레이아웃과 작업 흐름을 원합니다.
    - 자동 사전 압축 메모리 플러시를 조정하고 싶습니다.
summary: OpenClaw 메모리 작동 방식(작업 공간 파일 + 자동 메모리 플러시)
x-i18n:
    generated_at: "2026-02-08T15:56:00Z"
    model: gtx
    provider: google-translate
    source_hash: e160dc678bb8fda2d30b9b2f1ba4d7e4e220997b7a9adc97a084bc43a2bf1dfe
    source_path: concepts/memory.md
    workflow: 15
---

# 메모리

OpenClaw 메모리는 **에이전트 작업 영역의 일반 마크다운**. 파일은
진실의 근원; 모델은 디스크에 기록된 내용만 "기억"합니다.

메모리 검색 도구는 활성 메모리 플러그인에서 제공됩니다(기본값:
`memory-core`). 다음을 사용하여 메모리 플러그인을 비활성화합니다. `plugins.slots.memory = "none"`.

## 메모리 파일(마크다운)

기본 작업 공간 레이아웃은 두 개의 메모리 레이어를 사용합니다.

- `memory/YYYY-MM-DD.md`
  - 일일 로그(추가 전용)
  - 오늘 + 어제 세션 시작 시 읽으세요.
- `MEMORY.md` (선택 과목)
  - 선별된 장기 기억.
  - **기본 비공개 세션에서만 로드** (그룹 상황에서는 절대 사용하지 않음)

이러한 파일은 작업 공간(`agents.defaults.workspace`, 기본
`~/.openclaw/workspace`). 보다 [상담원 작업공간](/concepts/agent-workspace) 전체 레이아웃을 위해.

## 메모리를 쓸 때

- 결정, 선호도 및 지속 가능한 사실은 다음과 같습니다. `MEMORY.md`.
- 일일 메모 및 실행 컨텍스트는 다음으로 이동합니다. `memory/YYYY-MM-DD.md`.
- 누군가가 "이것을 기억하세요"라고 말하면 적어두세요(RAM에 보관하지 마세요).
- 이 영역은 여전히 ​​발전하고 있습니다. 모델이 기억을 저장하도록 상기시키는 데 도움이 됩니다. 무엇을 해야할지 알게 될 것입니다.
- 뭔가 달라붙고 싶다면, **봇에게 작성해달라고 요청하세요** 기억 속으로.

## 자동 메모리 플러시(압축 전 핑)

세션이 있을 때 **자동 압축에 가깝습니다.**, OpenClaw는 **침묵하다,
대리인 차례** 모델에게 내구성 있는 메모리를 쓰도록 상기시킵니다. **~ 전에** 는
컨텍스트가 압축되었습니다. 기본 프롬프트는 모델을 명시적으로 말합니다. _대답할 수도 있다_,
하지만 보통 `NO_REPLY` 올바른 응답이므로 사용자는 이번 차례를 볼 수 없습니다.

이는 다음에 의해 제어됩니다. `agents.defaults.compaction.memoryFlush`:

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

세부:

- **소프트 임계값**: 세션 토큰 추정치가 초과되면 플러시가 트리거됩니다.
  `contextWindow - reserveTokensFloor - softThresholdTokens`.
- **조용한** 기본적으로 프롬프트에는 다음이 포함됩니다. `NO_REPLY` 그래서 아무것도 배달되지 않습니다.
- **프롬프트 2개**: 사용자 프롬프트와 시스템 프롬프트가 미리 알림을 추가합니다.
- **압축 주기당 한 번의 세척** (추적됨 `sessions.json`).
- **작업공간은 쓰기 가능해야 합니다.**: 세션이 샌드박스로 실행되는 경우
  `workspaceAccess: "ro"` 또는 `"none"`, 플러시를 건너뜁니다.

전체 압축 수명주기는 다음을 참조하세요.
[세션 관리 + 압축](/reference/session-management-compaction).

## 벡터 메모리 검색

OpenClaw는 작은 벡터 인덱스를 구축할 수 있습니다. `MEMORY.md` 그리고 `memory/*.md` 그래서
의미론적 쿼리는 표현이 다른 경우에도 관련 메모를 찾을 수 있습니다.

기본값:

- 기본적으로 활성화되어 있습니다.
- 메모리 파일의 변경 사항을 감시합니다(디바운스됨).
- 기본적으로 원격 임베딩을 사용합니다. 만약에 `memorySearch.provider` 설정되지 않은 경우 OpenClaw는 다음을 자동 선택합니다.
  1. `local` 만약에 `memorySearch.local.modelPath` 구성되었으며 파일이 존재합니다.
  2. `openai` OpenAI 키를 확인할 수 있는지 여부.
  3. `gemini` Gemini 키를 해결할 수 있는지 여부.
  4. `voyage` Voyage 키를 해결할 수 있는 경우.
  5. 그렇지 않으면 구성될 때까지 메모리 검색이 비활성화된 상태로 유지됩니다.
- 로컬 모드는 node-llama-cpp를 사용하며 필요할 수 있습니다. `pnpm approve-builds`.
- sqlite-vec(사용 가능한 경우)를 사용하여 SQLite 내에서 벡터 검색을 가속화합니다.

원격 임베딩 **필요하다** 임베딩 공급자의 API 키입니다. 오픈클로
인증 프로필의 키를 확인합니다. `models.providers.*.apiKey`또는 환경
변수. Codex OAuth는 채팅/완료에만 적용되며 **~ 아니다** 만족시키다
메모리 검색을 위한 임베딩. 쌍둥이자리의 경우 다음을 사용하세요. `GEMINI_API_KEY` 또는 
`models.providers.google.apiKey`. 항해의 경우 다음을 사용하십시오. `VOYAGE_API_KEY` 또는 
`models.providers.voyage.apiKey`. 사용자 정의 OpenAI 호환 엔드포인트를 사용하는 경우,
세트 `memorySearch.remote.apiKey` (그리고 선택사항 `memorySearch.remote.headers`).

### QMD 백엔드(실험적)

세트 `memory.backend = "qmd"` 내장된 SQLite 인덱서를 교체하려면
[QMD](https://github.com/tobi/qmd): 로컬 우선 검색 사이드카
BM25 + 벡터 + 순위 재지정. Markdown은 진실의 원천으로 남아 있습니다. OpenClaw 껍질
검색을 위해 QMD로 전송됩니다. 핵심 사항:

**전제조건**

- 기본적으로 비활성화되어 있습니다. 구성별 옵트인(`memory.backend = "qmd"`).
- QMD CLI를 별도로 설치합니다(`bun install -g https://github.com/tobi/qmd` 아니면 잡아
  릴리스)를 확인하고 `qmd` 바이너리가 게이트웨이에 있습니다. `PATH`.
- QMD에는 확장을 허용하는 SQLite 빌드가 필요합니다(`brew install sqlite` 에
  macOS).
- QMD는 Bun +를 통해 완전히 로컬로 실행됩니다. `node-llama-cpp` GGUF 자동 다운로드
  처음 사용 시 HuggingFace의 모델(별도의 Ollama 데몬이 필요하지 않음)
- 게이트웨이는 독립형 XDG 홈에서 QMD를 실행합니다.
  `~/.openclaw/agents/<agentId>/qmd/` 설정으로 `XDG_CONFIG_HOME` 그리고 
  `XDG_CACHE_HOME`.
- OS 지원: Bun + SQLite를 사용하면 macOS 및 Linux가 즉시 작동합니다.
  설치되었습니다. Windows는 WSL2를 통해 가장 잘 지원됩니다.

**사이드카 실행 방법**

- 게이트웨이는 독립형 QMD 홈을 작성합니다.
  `~/.openclaw/agents/<agentId>/qmd/` (구성 + 캐시 + sqlite DB).
- 컬렉션은 다음을 통해 생성됩니다. `qmd collection add` ~에서 `memory.qmd.paths`
  (및 기본 작업 공간 메모리 파일), 그런 다음 `qmd update` + `qmd embed` 달리다
  부팅 시 및 구성 가능한 간격(`memory.qmd.update.interval`,
  기본 5m).
- 이제 부팅 새로 고침이 기본적으로 백그라운드에서 실행되므로 채팅이 시작되지 않습니다.
  차단됨; 세트 `memory.qmd.update.waitForBootSync = true` 이전 것을 유지하기 위해
  차단 행동.
- 검색은 다음을 통해 실행됩니다. `qmd query --json`. QMD가 실패하거나 바이너리가 누락된 경우
  OpenClaw는 자동으로 내장된 SQLite 관리자로 대체되므로 메모리 도구는
  계속 일하세요.
- OpenClaw는 현재 QMD 삽입 배치 크기 조정을 공개하지 않습니다. 배치 동작은
  QMD 자체에 의해 제어됩니다.
- **첫 번째 검색이 느릴 수 있음**: QMD는 로컬 GGUF 모델을 다운로드할 수 있습니다(재순위 지정/쿼리
  확장) 첫 번째 `qmd query` 달리다.
  - OpenClaw 세트 `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` QMD를 실행할 때 자동으로.
  - 모델을 수동으로 미리 다운로드하고 동일한 인덱스 OpenClaw를 따뜻하게 하려면
    사용) 에이전트의 XDG 디렉토리를 사용하여 일회성 쿼리를 실행합니다.

    OpenClaw의 QMD 상태는 귀하의 관리하에 있습니다. **주 디렉토리** (기본값은 `~/.openclaw`).
    가리킬 수 있습니다 `qmd` 동일한 XDG 변수를 내보내서 정확히 동일한 인덱스에서
    OpenClaw는 다음을 사용합니다.

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

**구성 표면(`memory.qmd.*`)**

- `command` (기본 `qmd`): 실행 파일 경로를 재정의합니다.
- `includeDefaultMemory` (기본 `true`): 자동 색인 `MEMORY.md` + `memory/**/*.md`.
- `paths[]`: 추가 디렉터리/파일 추가(`path`, 선택사항 `pattern`, 선택사항
  안정된 `name`).
- `sessions`: 세션 JSONL 인덱싱을 선택합니다(`enabled`, `retentionDays`, 
  `exportDir`).
- `update`: 새로 고침 주기 및 유지 관리 실행을 제어합니다.
  (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`, 
  `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`).
- `limits`: 클램프 리콜 페이로드(`maxResults`, `maxSnippetChars`, 
  `maxInjectedChars`, `timeoutMs`).
- `scope`: 동일한 스키마 [`session.sendPolicy`](/gateway/configuration#session).
  기본값은 DM 전용(`deny` 모두, `allow` 직접 채팅); 표면 QMD에 느슨하게
  그룹/채널 히트.
- 작업공간 외부에서 가져온 조각은 다음과 같이 표시됩니다.
  `qmd/<collection>/<relative-path>` ~에 `memory_search` 결과; `memory_get`
  해당 접두사를 이해하고 구성된 QMD 컬렉션 루트에서 읽습니다.
- 언제 `memory.qmd.sessions.enabled = true`, OpenClaw는 정리된 세션을 내보냅니다.
  성적표(사용자/어시스턴트 전환)를 전용 QMD 컬렉션으로
  `~/.openclaw/agents/<id>/qmd/sessions/`, 그래서 `memory_search` 최근을 떠올릴 수 있다
  내장된 SQLite 인덱스를 건드리지 않고 대화합니다.
- `memory_search` 이제 스니펫에는 `Source: <path#line>` 바닥글 언제
  `memory.citations` ~이다 `auto`/`on`; 세트 `memory.citations = "off"` 유지하다
  경로 메타데이터 내부(에이전트는 계속해서
  `memory_get`, 그러나 스니펫 텍스트에는 바닥글과 시스템 프롬프트가 생략되어 있습니다.
  상담원에게 인용하지 말라고 경고합니다.)

**예**

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

**인용 및 대체**

- `memory.citations` 백엔드에 관계없이 적용됩니다(`auto`/`on`/`off`).
- 언제 `qmd` 달리고, 우리는 태그를 붙인다 `status().backend = "qmd"` 그래서 진단 결과는 어느 것입니까?
  엔진이 결과를 제공했습니다. QMD 하위 프로세스가 종료되거나 JSON 출력을 수행할 수 없는 경우
  구문 분석되면 검색 관리자는 경고를 기록하고 내장 공급자를 반환합니다.
  (기존 Markdown 임베딩) QMD가 복구될 때까지.

### 추가 메모리 경로

기본 작업 공간 레이아웃 외부에서 Markdown 파일을 색인화하려면 다음을 추가하십시오.
명시적 경로:

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

참고:

- 경로는 절대 경로이거나 작업공간 상대 경로일 수 있습니다.
- 디렉터리는 재귀적으로 검색됩니다. `.md` 파일.
- Markdown 파일만 색인화됩니다.
- Symlink는 무시됩니다(파일 또는 디렉터리).

### Gemini 임베딩(네이티브)

공급자를 다음으로 설정하십시오. `gemini` Gemini 임베딩 API를 직접 사용하려면:

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

참고:

- `remote.baseUrl` 선택사항입니다(기본값은 Gemini API 기본 URL임).
- `remote.headers` 필요한 경우 추가 헤더를 추가할 수 있습니다.
- 기본 모델: `gemini-embedding-001`.

당신이 **맞춤형 OpenAI 호환 엔드포인트** (OpenRouter, vLLM 또는 프록시)
당신은 사용할 수 있습니다 `remote` OpenAI 공급자를 사용한 구성:

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

API 키를 설정하지 않으려면 다음을 사용하세요. `memorySearch.provider = "local"` 또는 설정
`memorySearch.fallback = "none"`.

대체:

- `memorySearch.fallback` 될 수 있다 `openai`, `gemini`, `local`, 또는 `none`.
- 대체 공급자는 기본 포함 공급자가 실패한 경우에만 사용됩니다.

일괄 인덱싱(OpenAI + Gemini):

- OpenAI 및 Gemini 임베딩에는 기본적으로 활성화되어 있습니다. 세트 `agents.defaults.memorySearch.remote.batch.enabled = false` 비활성화합니다.
- 기본 동작은 일괄 처리 완료를 기다립니다. 곡조 `remote.batch.wait`, `remote.batch.pollIntervalMs`, 그리고 `remote.batch.timeoutMinutes` 필요한 경우.
- 세트 `remote.batch.concurrency` 병렬로 제출하는 일괄 작업 수를 제어합니다(기본값: 2).
- 배치 모드는 다음과 같은 경우에 적용됩니다. `memorySearch.provider = "openai"` 또는 `"gemini"` 해당 API 키를 사용합니다.
- Gemini 배치 작업은 비동기 임베딩 배치 엔드포인트를 사용하며 Gemini Batch API 가용성이 필요합니다.

OpenAI 배치가 빠르고 저렴한 이유:

- 대규모 백필의 경우 단일 배치 작업으로 많은 포함 요청을 제출하고 OpenAI가 이를 비동기적으로 처리할 수 있도록 하기 때문에 OpenAI는 일반적으로 우리가 지원하는 가장 빠른 옵션입니다.
- OpenAI는 Batch API 워크로드에 대해 할인된 가격을 제공하므로 대규모 인덱싱 실행은 일반적으로 동일한 요청을 동기식으로 보내는 것보다 저렴합니다.
- 자세한 내용은 OpenAI Batch API 문서 및 가격을 참조하세요.
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

- `memory_search` — 파일 + 줄 범위가 포함된 조각을 반환합니다.
- `memory_get` — 경로별로 메모리 파일 내용을 읽습니다.

로컬 모드:

- 세트 `agents.defaults.memorySearch.provider = "local"`.
- 제공하다 `agents.defaults.memorySearch.local.modelPath` (GGUF 또는 `hf:` URI).
- 선택사항: 설정 `agents.defaults.memorySearch.fallback = "none"` 원격 폴백을 방지합니다.

### 메모리 도구의 작동 방식

- `memory_search` 마크다운 청크(~400개 토큰 대상, 80개 토큰 중복)를 의미론적으로 검색합니다. `MEMORY.md` + `memory/**/*.md`. 스니펫 텍스트(최대 700자), 파일 경로, 줄 범위, 점수, 공급자/모델 및 로컬 → 원격 임베딩에서 대체되었는지 여부를 반환합니다. 전체 파일 페이로드가 반환되지 않습니다.
- `memory_get` 선택적으로 시작 줄에서 N 줄에 대한 특정 메모리 Markdown 파일(작업 공간 기준)을 읽습니다. 외부 경로 `MEMORY.md`/`memory/` 거부됩니다.
- 두 도구 모두 다음 경우에만 활성화됩니다. `memorySearch.enabled` 에이전트에 대해 true로 확인됩니다.

### 색인이 생성되는 대상 및 시기

- 파일 형식: 마크다운 전용(`MEMORY.md`, `memory/**/*.md`).
- 인덱스 저장소: 에이전트별 SQLite `~/.openclaw/memory/<agentId>.sqlite` (다음을 통해 구성 가능 `agents.defaults.memorySearch.store.path`, 지원 `{agentId}` 토큰).
- 신선도: 감시자 켜짐 `MEMORY.md` + `memory/` 인덱스를 더티로 표시합니다(디바운스 1.5초). 동기화는 세션 시작 시, 검색 시 또는 일정 간격으로 예약되며 비동기식으로 실행됩니다. 세션 기록은 델타 임계값을 사용하여 백그라운드 동기화를 트리거합니다.
- 재색인 트리거: 인덱스는 임베딩을 저장합니다. **공급자/모델 + 엔드포인트 지문 + 청킹 매개변수**. 변경 사항이 있으면 OpenClaw는 자동으로 전체 매장을 재설정하고 다시 색인을 생성합니다.

### 하이브리드 검색(BM25 + 벡터)

활성화되면 OpenClaw는 다음을 결합합니다.

- **벡터 유사성** (의미적 일치, 표현은 다를 수 있음)
- **BM25 키워드 관련성** (ID, 환경 변수, 코드 기호와 같은 정확한 토큰)

플랫폼에서 전체 텍스트 검색을 사용할 수 없는 경우 OpenClaw는 벡터 전용 검색으로 대체됩니다.

#### 왜 하이브리드인가?

벡터 검색은 "이것은 같은 것을 의미합니다"에 훌륭합니다.

- "Mac Studio 게이트웨이 호스트"와 "게이트웨이를 실행하는 컴퓨터"
- "파일 업데이트 디바운스" vs "쓰기마다 인덱싱 방지"

그러나 정확한 신호가 높은 토큰에는 약할 수 있습니다.

- ID(`a828e60`, `b3b9895a…`)
- 코드 기호(`memorySearch.query.hybrid`)
- 오류 문자열("sqlite-vec 사용할 수 없음")

BM25(전체 텍스트)는 그 반대입니다. 정확한 토큰에는 강하고 다른 표현에는 약합니다.
하이브리드 검색은 실용적인 중간 지점입니다. **두 검색 신호를 모두 사용** 그래서 당신은 얻습니다
"자연어" 쿼리와 "건초 더미 속의 바늘" 쿼리 모두에 대해 좋은 결과를 얻었습니다.

#### 결과를 병합하는 방법(현재 설계)

구현 스케치:

1. 양쪽에서 후보 풀을 검색합니다.

- **벡터**: 맨 위 `maxResults * candidateMultiplier` 코사인 유사성에 의해.
- **BM25**: 맨 위 `maxResults * candidateMultiplier` FTS5 BM25 등급 기준(낮을수록 좋음).

2. BM25 순위를 0..1 같은 점수로 변환합니다.

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. 청크 ID별로 후보를 통합하고 가중치 점수를 계산합니다.

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

참고:

- `vectorWeight` + `textWeight` 구성 해상도에서는 1.0으로 정규화되므로 가중치는 백분율로 작동합니다.
- 임베딩을 사용할 수 없는 경우(또는 공급자가 0-벡터를 반환하는 경우) 우리는 여전히 BM25를 실행하고 키워드 일치를 반환합니다.
- FTS5를 생성할 수 없는 경우 벡터 전용 검색을 유지합니다(하드 오류 없음).

이것은 "IR 이론의 완벽함"은 아니지만 간단하고 빠르며 실제 메모의 재현율/정밀도를 향상시키는 경향이 있습니다.
나중에 더 좋아지고 싶다면 일반적인 다음 단계는 RRF(Reciprocal Rank Fusion) 또는 점수 정규화입니다.
(최소/최대 또는 z-점수) 혼합 전.

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

### 캐시 삽입

OpenClaw는 캐시할 수 있습니다. **청크 임베딩** SQLite에서는 재색인 및 빈번한 업데이트(특히 세션 기록)가 변경되지 않은 텍스트를 다시 포함하지 않도록 합니다.

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

### 세션 메모리 검색(실험적)

선택적으로 색인을 생성할 수 있습니다. **세션 기록** 다음을 통해 표면화합니다. `memory_search`.
이것은 실험적인 깃발 뒤에 문이 있습니다.

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

참고:

- 세션 인덱싱은 **선택** (기본적으로 꺼져 있음).
- 세션 업데이트가 디바운싱되고 **비동기식으로 인덱싱됨** 델타 임계값을 넘으면(최선의 노력)
- `memory_search` 인덱싱을 차단하지 않습니다. 백그라운드 동기화가 완료될 때까지 결과가 약간 오래될 수 있습니다.
- 결과에는 여전히 스니펫만 포함됩니다. `memory_get` 메모리 파일로 제한되어 있습니다.
- 세션 인덱싱은 에이전트별로 격리됩니다(해당 에이전트의 세션 로그만 인덱싱됩니다).
- 세션 로그가 디스크에 실시간으로 저장됩니다(`~/.openclaw/agents/<agentId>/sessions/*.jsonl`). 파일 시스템 액세스 권한이 있는 모든 프로세스/사용자는 이를 읽을 수 있으므로 디스크 액세스를 신뢰 경계로 취급하십시오. 더 엄격하게 격리하려면 별도의 OS 사용자 또는 호스트에서 에이전트를 실행하세요.

델타 임계값(기본값 표시):

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

### SQLite 벡터 가속(sqlite-vec)

sqlite-vec 확장을 사용할 수 있는 경우 OpenClaw는 임베딩을
SQLite 가상 테이블(`vec0`)에서 벡터 거리 쿼리를 수행합니다.
데이터베이스. 이렇게 하면 JS에 모든 임베딩을 로드하지 않고도 검색 속도가 빨라집니다.

구성(선택 사항):

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

참고:

- `enabled` 기본값은 true입니다. 비활성화되면 검색이 진행 중으로 돌아갑니다.
  저장된 임베딩에 대한 코사인 유사성.
- sqlite-vec 확장이 없거나 로드에 실패하면 OpenClaw는
  오류가 발생하고 JS 대체(벡터 테이블 없음)가 계속됩니다.
- `extensionPath` 번들로 제공되는 sqlite-vec 경로를 재정의합니다(사용자 정의 빌드에 유용함).
  또는 비표준 설치 위치).

### 로컬 임베딩 자동 다운로드

- 기본 로컬 임베딩 모델: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` (~0.6GB).
- 언제 `memorySearch.provider = "local"`, `node-llama-cpp` 해결하다 `modelPath`; GGUF에 누락된 경우 **자동 다운로드** 캐시에(또는 `local.modelCacheDir` 설정된 경우) 로드합니다. 재시도 시 다운로드가 재개됩니다.
- 네이티브 빌드 요구 사항: 실행 `pnpm approve-builds`, 선택하다 `node-llama-cpp`, 그 다음에 `pnpm rebuild node-llama-cpp`.
- 대체: 로컬 설정이 실패하고 `memorySearch.fallback = "openai"`, 자동으로 원격 임베딩으로 전환합니다(`openai/text-embedding-3-small` 재정의되지 않는 한) 이유를 기록합니다.

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

참고:

- `remote.*` 우선한다 `models.providers.openai.*`.
- `remote.headers` OpenAI 헤더와 병합 주요 충돌에서 원격 승리. 생략 `remote.headers` OpenAI 기본값을 사용합니다.
