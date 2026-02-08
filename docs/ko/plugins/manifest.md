---
read_when:
    - OpenClaw 플러그인을 구축 중입니다.
    - 플러그인 구성 스키마를 제공하거나 플러그인 유효성 검사 오류를 디버그해야 합니다.
summary: 플러그인 매니페스트 + JSON 스키마 요구 사항(엄격한 구성 검증)
title: 플러그인 매니페스트
x-i18n:
    generated_at: "2026-02-08T16:00:28Z"
    model: gtx
    provider: google-translate
    source_hash: 234c7c0e77f22f5cd3c7fa0c06d442ce2c543b45cdeb35229d19f2f805dafcd2
    source_path: plugins/manifest.md
    workflow: 15
---

# 플러그인 매니페스트(openclaw.plugin.json)

모든 플러그인 **~ 해야 하다** 선박 `openclaw.plugin.json` 파일을 **플러그인 루트**.
OpenClaw는 이 매니페스트를 사용하여 구성을 검증합니다. **플러그인을 실행하지 않고
코드**. 누락되거나 유효하지 않은 매니페스트는 플러그인 오류로 처리되어 차단됩니다.
구성 검증.

전체 플러그인 시스템 가이드를 참조하세요: [플러그인](/tools/plugin).

## 필수 입력사항

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

- `id` (문자열): 표준 플러그인 ID.
- `configSchema` (객체): 플러그인 구성을 위한 JSON 스키마(인라인).

선택적 키:

- `kind` (문자열): 플러그인 종류(예: `"memory"`).
- `channels` (array): 이 플러그인이 등록한 채널 ID(예: `["matrix"]`).
- `providers` (배열): 이 플러그인이 등록한 공급자 ID입니다.
- `skills` (배열): 로드할 스킬 디렉터리(플러그인 루트 기준).
- `name` (문자열): 플러그인의 표시 이름입니다.
- `description` (문자열): 짧은 플러그인 요약.
- `uiHints` (객체): UI 렌더링을 위한 구성 필드 레이블/자리 표시자/민감한 플래그입니다.
- `version` (문자열): 플러그인 버전(정보용).

## JSON 스키마 요구 사항

- **모든 플러그인은 JSON 스키마를 제공해야 합니다.**, 구성을 허용하지 않는 경우에도 마찬가지입니다.
- 빈 스키마가 허용됩니다(예: `{ "type": "object", "additionalProperties": false }`).
- 스키마는 런타임이 아닌 구성 읽기/쓰기 시간에 검증됩니다.

## 검증 동작

- 알려지지 않은 `channels.*` 열쇠는 **오류**, 채널 ID가 다음에 의해 선언되지 않는 한
  플러그인 매니페스트.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny`, 그리고 `plugins.slots.*`
  참조해야 함 **검색 가능** 플러그인 ID. 알 수 없는 ID는 다음과 같습니다. **오류**.
- 플러그인이 설치되었지만 매니페스트나 스키마가 손상되거나 누락된 경우,
  검증이 실패하고 의사가 플러그인 오류를 보고합니다.
- 플러그인 구성이 존재하지만 플러그인이 **장애가 있는**, 구성이 유지되고
  에 **경고** Doctor + 로그에 표시됩니다.

## 메모

- 매니페스트는 **모든 플러그인에 필요**, 로컬 파일 시스템 로드 포함.
- 런타임은 여전히 ​​플러그인 모듈을 별도로 로드합니다. 매니페스트는
  발견 + 검증.
- 플러그인이 기본 모듈에 의존하는 경우 빌드 단계와 모든 사항을 문서화하세요.
  패키지 관리자 허용 목록 요구 사항(예: pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`).
