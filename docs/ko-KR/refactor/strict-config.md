---
summary: "Strict config validation + doctor-only migrations"
read_when:
  - Designing or implementing config validation behavior
  - Working on config migrations or doctor workflows
  - Handling plugin config schemas or plugin load gating
title: "Strict Config Validation"
x-i18n:
  source_hash: 5bc7174a67d2234e763f21330d8fe3afebc23b2e5c728a04abcc648b453a91cc
---

# 엄격한 구성 검증(의사 전용 마이그레이션)

## 목표

- **모든 곳에서 알 수 없는 구성 키를 거부합니다**(루트 + 중첩).
- **스키마가 없는 플러그인 구성 거부**; 해당 플러그인을 로드하지 마세요.
- **로드 시 기존 자동 마이그레이션 제거**; 마이그레이션은 의사를 통해서만 실행됩니다.
- **시작 시 자동 실행 닥터(모의 실행)**; 유효하지 않은 경우 비진단 명령을 차단합니다.

## 논골

- 로드 시 이전 버전과의 호환성(레거시 키는 자동 마이그레이션되지 않음)
- 인식할 수 없는 키가 자동으로 삭제됩니다.

## 엄격한 검증 규칙

- 구성은 모든 수준에서 스키마와 정확히 일치해야 합니다.
- 알 수 없는 키는 유효성 검사 오류입니다(루트 또는 중첩된 패스스루 없음).
- `plugins.entries.<id>.config`는 플러그인 스키마에 의해 검증되어야 합니다.
  - 플러그인에 스키마가 부족한 경우 **플러그인 로드를 거부**하고 명확한 오류를 표시합니다.
- 알 수 없는 `channels.<id>` 키는 플러그인 매니페스트가 채널 ID를 선언하지 않는 한 오류입니다.
- 모든 플러그인에는 플러그인 매니페스트(`openclaw.plugin.json`)가 필요합니다.

## 플러그인 스키마 적용

- 각 플러그인은 구성에 대해 엄격한 JSON 스키마를 제공합니다(매니페스트의 인라인).
- 플러그인 로드 흐름:
  1. 플러그인 매니페스트 + 스키마(`openclaw.plugin.json`)를 해결합니다.
  2. 스키마에 대해 구성의 유효성을 검사합니다.
  3. 스키마가 누락되었거나 구성이 잘못된 경우: 플러그인 로드를 차단하고 오류를 기록합니다.
- 오류 메시지에는 다음이 포함됩니다.
  - 플러그인 ID
  - 이유(스키마 누락/잘못된 구성)
  - 검증에 실패한 경로
- 비활성화된 플러그인은 구성을 유지하지만 Doctor + 로그에는 경고가 표시됩니다.

## 닥터플로우

- Doctor는 구성이 로드될 때마다 \*\*실행됩니다(기본적으로 테스트 실행).
- 구성이 유효하지 않은 경우:
  - 요약 + 실행 가능한 오류를 인쇄합니다.
  - 지시: `openclaw doctor --fix`.
- `openclaw doctor --fix`:
  - 마이그레이션을 적용합니다.
  - 알 수 없는 키를 제거합니다.
  - 업데이트된 구성을 작성합니다.

## 명령 게이팅(구성이 유효하지 않은 경우)

허용됨(진단 전용):

- `openclaw doctor`
- `openclaw logs`
- `openclaw health`
- `openclaw help`
- `openclaw status`
- `openclaw gateway status`

다른 모든 것은 "구성이 잘못되었습니다. `openclaw doctor --fix`를 실행하세요."라는 메시지와 함께 하드 실패해야 합니다.

## 오류 UX 형식

- 단일 요약 헤더.
- 그룹화된 섹션:
  - 알 수 없는 키(전체 경로)
  - 레거시 키/마이그레이션 필요
  - 플러그인 로드 실패(플러그인 ID + 이유 + 경로)

## 구현 터치포인트

- `src/config/zod-schema.ts`: 루트 패스스루를 제거합니다. 모든 곳에서 엄격한 개체.
- `src/config/zod-schema.providers.ts`: 엄격한 채널 스키마를 보장합니다.
- `src/config/validation.ts`: 알 수 없는 키에 실패합니다. 레거시 마이그레이션을 적용하지 마십시오.
- `src/config/io.ts`: 레거시 자동 마이그레이션을 제거합니다. 항상 닥터 드라이런을 하세요.
- `src/config/legacy*.ts`: 의사에게만 사용권을 옮깁니다.
- `src/plugins/*`: 스키마 레지스트리 + 게이팅을 추가합니다.
- `src/cli`의 CLI 명령 게이팅.

## 테스트

- 알 수 없는 키 거부(루트 + 중첩)
- 플러그인 스키마 누락 → 명확한 오류로 인해 플러그인 로드가 차단되었습니다.
- 잘못된 구성 → 진단 명령을 제외한 게이트웨이 시작이 차단됩니다.
- 닥터 드라이런 자동; `doctor --fix`는 수정된 구성을 작성합니다.
