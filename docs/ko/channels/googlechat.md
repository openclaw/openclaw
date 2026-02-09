---
summary: "Google Chat 앱 지원 상태, 기능 및 구성"
read_when:
  - Google Chat 채널 기능을 작업할 때
title: "Google Chat"
---

# Google Chat (Chat API)

상태: Google Chat API 웹훅을 통해 다이렉트 메시지 + 스페이스 지원 준비 완료 (HTTP 전용).

## 빠른 시작 (초보자)

1. Google Cloud 프로젝트를 생성하고 **Google Chat API** 를 활성화합니다.
   - 이동: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - 아직 활성화되지 않았다면 API 를 활성화합니다.
2. **서비스 계정**을 생성합니다:
   - **Create Credentials** > **Service Account** 를 클릭합니다.
   - 원하는 이름을 지정합니다 (예: `openclaw-chat`).
   - 권한은 비워 둡니다 (**Continue** 클릭).
   - 액세스 권한이 있는 주체도 비워 둡니다 (**Done** 클릭).
3. **JSON 키**를 생성하고 다운로드합니다:
   - 서비스 계정 목록에서 방금 생성한 계정을 클릭합니다.
   - **Keys** 탭으로 이동합니다.
   - **Add Key** > **Create new key** 를 클릭합니다.
   - **JSON** 을 선택하고 **Create** 를 누릅니다.
4. 다운로드한 JSON 파일을 게이트웨이 호스트에 저장합니다 (예: `~/.openclaw/googlechat-service-account.json`).
5. [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat) 에서 Google Chat 앱을 생성합니다:
   - **Application info** 를 입력합니다:
     - **App name**: (예: `OpenClaw`)
     - **Avatar URL**: (예: `https://openclaw.ai/logo.png`)
     - **Description**: (예: `Personal AI Assistant`)
   - **Interactive features** 를 활성화합니다.
   - **Functionality** 아래에서 **Join spaces and group conversations** 를 체크합니다.
   - **Connection settings** 아래에서 **HTTP endpoint URL** 을 선택합니다.
   - **Triggers** 아래에서 **Use a common HTTP endpoint URL for all triggers** 를 선택하고, 게이트웨이의 공개 URL 뒤에 `/googlechat` 을 추가하여 설정합니다.
     - _팁: `openclaw status` 을 실행하면 게이트웨이의 공개 URL 을 확인할 수 있습니다._
   - **Visibility** 아래에서 **Make this Chat app available to specific people and groups in &lt;Your Domain&gt;** 를 체크합니다.
   - 텍스트 상자에 이메일 주소를 입력합니다 (예: `user@example.com`).
   - 하단의 **Save** 를 클릭합니다.
6. **앱 상태를 활성화합니다**:
   - 저장 후 **페이지를 새로고침**합니다.
   - **App status** 섹션을 찾습니다 (보통 저장 후 상단 또는 하단에 표시됩니다).
   - 상태를 **Live - available to users** 로 변경합니다.
   - 다시 **Save** 를 클릭합니다.
7. 서비스 계정 경로 + 웹훅 audience 로 OpenClaw 를 구성합니다:
   - 환경 변수: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - 또는 설정: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`.
8. 웹훅 audience 타입과 값을 설정합니다 (Chat 앱 구성과 일치해야 합니다).
9. 게이트웨이를 시작합니다. Google Chat 이 웹훅 경로로 POST 요청을 보냅니다.

## Google Chat 에 추가하기

게이트웨이가 실행 중이고 이메일이 가시성 목록에 추가된 상태에서:

1. [Google Chat](https://chat.google.com/) 으로 이동합니다.
2. **Direct Messages** 옆의 **+** (플러스) 아이콘을 클릭합니다.
3. 검색창(사람을 추가할 때 사용하는 곳)에 Google Cloud Console 에서 설정한 **App name** 을 입력합니다.
   - **참고**: 이 봇은 비공개 앱이므로 "Marketplace" 탐색 목록에는 나타나지 않습니다. 이름으로 직접 검색해야 합니다.
4. 결과에서 봇을 선택합니다.
5. **Add** 또는 **Chat** 을 클릭하여 1:1 대화를 시작합니다.
6. "Hello" 를 보내 어시스턴트를 트리거합니다!

## 공개 URL (웹훅 전용)

Google Chat 웹훅은 공개 HTTPS 엔드포인트가 필요합니다. 보안을 위해 **`/googlechat` 경로만** 인터넷에 노출하십시오. OpenClaw 대시보드와 기타 민감한 엔드포인트는 사설 네트워크에 유지해야 합니다.

### 옵션 A: Tailscale Funnel (권장)

사설 대시보드에는 Tailscale Serve 를 사용하고, 공개 웹훅 경로에는 Funnel 을 사용합니다. 이렇게 하면 `/` 는 비공개로 유지하면서 `/googlechat` 만 노출할 수 있습니다.

1. **게이트웨이가 바인딩된 주소를 확인합니다:**

   ```bash
   ss -tlnp | grep 18789
   ```

   IP 주소를 기록합니다 (예: `127.0.0.1`, `0.0.0.0`, 또는 `100.x.x.x` 와 같은 Tailscale IP).

2. **대시보드를 tailnet 전용으로 노출합니다 (포트 8443):**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **웹훅 경로만 공개로 노출합니다:**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **Funnel 액세스를 위해 노드를 승인합니다:**
   프롬프트가 표시되면 출력에 표시된 승인 URL 을 방문하여 tailnet 정책에서 이 노드에 대해 Funnel 을 활성화합니다.

5. **구성을 확인합니다:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

공개 웹훅 URL 은 다음과 같습니다:
`https://<node-name>.<tailnet>.ts.net/googlechat`

사설 대시보드는 tailnet 전용으로 유지됩니다:
`https://<node-name>.<tailnet>.ts.net:8443/`

Google Chat 앱 구성에는 공개 URL 에서 `:8443` 을 제외한 값을 사용하십시오.

> 참고: 이 구성은 재부팅 후에도 유지됩니다. 나중에 제거하려면 `tailscale funnel reset` 과 `tailscale serve reset` 을 실행하십시오.

### 옵션 B: 리버스 프록시 (Caddy)

Caddy 와 같은 리버스 프록시를 사용하는 경우, 특정 경로만 프록시하십시오:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

이 구성에서는 `your-domain.com/` 로의 모든 요청은 무시되거나 404 로 반환되며, `your-domain.com/googlechat` 만 안전하게 OpenClaw 로 라우팅됩니다.

### 옵션 C: Cloudflare Tunnel

터널의 ingress 규칙을 구성하여 웹훅 경로만 라우팅합니다:

- **Path**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Default Rule**: HTTP 404 (Not Found)

## 동작 방식

1. Google Chat 이 게이트웨이로 웹훅 POST 요청을 보냅니다. 각 요청에는 `Authorization: Bearer <token>` 헤더가 포함됩니다.
2. OpenClaw 는 구성된 `audienceType` + `audience` 에 대해 토큰을 검증합니다:
   - `audienceType: "app-url"` → audience 는 HTTPS 웹훅 URL 입니다.
   - `audienceType: "project-number"` → audience 는 Cloud 프로젝트 번호입니다.
3. 메시지는 스페이스별로 라우팅됩니다:
   - 다이렉트 메시지는 세션 키 `agent:<agentId>:googlechat:dm:<spaceId>` 을 사용합니다.
   - 스페이스는 세션 키 `agent:<agentId>:googlechat:group:<spaceId>` 를 사용합니다.
4. 다이렉트 메시지 액세스는 기본적으로 페어링 방식입니다. 알 수 없는 발신자는 페어링 코드를 받으며, 다음으로 승인합니다:
   - `openclaw pairing approve googlechat <code>`
5. 그룹 스페이스는 기본적으로 @멘션이 필요합니다. 멘션 감지가 앱의 사용자 이름을 필요로 하는 경우 `botUser` 를 사용하십시오.

## 대상

전송 및 허용 목록에 다음 식별자를 사용하십시오:

- 다이렉트 메시지: `users/<userId>` 또는 `users/<email>` (이메일 주소도 허용됩니다).
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
      botUser: "users/1234567890", // optional; helps mention detection
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

참고 사항:

- 서비스 계정 자격 증명은 `serviceAccount` (JSON 문자열)로 인라인 전달할 수도 있습니다.
- `webhookPath` 이 설정되지 않은 경우 기본 웹훅 경로는 `/googlechat` 입니다.
- `actions.reactions` 이 활성화되면 `reactions` 도구와 `channels action` 를 통해 반응을 사용할 수 있습니다.
- `typingIndicator` 는 `none`, `message` (기본값), `reaction` 를 지원합니다 (반응에는 사용자 OAuth 가 필요합니다).
- 첨부 파일은 Chat API 를 통해 다운로드되어 미디어 파이프라인에 저장되며, 크기는 `mediaMaxMb` 로 제한됩니다.

## 문제 해결

### 405 Method Not Allowed

Google Cloud Logs Explorer 에서 다음과 같은 오류가 표시되는 경우:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

이는 웹훅 핸들러가 등록되지 않았음을 의미합니다. 일반적인 원인은 다음과 같습니다:

1. **채널이 구성되지 않음**: 설정에 `channels.googlechat` 섹션이 없습니다. 다음으로 확인하십시오:

   ```bash
   openclaw config get channels.googlechat
   ```

   "Config path not found" 가 반환되면 구성을 추가하십시오 ([구성 하이라이트](#config-highlights) 참고).

2. **플러그인이 활성화되지 않음**: 플러그인 상태를 확인하십시오:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   "disabled" 로 표시되면 설정에 `plugins.entries.googlechat.enabled: true` 을 추가하십시오.

3. **게이트웨이를 재시작하지 않음**: 구성을 추가한 후 게이트웨이를 재시작하십시오:

   ```bash
   openclaw gateway restart
   ```

채널이 실행 중인지 확인합니다:

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### 기타 문제

- 인증 오류 또는 audience 구성 누락 여부는 `openclaw channels status --probe` 을 확인하십시오.
- 메시지가 도착하지 않으면 Chat 앱의 웹훅 URL 과 이벤트 구독을 확인하십시오.
- 멘션 게이팅으로 응답이 차단되면 `botUser` 를 앱의 사용자 리소스 이름으로 설정하고 `requireMention` 을 확인하십시오.
- 테스트 메시지를 보내는 동안 `openclaw logs --follow` 를 사용하여 요청이 게이트웨이에 도달하는지 확인하십시오.

관련 문서:

- [Gateway configuration](/gateway/configuration)
- [Security](/gateway/security)
- [Reactions](/tools/reactions)
