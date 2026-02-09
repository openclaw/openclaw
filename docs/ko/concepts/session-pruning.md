---
summary: "세션 프루닝: 컨텍스트 비대를 줄이기 위한 도구 결과 트리밍"
read_when:
  - 도구 출력으로 인한 LLM 컨텍스트 증가를 줄이고자 할 때
  - agents.defaults.contextPruning 을 튜닝할 때
---

# Session Pruning

Session pruning 은 각 LLM 호출 직전에 메모리 내 컨텍스트에서 **오래된 도구 결과**를 트리밍합니다. 디스크에 저장된 세션 히스토리는 **재작성하지 않습니다** (`*.jsonl`).

## When it runs

- `mode: "cache-ttl"` 이 활성화되어 있고, 해당 세션의 마지막 Anthropic 호출이 `ttl` 보다 오래된 경우.
- 해당 요청에 대해 모델로 전송되는 메시지에만 영향을 줍니다.
- Anthropic API 호출(및 OpenRouter Anthropic 모델)에만 활성화됩니다.
- 최상의 결과를 위해 `ttl` 을(를) 사용 중인 모델의 `cacheControlTtl` 과 일치시키십시오.
- 프루닝 이후 TTL 윈도우가 리셋되므로, 이후 요청은 `ttl` 이 다시 만료될 때까지 캐시를 유지합니다.

## Smart defaults (Anthropic)

- **OAuth 또는 setup-token** 프로파일: `cache-ttl` 프루닝을 활성화하고 하트비트를 `1h` 으로 설정합니다.
- **API key** 프로파일: `cache-ttl` 프루닝을 활성화하고, 하트비트를 `30m` 으로 설정하며, Anthropic 모델에서 기본 `cacheControlTtl` 을(를) `1h` 로 설정합니다.
- 이러한 값 중 어느 하나라도 명시적으로 설정하면 OpenClaw 는 이를 **재정의하지 않습니다**.

## What this improves (cost + cache behavior)

- **왜 프루닝하는가:** Anthropic 프롬프트 캐싱은 TTL 내에서만 적용됩니다. 세션이 TTL 을 지나 유휴 상태가 되면, 다음 요청은 먼저 트리밍하지 않는 한 전체 프롬프트를 다시 캐시합니다.
- **무엇이 더 저렴해지는가:** 프루닝은 TTL 만료 이후 첫 요청의 **cacheWrite** 크기를 줄입니다.
- **TTL 리셋이 중요한 이유:** 프루닝이 실행되면 캐시 윈도우가 리셋되어, 이후 요청이 전체 히스토리를 다시 캐시하는 대신 새로 캐시된 프롬프트를 재사용할 수 있습니다.
- **하지 않는 것:** 프루닝은 토큰을 추가하거나 비용을 “이중”으로 발생시키지 않습니다. TTL 이후 첫 요청에서 무엇이 캐시되는지만 변경합니다.

## What can be pruned

- `toolResult` 메시지만 해당됩니다.
- 사용자 + 어시스턴트 메시지는 **절대** 수정되지 않습니다.
- 마지막 `keepLastAssistants` 개의 어시스턴트 메시지는 보호되며, 해당 컷오프 이후의 도구 결과만 프루닝됩니다.
- 컷오프를 설정할 만큼 어시스턴트 메시지가 충분하지 않으면 프루닝이 건너뜁니다.
- **이미지 블록**을 포함한 도구 결과는 건너뜁니다(절대 트리밍/삭제되지 않음).

## Context window estimation

프루닝은 추정 컨텍스트 윈도우를 사용합니다(문자 수 ≈ 토큰 × 4). 기본 윈도우는 다음 순서로 결정됩니다:

1. `models.providers.*.models[].contextWindow` 오버라이드.
2. 모델 정의 `contextWindow` (모델 레지스트리 기준).
3. 기본 `200000` 토큰.

`agents.defaults.contextTokens` 이 설정되어 있으면, 결정된 윈도우의 상한(최소값)으로 취급됩니다.

## Mode

### cache-ttl

- 마지막 Anthropic 호출이 `ttl` 보다 오래된 경우에만 프루닝이 실행됩니다(기본값 `5m`).
- 실행 시: 이전과 동일한 소프트 트림 + 하드 클리어 동작을 수행합니다.

## Soft vs hard pruning

- **소프트 트림**: 과도하게 큰 도구 결과에만 적용됩니다.
  - 헤드 + 테일을 유지하고 `...` 을 삽입하며, 원래 크기에 대한 노트를 추가합니다.
  - 이미지 블록이 있는 결과는 건너뜁니다.
- **하드 클리어**: 전체 도구 결과를 `hardClear.placeholder` 로 대체합니다.

## Tool selection

- `tools.allow` / `tools.deny` 은(는) `*` 와일드카드를 지원합니다.
- 거부가 우선합니다.
- 매칭은 대소문자를 구분하지 않습니다.
- 허용 목록이 비어 있으면 => 모든 도구가 허용됩니다.

## Interaction with other limits

- 내장 도구는 이미 자체 출력 트렁케이션을 수행합니다. 세션 프루닝은 장시간 채팅에서 모델 컨텍스트에 과도한 도구 출력이 누적되는 것을 방지하는 추가 레이어입니다.
- 컴팩션은 별개입니다: 컴팩션은 요약하여 영구 저장하고, 프루닝은 요청 단위로 일시적입니다. [/concepts/compaction](/concepts/compaction) 을 참고하십시오.

## Defaults (when enabled)

- `ttl`: `"5m"`
- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3`
- `hardClearRatio`: `0.5`
- `minPrunableToolChars`: `50000`
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## Examples

기본값 (비활성화):

```json5
{
  agent: {
    contextPruning: { mode: "off" },
  },
}
```

TTL 인지 프루닝 활성화:

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

특정 도구로 프루닝 제한:

```json5
{
  agent: {
    contextPruning: {
      mode: "cache-ttl",
      tools: { allow: ["exec", "read"], deny: ["*image*"] },
    },
  },
}
```

구성 참조 보기: [Gateway Configuration](/gateway/configuration)
