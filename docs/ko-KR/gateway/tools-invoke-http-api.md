---
summary: "Invoke a single tool directly via the Gateway HTTP endpoint"
read_when:
  - Calling tools without running a full agent turn
  - Building automations that need tool policy enforcement
title: "Tools Invoke API"
x-i18n:
  source_hash: 17ccfbe0b0d9bb61cc46fb21f5c09b106ba6e8e4c2c14135a11ca8d5b77b8a88
---

# 도구 호출(HTTP)

OpenClaw의 게이트웨이는 단일 도구를 직접 호출하기 위한 간단한 HTTP 엔드포인트를 노출합니다. 항상 활성화되어 있지만 게이트웨이 인증 및 도구 정책에 따라 관리됩니다.

- `POST /tools/invoke`
- 게이트웨이와 동일한 포트(WS + HTTP 다중화): `http://<gateway-host>:<port>/tools/invoke`

기본 최대 페이로드 크기는 2MB입니다.

## 인증

게이트웨이 인증 구성을 사용합니다. 전달자 토큰 보내기:

- `Authorization: Bearer <token>`

참고:

- `gateway.auth.mode="token"`인 경우 `gateway.auth.token`(또는 `OPENCLAW_GATEWAY_TOKEN`)를 사용합니다.
- `gateway.auth.mode="password"`인 경우 `gateway.auth.password`(또는 `OPENCLAW_GATEWAY_PASSWORD`)를 사용합니다.

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

분야:

- `tool` (문자열, 필수) : 호출할 도구 이름입니다.
- `action` (문자열, 선택 사항): 도구 스키마가 `action`를 지원하고 args 페이로드가 이를 생략한 경우 args에 매핑됩니다.
- `args` (객체, 선택 사항): 도구별 인수입니다.
- `sessionKey` (문자열, 선택): 대상 세션 키. 생략되거나 `"main"`인 경우 게이트웨이는 구성된 기본 세션 키(`session.mainKey` 및 기본 에이전트 또는 전역 범위에서 `global`를 사용함)를 사용합니다.
- `dryRun` (부울, 선택 사항): 향후 사용을 위해 예약되어 있습니다. 현재는 무시됩니다.

## 정책 + 라우팅 동작

도구 가용성은 게이트웨이 에이전트에서 사용하는 것과 동일한 정책 체인을 통해 필터링됩니다.

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- 그룹 정책(세션 키가 그룹 또는 채널에 매핑되는 경우)
- 하위 에이전트 정책(하위 에이전트 세션 키로 호출하는 경우)

정책에 따라 도구가 허용되지 않는 경우 엔드포인트는 **404**를 반환합니다.

그룹 정책이 컨텍스트를 해결하는 데 도움이 되도록 선택적으로 다음을 설정할 수 있습니다.

- `x-openclaw-message-channel: <channel>` (예: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (여러 계정이 존재하는 경우)

## 응답

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (잘못된 요청 또는 도구 오류)
- `401` → 승인되지 않음
- `404` → 도구를 사용할 수 없음(찾을 수 없거나 허용 목록에 없음)
- `405` → 방법은 허용되지 않습니다.

## 예

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
