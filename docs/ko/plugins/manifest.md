---
summary: "플러그인 매니페스트 + JSON 스키마 요구 사항(엄격한 설정 검증)"
read_when:
  - OpenClaw 플러그인을 구축하고 있을 때
  - 플러그인 설정 스키마를 배포하거나 플러그인 검증 오류를 디버그해야 할 때
title: "플러그인 매니페스트"
---

# 플러그인 매니페스트 (openclaw.plugin.json)

모든 플러그인은 **플러그인 루트**에 `openclaw.plugin.json` 파일을 **반드시** 포함해야 합니다.
OpenClaw 는 이 매니페스트를 사용하여 플러그인 코드를 **실행하지 않고도**
설정을 검증합니다. 매니페스트가 누락되었거나 유효하지 않으면 플러그인 오류로
처리되며 설정 검증이 차단됩니다.

전체 플러그인 시스템 가이드는 다음을 참고하십시오: [Plugins](/tools/plugin).

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

- `id` (string): 표준 플러그인 id.
- `configSchema` (object): 플러그인 설정을 위한 JSON 스키마(인라인).

선택 키:

- `kind` (string): 플러그인 종류(예: `"memory"`).
- `channels` (array): 이 플러그인이 등록하는 채널 id(예: `["matrix"]`).
- `providers` (array): 이 플러그인이 등록하는 프로바이더 id.
- `skills` (array): 로드할 Skills 디렉토리(플러그인 루트 기준 상대 경로).
- `name` (string): 플러그인의 표시 이름.
- `description` (string): 플러그인에 대한 짧은 요약.
- `uiHints` (object): UI 렌더링을 위한 설정 필드 레이블/플레이스홀더/민감 정보 플래그.
- `version` (string): 플러그인 버전(정보 제공용).

## JSON 스키마 요구 사항

- **모든 플러그인은 JSON 스키마를 반드시 포함해야 합니다**, 설정을 받지 않는 경우라도 동일합니다.
- 빈 스키마도 허용됩니다(예: `{ "type": "object", "additionalProperties": false }`).
- 스키마는 런타임이 아니라 설정 읽기/쓰기 시점에 검증됩니다.

## 검증 동작

- 알 수 없는 `channels.*` 키는 **오류**이며, 해당 채널 id 가
  플러그인 매니페스트에 선언된 경우에만 예외가 됩니다.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny`, `plugins.slots.*` 는
  **검색 가능한** 플러그인 id 를 참조해야 합니다. 알 수 없는 id 는 **오류**입니다.
- 플러그인이 설치되어 있으나 매니페스트 또는 스키마가 손상되었거나 누락된 경우,
  검증이 실패하며 Doctor 가 플러그인 오류를 보고합니다.
- 플러그인 설정이 존재하지만 플러그인이 **비활성화**된 경우, 설정은 유지되며
  Doctor + 로그에 **경고**가 표시됩니다.

## 참고 사항

- 매니페스트는 로컬 파일시스템 로드를 포함하여 **모든 플러그인에 필수**입니다.
- 런타임은 여전히 플러그인 모듈을 별도로 로드하며, 매니페스트는
  디바이스 검색 + 검증 용도로만 사용됩니다.
- 플러그인이 네이티브 모듈에 의존하는 경우, 빌드 단계와 패키지 매니저 허용 목록
  요구 사항을 문서화하십시오(예: pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`).
