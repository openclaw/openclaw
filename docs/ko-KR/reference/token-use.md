---
summary: "OpenClaw가 프롬프트 컨텍스트를 구성하고 토큰 사용 및 비용을 보고하는 방법"
read_when:
  - 토큰 사용, 비용 또는 컨텍스트 윈도우를 설명할 때
  - 컨텍스트 증가 또는 압축 행동을 디버깅할 때
title: "토큰 사용 및 비용"
---

# 토큰 사용 및 비용

OpenClaw는 **문자**가 아닌 **토큰**을 추적합니다. 토큰은 모델 별로 다르지만 대부분의 OpenAI 스타일 모델은 영어 텍스트의 경우 토큰당 평균 약 4문자를 사용합니다.

## 시스템 프롬프트가 구축되는 방법

OpenClaw는 실행할 때마다 자체 시스템 프롬프트를 조립합니다. 여기에는 다음이 포함됩니다:

- 도구 목록 + 짧은 설명
- 스킬 목록 (메타데이터만 포함; 지침은 `read`로 필요 시 로드됨)
- 자체 업데이트 지침
- 워크스페이스 + 초기화 파일 (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`가 새로워질 때, 그리고 `MEMORY.md` 및/또는 `memory.md`가 있을 경우 포함). 큰 파일은 `agents.defaults.bootstrapMaxChars` (기본값: 20000)로 잘리고, 전체 부트스트랩 주입은 `agents.defaults.bootstrapTotalMaxChars` (기본값: 150000)로 제한됩니다. `memory/*.md` 파일은 메모리 도구를 통해 필요 시 로드되며 자동 주입되지 않습니다.
- 시간 (UTC + 사용자 시간대)
- 답글 태그 + 하트비트 행동
- 런타임 메타데이터 (호스트/OS/모델/생각)

전체 설명은 [시스템 프롬프트](/ko-KR/concepts/system-prompt)에서 확인하세요.

## 컨텍스트 윈도우에 포함되는 것

모델이 받는 모든 것은 컨텍스트 제한에 포함됩니다:

- 시스템 프롬프트 (위에 나열된 모든 섹션)
- 대화 기록 (사용자 + 에이전트 메시지)
- 도구 호출 및 도구 결과
- 첨부 파일/스크립트 (이미지, 오디오, 파일)
- 압축 요약 및 가지치기 아티팩트
- 프로바이더 래퍼 또는 안전 헤더 (보이지 않지만 여전히 계산됨)

이미지의 경우, OpenClaw는 프로바이더 호출 전에 스크립트/도구 이미지 페이로드를 축소합니다. `agents.defaults.imageMaxDimensionPx` (기본값: `1200`)를 사용하여 이를 조정하세요:

- 낮은 값은 일반적으로 비전 토큰 사용량과 페이로드 크기를 줄입니다.
- 높은 값은 OCR/UI 중심 스크린샷에 대해 더 많은 시각적 세부 정보를 보존합니다.

실제 구성 요소 (주입된 파일, 도구, 스킬, 시스템 프롬프트 크기별) 분석은 `/context list` 또는 `/context detail`을 사용하세요. [컨텍스트](/ko-KR/concepts/context)를 참조하세요.

## 현재 토큰 사용량을 보는 방법

채팅에서 다음을 사용하세요:

- `/status` → 세션 모델, 컨텍스트 사용량, 마지막 응답 입출력 토큰, **예상 비용** (API 키만 제공)과 함께 **이모지 풍부 상태 카드**를 표시합니다.
- `/usage off|tokens|full` → 모든 답글에 **응답별 사용량 바닥글**을 추가합니다.
  - 세션당 지속됩니다 (`responseUsage`로 저장됩니다).
  - OAuth 인증 시 **비용 숨김** (토큰만 표시).
- `/usage cost` → OpenClaw 세션 로그에서 로컬 비용 요약을 보여줍니다.

기타 인터페이스:

- **TUI/Web TUI:** `/status` + `/usage` 지원.
- **CLI:** `openclaw status --usage` 및 `openclaw channels list`는 프로바이더 쿼터 윈도우를 표시 (응답별 비용은 아님).

## 비용 추정 (표시될 때)

비용은 모델 가격 설정에서 추정됩니다:

```
models.providers.<provider>.models[].cost
```

이는 `input`, `output`, `cacheRead`, 및 `cacheWrite`에 대해 **1M토큰당 USD**입니다. 가격이 누락된 경우, OpenClaw는 토큰만 표시합니다. OAuth 토큰은 절대 비용을 보여주지 않습니다.

## 캐시 TTL 및 가지치기 영향

프로바이더 프롬프트 캐싱은 캐시 TTL 윈도우 내에서만 적용됩니다. OpenClaw는 선택적으로 **캐시-ttl 가지치기**를 실행할 수 있습니다: 캐시 TTL이 만료되면 세션을 가지치기하고 캐시 윈도우를 리셋하여 후속 요청 시 전체 기록을 다시 캐싱하는 대신 새롭게 캐시된 컨텍스트를 재사용할 수 있게 합니다. 이는 세션이 TTL을 초과하여 유휴 상태가 되었을 때 캐시 쓰기 비용을 낮게 유지합니다.

[게이트웨이 구성](/ko-KR/gateway/configuration)에서 설정하고 [세션 가지치기](/ko-KR/concepts/session-pruning)에서 행동 세부사항을 참조하세요.

하트비트는 유휴 간격 동안 캐시를 **따뜻하게** 유지할 수 있습니다. 모델 캐시 TTL이 `1h`인 경우, 하트비트 간격을 그보다 약간 낮게 설정 (예: `55m`)하면 전체 프롬프트를 다시 캐싱하지 않게 되어 캐시 쓰기 비용을 줄일 수 있습니다.

Anthropic API 가격 책정에서 캐시 읽기 비용은 입력 토큰보다 상당히 저렴하지만 캐시 쓰기는 더 높은 배율로 청구됩니다. 최신 요율과 TTL 배율을 위해 Anthropic의 프롬프트 캐싱 가격을 참조하세요: [https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### 예제: 하트비트를 통해 1시간 캐시 따뜻하게 유지하기

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

### 예제: Anthropic 1M 컨텍스트 베타 헤더 활성화하기

Anthropic의 1M 컨텍스트 윈도우는 현재 베타로 제한됩니다. OpenClaw는 지원되는 Opus 또는 Sonnet 모델에서 `context1m`을 활성화할 때 필요한 `anthropic-beta` 값을 주입할 수 있습니다.

```yaml
agents:
  defaults:
    models:
      "anthropic/claude-opus-4-6":
        params:
          context1m: true
```

이는 Anthropic의 `context-1m-2025-08-07` 베타 헤더로 매핑됩니다.

## 토큰 압박 줄이는 팁

- `/compact`를 사용하여 긴 세션을 요약합니다.
- 워크플로에서 큰 도구 출력을 줄입니다.
- 스크린샷 중심 세션을 위해 `agents.defaults.imageMaxDimensionPx`를 낮추세요.
- 스킬 설명을 짧게 유지하세요 (스킬 목록이 프롬프트에 주입됨).
- 자세하고 탐사적인 작업에 작은 모델을 선호하세요.

정확한 스킬 목록 오버헤드 공식은 [스킬](/ko-KR/tools/skills)에서 확인하세요.