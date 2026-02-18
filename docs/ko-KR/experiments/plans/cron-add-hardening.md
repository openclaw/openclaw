---
summary: "cron.add 입력 처리 강화를 통해 스키마 정렬 및 cron UI/에이전트 도구 개선"
owner: "openclaw"
status: "완료"
last_updated: "2026-01-05"
title: "Cron 추가 강화"
---

# Cron 추가 강화 및 스키마 정렬

## 맥락

최근 게이트웨이 로그에 따르면 잘못된 매개변수(누락된 `sessionTarget`, `wakeMode`, `payload`, 잘못된 `schedule`)로 인한 `cron.add` 실패가 반복되고 있습니다. 이는 적어도 하나의 클라이언트(아마도 에이전트 도구 호출 경로)가 래핑되거나 부분적으로 지정된 작업 페이로드를 보내고 있음을 나타냅니다. 별도로 TypeScript, 게이트웨이 스키마, CLI 플래그, UI 양식 타입의 cron 프로바이더 열거형 간에 차이가 있으며, `cron.status`의 UI 불일치가 있습니다(`jobCount`를 기대하지만 게이트웨이는 `jobs`를 반환).

## 목표

- 일반적인 래퍼 페이로드를 정규화하고 누락된 `kind` 필드를 추론하여 `cron.add` INVALID_REQUEST 스팸 중지.
- 게이트웨이 스키마, cron 타입, CLI 문서, UI 양식 전반에 걸쳐 cron 프로바이더 목록 정렬.
- 에이전트 cron 도구 스키마를 명시적으로 만들어 LLM이 올바른 작업 페이로드를 생성하도록 개선.
- Control UI cron 상태 작업 수 표시 수정.
- 정규화 및 도구 동작을 다루는 테스트 추가.

## 비목표

- cron 일정 설정 의미 또는 작업 실행 동작 변경.
- 새로운 일정 종류 추가 또는 cron 표현식 파싱 추가.
- 필요한 필드 수정 외의 cron을 위한 UI/UX 전면 개편.

## 발견된 사항 (현재의 간극)

- 게이트웨이의 `CronPayloadSchema`에서 `signal` + `imessage` 제외되어 있지만, TS 타입에는 포함.
- Control UI CronStatus는 `jobCount`를 기대하지만, 게이트웨이는 `jobs`를 반환.
- 에이전트 cron 도구 스키마는 임의의 `job` 개체를 허용하여 잘못된 입력을 가능하게 함.
- 게이트웨이는 `cron.add`를 엄격하게 검증하며 정규화를 수행하지 않으므로 래핑된 페이로드가 실패.

## 변경 사항

- 이제 `cron.add`와 `cron.update`는 일반적인 래퍼 모양을 정규화하고 누락된 `kind` 필드를 추론.
- 에이전트 cron 도구 스키마가 게이트웨이 스키마와 일치하여 잘못된 페이로드 감소.
- 프로바이더 열거형이 게이트웨이, CLI, UI 및 macOS 선택기와 일치.
- Control UI는 게이트웨이의 `jobs` 수 필드를 상태에 사용.

## 현재 동작

- **정규화:** 래핑된 `data`/`job` 페이로드가 풀림; `schedule.kind`와 `payload.kind`는 안전할 때 추론됨.
- **기본값:** 안전한 기본값이 누락된 경우 `wakeMode`와 `sessionTarget`에 적용.
- **프로바이더:** Discord/Slack/Signal/iMessage가 CLI/UI 전반에 일관되게 표출.

정규화된 모양과 예제를 보려면 [Cron jobs](/automation/cron-jobs)를 참조하세요.

## 검증

- 게이트웨이 로그에서 줄어든 `cron.add` INVALID_REQUEST 오류 관찰.
- 새로 고침 후 Control UI cron 상태가 작업 수를 표시하는지 확인.

## 선택적 후속 작업

- 수동 Control UI 흡연 검사: 프로바이더당 cron 작업 추가 + 상태 작업 수 확인.

## 개방된 질문

- `cron.add`가 클라이언트로부터 명시적인 `state`를 허용해야 할까요(현재 스키마에서 허용되지 않음)?
- `webchat`을 명시적인 전달 프로바이더로 허용해야 할까요(현재 전달 해결 시 필터링됨)?
