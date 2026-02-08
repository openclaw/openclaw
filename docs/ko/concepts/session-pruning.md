---
read_when:
    - 도구 출력으로 인한 LLM 컨텍스트 증가를 줄이고 싶습니다.
    - Agent.defaults.contextPruning을 조정하고 있습니다.
summary: '세션 가지치기: 도구 결과를 다듬어 컨텍스트 부풀림을 줄입니다.'
x-i18n:
    generated_at: "2026-02-08T15:53:29Z"
    model: gtx
    provider: google-translate
    source_hash: 9b0aa2d1abea7050ba848a2db038ccc3e6e2d83c6eb4e3843a2ead0ab847574a
    source_path: concepts/session-pruning.md
    workflow: 15
---

# 세션 가지치기

세션 가지치기 트림 **오래된 도구 결과** 각 LLM 호출 직전에 메모리 내 컨텍스트에서. 그렇습니다 **~ 아니다** 온디스크 세션 기록을 다시 작성합니다(`*.jsonl`).

## 실행될 때

- 언제 `mode: "cache-ttl"` 활성화되어 있으며 세션에 대한 마지막 Anthropic 호출이 다음보다 오래되었습니다. `ttl`.
- 해당 요청에 대해 모델로 전송된 메시지에만 영향을 미칩니다.
- Anthropic API 호출(및 OpenRouter Anthropic 모델)에만 활성화됩니다.
- 최상의 결과를 얻으려면 다음을 일치시키세요. `ttl` 당신의 모델에 `cacheControlTtl`.
- 정리 후 TTL 기간이 재설정되므로 후속 요청은 다음까지 캐시를 유지합니다. `ttl` 다시 만료됩니다.

## 스마트 기본값(인류)

- **OAuth 또는 설정 토큰** 프로필: 활성화 `cache-ttl` 가지치기 및 하트비트 설정 `1h`.
- **API 키** 프로필: 활성화 `cache-ttl` 가지치기, 하트비트 설정 `30m`및 기본값 `cacheControlTtl` 에게 `1h` 인류 모델에.
- 이러한 값 중 하나를 명시적으로 설정하면 OpenClaw는 다음을 수행합니다. **~ 아니다** 그것들을 무시하십시오.

## 개선 사항(비용 + 캐시 동작)

- **가지치기하는 이유:** 인류 프롬프트 캐싱은 TTL 내에서만 적용됩니다. 세션이 TTL을 초과하여 유휴 상태가 되면 먼저 잘라내지 않는 한 다음 요청에서 전체 프롬프트를 다시 캐시합니다.
- **더 저렴해지는 것:** 가지치기를 하면 **캐시쓰기** TTL이 만료된 후 첫 번째 요청의 크기입니다.
- **TTL 재설정이 중요한 이유:** 정리가 실행되면 캐시 창이 재설정되므로 후속 요청은 전체 기록을 다시 캐시하는 대신 새로 캐시된 프롬프트를 재사용할 수 있습니다.
- **하지 않는 일:** 가지치기는 토큰이나 "이중" 비용을 추가하지 않습니다. 첫 번째 TTL 이후 요청에서 캐시된 내용만 변경됩니다.

## 잘라낼 수 있는 것

- 오직 `toolResult` 메시지.
- 사용자 + 보조자 메시지는 다음과 같습니다. **절대** 수정되었습니다.
- 마지막 `keepLastAssistants` 보조 메시지는 보호됩니다. 해당 컷오프 이후의 도구 결과는 정리되지 않습니다.
- 컷오프를 설정하는 데 보조 메시지가 충분하지 않으면 정리를 건너뜁니다.
- 다음을 포함하는 도구 결과 **이미지 블록** 건너뜁니다(절대 트리밍/삭제되지 않음).

## 컨텍스트 창 추정

정리에서는 예상 컨텍스트 창(문자 ≒ 토큰 × 4)을 사용합니다. 기본 창은 다음 순서로 해결됩니다.

1. `models.providers.*.models[].contextWindow` 보수.
2. 모델 정의 `contextWindow` (모델 레지스트리에서).
3. 기본 `200000` 토큰.

만약에 `agents.defaults.contextTokens` 설정되면 확인된 창에서 상한(최소)으로 처리됩니다.

## 방법

### 캐시-ttl

- 가지치기는 마지막 Anthropic 호출이 다음보다 오래된 경우에만 실행됩니다. `ttl` (기본 `5m`).
- 실행 시: 이전과 동일한 소프트 트림 + 하드 클리어 동작.

## 부드러운 가지치기 vs 단단한 가지치기

- **소프트 트림**: 대형 공구 결과에만 해당됩니다.
  - 머리 + 꼬리 유지, 삽입 `...`를 클릭하고 원래 크기의 메모를 추가합니다.
  - 이미지 블록이 포함된 결과를 건너뜁니다.
- **하드클리어**: 전체 도구 결과를 다음으로 대체합니다. `hardClear.placeholder`.

## 도구 선택

- `tools.allow` / `tools.deny` 지원하다 `*` 와일드카드.
- 거부가 승리합니다.
- 일치는 대소문자를 구분하지 않습니다.
- 빈 허용 목록 => 모든 도구가 허용됩니다.

## 다른 제한과의 상호 작용

- 내장 도구는 이미 자체 출력을 자릅니다. 세션 정리는 장기 실행 채팅이 모델 컨텍스트에서 너무 많은 도구 출력을 축적하는 것을 방지하는 추가 계층입니다.
- 압축은 별개입니다. 압축은 요약되고 지속되며, 정리는 요청에 따라 일시적입니다. 보다 [/개념/압축](/concepts/compaction).

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

구성 참조를 참조하세요. [게이트웨이 구성](/gateway/configuration)
