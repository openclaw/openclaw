---
summary: "Plugin manifest + JSON schema requirements (strict config validation)"
read_when:
  - You are building a OpenClaw plugin
  - You need to ship a plugin config schema or debug plugin validation errors
title: "Plugin Manifest"
x-i18n:
  source_hash: 234c7c0e77f22f5cd3c7fa0c06d442ce2c543b45cdeb35229d19f2f805dafcd2
---

# 플러그인 매니페스트(openclaw.plugin.json)

모든 플러그인은 **플러그인 루트**에 `openclaw.plugin.json` 파일을 **반드시** 제공해야 합니다.
OpenClaw는 이 매니페스트를 사용하여 **플러그인을 실행하지 않고 구성을 검증합니다.
코드**. 누락되거나 유효하지 않은 매니페스트는 플러그인 오류로 처리되어 차단됩니다.
구성 검증.

전체 플러그인 시스템 가이드를 참조하세요: [플러그인](/tools/plugin).

## 필수입력사항

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

- `id` (문자열): 정식 플러그인 ID.
- `configSchema` (객체): 플러그인 구성을 위한 JSON 스키마(인라인).

선택적 키:

- `kind` (문자열): 플러그인 종류(예: `"memory"`).
- `channels` (배열): 이 플러그인에 등록된 채널 ID(예: `["matrix"]`).
- `providers` (배열): 이 플러그인이 등록한 공급자 ID입니다.
- `skills` (배열): 로드할 스킬 디렉터리(플러그인 루트 기준).
- `name` (문자열): 플러그인의 표시 이름입니다.
- `description` (문자열): 짧은 플러그인 요약.
- `uiHints` (객체): UI 렌더링을 위한 구성 필드 레이블/자리 표시자/민감한 플래그입니다.
- `version` (문자열): 플러그인 버전(정보용).

## JSON 스키마 요구 사항

- **모든 플러그인은 구성을 허용하지 않는 경우에도 JSON 스키마를 제공해야 합니다**.
- 빈 스키마가 허용됩니다(예: `{ "type": "object", "additionalProperties": false }`).
- 스키마는 런타임이 아닌 구성 읽기/쓰기 시간에 검증됩니다.

## 유효성 검사 동작

- 채널 ID가 다음에서 선언되지 않는 한 알 수 없는 `channels.*` 키는 **오류**입니다.
  플러그인 매니페스트.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny` 및 `plugins.slots.*`
  **검색 가능한** 플러그인 ID를 참조해야 합니다. 알 수 없는 ID는 **오류**입니다.
- 플러그인이 설치되었지만 매니페스트나 스키마가 손상되거나 누락된 경우,
  검증이 실패하고 의사가 플러그인 오류를 보고합니다.
- 플러그인 구성이 존재하지만 플러그인이 **비활성화**된 경우 구성은 유지되며
  **경고**가 Doctor + 로그에 표시됩니다.

## 메모

- 매니페스트는 로컬 파일 시스템 로드를 포함하여 **모든 플러그인에 필요합니다**.
- 런타임은 여전히 ​​플러그인 모듈을 별도로 로드합니다. 매니페스트는
  발견 + 검증.
- 플러그인이 기본 모듈에 의존하는 경우 빌드 단계와 모든 사항을 문서화하세요.
  패키지 관리자 허용 목록 요구 사항(예: pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`).
