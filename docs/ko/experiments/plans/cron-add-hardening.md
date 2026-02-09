---
summary: "cron.add 입력 처리를 강화하고, 스키마를 정렬하며, cron UI/에이전트 도구를 개선합니다"
owner: "openclaw"
status: "complete"
last_updated: "2026-01-05"
title: "Cron Add 하드닝"
---

# Cron Add 하드닝 & 스키마 정렬

## Context

최근 Gateway(게이트웨이) 로그에서 잘못된 파라미터(누락된 `sessionTarget`, `wakeMode`, `payload` 및 형식이 잘못된 `schedule`)로 인해 `cron.add` 실패가 반복적으로 발생하고 있습니다. 이는 최소 한 개의 클라이언트(아마도 에이전트 도구 호출 경로)가 래핑되었거나 부분적으로 지정된 작업 페이로드를 전송하고 있음을 시사합니다. 별도로, TypeScript 의 cron 프로바이더 enum, Gateway(게이트웨이) 스키마, CLI 플래그, UI 폼 타입 간에 불일치가 있으며, `cron.status` 에 대한 UI 불일치도 존재합니다(UI 는 `jobCount` 을 기대하지만 Gateway(게이트웨이)는 `jobs` 을 반환).

## Goals

- 일반적인 래퍼 페이로드를 정규화하고 누락된 `kind` 필드를 추론하여 `cron.add` INVALID_REQUEST 스팸을 중지합니다.
- Gateway(게이트웨이) 스키마, cron 타입, CLI 문서, UI 폼 전반에서 cron 프로바이더 목록을 정렬합니다.
- LLM 이 올바른 작업 페이로드를 생성하도록 에이전트 cron 도구 스키마를 명시적으로 만듭니다.
- Control UI 의 cron 상태 작업 수 표시를 수정합니다.
- 정규화 및 도구 동작을 포괄하는 테스트를 추가합니다.

## Non-goals

- cron 스케줄링 의미론 또는 작업 실행 동작을 변경하지 않습니다.
- 새로운 스케줄 종류를 추가하거나 cron 표현식 파싱을 추가하지 않습니다.
- 필요한 필드 수정 범위를 넘어 cron 에 대한 UI/UX 를 전면 개편하지 않습니다.

## Findings (current gaps)

- Gateway(게이트웨이)의 `CronPayloadSchema` 은 `signal` + `imessage` 를 제외하지만, TS 타입에는 포함되어 있습니다.
- Control UI 의 CronStatus 는 `jobCount` 을 기대하지만, Gateway(게이트웨이)는 `jobs` 를 반환합니다.
- 에이전트 cron 도구 스키마가 임의의 `job` 객체를 허용하여 잘못된 입력을 가능하게 합니다.
- Gateway(게이트웨이)는 정규화 없이 `cron.add` 을 엄격히 검증하므로, 래핑된 페이로드가 실패합니다.

## What changed

- `cron.add` 및 `cron.update` 이 이제 일반적인 래퍼 형태를 정규화하고 누락된 `kind` 필드를 추론합니다.
- 에이전트 cron 도구 스키마가 Gateway(게이트웨이) 스키마와 일치하여 잘못된 페이로드를 줄입니다.
- 프로바이더 enum 이 Gateway(게이트웨이), CLI, UI, macOS 피커 전반에서 정렬되었습니다.
- Control UI 는 상태 표시를 위해 Gateway(게이트웨이)의 `jobs` 카운트 필드를 사용합니다.

## Current behavior

- **정규화:** 래핑된 `data`/`job` 페이로드는 언래핑되며, 안전한 경우 `schedule.kind` 및 `payload.kind` 가 추론됩니다.
- **기본값:** 누락 시 `wakeMode` 및 `sessionTarget` 에 대해 안전한 기본값이 적용됩니다.
- **프로바이더:** Discord/Slack/Signal/iMessage 가 이제 CLI/UI 전반에서 일관되게 노출됩니다.

정규화된 형태와 예시는 [Cron jobs](/automation/cron-jobs) 를 참고하십시오.

## Verification

- Gateway(게이트웨이) 로그를 모니터링하여 `cron.add` INVALID_REQUEST 오류가 감소했는지 확인합니다.
- 새로 고침 후 Control UI 의 cron 상태에 작업 수가 표시되는지 확인합니다.

## Optional Follow-ups

- Control UI 수동 스모크 테스트: 프로바이더별로 cron 작업을 하나씩 추가하고 상태 작업 수를 확인합니다.

## Open Questions

- `cron.add` 이 클라이언트로부터 명시적인 `state` 을 수용해야 합니까(현재 스키마에서 허용되지 않음)?
- `webchat` 을 명시적인 전달 프로바이더로 허용해야 합니까(현재 전달 해석에서 필터링됨)?
