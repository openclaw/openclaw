---
summary: "플러그인 매니페스트 + JSON 스키마 요구 사항 (엄격한 설정 검증)"
read_when:
  - OpenClaw 플러그인을 빌드할 때
  - 플러그인 설정 스키마를 배포하거나 플러그인 검증 오류를 디버깅해야 할 때
title: "플러그인 매니페스트"
x-i18n:
  source_path: docs/plugins/manifest.md
---

# 플러그인 매니페스트 (openclaw.plugin.json)

이 페이지는 **네이티브 OpenClaw 플러그인 매니페스트**만을 위한 것입니다.

호환 번들 레이아웃은 [플러그인 번들](/plugins/bundles)을 참조하세요.

호환 번들 형식은 다른 매니페스트 파일을 사용합니다:

- Codex 번들: `.codex-plugin/plugin.json`
- Claude 번들: `.claude-plugin/plugin.json` 또는 매니페스트 없는 기본 Claude 컴포넌트 레이아웃
- Cursor 번들: `.cursor-plugin/plugin.json`

OpenClaw 은 이러한 번들 레이아웃도 자동 감지하지만, 여기에 설명된 `openclaw.plugin.json` 스키마에 대해 검증되지 않습니다.

모든 네이티브 OpenClaw 플러그인은 **플러그인 루트**에 `openclaw.plugin.json` 파일을 **반드시** 배포해야 합니다. OpenClaw 은 이 매니페스트를 사용하여 **플러그인 코드를 실행하지 않고** 구성을 검증합니다. 누락되거나 유효하지 않은 매니페스트는 플러그인 오류로 처리되어 설정 검증을 차단합니다.

전체 플러그인 시스템 가이드: [플러그인](/tools/plugin).

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

- `id` (string): 정규 플러그인 ID.
- `configSchema` (object): 플러그인 설정을 위한 JSON Schema (인라인).

선택적 키:

- `kind` (string): 플러그인 종류 (예: `"memory"`, `"context-engine"`).
- `channels` (array): 이 플러그인이 등록하는 채널 ID (채널 기능; 예: `["matrix"]`).
- `providers` (array): 이 플러그인이 등록하는 프로바이더 ID (텍스트 추론 기능).
- `providerAuthEnvVars` (object): 프로바이더 ID 로 키가 지정된 인증 환경 변수.
- `providerAuthChoices` (array): 프로바이더 + 인증 방법으로 키가 지정된 저렴한 온보딩/인증 선택 메타데이터.
- `skills` (array): 로드할 Skill 디렉토리 (플러그인 루트 기준 상대 경로).
- `name` (string): 플러그인 표시 이름.
- `description` (string): 짧은 플러그인 요약.
- `uiHints` (object): UI 렌더링을 위한 설정 필드 레이블/플레이스홀더/민감도 플래그.
- `version` (string): 플러그인 버전 (정보용).

## JSON Schema 요구 사항

- **모든 플러그인은 JSON Schema 를 배포해야 합니다**, 설정을 받지 않더라도.
- 빈 스키마가 허용됩니다 (예: `{ "type": "object", "additionalProperties": false }`).
- 스키마는 런타임이 아닌 설정 읽기/쓰기 시에 검증됩니다.

## 검증 동작

- 알 수 없는 `channels.*` 키는 **오류**입니다, 채널 ID 가 플러그인 매니페스트에 의해 선언되지 않은 한.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny`, `plugins.slots.*`는 **검색 가능한** 플러그인 ID 를 참조해야 합니다. 알 수 없는 ID 는 **오류**입니다.
- 플러그인이 설치되었지만 매니페스트나 스키마가 깨지거나 누락된 경우 검증이 실패하고 Doctor 가 플러그인 오류를 보고합니다.
- 플러그인 설정이 존재하지만 플러그인이 **비활성화**된 경우 설정은 유지되고 Doctor + 로그에 **경고**가 표시됩니다.

설정 참조는 [구성 참조](/configuration)를 확인하세요.

## 참고 사항

- 매니페스트는 로컬 파일 시스템 로드를 포함한 **네이티브 OpenClaw 플러그인에 필수**입니다.
- 런타임은 여전히 플러그인 모듈을 별도로 로드합니다; 매니페스트는 검색 + 검증에만 사용됩니다.
- 독점 플러그인 종류는 `plugins.slots.*`를 통해 선택됩니다.
  - `kind: "memory"`는 `plugins.slots.memory`로 선택됩니다.
  - `kind: "context-engine"`은 `plugins.slots.contextEngine`으로 선택됩니다 (기본값: 내장 `legacy`).
