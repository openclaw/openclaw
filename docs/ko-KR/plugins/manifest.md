---
summary: "플러그인 매니페스트 + JSON 스키마 요구 사항 (엄격한 구성 검증)"
read_when:
  - "OpenClaw 플러그인을 구축할 때"
  - "플러그인 구성 스키마를 제공하거나 플러그인 검증 오류를 디버깅해야 할 때"
title: "플러그인 매니페스트"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/plugins/manifest.md
  workflow: 15
---

# 플러그인 매니페스트 (openclaw.plugin.json)

모든 플러그인은 **플러그인 루트**에 `openclaw.plugin.json` 파일을 제공해야 합니다.
OpenClaw는 이 매니페스트를 사용하여 플러그인 코드를 실행하지 않고 구성을 검증합니다. 누락되거나 잘못된 매니페스트는 플러그인 오류로 취급되며 구성 검증을 차단합니다.

전체 플러그인 시스템 가이드를 참조하세요: [플러그인](/tools/plugin).

## 필수 필드

```json
{
  "id": "voice-call",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

필수 키:

- `id` (문자열): 표준 플러그인 id.
- `configSchema` (객체): 플러그인 구성용 JSON 스키마 (인라인).

선택적 키:

- `kind` (문자열): 플러그인 종류 (예: `"memory"`).
- `channels` (배열): 이 플러그인에서 등록된 채널 id (예: `["matrix"]`).
- `providers` (배열): 등록된 제공자 id.
- `skills` (배열): 로드할 스킬 디렉토리 (플러그인 루트 기준).
- `name` (문자열): 플러그인의 표시 이름.
- `description` (문자열): 짧은 플러그인 요약.
- `uiHints` (객체): UI 렌더링을 위한 구성 필드 레이블/자리 표시자/민감한 플래그.
- `version` (문자열): 플러그인 버전 (정보용).

## JSON 스키마 요구 사항

- **모든 플러그인은 JSON 스키마를 제공해야 합니다** (구성이 없으면 없음).
- 빈 스키마는 수용 가능합니다 (예: `{ "type": "object", "additionalProperties": false }`).
- 스키마는 런타임이 아닌 구성 읽기/쓰기 시간에 검증됩니다.

## 검증 동작

- 알려지지 않은 `channels.*` 키는 채널 id가 플러그인 매니페스트에 의해 선언되지 않으면 **오류**입니다.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny`, 및 `plugins.slots.*`는 **발견 가능한** 플러그인 id를 참조해야 합니다. 알려지지 않은 id는 **오류**입니다.
- 플러그인이 설치되었지만 손상되거나 누락된 매니페스트 또는 스키마가 있으면 검증이 실패하고 Doctor가 플러그인 오류를 보고합니다.
- 플러그인 구성이 있지만 플러그인이 **비활성화**되면 구성이 유지되고 Doctor + 로그에 **경고**가 표시됩니다.

## 메모

- 매니페스트는 **모든 플러그인에 필수**이며 로컬 파일 시스템 로드 포함.
- 런타임은 여전히 플러그인 모듈을 별도로 로드합니다. 매니페스트는 발견 + 검증만 해당합니다.
- 플러그인이 네이티브 모듈에 의존하면 빌드 단계 및 모든 패키지 관리자 allowlist 요구 사항을 문서화합니다 (예: pnpm `allow-build-scripts` - `pnpm rebuild <package>`).
