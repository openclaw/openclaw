---
title: "세션 Pruning"
summary: "세션 pruning: context bloat를 줄이기 위한 tool-result trimming"
read_when:
  - LLM context growth를 줄이려고 할 때
  - agents.defaults.contextPruning을 tuning할 때
---

# 세션 Pruning

세션 pruning은 각 LLM 호출 직전에 in-memory context에서 **old 도구 결과를 trim**합니다. on-disk 세션 히스토리 (`*.jsonl`)는 재작성하지 **않습니다**.

## 실행 시기

- `mode: "cache-ttl"`이 활성화되고 세션에 대한 last Anthropic call이 `ttl`보다 오래된 경우.
- 오직 그 요청에 대해 모델로 전송된 메시지에만 영향을 미칩니다.
- Anthropic API 호출 (및 OpenRouter Anthropic models)에만 활성화됩니다.
- 최고 결과를 위해 `ttl`을 당신의 모델 `cacheRetention` 정책과 매칭하십시오 (`short` = 5m, `long` = 1h).
- Prune 이후, TTL 윈도우는 재설정되어 후속 요청은 `ttl`이 다시 만료될 때까지 cache를 유지합니다.

## Smart 기본값 (Anthropic)

- **OAuth 또는 setup-token** profiles: `cache-ttl` pruning을 활성화하고 heartbeat를 `1h`로 설정합니다.
- **API key** profiles: `cache-ttl` pruning을 활성화하고, heartbeat를 `30m`으로 설정하고, Anthropic models에서 `cacheRetention: "short"`을 기본값으로 설정합니다.
- 이들 값을 명시적으로 설정하는 경우, OpenClaw는 **재정의하지 않습니다**.

## 이것이 개선하는 것 (비용 + cache 동작)

- **왜 prune:** Anthropic prompt caching은 오직 TTL 내에서만 적용됩니다. 세션이 TTL 이후로 idle하면, 다음 요청은 첫 번째 요청 이후에 full prompt를 re-cache합니다 unless you trim it first.
- **뭐가 싸져:** pruning은 TTL이 만료된 후 첫 요청에 대한 **cacheWrite** 크기를 줄입니다.
- **TTL reset이 중요한 이유:** pruning이 실행되면, cache window는 reset되어, follow‑up 요청은 freshly cached 프롬프트를 full history를 다시 cache하는 대신 재사용할 수 있습니다.
- **어떤 것을 하지 않는가:** pruning은 토큰을 추가하거나 "double" 비용하지 않습니다; 이는 그 첫 post‑TTL 요청에서 cached되는 것을 변경하기만 합니다.

## Pruning할 수 있는 것

- `toolResult` 메시지만.
- User + 어시스턴트 메시지는 **절대** 수정되지 않습니다.
- 마지막 `keepLastAssistants` 어시스턴트 메시지는 보호됩니다; 그 cutoff 후의 도구 결과는 pruned되지 않습니다.
- pruning할 만큼 충분한 어시스턴트 메시지가 없는 경우, pruning은 skipped됩니다.
- **image blocks**를 포함하는 도구 결과는 skipped됩니다 (절대 trimmed/cleared).

## 컨텍스트 윈도우 추정

Pruning은 estimated context window (chars ≈ tokens × 4)를 사용합니다. Base window는 다음 순서로 해결됩니다:

1. `models.providers.*.models[].contextWindow` override.
2. 모델 정의 `contextWindow` (model registry에서).
3. 기본값 `200000` tokens.

`agents.defaults.contextTokens`가 설정된 경우, resolved window에 대한 cap (min)으로 처리됩니다.

## 모드

### cache-ttl

- Pruning은 last Anthropic call이 `ttl`보다 오래된 경우에만 실행됩니다 (기본값 `5m`).
- 실행할 때: 이전과 같은 soft-trim + hard-clear 동작.

## Soft vs hard pruning

- **Soft-trim**: oversized 도구 결과에만.
  - Head + tail을 유지하고, `...`를 삽입하고, original size를 포함한 노트를 append합니다.
  - Image blocks이 있는 결과는 skip합니다.
- **Hard-clear**: 전체 도구 결과를 `hardClear.placeholder`로 replace합니다.

## 도구 선택

- `tools.allow` / `tools.deny`는 `*` wildcards를 지원합니다.
- Deny가 이깁니다.
- Matching은 case-insensitive입니다.
- Empty allow list => 모든 도구가 허용됩니다.

## 다른 제한과의 상호작용

- Built-in 도구는 이미 자신의 출력을 truncate합니다; session pruning은 긴 실행 채팅이 모델 context에서 너무 많은 도구 출력을 축적하지 않도록 하는 extra layer입니다.
- Compaction은 별개입니다: compaction은 요약하고 유지하며, pruning은 요청별 transient입니다. [/concepts/compaction](/concepts/compaction) 참조.

## 기본값 (활성화될 때)

- `ttl`: `"5m"`
- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3`
- `hardClearRatio`: `0.5`
- `minPrunableToolChars`: `50000`
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## 예시

기본값 (off):

```json5
{
  agents: { defaults: { contextPruning: { mode: "off" } } },
}
```

TTL-aware pruning을 활성화:

```json5
{
  agents: { defaults: { contextPruning: { mode: "cache-ttl", ttl: "5m" } } },
}
```

특정 도구로만 pruning을 제한:

```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "cache-ttl",
        tools: { allow: ["exec", "read"], deny: ["*image*"] },
      },
    },
  },
}
```

설정 참고서 참조: [게이트웨이 설정](/gateway/configuration)
