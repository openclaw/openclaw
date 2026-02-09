---
summary: "OpenClaw 가 프롬프트 컨텍스트를 구성하고 토큰 사용량과 비용을 보고하는 방법"
read_when:
  - 토큰 사용량, 비용 또는 컨텍스트 윈도우를 설명할 때
  - 컨텍스트 증가 또는 압축 동작을 디버깅할 때
title: "토큰 사용 및 비용"
---

# 토큰 사용 및 비용

OpenClaw 는 문자 수가 아니라 **토큰**을 추적합니다. 토큰은 모델별로 다르지만,
대부분의 OpenAI 스타일 모델은 영어 텍스트 기준으로 토큰 1개당 평균 약 4자를 사용합니다.

## 시스템 프롬프트가 구성되는 방식

OpenClaw 는 실행할 때마다 자체 시스템 프롬프트를 조립합니다. 포함되는 항목은 다음과 같습니다:

- 도구 목록 + 간단한 설명
- Skills 목록 (메타데이터만 포함; 지침은 `read` 로 필요 시 로드)
- 자체 업데이트 지침
- 워크스페이스 + 부트스트랩 파일 (새로 추가될 때 `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`). 대용량 파일은 `agents.defaults.bootstrapMaxChars` 에 의해 잘립니다 (기본값: 20000).
- 시간 (UTC + 사용자 시간대)
- 응답 태그 + 하트비트 동작
- 런타임 메타데이터 (호스트/OS/모델/사고)

전체 구성 내역은 [System Prompt](/concepts/system-prompt) 를 참고하십시오.

## 컨텍스트 윈도우에 포함되는 항목

모델이 수신하는 모든 것은 컨텍스트 한도에 포함됩니다:

- 시스템 프롬프트 (위에 나열된 모든 섹션)
- 대화 기록 (사용자 + 어시스턴트 메시지)
- 도구 호출 및 도구 결과
- 첨부/전사물 (이미지, 오디오, 파일)
- 압축 요약 및 가지치기 아티팩트
- 프로바이더 래퍼 또는 안전 헤더 (보이지 않지만 계산에는 포함됨)

주입된 파일별, 도구, Skills, 시스템 프롬프트 크기 기준의 실용적인 분해는 `/context list` 또는 `/context detail` 를 사용하십시오. [Context](/concepts/context) 를 참고하십시오.

## 현재 토큰 사용량 확인 방법

채팅에서 다음을 사용하십시오:

- `/status` → 세션 모델, 컨텍스트 사용량,
  마지막 응답의 입력/출력 토큰, **추정 비용** (API 키 사용 시)을 표시하는 **이모지 풍부한 상태 카드**.
- `/usage off|tokens|full` → 모든 응답에 **응답별 사용량 푸터**를 추가합니다.
  - 세션별로 유지됩니다 (`responseUsage` 로 저장).
  - OAuth 인증에서는 **비용이 숨겨집니다** (토큰만 표시).
- `/usage cost` → OpenClaw 세션 로그의 로컬 비용 요약을 표시합니다.

기타 인터페이스:

- **TUI/Web TUI:** `/status` + `/usage` 를 지원합니다.
- **CLI:** `openclaw status --usage` 및 `openclaw channels list` 은
  프로바이더 쿼터 윈도우를 표시합니다 (응답별 비용은 아님).

## 비용 추정 (표시되는 경우)

비용은 모델 가격 설정에서 추정됩니다:

```
models.providers.<provider>.models[].cost
```

이는 `input`, `output`, `cacheRead`, 그리고
`cacheWrite` 에 대한 **토큰 100만 개당 USD** 입니다. 가격 정보가 없으면 OpenClaw 는 토큰만 표시합니다. OAuth 토큰은
달러 비용을 절대 표시하지 않습니다.

## 캐시 TTL 및 가지치기 영향

프로바이더 프롬프트 캐싱은 캐시 TTL 윈도우 내에서만 적용됩니다. OpenClaw 는
선택적으로 **cache-ttl 가지치기**를 실행할 수 있습니다: 캐시 TTL 이 만료되면 세션을 가지치기하고, 이후 요청에서 전체 히스토리를 다시 캐싱하는 대신 새로 캐싱된 컨텍스트를 재사용할 수 있도록 캐시 윈도우를 재설정합니다. 이는 세션이 TTL 이후 유휴 상태가 될 때 캐시 쓰기 비용을 낮게 유지합니다.

[Gateway configuration](/gateway/configuration) 에서 구성하고, 동작 세부 사항은 [Session pruning](/concepts/session-pruning) 을 참고하십시오.

하트비트는 유휴 구간 전반에 걸쳐 캐시를 **따뜻하게** 유지할 수 있습니다. 모델 캐시 TTL 이 `1h` 인 경우,
하트비트 간격을 그보다 약간 짧게 설정하면 (예: `55m`) 전체 프롬프트를 다시 캐싱하는 것을 피하여 캐시 쓰기 비용을 줄일 수 있습니다.

Anthropic API 가격 정책에서 캐시 읽기는 입력 토큰보다 훨씬 저렴한 반면,
캐시 쓰기는 더 높은 배수로 과금됩니다. 최신 요율과 TTL 배수는 Anthropic 의 프롬프트 캐싱 가격 문서를 참고하십시오:
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### 예시: 하트비트로 1시간 캐시 유지

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

## 토큰 부담을 줄이기 위한 팁

- 긴 세션을 요약하려면 `/compact` 를 사용하십시오.
- 워크플로에서 대용량 도구 출력은 잘라내십시오.
- 스킬 설명은 짧게 유지하십시오 (스킬 목록이 프롬프트에 주입됩니다).
- 장황한 탐색 작업에는 더 작은 모델을 선호하십시오.

정확한 스킬 목록 오버헤드 공식은 [Skills](/tools/skills) 를 참고하십시오.
