---
summary: "게이트웨이 HTTP 끝점을 통해 단일 도구를 직접 호출"
read_when:
  - 전체 에이전트 차례 없이 도구 호출
  - 도구 정책 적용이 필요한 자동화 구축
title: "도구 호출 API"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/tools-invoke-http-api.md
  workflow: 15
---

# 도구 호출(HTTP)

OpenClaw의 게이트웨이는 단일 도구를 직접 호출하기 위한 간단한 HTTP 끝점을 노출합니다. 항상 활성화되지만 게이트웨이 인증 및 도구 정책에 의해 게이트되어 있습니다.

- `POST /tools/invoke`
- 게이트웨이와 동일한 포트(WS + HTTP 멀티플렉스): `http://<gateway-host>:<port>/tools/invoke`

기본 최대 페이로드 크기는 2MB입니다.

## 인증

게이트웨이 인증 설정을 사용합니다. 베어러 토큰을 전송합니다:

- `Authorization: Bearer <token>`

참고:

- `gateway.auth.mode="token"`일 때 `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`) 사용.
- `gateway.auth.mode="password"`일 때 `gateway.auth.password` (또는 `OPENCLAW_GATEWAY_PASSWORD`) 사용.
- `gateway.auth.rateLimit`이 구성되고 너무 많은 인증 실패가 발생하면 끝점이 `429`를 `Retry-After` 사용으로 반환합니다.

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

- `tool` (문자열, 필수): 호출할 도구 이름.
- `action` (문자열, 선택): 도구 스키마가 `action`을 지원하고 args 페이로드가 이를 생략한 경우 args에 매핑됩니다.
- `args` (객체, 선택): 도구별 인수.
- `sessionKey` (문자열, 선택): 대상 세션 키. 생략되거나 `"main"`이면 게이트웨이가 구성된 메인 세션 키를 사용합니다(`session.mainKey` 및 기본 에이전트 존중, 또는 전역 범위에서 `global`).
- `dryRun` (boolean, 선택): 향후 사용 예약됨. 현재 무시됨.

## 정책 + 라우팅 동작

도구 가용성은 게이트웨이 에이전트에서 사용하는 동일한 정책 체인을 통해 필터링됩니다:

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- 그룹 정책(세션 키가 그룹 또는 채널로 매핑되는 경우)
- subagent 정책(subagent 세션 키로 호출할 때)

도구가 정책에서 허용되지 않으면 끝점이 **404**를 반환합니다.

게이트웨이 HTTP는 기본적으로 하드 거부 목록도 적용합니다(세션 정책이 도구를 허용하더라도):

- `sessions_spawn`
- `sessions_send`
- `gateway`
- `whatsapp_login`

`gateway.tools`를 통해 이 거부 목록을 사용자 정의할 수 있습니다:

```json5
{
  gateway: {
    tools: {
      // HTTP /tools/invoke에서 차단할 추가 도구
      deny: ["browser"],
      // 기본 거부 목록에서 도구 제거
      allow: ["gateway"],
    },
  },
}
```

그룹 정책이 컨텍스트를 해결하도록 돕기 위해 선택적으로 다음을 설정할 수 있습니다:

- `x-openclaw-message-channel: <channel>` (예: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (여러 계정이 존재할 때)

## 응답

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (잘못된 요청 또는 도구 입력 오류)
- `401` → 인증 안 됨
- `429` → 인증 속도 제한(`Retry-After` 설정)
- `404` → 도구를 사용할 수 없음(찾을 수 없거나 허용 목록에 없음)
- `405` → 메서드 허용 안 됨
- `500` → `{ ok: false, error: { type, message } }` (예상치 못한 도구 실행 오류; 다듬어진 메시지)

## 예제

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
