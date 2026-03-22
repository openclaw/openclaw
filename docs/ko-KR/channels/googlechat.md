---
summary: "Google Chat 앱 지원 상태, 기능, 구성"
read_when:
  - Google Chat 채널 기능을 작업하는 경우
title: "Google Chat"
x-i18n:
  source_path: docs/channels/googlechat.md
---

# Google Chat (Chat API)

상태: Google Chat API 웹훅 (HTTP 전용) 을 통한 DM + 스페이스 지원 준비 완료.

## 빠른 설정 (초보자)

1. Google Cloud 프로젝트를 만들고 **Google Chat API** 를 활성화합니다.
2. **서비스 계정**을 만듭니다.
3. **JSON 키**를 만들고 다운로드합니다.
4. 다운로드한 JSON 파일을 Gateway 호스트에 저장합니다 (예: `~/.openclaw/googlechat-service-account.json`).
5. [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat) 에서 Google Chat 앱을 만듭니다.
6. **앱 상태를 활성화**합니다 — 상태를 **Live - available to users** 로 변경합니다.
7. 서비스 계정 경로 + 웹훅 audience 로 OpenClaw 를 구성합니다:
   - 환경: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - 또는 구성: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`.
8. 웹훅 audience 유형 + 값을 설정합니다 (Chat 앱 구성과 일치).
9. Gateway 를 시작합니다. Google Chat 이 웹훅 경로로 POST 합니다.

## Google Chat 에 추가

Gateway 가 실행 중이고 이메일이 가시성 목록에 추가되면:

1. [Google Chat](https://chat.google.com/) 으로 이동합니다.
2. **Direct Messages** 옆의 **+** (플러스) 아이콘을 클릭합니다.
3. 검색창에서 Google Cloud Console 에서 구성한 **앱 이름**을 입력합니다.
4. 결과에서 봇을 선택합니다.
5. **Add** 또는 **Chat** 을 클릭하여 1:1 대화를 시작합니다.

## 공개 URL (웹훅 전용)

Google Chat 웹훅에는 공개 HTTPS 엔드포인트가 필요합니다. 보안을 위해 **`/googlechat` 경로만** 인터넷에 노출하세요.

### 옵션 A: Tailscale Funnel (권장)

Tailscale Serve 를 프라이빗 대시보드에, Funnel 을 공개 웹훅 경로에 사용합니다.

### 옵션 B: 리버스 프록시 (Caddy)

특정 경로만 프록시합니다.

### 옵션 C: Cloudflare Tunnel

웹훅 경로만 라우팅하도록 터널 인그레스 규칙을 구성합니다.

## 작동 방식

1. Google Chat 이 Gateway 에 웹훅 POST 를 보냅니다. 각 요청에는 `Authorization: Bearer <token>` 헤더가 포함됩니다.
2. OpenClaw 는 구성된 `audienceType` + `audience` 에 대해 토큰을 검증합니다.
3. 메시지는 스페이스별로 라우팅됩니다.
4. DM 접근은 기본적으로 페어링입니다.
5. 그룹 스페이스는 기본적으로 @멘션이 필요합니다.

## 대상

전달 및 허용 목록에 다음 식별자를 사용합니다:

- 다이렉트 메시지: `users/<userId>` (권장).
- 스페이스: `spaces/<spaceId>`.

## 구성 하이라이트

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890",
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": {
          allow: true,
          requireMention: true,
          users: ["users/1234567890"],
          systemPrompt: "Short answers only.",
        },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

참고:

- 서비스 계정 자격 증명은 `serviceAccount` (JSON 문자열) 로 인라인 전달할 수도 있습니다.
- `serviceAccountRef` 도 지원됩니다 (env/file SecretRef).
- 기본 웹훅 경로는 `webhookPath` 가 설정되지 않으면 `/googlechat` 입니다.
- 리액션은 `actions.reactions` 가 활성화된 경우 `reactions` 도구 및 `channels action` 을 통해 사용 가능합니다.
- 첨부 파일은 Chat API 를 통해 다운로드되고 미디어 파이프라인에 저장됩니다 (`mediaMaxMb` 로 크기 제한).

시크릿 참조 세부 사항: [Secrets Management](/gateway/secrets).

## 문제 해결

### 405 Method Not Allowed

Google Cloud Logs Explorer 에 다음과 같은 오류가 표시되는 경우:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

이는 웹훅 핸들러가 등록되지 않았다는 의미입니다. 일반적인 원인:

1. **채널 미구성**: 구성에 `channels.googlechat` 섹션이 없습니다.
2. **플러그인 미활성화**: 플러그인 상태를 확인합니다.
3. **Gateway 미재시작**: 구성 추가 후 Gateway 를 재시작합니다.

### 기타 문제

- 인증 오류나 누락된 audience 구성에 대해 `openclaw channels status --probe` 를 확인합니다.
- 메시지가 도착하지 않으면 Chat 앱의 웹훅 URL + 이벤트 구독을 확인합니다.
- 멘션 게이팅이 응답을 차단하면 `botUser` 를 앱의 사용자 리소스 이름으로 설정하고 `requireMention` 을 확인합니다.
- 테스트 메시지를 보내면서 `openclaw logs --follow` 로 요청이 Gateway 에 도달하는지 확인합니다.

관련 문서:

- [Gateway configuration](/gateway/configuration)
- [Security](/gateway/security)
- [Reactions](/tools/reactions)
