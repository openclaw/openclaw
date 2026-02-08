---
read_when:
    - 토큰 사용량, 비용 또는 컨텍스트 창 설명
    - 컨텍스트 증가 또는 압축 동작 디버깅
summary: OpenClaw가 프롬프트 컨텍스트를 구축하고 토큰 사용량 + 비용을 보고하는 방법
title: 토큰 사용 및 비용
x-i18n:
    generated_at: "2026-02-08T16:08:51Z"
    model: gtx
    provider: google-translate
    source_hash: f8bfadb36b51830c414e2d94810e5c3f9751fdfb8f7da1c43aa44dfb0db7672c
    source_path: reference/token-use.md
    workflow: 15
---

# 토큰 사용 및 비용

OpenClaw 트랙 **토큰**, 문자가 아닙니다. 토큰은 모델마다 다르지만 대부분
OpenAI 스타일 모델은 영어 텍스트의 경우 토큰당 평균 최대 4자입니다.

## 시스템 프롬프트가 구축되는 방법

OpenClaw는 실행될 때마다 자체 시스템 프롬프트를 구성합니다. 여기에는 다음이 포함됩니다.

- 도구 목록 + 간단한 설명
- 기술 목록(메타데이터만 해당, 지침은 요청 시 로드됨 `read`)
- 자체 업데이트 지침
- 작업공간 + 부트스트랩 파일(`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` 새로운 경우). 큰 파일은 다음에 의해 잘립니다. `agents.defaults.bootstrapMaxChars` (기본값: 20000)
- 시간(UTC + 사용자 시간대)
- 답장 태그 + 하트비트 동작
- 런타임 메타데이터(호스트/OS/모델/사고)

전체 내용은 다음에서 확인하세요. [시스템 프롬프트](/concepts/system-prompt).

## 컨텍스트 창에서 중요한 것은 무엇입니까?

모델이 수신하는 모든 것은 컨텍스트 제한에 포함됩니다.

- 시스템 프롬프트(위에 나열된 모든 섹션)
- 대화 기록(사용자 + 보조자 메시지)
- 도구 호출 및 도구 결과
- 첨부 파일/기록(이미지, 오디오, 파일)
- 압축 요약 및 가지치기 아티팩트
- 공급자 래퍼 또는 안전 헤더(표시되지 않지만 여전히 계산됨)

실제 분석(삽입된 파일, 도구, 기술 및 시스템 프롬프트 크기 기준)을 보려면 다음을 사용하세요. `/context list` 또는 `/context detail`. 보다 [문맥](/concepts/context).

## 현재 토큰 사용량을 확인하는 방법

채팅에서 다음을 사용하세요:

- `/status` → **이모티콘이 풍부한 상태 카드** 세션 모델, 컨텍스트 사용,
  마지막 응답 입력/출력 토큰 및 **예상 비용** (API 키만 해당)
- `/usage off|tokens|full` → 추가 **응답별 사용량 바닥글** 모든 답변에.
  - 세션당 지속(다음으로 저장됨) `responseUsage`).
  - OAuth 인증 **비용을 숨긴다** (토큰만 해당)
- `/usage cost` → OpenClaw 세션 로그의 로컬 비용 요약을 표시합니다.

기타 표면:

- **TUI/웹 TUI:** `/status` + `/usage` 지원됩니다.
- **CLI:** `openclaw status --usage` 그리고 `openclaw channels list` 쇼
  공급자 할당량 기간(응답별 비용 아님)

## 비용 추정(표시된 경우)

비용은 모델 가격 구성에서 추정됩니다.

```
models.providers.<provider>.models[].cost
```

이들은 **100만 토큰당 USD** ~을 위한 `input`, `output`, `cacheRead`, 그리고
`cacheWrite`. 가격이 누락된 경우 OpenClaw는 토큰만 표시합니다. OAuth 토큰
달러 비용을 표시하지 마십시오.

## 캐시 TTL 및 정리 영향

공급자 프롬프트 캐싱은 캐시 TTL 창 내에서만 적용됩니다. OpenClaw는 할 수 있습니다
선택적으로 실행 **캐시 TTL 정리**: 캐시 TTL이 끝나면 세션을 정리합니다.
만료된 후 후속 요청이 해당 캐시 창을 다시 사용할 수 있도록 캐시 창을 재설정합니다.
전체 기록을 다시 캐시하는 대신 새로 캐시된 컨텍스트입니다. 이렇게 하면 캐시가 유지됩니다.
세션이 TTL을 지나 유휴 상태가 되면 쓰기 비용이 낮아집니다.

그것을 구성하십시오 [게이트웨이 구성](/gateway/configuration) 그리고
행동 세부정보 [세션 가지치기](/concepts/session-pruning).

하트비트는 캐시를 유지할 수 있습니다. **따뜻한** 유휴 간격을 통해. 모델 캐시 TTL인 경우
이다 `1h`, 바로 아래에 하트비트 간격을 설정합니다(예: `55m`) 피할 수 있다
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

- 사용 `/compact` 긴 세션을 요약합니다.
- 워크플로우에서 대규모 도구 출력을 다듬습니다.
- 스킬 설명을 짧게 유지하세요(스킬 목록이 프롬프트에 삽입됩니다).
- 장황하고 탐구적인 작업에는 더 작은 모델을 선호합니다.

보다 [기술](/tools/skills) 정확한 스킬 목록 오버헤드 공식은 다음과 같습니다.
