---
title: "Session Pruning"
summary: "Session pruning: tool-result trimming to reduce context bloat"
read_when:
  - You want to reduce LLM context growth from tool outputs
  - You are tuning agents.defaults.contextPruning
x-i18n:
  source_hash: 8c9f26bad0f070b72e60f9b4e96bc3027ad4d591eebdab7e3f789082dab7f3af
---

# 세션 가지치기

세션 정리는 각 LLM 호출 직전에 메모리 내 컨텍스트에서 **이전 도구 결과**를 정리합니다. 디스크상의 세션 기록(`*.jsonl`)을 다시 쓰지 **않습니다**.

## 실행되면

- `mode: "cache-ttl"`가 활성화되고 세션에 대한 마지막 인류 호출이 `ttl`보다 오래된 경우.
- 해당 요청에 대해 모델로 전송된 메시지에만 영향을 미칩니다.
- Anthropic API 호출(및 OpenRouter Anthropic 모델)에만 활성화됩니다.
- 최상의 결과를 얻으려면 `ttl`를 모델 `cacheControlTtl`과 일치시키세요.
- 정리 후 TTL 창이 재설정되므로 후속 요청은 `ttl`가 다시 만료될 때까지 캐시를 유지합니다.

## 스마트 기본값(인류)

- **OAuth 또는 설정 토큰** 프로필: `cache-ttl` 정리를 활성화하고 하트비트를 `1h`로 설정합니다.
- **API 키** 프로필: `cache-ttl` 가지치기를 활성화하고, 하트비트를 `30m`로 설정하고, 인류 모델에서 기본값 `cacheControlTtl`을 `1h`로 설정합니다.
- 이러한 값을 명시적으로 설정하면 OpenClaw는 해당 값을 재정의하지 **않습니다**.

## 개선 사항(비용 + 캐시 동작)

- **프루닝하는 이유:** 인류 프롬프트 캐싱은 TTL 내에서만 적용됩니다. 세션이 TTL을 초과하여 유휴 상태가 되면 먼저 잘라내지 않는 한 다음 요청에서 전체 프롬프트를 다시 캐시합니다.
- **더 저렴해지는 점:** 정리를 수행하면 TTL이 만료된 후 첫 번째 요청에 대한 **cacheWrite** 크기가 줄어듭니다.
- **TTL 재설정이 중요한 이유:** 정리가 실행되면 캐시 창이 재설정되므로 후속 요청은 전체 기록을 다시 캐시하는 대신 새로 캐시된 프롬프트를 재사용할 수 있습니다.
- **하지 않는 작업:** 가지치기는 토큰을 추가하거나 "이중" 비용을 추가하지 않습니다. 첫 번째 TTL 이후 요청에서 캐시된 내용만 변경됩니다.

## 잘라낼 수 있는 것

- `toolResult` 메시지만 해당됩니다.
- 사용자 + 보조자 메시지는 **절대로** 수정되지 않습니다.
- 마지막 `keepLastAssistants` 보조 메시지는 보호됩니다. 해당 컷오프 이후의 도구 결과는 정리되지 않습니다.
- 컷오프를 설정할 만큼 보조 메시지가 충분하지 않은 경우 가지치기를 건너뜁니다.
- **이미지 블록**이 포함된 도구 결과는 건너뜁니다(절대 트리밍/삭제되지 않음).

## 컨텍스트 창 추정

정리에서는 예상 컨텍스트 창(문자 ≒ 토큰 × 4)을 사용합니다. 기본 창은 다음 순서로 해결됩니다.

1. `models.providers.*.models[].contextWindow` 재정의.
2. 모델 정의 `contextWindow` (모델 레지스트리에서).
3. 기본 `200000` 토큰.

`agents.defaults.contextTokens`을 설정하면 해결된 창에서 상한(최소)으로 처리됩니다.

## 모드

### 캐시-ttl

- 가지치기는 마지막 Anthropic 호출이 `ttl`(기본값 `5m`)보다 오래된 경우에만 실행됩니다.
- 실행 시: 이전과 동일한 소프트 트림 + 하드 클리어 동작.

## 부드러운 가지치기 대 단단한 가지치기

- **소프트 트림**: 대형 도구 결과에만 해당됩니다.
  - 머리 + 꼬리를 유지하고 `...`를 삽입하고 원본 크기로 메모를 추가합니다.
  - 이미지 블록이 있는 결과를 건너뜁니다.
- **하드 클리어**: 전체 도구 결과를 `hardClear.placeholder`로 대체합니다.

## 도구 선택

- `tools.allow` / `tools.deny`는 `*` 와일드카드를 지원합니다.
- 거부가 승리합니다.
- 일치는 대소문자를 구분하지 않습니다.
- 빈 허용 목록 => 모든 도구가 허용됩니다.

## 다른 제한과의 상호 작용

- 내장 도구는 이미 자체 출력을 자릅니다. 세션 정리는 장기 실행 채팅이 모델 컨텍스트에서 너무 많은 도구 출력을 축적하는 것을 방지하는 추가 계층입니다.
- 압축은 별개입니다. 압축은 요약되고 지속되며, 정리는 요청에 따라 일시적입니다. [/concepts/compaction](/concepts/compaction)를 참조하세요.

## 기본값(활성화된 경우)

- `ttl`: `"5m"`
- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3`
- `hardClearRatio`: `0.5`
- `minPrunableToolChars`: `50000`
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## 예

기본값(꺼짐):

```json5
{
  agent: {
    contextPruning: { mode: "off" },
  },
}
```

TTL 인식 정리를 활성화합니다.

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

특정 도구로 가지치기를 제한합니다.

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

구성 참조 참조: [게이트웨이 구성](/gateway/configuration)
