---
summary: "Google Chat 앱 지원 상태, 기능 및 구성"
read_when:
  - Google Chat 채널 기능 작업 중
title: "Google Chat"
---

# Google Chat (Chat API)

상태: Google Chat API 웹훅(HTTP 전용)을 통해 다이렉트 메시지 및 스페이스를 지원할 준비가 되어 있습니다.

## 빠른 설정 (초보자용)

1. Google Cloud 프로젝트를 생성하고 **Google Chat API**를 활성화하세요.
   - 이동: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - API가 활성화되지 않은 경우, 활성화하세요.
2. **서비스 계정**을 생성하세요:
   - **자격 증명 생성** > **서비스 계정**을 누르세요.
   - 원하는 이름을 입력하세요 (예: `openclaw-chat`).
   - 권한을 비워 둡니다 (**계속**을 누르세요).
   - 액세스 권한이 있는 주체를 비워 둡니다 (**완료**를 누르세요).
3. **JSON 키**를 생성하고 다운로드하세요:
   - 서비스 계정 목록에서 방금 생성한 계정을 클릭합니다.
   - **키** 탭으로 이동합니다.
   - **키 추가** > **새 키 생성**을 클릭합니다.
   - **JSON**을 선택하고 **생성**을 누르세요.
4. 다운로드한 JSON 파일을 게이트웨이 호스트에 저장하세요 (예: `~/.openclaw/googlechat-service-account.json`).
5. [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat)에서 Google Chat 앱을 만듭니다:
   - **응용 프로그램 정보**를 완성합니다:
     - **앱 이름**: (예: `OpenClaw`)
     - **아바타 URL**: (예: `https://openclaw.ai/logo.png`)
     - **설명**: (예: `Personal AI Assistant`)
   - **대화형 기능**을 활성화합니다.
   - **기능** 아래에서 **스페이스와 그룹 대화 참여**를 선택합니다.
   - **연결 설정** 아래에서 **HTTP 엔드포인트 URL**을 선택합니다.
   - **트리거** 아래에서 **모든 트리거에 공통 HTTP 엔드포인트 URL 사용**을 선택하고 게이트웨이의 공개 URL에 `/googlechat`을 추가합니다.
     - _팁: `openclaw status`를 실행하여 게이트웨이의 공개 URL을 확인하세요._
   - **가시성** 아래에서 **이 Chat 앱을 특정 사람 및 그룹에 사용 가능하게 설정**을 선택합니다.
   - 텍스트 박스에 이메일 주소를 입력하세요 (예: `user@example.com`).
   - 아래쪽의 **저장**을 클릭합니다.
6. **앱 상태 활성화**:
   - 저장 후, **페이지를 새로고침**합니다.
   - **앱 상태** 섹션을 찾습니다 (보통 저장 후 상단이나 하단에 위치함).
   - 상태를 **사용 가능 - 사용자에게 사용 가능**으로 변경합니다.
   - **저장**을 다시 클릭합니다.
7. 서비스 계정 경로 및 웹훅 수신자와 함께 OpenClaw를 구성합니다:
   - 환경 변수: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - 또는 설정: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`.
8. 웹훅 수신자 유형 및 값을 설정합니다 (Chat 앱 설정과 일치시킵니다).
9. 게이트웨이를 시작하세요. Google Chat이 웹훅 경로로 POST를 보냅니다.

## Google Chat에 추가

게이트웨이가 실행 중이고 이메일이 가시성 목록에 추가된 후:

1. [Google Chat](https://chat.google.com/)으로 이동하세요.
2. **다이렉트 메시지** 옆의 **+** (플러스) 아이콘을 클릭하세요.
3. 검색 바(일반적으로 사람을 추가하는 곳)에 Google Cloud Console에 구성한 **앱 이름**을 입력하세요.
   - **참고**: 봇은 비공개 앱이므로 "Marketplace" 목록에는 나타나지 않습니다. 이름으로 검색해야 합니다.
4. 결과에서 귀하의 봇을 선택하십시오.
5. **추가** 또는 **채팅**을 클릭하여 1:1 대화를 시작하세요.
6. "Hello"를 보내어 비서를 활성화하세요!

## 공개 URL (웹훅 전용)

Google Chat 웹훅은 공개 HTTPS 엔드포인트가 필요합니다. 보안상 **오직 `/googlechat` 경로**만 인터넷에 공개하세요. OpenClaw 대시보드 및 기타 민감한 엔드포인트는 사설 네트워크에 두십시오.

### 옵션 A: Tailscale Funnel (추천)

사설 대시보드에는 Tailscale Serve를, 공개 웹훅 경로에는 Funnel을 사용하세요. 이는 `/`을 비공개로 유지하면서 오직 `/googlechat`만 노출합니다.

1. **게이트웨이가 바인딩된 주소를 확인하세요:**

   ```bash
   ss -tlnp | grep 18789
   ```

   IP 주소를 기록하세요 (예: `127.0.0.1`, `0.0.0.0`, 또는 `100.x.x.x`와 같은 Tailscale IP).

2. **대시보드를 테일넷에만 노출하세요 (포트 8443):**

   ```bash
   # 로컬호스트에 바인딩된 경우 (127.0.0.1 또는 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # Tailscale IP에만 바인딩된 경우 (예: 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **웹훅 경로만 공개적으로 노출하세요:**

   ```bash
   # 로컬호스트에 바인딩된 경우 (127.0.0.1 또는 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # Tailscale IP에만 바인딩된 경우 (예: 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **Funnel 액세스를 위한 노드를 승인하세요:**
   승인하라는 메시지가 표시되면, 출력에 표시된 승인 URL을 방문하여 이 노드의 테일넷 정책에서 Funnel을 활성화하세요.

5. **구성을 확인하세요:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

공개 웹훅 URL은 다음과 같습니다:
`https://<node-name>.<tailnet>.ts.net/googlechat`

사설 대시보드는 테일넷 전용입니다:
`https://<node-name>.<tailnet>.ts.net:8443/`

공개 URL (8443 없이)을 Google Chat 앱 설정에 사용하세요.

> 참고: 이 구성은 재부팅 후에도 유지됩니다. 나중에 제거하려면 `tailscale funnel reset` 및 `tailscale serve reset`을 실행하세요.

### 옵션 B: Reverse Proxy (Caddy)

Caddy와 같은 리버스 프록시를 사용하는 경우, 특정 경로만 프록시하세요:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

이 구성에서는 `your-domain.com/`에 대한 모든 요청은 무시되거나 404로 반환되며, `your-domain.com/googlechat`은 안전하게 OpenClaw로 라우팅됩니다.

### 옵션 C: Cloudflare Tunnel

웹훅 경로만 라우팅하도록 터널의 인그레스 규칙을 구성하세요:

- **경로**: `/googlechat` -> `http://localhost:18789/googlechat`
- **기본 규칙**: HTTP 404 (Not Found)

## 작동 원리

1. Google Chat이 게이트웨이로 웹훅 POST를 보냅니다. 각 요청에는 `Authorization: Bearer <토큰>` 헤더가 포함됩니다.
2. OpenClaw는 구성된 `audienceType` + `audience`에 대해 토큰을 검증합니다:
   - `audienceType: "app-url"` → 수신자는 HTTPS 웹훅 URL입니다.
   - `audienceType: "project-number"` → 수신자는 Cloud 프로젝트 번호입니다.
3. 메시지는 공간에 따라 라우팅됩니다:
   - 다이렉트 메시지는 세션 키 `agent:<agentId>:googlechat:dm:<spaceId>`를 사용합니다.
   - 스페이스는 세션 키 `agent:<agentId>:googlechat:group:<spaceId>`를 사용합니다.
4. 디폴트로 다이렉트 메시지 접근은 페어링입니다. 알 수 없는 발신자는 페어링 코드를 받으며, 이를 승인하려면 다음을 사용하세요:
   - `openclaw pairing approve googlechat <code>`
5. 그룹 공간은 기본적으로 @멘션이 필요합니다. 앱의 사용자 이름이 멘션 감지에 필요한 경우 `botUser`를 사용하세요.

## 타겟

배송 및 허용 목록을 위한 다음 식별자를 사용하세요:

- 다이렉트 메시지: `users/<userId>` (추천) 또는 원시 이메일 `name@example.com` (변경 가능한 주체).
- 사용되지 않음: `users/<email>`은 사용자 아이디로 간주되며, 이메일 허용 목록이 아닙니다.
- 스페이스: `spaces/<spaceId>`.

## 설정 하이라이트

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // 선택 사항; 멘션 감지에 도움
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890", "name@example.com"],
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

노트:

- 서비스 계정 자격 증명은 `serviceAccount` (JSON 문자열)로 인라인 전달될 수도 있습니다.
- `webhookPath`가 설정되지 않으면 기본 웹훅 경로는 `/googlechat`입니다.
- 리액션은 `actions.reactions`가 활성화된 경우 `reactions` 도구 및 `channels action`을 통해 사용할 수 있습니다.
- `typingIndicator`는 `none`, `message` (기본값), `reaction` (리액션은 사용자 OAuth 필요)을 지원합니다.
- 첨부 파일은 Chat API를 통해 다운로드되며 미디어 파이프라인에 저장됩니다 (`mediaMaxMb`에 따라 크기 제한).

## 문제 해결

### 405 Method Not Allowed

Google Cloud Logs Explorer에 다음과 같은 오류가 표시되는 경우:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

이는 웹훅 핸들러가 등록되지 않았음을 의미합니다. 일반적인 원인은:

1. **채널이 구성되지 않음**: 구성에 `channels.googlechat` 섹션이 누락되었습니다. 다음으로 확인하세요:

   ```bash
   openclaw config get channels.googlechat
   ```

   "Config path not found"를 반환하면 구성(설정 하이라이트 참조)을 추가하세요.

2. **플러그인이 활성화되지 않음**: 플러그인 상태를 확인하세요:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   "disabled"로 표시되면 구성에 `plugins.entries.googlechat.enabled: true`를 추가하세요.

3. **게이트웨이가 재시작되지 않음**: 설정 추가 후 게이트웨이를 재시작하세요:

   ```bash
   openclaw gateway restart
   ```

채널이 실행중인지 확인하세요:

```bash
openclaw channels status
# 표시 내용: Google Chat default: enabled, configured, ...
```

### 기타 문제

- 인증 오류나 누락된 수신자 구성을 `openclaw channels status --probe`로 확인하세요.
- 메시지가 도착하지 않는 경우, Chat 앱의 웹훅 URL 및 이벤트 구독을 확인하세요.
- 멘션 게이팅이 회신을 차단하는 경우, `botUser`를 앱의 사용자 리소스 이름으로 설정하고 `requireMention`을 확인하세요.
- `openclaw logs --follow`를 사용하여 테스트 메시지를 보낼 때 요청이 게이트웨이에 도달하는지 확인하세요.

관련 문서:

- [게이트웨이 구성](/ko-KR/gateway/configuration)
- [보안](/ko-KR/gateway/security)
- [리액션](/ko-KR/tools/reactions)