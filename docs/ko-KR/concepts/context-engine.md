---
summary: "컨텍스트 엔진: 플러그 가능한 컨텍스트 조립, 압축 및 서브 에이전트 라이프사이클"
read_when:
  - OpenClaw가 모델 컨텍스트를 어떻게 조립하는지 이해하고 싶을 때
  - 레거시 엔진과 플러그인 엔진 간 전환 시
  - 컨텍스트 엔진 플러그인을 구축할 때
title: "컨텍스트 엔진"
x-i18n:
  source_path: "docs/concepts/context-engine.md"
---

# 컨텍스트 엔진

**컨텍스트 엔진**은 OpenClaw가 각 실행에 대해 모델 컨텍스트를 구축하는 방법을 제어합니다. 어떤 메시지를 포함할지, 오래된 기록을 어떻게 요약할지, 서브 에이전트 경계에서 컨텍스트를 어떻게 관리할지 결정합니다.

OpenClaw는 내장 `legacy` 엔진을 제공합니다. 플러그인은 활성 컨텍스트 엔진 라이프사이클을 대체하는 대체 엔진을 등록할 수 있습니다.

## 빠른 시작

활성 엔진을 확인하세요:

```bash
openclaw doctor
# 또는 설정을 직접 검사:
cat ~/.openclaw/openclaw.json | jq '.plugins.slots.contextEngine'
```

### 컨텍스트 엔진 플러그인 설치

컨텍스트 엔진 플러그인은 다른 OpenClaw 플러그인과 동일하게 설치됩니다. 먼저 설치한 후 슬롯에서 엔진을 선택하세요:

```bash
# npm에서 설치
openclaw plugins install @martian-engineering/lossless-claw

# 또는 로컬 경로에서 설치 (개발용)
openclaw plugins install -l ./my-context-engine
```

그런 다음 플러그인을 활성화하고 설정에서 활성 엔진으로 선택하세요:

```json5
// openclaw.json
{
  plugins: {
    slots: {
      contextEngine: "lossless-claw", // 플러그인의 등록된 엔진 id와 일치해야 합니다
    },
    entries: {
      "lossless-claw": {
        enabled: true,
        // 플러그인별 설정은 여기에 (플러그인 문서 참조)
      },
    },
  },
}
```

설치 및 설정 후 Gateway를 재시작하세요.

내장 엔진으로 다시 전환하려면 `contextEngine`을 `"legacy"`로 설정하세요 (또는 키를 완전히 제거하세요 -- `"legacy"`가 기본값입니다).

## 작동 방식

OpenClaw가 모델 프롬프트를 실행할 때마다 컨텍스트 엔진은 네 가지 라이프사이클 포인트에 참여합니다:

1. **Ingest** -- 새 메시지가 세션에 추가될 때 호출됩니다. 엔진은 자체 데이터 저장소에 메시지를 저장하거나 인덱싱할 수 있습니다.
2. **Assemble** -- 각 모델 실행 전에 호출됩니다. 엔진은 토큰 예산 내에 맞는 정렬된 메시지 세트와 선택적 `systemPromptAddition`을 반환합니다.
3. **Compact** -- 컨텍스트 윈도우가 가득 찼을 때 또는 사용자가 `/compact`를 실행할 때 호출됩니다. 엔진은 공간을 확보하기 위해 오래된 기록을 요약합니다.
4. **After turn** -- 실행이 완료된 후 호출됩니다. 엔진은 상태를 영속화하거나, 백그라운드 압축을 트리거하거나, 인덱스를 업데이트할 수 있습니다.

### 서브 에이전트 라이프사이클 (선택 사항)

OpenClaw는 현재 하나의 서브 에이전트 라이프사이클 후크를 호출합니다:

- **onSubagentEnded** -- 서브 에이전트 세션이 완료되거나 정리될 때 클린업합니다.

`prepareSubagentSpawn` 후크는 향후 사용을 위한 인터페이스의 일부이지만, 런타임은 아직 이를 호출하지 않습니다.

### 시스템 프롬프트 추가

`assemble` 메서드는 `systemPromptAddition` 문자열을 반환할 수 있습니다. OpenClaw는 이를 해당 실행의 시스템 프롬프트 앞에 추가합니다. 이를 통해 엔진은 정적 워크스페이스 파일 없이도 동적 리콜 안내, 검색 지침 또는 컨텍스트 인식 힌트를 주입할 수 있습니다.

## 레거시 엔진

내장 `legacy` 엔진은 OpenClaw의 원래 동작을 보존합니다:

- **Ingest**: no-op (세션 매니저가 메시지 영속성을 직접 처리).
- **Assemble**: 패스스루 (런타임의 기존 정제 → 검증 → 제한 파이프라인이 컨텍스트 조립 처리).
- **Compact**: 내장 요약 압축에 위임하며, 오래된 메시지의 단일 요약을 생성하고 최근 메시지를 유지합니다.
- **After turn**: no-op.

레거시 엔진은 도구를 등록하거나 `systemPromptAddition`을 제공하지 않습니다.

`plugins.slots.contextEngine`이 설정되지 않거나 `"legacy"`로 설정된 경우, 이 엔진이 자동으로 사용됩니다.

## 플러그인 엔진

플러그인은 플러그인 API를 사용하여 컨텍스트 엔진을 등록할 수 있습니다:

```ts
export default function register(api) {
  api.registerContextEngine("my-engine", () => ({
    info: {
      id: "my-engine",
      name: "My Context Engine",
      ownsCompaction: true,
    },

    async ingest({ sessionId, message, isHeartbeat }) {
      // 데이터 저장소에 메시지 저장
      return { ingested: true };
    },

    async assemble({ sessionId, messages, tokenBudget }) {
      // 예산에 맞는 메시지 반환
      return {
        messages: buildContext(messages, tokenBudget),
        estimatedTokens: countTokens(messages),
        systemPromptAddition: "Use lcm_grep to search history...",
      };
    },

    async compact({ sessionId, force }) {
      // 오래된 컨텍스트 요약
      return { ok: true, compacted: true };
    },
  }));
}
```

그런 다음 설정에서 활성화하세요:

```json5
{
  plugins: {
    slots: {
      contextEngine: "my-engine",
    },
    entries: {
      "my-engine": {
        enabled: true,
      },
    },
  },
}
```

### ContextEngine 인터페이스

필수 멤버:

| 멤버               | 종류     | 목적                                                   |
| ------------------ | -------- | ------------------------------------------------------ |
| `info`             | Property | 엔진 id, 이름, 버전, 압축 소유 여부                    |
| `ingest(params)`   | Method   | 단일 메시지 저장                                       |
| `assemble(params)` | Method   | 모델 실행을 위한 컨텍스트 구축 (`AssembleResult` 반환) |
| `compact(params)`  | Method   | 컨텍스트 요약/축소                                     |

`assemble`은 다음을 포함하는 `AssembleResult`를 반환합니다:

- `messages` -- 모델에 보낼 정렬된 메시지.
- `estimatedTokens` (필수, `number`) -- 조립된 컨텍스트의 총 토큰에 대한 엔진의 추정치. OpenClaw는 이를 압축 임계값 결정 및 진단 보고에 사용합니다.
- `systemPromptAddition` (선택적, `string`) -- 시스템 프롬프트 앞에 추가됨.

선택적 멤버:

| 멤버                           | 종류   | 목적                                                                               |
| ------------------------------ | ------ | ---------------------------------------------------------------------------------- |
| `bootstrap(params)`            | Method | 세션에 대한 엔진 상태 초기화. 엔진이 세션을 처음 볼 때 호출됨 (예: 기록 가져오기). |
| `ingestBatch(params)`          | Method | 완료된 턴을 배치로 수집. 실행 완료 후 해당 턴의 모든 메시지와 함께 호출됨.         |
| `afterTurn(params)`            | Method | 실행 후 라이프사이클 작업 (상태 영속화, 백그라운드 압축 트리거).                   |
| `prepareSubagentSpawn(params)` | Method | 자식 세션을 위한 공유 상태 설정.                                                   |
| `onSubagentEnded(params)`      | Method | 서브 에이전트 종료 후 클린업.                                                      |
| `dispose()`                    | Method | 리소스 해제. Gateway 종료 또는 플러그인 리로드 시 호출됨 -- 세션별이 아님.         |

### ownsCompaction

`ownsCompaction`은 Pi의 내장 인어텀트 자동 압축이 해당 실행에서 활성 상태를 유지할지 제어합니다:

- `true` -- 엔진이 압축 동작을 소유합니다. OpenClaw는 해당 실행에서 Pi의 내장 자동 압축을 비활성화하며, 엔진의 `compact()` 구현이 `/compact`, 오버플로 복구 압축 및 `afterTurn()`에서 수행하려는 사전 압축에 대해 책임집니다.
- `false` 또는 미설정 -- Pi의 내장 자동 압축이 프롬프트 실행 중에 여전히 실행될 수 있지만, 활성 엔진의 `compact()` 메서드는 여전히 `/compact` 및 오버플로 복구에 대해 호출됩니다.

`ownsCompaction: false`는 OpenClaw가 자동으로 레거시 엔진의 압축 경로로 폴백한다는 의미가 **아닙니다**.

즉, 두 가지 유효한 플러그인 패턴이 있습니다:

- **소유 모드** -- 자체 압축 알고리즘을 구현하고 `ownsCompaction: true`를 설정합니다.
- **위임 모드** -- `ownsCompaction: false`를 설정하고 `compact()`에서 `openclaw/plugin-sdk/core`의 `delegateCompactionToRuntime(...)`을 호출하여 OpenClaw의 내장 압축 동작을 사용합니다.

활성 비소유 엔진에 대한 no-op `compact()`는 안전하지 않습니다. 해당 엔진 슬롯에 대한 일반 `/compact` 및 오버플로 복구 압축 경로를 비활성화하기 때문입니다.

## 설정 참조

```json5
{
  plugins: {
    slots: {
      // 활성 컨텍스트 엔진 선택. 기본값: "legacy".
      // 플러그인 엔진을 사용하려면 플러그인 id로 설정.
      contextEngine: "legacy",
    },
  },
}
```

슬롯은 런타임에서 배타적입니다 -- 주어진 실행이나 압축 작업에 대해 하나의 등록된 컨텍스트 엔진만 확인됩니다. 다른 활성화된 `kind: "context-engine"` 플러그인은 여전히 로드되어 등록 코드를 실행할 수 있습니다. `plugins.slots.contextEngine`은 OpenClaw가 컨텍스트 엔진이 필요할 때 어떤 등록된 엔진 id를 확인할지만 선택합니다.

## 압축 및 메모리와의 관계

- **압축**은 컨텍스트 엔진의 한 가지 책임입니다. 레거시 엔진은 OpenClaw의 내장 요약에 위임합니다. 플러그인 엔진은 모든 압축 전략(DAG 요약, 벡터 검색 등)을 구현할 수 있습니다.
- **메모리 플러그인** (`plugins.slots.memory`)은 컨텍스트 엔진과 별개입니다. 메모리 플러그인은 검색/검색을 제공하며, 컨텍스트 엔진은 모델이 보는 것을 제어합니다. 함께 작동할 수 있습니다 -- 컨텍스트 엔진이 조립 중에 메모리 플러그인 데이터를 사용할 수 있습니다.
- **세션 프루닝** (인메모리에서 오래된 도구 결과 트리밍)은 어떤 컨텍스트 엔진이 활성인지에 관계없이 계속 실행됩니다.

## 팁

- `openclaw doctor`를 사용하여 엔진이 올바르게 로드되는지 확인하세요.
- 엔진을 전환할 때, 기존 세션은 현재 기록으로 계속됩니다. 새 엔진이 향후 실행에 적용됩니다.
- 엔진 오류는 로그에 기록되고 진단에 표시됩니다. 플러그인 엔진이 등록에 실패하거나 선택된 엔진 id를 확인할 수 없는 경우, OpenClaw는 자동으로 폴백하지 않습니다. 플러그인을 수정하거나 `plugins.slots.contextEngine`을 `"legacy"`로 다시 전환할 때까지 실행이 실패합니다.
- 개발용으로 `openclaw plugins install -l ./my-engine`을 사용하여 복사 없이 로컬 플러그인 디렉토리를 연결하세요.

참조: [압축](/concepts/compaction), [컨텍스트](/concepts/context),
[플러그인](/tools/plugin), [플러그인 매니페스트](/plugins/manifest).
