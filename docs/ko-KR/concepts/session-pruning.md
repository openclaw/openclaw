---
title: "세션 가지치기"
summary: "세션 가지치기: 도구 결과를 정리하여 컨텍스트 부하 감소"
read_when:
  - 도구 출력으로 인한 LLM 컨텍스트 성장을 줄이고 싶을 때
  - agents.defaults.contextPruning을 조정하고 있을 때
---

# 세션 가지치기

세션 가지치기는 각 LLM 호출 전에 **이전 도구 결과**를 메모리 내 컨텍스트에서 다듬습니다. 디스크에 저장된 세션 기록(`*.jsonl`)은 **다시 쓰지 않습니다**.

## 실행 시점

- `mode: "cache-ttl"`이 활성화되어 있고 해당 세션의 마지막 Anthropic 호출이 `ttl`보다 오래된 경우.
- 해당 요청을 위해 모델에 전송되는 메시지에만 영향을 줍니다.
- Anthropic API 호출(및 OpenRouter Anthropic 모델)에만 활성입니다.
- 최상의 결과를 위해 `ttl`을 모델 `cacheControlTtl`에 맞추세요.
- 가지치기가 이루어진 후, TTL 창이 리셋되어 이후 요청들이 `ttl`이 다시 만료될 때까지 캐시를 유지합니다.

## 스마트 기본값 (Anthropic)

- **OAuth 또는 설정 토큰** 프로필: `cache-ttl` 가지치기를 활성화하고 하트비트는 `1h`로 설정합니다.
- **API 키** 프로필: `cache-ttl` 가지치기를 활성화하고 하트비트는 `30m`로 설정하며, Anthropic 모델에서 기본 `cacheControlTtl`을 `1h`로 설정합니다.
- 이러한 값을 명시적으로 설정하면 OpenClaw는 **변경하지 않습니다**.

## 이것이 개선하는 것 (비용 + 캐시 동작)

- **가지치기가 필요한 이유:** Anthropic 프롬프트 캐싱은 TTL 내에서만 적용됩니다. 세션이 TTL을 지나면 다음 요청에서 프롬프트를 재캐싱해야 하며, 이를 방지하기 위해 먼저 다듬어야 합니다.
- **저렴해지는 것:** 가지치기는 TTL 만료 후 첫 번째 요청에 대한 **cacheWrite** 크기를 줄입니다.
- **TTL 리셋이 중요한 이유:** 가지치기가 실행된 후, 캐시 창이 리셋되어 후속 요청에서 새로 캐싱된 프롬프트를 재사용할 수 있으며, 전체 기록을 다시 캐싱할 필요가 없습니다.
- **하지 않는 것:** 가지치기는 토큰을 추가하거나 비용을 "두 배로" 늘리지 않으며, TTL 후 첫 요청에 캐싱되는 항목만 변경합니다.

## 가지칠 수 있는 것

- `toolResult` 메시지만.
- 사용자 + 어시스턴트 메시지는 절대 **수정되지 않습니다**.
- 마지막 `keepLastAssistants` 어시스턴트 메시지는 보호되며, 해당 절단점 이후의 도구 결과는 가지치기되지 않습니다.
- 절단점을 설정할 만큼의 어시스턴트 메시지가 없으면, 가지치기는 생략됩니다.
- **이미지 블록**을 포함하는 도구 결과는 무시됩니다 (결코 다듬거나 제거하지 않음).

## 컨텍스트 창 추정

가지치기는 추정된 컨텍스트 창을 사용합니다 (문자 ≈ 토큰 × 4). 기본 창은 다음 순서로 해결됩니다:

1. `models.providers.*.models[].contextWindow` 덮어쓰기.
2. 모델 정의 `contextWindow` (모델 레지스트리에서).
3. 기본 `200000` 토큰.

`agents.defaults.contextTokens`가 설정된 경우, 이는 해결된 창에 대한 상한 (최소)으로 처리됩니다.

## 모드

### cache-ttl

- 마지막 Anthropic 호출이 `ttl`보다 오래되었을 때만 가지치기가 실행됩니다 (기본값 `5m`).
- 실행 시점: 이전과 동일한 소프트 트림 + 하드 클리어 동작을 유지합니다.

## 소프트 vs 하드 가지치기

- **소프트 트림**: 크기가 큰 도구 결과에만 해당.
  - 머리와 꼬리를 유지하고 `...` 를 삽입하며 원래 크기와 함께 노트를 추가합니다.
  - 이미지 블록이 포함된 결과는 건너뜁니다.
- **하드 클리어**: 전체 도구 결과를 `hardClear.placeholder`로 대체합니다.

## 도구 선택

- `tools.allow` / `tools.deny`는 `*` 와일드카드를 지원합니다.
- 거부가 우선합니다.
- 대소문자 구분 없이 일치합니다.
- 허용 목록이 비어 있으면 모든 도구가 허용됩니다.

## 다른 제한과의 상호 작용

- 내장 도구는 이미 자체 출력을 잘라냅니다. 세션 가지치기는 모델 컨텍스트에 너무 많은 도구 출력이 누적되지 않도록 추가적으로 작용합니다.
- 압축은 별개입니다: 압축은 요약 및 영구적이며, 가지치기는 요청 당 일시적입니다. [/concepts/compaction](/ko-KR/concepts/compaction)를 참조하세요.

## 기본값 (활성화 되었을 때)

- `ttl`: `"5m"`
- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3`
- `hardClearRatio`: `0.5`
- `minPrunableToolChars`: `50000`
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## 예제

기본값 (꺼짐):

```json5
{
  agent: {
    contextPruning: { mode: "off" },
  },
}
```

TTL-인식 가지치기 활성화:

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

특정 도구에 가지치기 제한:

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

설정 참조: [Gateway Configuration](/ko-KR/gateway/configuration)