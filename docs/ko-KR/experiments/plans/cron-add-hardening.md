---
summary: "Harden cron.add input handling, align schemas, and improve cron UI/agent tooling"
owner: "openclaw"
status: "complete"
last_updated: "2026-01-05"
title: "Cron Add Hardening"
x-i18n:
  source_hash: d7e469674bd9435b846757ea0d5dc8f174eaa8533917fc013b1ef4f82859496d
---

# Cron 강화 및 스키마 정렬 추가

## 컨텍스트

최근 게이트웨이 로그에 잘못된 매개변수로 인해 `cron.add` 오류가 반복적으로 표시됩니다(`sessionTarget`, `wakeMode`, `payload` 누락 및 형식이 잘못된 `schedule`). 이는 하나 이상의 클라이언트(에이전트 도구 호출 경로 등)가 래핑되거나 부분적으로 지정된 작업 페이로드를 보내고 있음을 나타냅니다. 이와 별도로 TypeScript의 크론 공급자 열거형, 게이트웨이 스키마, CLI 플래그 및 UI 양식 유형과 `cron.status`에 대한 UI 불일치가 있습니다(게이트웨이가 `jobs`를 반환하는 동안 `jobCount`가 예상됨).

## 목표

- 일반적인 래퍼 페이로드를 정규화하고 누락된 `kind` 필드를 추론하여 `cron.add` INVALID_REQUEST 스팸을 중지합니다.
- 게이트웨이 스키마, cron 유형, CLI 문서 및 UI 양식 전반에 걸쳐 cron 공급자 목록을 정렬합니다.
- LLM이 올바른 작업 페이로드를 생성하도록 에이전트 크론 도구 스키마를 명시적으로 만듭니다.
- Control UI cron 상태 작업 수 표시를 수정합니다.
- 정규화 및 도구 동작을 다루는 테스트를 추가합니다.

## 논골

- 크론 예약 의미 또는 작업 실행 동작을 변경합니다.
- 새로운 일정 종류 또는 크론 표현 구문 분석을 추가합니다.
- 필요한 필드 수정 이상으로 cron의 UI/UX를 점검합니다.

## 조사 결과(현재 격차)

- 게이트웨이의 `CronPayloadSchema`는 `signal` + `imessage`를 제외하고, TS 유형은 이를 포함합니다.
- 제어 UI CronStatus는 `jobCount`를 예상하지만 게이트웨이는 `jobs`를 반환합니다.
- 에이전트 크론 도구 스키마는 임의의 `job` 객체를 허용하여 잘못된 입력을 가능하게 합니다.
- 게이트웨이는 정규화 없이 `cron.add`를 엄격하게 검증하므로 래핑된 페이로드가 실패합니다.

## 달라진 점

- `cron.add` 및 `cron.update`는 이제 일반적인 래퍼 모양을 정규화하고 누락된 `kind` 필드를 추론합니다.
- 에이전트 cron 도구 스키마가 게이트웨이 스키마와 일치하므로 잘못된 페이로드가 줄어듭니다.
- 공급자 열거형은 게이트웨이, CLI, UI 및 macOS 선택기에 걸쳐 정렬됩니다.
- 컨트롤 UI는 상태를 나타내는 게이트웨이의 `jobs` 카운트 필드를 사용합니다.

## 현재 동작

- **정규화:** 래핑된 `data`/`job` 페이로드가 래핑 해제됩니다. `schedule.kind` 및 `payload.kind`는 안전할 때 추론됩니다.
- **기본값:** 누락된 경우 `wakeMode` 및 `sessionTarget`에 안전한 기본값이 적용됩니다.
- **제공자:** Discord/Slack/Signal/iMessage는 이제 CLI/UI 전반에 일관되게 표시됩니다.

정규화된 형태와 예시는 [Cron 작업](/automation/cron-jobs)을 참조하세요.

## 확인

- 게이트웨이 로그에서 `cron.add` INVALID_REQUEST 오류가 감소했는지 확인하세요.
- 제어 UI cron 상태가 새로 고침 후 작업 수를 표시하는지 확인합니다.

## 선택적 후속 조치

- 수동 제어 UI 연기: 공급자당 cron 작업을 추가하고 상태 작업 수를 확인합니다.

## 공개 질문

- `cron.add`는 클라이언트로부터 명시적인 `state`를 허용해야 합니까(현재 스키마에서는 허용되지 않음)?
- `webchat`를 명시적인 배달 공급자로 허용해야 합니까(현재 배달 해상도에서 필터링됨)?
