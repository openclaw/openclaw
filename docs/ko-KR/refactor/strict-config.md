---
summary: "엄격한 config 검증 + doctor-only 마이그레이션"
read_when:
  - Designing or implementing config validation behavior
  - Working on config migrations or doctor workflows
  - Handling plugin config schemas or plugin load gating
title: "엄격한 Config 검증"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/refactor/strict-config.md
  workflow: 15
---

# 엄격한 config 검증 (doctor-only 마이그레이션)

## 목표

- **모든 곳에서 미지의 config 키를 거부합니다** (root + 중첩), root `$schema` 메타데이터 제외.
- **스키마가 없는 플러그인 config를 거부합니다**; 해당 플러그인을 로드하지 않습니다.
- **로드 시 레거시 자동-마이그레이션을 제거합니다**; 마이그레이션은 doctor를 통해서만 실행됩니다.
- **Startup에서 doctor를 자동-실행 (dry-run)**; 무효한 경우, 비-진단 명령을 차단합니다.

## 비목표

- 로드 시 역호환성 (레거시 키는 자동-마이그레이션하지 않음).
- 인식되지 않는 키의 자동 드롭.

## 엄격한 검증 규칙

- Config는 모든 수준에서 스키마와 정확히 일치해야 합니다.
- 미지의 키는 검증 오류입니다 (root 또는 중첩에서 passthrough 없음), root `$schema`가 문자열일 때 제외.
- `plugins.entries.<id>.config`은 플러그인의 스키마로 검증되어야 합니다.
  - 플러그인이 스키마를 부족하면, **플러그인 로드를 거부**하고 명확한 오류를 표시합니다.
- 미지의 `channels.<id>` 키는 플러그인 manifest가 channel id를 선언하지 않으면 오류입니다.
- 플러그인 manifest (`openclaw.plugin.json`)은 모든 플러그인에 필요합니다.

## 플러그인 스키마 강제

- 각 플러그인은 해당 config (manifest에 인라인)에 대한 엄격한 JSON 스키마를 제공합니다.
- 플러그인 로드 흐름:
  1. 플러그인 manifest + 스키마 (`openclaw.plugin.json`)를 해결합니다.
  2. 스키마에 대해 config를 검증합니다.
  3. 스키마가 누락되거나 config가 무효한 경우: 플러그인 로드를 차단하고 오류를 기록합니다.
- 오류 메시지는 다음을 포함합니다:
  - 플러그인 id
  - 이유 (스키마 누락 / 무효 config)
  - 검증에 실패한 경로
- 비활성화된 플러그인은 해당 config를 유지하지만, Doctor + 로그가 경고를 표시합니다.

## Doctor 흐름

- Doctor는 **매번** config이 로드될 때 실행됩니다 (기본적으로 dry-run).
- config가 무효한 경우:
  - 요약 + actionable 오류를 인쇄합니다.
  - 지시: `openclaw doctor --fix`.
- `openclaw doctor --fix`:
  - 마이그레이션을 적용합니다.
  - 미지의 키를 제거합니다.
  - 업데이트된 config를 씁니다.

## 명령 게이팅 (config이 무효할 때)

허용됨 (진단-전용):

- `openclaw doctor`
- `openclaw logs`
- `openclaw health`
- `openclaw help`
- `openclaw status`
- `openclaw gateway status`

다른 모든 것은 다음과 함께 hard-fail해야 합니다: "Config invalid. Run `openclaw doctor --fix`."

## 오류 UX 형식

- 단일 요약 헤더.
- 그룹화된 섹션:
  - 미지의 키 (전체 경로)
  - 레거시 키 / 마이그레이션이 필요함
  - 플러그인 로드 실패 (플러그인 id + 이유 + 경로)

## 구현 터치포인트

- `src/config/zod-schema.ts`: root passthrough를 제거; 모든 곳에서 엄격한 객체.
- `src/config/zod-schema.providers.ts`: 엄격한 channel 스키마를 보장합니다.
- `src/config/validation.ts`: 미지의 키에서 실패; 레거시 마이그레이션을 적용하지 않습니다.
- `src/config/io.ts`: 레거시 자동-마이그레이션을 제거; 항상 doctor dry-run을 실행합니다.
- `src/config/legacy*.ts`: doctor only로 사용을 이동합니다.
- `src/plugins/*`: 스키마 레지스트리 + 게이팅을 추가합니다.
- `src/cli`의 CLI 명령 게이팅.

## 테스트

- 미지의 키 거부 (root + 중첩).
- 플러그인 스키마 누락 → 명확한 오류로 플러그인 로드 차단.
- 무효한 config → 진단 명령을 제외한 gateway startup 차단.
- Doctor dry-run auto; `doctor --fix`이 수정된 config를 씁니다.
