---
summary: "Gateway HTTP 엔드포인트를 통해 단일 도구를 직접 호출"
read_when:
  - 전체 에이전트 턴을 실행하지 않고 도구를 호출할 때
  - 도구 정책 강제가 필요한 자동화를 빌드할 때
title: "도구 호출 API"
x-i18n:
  source_path: docs/gateway/tools-invoke-http-api.md
---

# 도구 호출 (HTTP)

OpenClaw의 Gateway는 단일 도구를 직접 호출하기 위한 간단한 HTTP 엔드포인트를 노출합니다. 항상 활성화되어 있지만, Gateway 인증과 도구 정책으로 제어됩니다.

- `POST /tools/invoke`
- Gateway와 동일한 포트 (WS + HTTP 멀티플렉스): `http://<gateway-host>:<port>/tools/invoke`

기본 최대 페이로드 크기는 2 MB입니다.

## 인증

Gateway 인증 설정을 사용합니다. 베어러 토큰을 전송합니다:

- `Authorization: Bearer <token>`

참고:

- `gateway.auth.mode="token"`일 때 `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`)을 사용합니다.
- `gateway.auth.mode="password"`일 때 `gateway.auth.password` (또는 `OPENCLAW_GATEWAY_PASSWORD`)를 사용합니다.
- `gateway.auth.rateLimit`이 설정되고 인증 실패가 너무 많으면, 엔드포인트는 `Retry-After`와 함께 `429`를 반환합니다.

## 요청 본문

```json
{
  "tool": "sessions_list",
  "action": "json",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

필드:

- `tool` (string, 필수): 호출할 도구 이름.
- `action` (string, 선택): 도구 스키마가 `action`을 지원하고 args 페이로드에서 생략된 경우 args에 매핑됩니다.
- `args` (object, 선택): 도구별 인수.
- `sessionKey` (string, 선택): 대상 세션 키. 생략되거나 `"main"`이면, Gateway는 설정된 메인 세션 키를 사용합니다 (`session.mainKey`와 기본 에이전트를 따르거나, 전역 범위에서 `global`).
- `dryRun` (boolean, 선택): 향후 사용을 위해 예약됨. 현재 무시됩니다.

## 정책 + 라우팅 동작

도구 가용성은 Gateway 에이전트가 사용하는 것과 동일한 정책 체인을 통해 필터링됩니다:

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- 그룹 정책 (세션 키가 그룹 또는 채널에 매핑되는 경우)
- 서브에이전트 정책 (서브에이전트 세션 키로 호출하는 경우)

도구가 정책에 의해 허용되지 않으면, 엔드포인트는 **404**를 반환합니다.

Gateway HTTP는 기본적으로 하드 거부 목록도 적용합니다 (세션 정책이 도구를 허용하더라도):

- `sessions_spawn`
- `sessions_send`
- `gateway`
- `whatsapp_login`

`gateway.tools`를 통해 이 거부 목록을 커스터마이즈할 수 있습니다:

```json5
{
  gateway: {
    tools: {
      // HTTP /tools/invoke에서 추가로 차단할 도구
      deny: ["browser"],
      // 기본 거부 목록에서 도구 제거
      allow: ["gateway"],
    },
  },
}
```

그룹 정책이 컨텍스트를 해석하는 데 도움이 되도록, 선택적으로 설정할 수 있습니다:

- `x-openclaw-message-channel: <channel>` (예: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (여러 계정이 있는 경우)

## 응답

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (잘못된 요청 또는 도구 입력 오류)
- `401` → 인증 실패
- `429` → 인증 속도 제한 (`Retry-After` 설정)
- `404` → 도구 사용 불가 (찾을 수 없거나 허용 목록에 없음)
- `405` → 허용되지 않는 메서드
- `500` → `{ ok: false, error: { type, message } }` (예상치 못한 도구 실행 오류; 메시지 정제됨)

## 예시

```bash
curl -sS http://127.0.0.1:18789/tools/invoke \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_list",
    "action": "json",
    "args": {}
  }'
```
