---
summary: "How OpenClaw builds prompt context and reports token usage + costs"
read_when:
  - Explaining token usage, costs, or context windows
  - Debugging context growth or compaction behavior
title: "Token Use and Costs"
x-i18n:
  source_hash: a0f54acb0b9306d51a88701cf88dcd692e726b6dc20ce778bd6abd39c816f977
---

# 토큰 사용 및 비용

OpenClaw는 문자가 아닌 **토큰**을 추적합니다. 토큰은 모델마다 다르지만 대부분
OpenAI 스타일 모델은 영어 텍스트의 경우 토큰당 평균 최대 4자입니다.

## 시스템 프롬프트 구축 방법

OpenClaw는 실행될 때마다 자체 시스템 프롬프트를 구성합니다. 여기에는 다음이 포함됩니다.

- 도구 목록 + 간단한 설명
- 스킬 목록(메타데이터만 해당, 지침은 `read`를 사용하여 요청 시 로드됨)
- 자체 업데이트 지침
- 작업공간 + 부트스트랩 파일(`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`(새 경우), + `MEMORY.md` 및/또는 `memory.md` 있는 경우). 대용량 파일은 `agents.defaults.bootstrapMaxChars`로 잘립니다(기본값: 20000). `memory/*.md` 파일은 메모리 도구를 통해 주문형이며 자동 주입되지 않습니다.
- 시간(UTC + 사용자 시간대)
- 답장 태그 + 하트비트 동작
- 런타임 메타데이터(호스트/OS/모델/사고)

[시스템 프롬프트](/concepts/system-prompt)에서 전체 분석을 참조하세요.

## 컨텍스트 창에서 중요한 것은 무엇입니까?

모델이 수신하는 모든 것은 컨텍스트 제한에 포함됩니다.

- 시스템 프롬프트(위에 나열된 모든 섹션)
- 대화 내용(사용자 + 보조자 메시지)
- 도구 호출 및 도구 결과
- 첨부 파일/기록(이미지, 오디오, 파일)
- 압축 요약 및 가지치기 유물
- 제공자 래퍼 또는 안전 헤더(표시되지 않지만 여전히 계산됨)

실제 분석(주입된 파일, 도구, 기술 및 시스템 프롬프트 크기별)을 보려면 `/context list` 또는 `/context detail`를 사용하세요. [컨텍스트](/concepts/context)를 참조하세요.

## 현재 토큰 사용량을 확인하는 방법

채팅에서 다음을 사용하세요:

- `/status` → **이모지가 풍부한 상태 카드**(세션 모델, 컨텍스트 사용,
  마지막 응답 입력/출력 토큰 및 **예상 비용**(API 키만 해당)
- `/usage off|tokens|full` → 모든 답글에 **응답별 사용 바닥글**을 추가합니다.
  - 세션당 지속됩니다(`responseUsage`로 저장됨).
  - OAuth 인증은 **비용을 숨깁니다**(토큰만 해당).
- `/usage cost` → OpenClaw 세션 로그의 로컬 비용 요약을 표시합니다.

기타 표면:

- **TUI/웹 TUI:** `/status` + `/usage`가 지원됩니다.
- **CLI:** `openclaw status --usage` 및 `openclaw channels list` 표시
  공급자 할당량 기간(응답별 비용 아님)

## 비용 추정(표시된 경우)

비용은 모델 가격 구성에서 추정됩니다.

```
models.providers.<provider>.models[].cost
```

이는 `input`, `output`, `cacheRead`에 대한 **100만 토큰당 USD**입니다.
`cacheWrite`. 가격이 누락된 경우 OpenClaw는 토큰만 표시합니다. OAuth 토큰
달러 비용을 표시하지 마십시오.

## 캐시 TTL 및 정리 영향

공급자 프롬프트 캐싱은 캐시 TTL 창 내에서만 적용됩니다. OpenClaw는 할 수 있습니다
선택적으로 **cache-ttl 정리** 실행: 캐시 TTL이 끝나면 세션을 정리합니다.
만료된 후 후속 요청이 해당 캐시 창을 다시 사용할 수 있도록 캐시 창을 재설정합니다.
전체 기록을 다시 캐시하는 대신 새로 캐시된 컨텍스트입니다. 이렇게 하면 캐시가 유지됩니다.
세션이 TTL을 지나 유휴 상태가 되면 쓰기 비용이 낮아집니다.

[게이트웨이 구성](/gateway/configuration)에서 구성하고
[세션 정리](/concepts/session-pruning)의 동작 세부정보입니다.

하트비트는 유휴 기간 동안 캐시를 **따뜻한** 상태로 유지할 수 있습니다. 모델 캐시 TTL인 경우
`1h`인 경우 바로 아래에 하트비트 간격을 설정하면(예: `55m`) 방지할 수 있습니다.
전체 프롬프트를 다시 캐싱하여 캐시 쓰기 비용을 줄입니다.

Anthropic API 가격의 경우 캐시 읽기가 입력보다 훨씬 저렴합니다.
토큰이며, 캐시 쓰기에는 더 높은 승수로 요금이 청구됩니다. Anthropic을 참조하세요.
최신 요금 및 TTL 승수에 대한 즉각적인 캐싱 가격:
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### 예: 하트비트로 1시간 캐시를 따뜻하게 유지

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
    heartbeat:
      every: "55m"
```

## 토큰 압력을 줄이기 위한 팁

- 긴 세션을 요약하려면 `/compact`을 사용하세요.
- 작업 흐름에서 큰 도구 출력을 다듬습니다.
- 스킬 설명을 짧게 유지하세요(스킬 목록이 프롬프트에 삽입됩니다).
- 장황하고 탐구적인 작업에는 더 작은 모델을 선호합니다.

정확한 스킬 목록 오버헤드 공식은 [스킬](/tools/skills)을 참조하세요.
