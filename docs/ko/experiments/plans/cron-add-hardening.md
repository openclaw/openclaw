---
last_updated: "2026-01-05"
owner: openclaw
status: complete
summary: cron.add 입력 처리 강화, 스키마 정렬, cron UI/에이전트 도구 개선
title: 크론 강화 강화
x-i18n:
    generated_at: "2026-02-08T15:57:15Z"
    model: gtx
    provider: google-translate
    source_hash: d7e469674bd9435b846757ea0d5dc8f174eaa8533917fc013b1ef4f82859496d
    source_path: experiments/plans/cron-add-hardening.md
    workflow: 15
---

# Cron 강화 및 스키마 정렬 추가

## 문맥

최근 게이트웨이 로그가 반복적으로 표시됩니다. `cron.add` 잘못된 매개변수로 인한 실패(누락 `sessionTarget`, `wakeMode`, `payload`, 형식이 잘못되었습니다. `schedule`). 이는 하나 이상의 클라이언트(에이전트 도구 호출 경로 등)가 래핑되거나 부분적으로 지정된 작업 페이로드를 보내고 있음을 나타냅니다. 이와 별도로 TypeScript, 게이트웨이 스키마, CLI 플래그 및 UI 양식 유형의 cron 공급자 열거형 사이에 드리프트가 있으며 `cron.status` (기대한다. `jobCount` 게이트웨이가 반환되는 동안 `jobs`).

## 목표

- 멈추다 `cron.add` 일반적인 래퍼 페이로드를 정규화하고 누락된 내용을 추론하여 INVALID_REQUEST 스팸을 보냅니다. `kind` 전지.
- 게이트웨이 스키마, cron 유형, CLI 문서 및 UI 양식 전반에 걸쳐 cron 공급자 목록을 정렬합니다.
- LLM이 올바른 작업 페이로드를 생성하도록 에이전트 cron 도구 스키마를 명시적으로 만듭니다.
- Control UI cron 상태 작업 수 표시를 수정합니다.
- 정규화 및 도구 동작을 다루는 테스트를 추가합니다.

## 논골

- 크론 예약 의미 또는 작업 실행 동작을 변경합니다.
- 새로운 일정 종류 또는 cron 표현식 구문 분석을 추가합니다.
- 필요한 필드 수정을 넘어 cron의 UI/UX를 점검합니다.

## 조사 결과(현재 격차)

- `CronPayloadSchema` 게이트웨이 제외 `signal` + `imessage`, TS 유형에는 이러한 항목이 포함됩니다.
- 컨트롤 UI CronStatus가 기대하는 것 `jobCount`, 그러나 게이트웨이가 반환됨 `jobs`.
- 에이전트 cron 도구 스키마는 임의 허용 `job` 잘못된 형식의 입력을 가능하게 합니다.
- 게이트웨이는 엄격하게 검증합니다. `cron.add` 정규화가 없으므로 래핑된 페이로드가 실패합니다.

## 무엇이 바뀌었나

- `cron.add` 그리고 `cron.update` 이제 일반적인 래퍼 모양을 정규화하고 누락된 항목을 추론합니다. `kind` 전지.
- 에이전트 크론 도구 스키마는 게이트웨이 스키마와 일치하여 잘못된 페이로드를 줄입니다.
- 공급자 열거형은 게이트웨이, CLI, UI 및 macOS 선택기에 걸쳐 정렬됩니다.
- 컨트롤 UI는 게이트웨이의 `jobs` 상태에 대한 개수 필드입니다.

## 현재 행동

- **표준화:** 감싸인 `data`/`job` 페이로드가 풀립니다. `schedule.kind` 그리고 `payload.kind` 안전할 때 추론됩니다.
- **기본값:** 안전한 기본값이 적용됩니다. `wakeMode` 그리고 `sessionTarget` 누락되었을 때.
- **제공자:** Discord/Slack/Signal/iMessage는 이제 CLI/UI 전반에 일관되게 표시됩니다.

보다 [크론 작업](/automation/cron-jobs) 정규화된 모양과 예를 들어보세요.

## 확인

- 감소된 게이트웨이 로그를 관찰하세요. `cron.add` INVALID_REQUEST 오류.
- Control UI 크론 상태가 새로 고침 후 작업 수를 표시하는지 확인하세요.

## 선택적 후속 조치

- 수동 제어 UI 연기: 공급자당 cron 작업을 추가하고 상태 작업 수를 확인합니다.

## 공개 질문

- 해야 한다 `cron.add` 명시적인 것을 받아들이다 `state` 클라이언트에서(현재 스키마에서 허용되지 않음)?
- 허용해야 할까? `webchat` 명시적인 배달 공급자(현재 배달 확인에서 필터링됨)입니까?
