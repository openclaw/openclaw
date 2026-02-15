---
summary: "Google Chat app support status, capabilities, and configuration"
read_when:
  - Working on Google Chat channel features
title: "Google Chat"
x-i18n:
  source_hash: 3d557dd25946ad11b0f9613f8bc6df5cfeb9b4705fdaede983a8d3e9f12c0aac
---

# 구글 채팅(채팅 API)

상태: Google Chat API 웹후크를 통해 DM + 스페이스를 사용할 수 있습니다(HTTP만 해당).

## 빠른 설정(초보자)

1. Google Cloud 프로젝트를 생성하고 **Google Chat API**를 활성화합니다.
   - 이동: [Google Chat API 자격 증명](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - API가 아직 활성화되지 않은 경우 활성화합니다.
2. **서비스 계정**을 만듭니다.
   - **자격 증명 만들기** > **서비스 계정**을 누릅니다.
   - 원하는 대로 이름을 지정하세요(예: `openclaw-chat`).
   - 권한을 비워 둡니다(**계속** 누르기).
   - 액세스 권한이 있는 주 구성원을 비워 둡니다(**완료** 누르기).
3. **JSON 키**를 생성하고 다운로드합니다.
   - 서비스 계정 목록에서 방금 생성한 계정을 클릭합니다.
   - **키** 탭으로 이동합니다.
   - **키 추가** > **새 키 만들기**를 클릭합니다.
   - **JSON**을 선택하고 **만들기**를 누릅니다.
4. 다운로드한 JSON 파일을 게이트웨이 호스트에 저장합니다(예: `~/.openclaw/googlechat-service-account.json`).
5. [Google Cloud Console 채팅 구성](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat)에서 Google Chat 앱을 만듭니다.
   - **신청 정보**를 입력하세요.
     - **앱 이름**: (예: `OpenClaw`)
     - **아바타 URL**: (예: `https://openclaw.ai/logo.png`)
     - **설명**: (예: `Personal AI Assistant`)
   - **대화형 기능**을 활성화합니다.
   - **기능**에서 **스페이스 및 그룹 대화에 참여**를 선택하세요.
   - **연결 설정**에서 **HTTP 엔드포인트 URL**을 선택합니다.
   - **트리거**에서 **모든 트리거에 공통 HTTP 엔드포인트 URL 사용**을 선택하고 이를 게이트웨이의 공개 URL 뒤에 `/googlechat`로 설정합니다.
     - _팁: 게이트웨이의 공개 URL을 찾으려면 `openclaw status`를 실행하세요._
   - **공개 상태**에서 **&lt;내 도메인&gt;의 특정 사용자 및 그룹이 이 채팅 앱을 사용할 수 있도록 설정**을 선택합니다.
   - 텍스트 상자에 이메일 주소(예: `user@example.com`)를 입력하세요.
   - 하단의 **저장**을 클릭하세요.
6. **앱 상태 활성화**:
   - 저장 후 **페이지를 새로고침**하세요.
   - **앱 상태** 섹션을 찾습니다(보통 저장 후 상단 또는 하단 근처).
   - 상태를 **라이브 - 사용자에게 제공**으로 변경합니다.
   - **저장**을 다시 클릭하세요.
7. 서비스 계정 경로 + 웹훅 대상으로 OpenClaw를 구성합니다.
   - 환경: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - 또는 구성: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`.
8. 웹훅 대상 유형 + 값을 설정합니다(채팅 앱 구성과 일치).
9. 게이트웨이를 시작합니다. Google Chat은 웹훅 경로에 게시됩니다.

## Google 채팅에 추가

게이트웨이가 실행되고 이메일이 공개 목록에 추가되면:

1. [구글 채팅](https://chat.google.com/)으로 이동합니다.
2. **직접 메시지** 옆에 있는 **+**(더하기) 아이콘을 클릭합니다.
3. 일반적으로 사람을 추가하는 검색창에 Google Cloud Console에서 구성한 **앱 이름**을 입력합니다.
   - **참고**: 봇은 비공개 앱이기 때문에 "마켓플레이스" 검색 목록에 표시되지 _않습니다_. 이름으로 검색하셔야 합니다.
4. 결과에서 봇을 선택합니다.
5. **추가** 또는 **채팅**을 클릭하여 1:1 대화를 시작하세요.
6. "Hello"를 보내어 어시스턴트를 트리거하세요!

## 공개 URL(웹훅 전용)

Google Chat 웹훅에는 공개 HTTPS 엔드포인트가 필요합니다. 보안을 위해 \*\*`/googlechat` 경로만 인터넷에 노출하세요. OpenClaw 대시보드와 기타 민감한 엔드포인트를 개인 네트워크에 유지하세요.

### 옵션 A: 테일스케일 깔때기(권장)

비공개 대시보드에는 Tailscale Serve를 사용하고 공개 웹훅 경로에는 Funnel을 사용하세요. 이는 `/`를 비공개로 유지하면서 `/googlechat`만 노출시킵니다.

1. **게이트웨이가 어떤 주소에 바인딩되어 있는지 확인하세요.**

   ```bash
   ss -tlnp | grep 18789
   ```

   IP 주소를 기록해 두십시오(예: `127.0.0.1`, `0.0.0.0` 또는 `100.x.x.x`와 같은 Tailscale IP).

2. **대시보드를 테일넷에만 노출합니다(포트 8443):**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **웹훅 경로만 공개적으로 노출:**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **퍼널 액세스를 위해 노드를 승인합니다.**
   메시지가 표시되면 출력에 표시된 인증 URL을 방문하여 tailnet 정책에서 이 노드에 대한 Funnel을 활성화하십시오.

5. **구성 확인:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

귀하의 공개 웹훅 URL은 다음과 같습니다:
`https://<node-name>.<tailnet>.ts.net/googlechat`

비공개 대시보드는 tailnet 전용으로 유지됩니다.
`https://<node-name>.<tailnet>.ts.net:8443/`

Google Chat 앱 구성에서 공개 URL(`:8443` 제외)을 사용하세요.

> 참고: 이 구성은 재부팅 후에도 유지됩니다. 나중에 제거하려면 `tailscale funnel reset` 및 `tailscale serve reset`를 실행하세요.

### 옵션 B: 역방향 프록시(캐디)

Caddy와 같은 역방향 프록시를 사용하는 경우 특정 경로만 프록시하세요.

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

이 구성을 사용하면 `your-domain.com/`에 대한 모든 요청이 무시되거나 404로 반환되는 반면 `your-domain.com/googlechat`는 OpenClaw로 안전하게 라우팅됩니다.

### 옵션 C: Cloudflare 터널

웹훅 경로만 라우팅하도록 터널의 수신 규칙을 구성합니다.

- **경로**: `/googlechat` -> `http://localhost:18789/googlechat`
- **기본 규칙**: HTTP 404(찾을 수 없음)

## 작동 방식

1. Google Chat은 웹훅 POST를 게이트웨이로 보냅니다. 각 요청에는 `Authorization: Bearer <token>` 헤더가 포함되어 있습니다.
2. OpenClaw는 구성된 `audienceType` + `audience`에 대해 토큰을 확인합니다.
   - `audienceType: "app-url"` → 대상은 HTTPS 웹훅 URL입니다.
   - `audienceType: "project-number"` → 대상은 Cloud 프로젝트 번호입니다.
3. 메시지는 공간을 기준으로 라우팅됩니다.
   - DM은 세션 키 `agent:<agentId>:googlechat:dm:<spaceId>`를 사용합니다.
   - Spaces는 세션 키 `agent:<agentId>:googlechat:group:<spaceId>`를 사용합니다.
4. DM접속은 기본적으로 페어링 되어있습니다. 알 수 없는 발신자는 페어링 코드를 받습니다. 다음으로 승인하세요:
   - `openclaw pairing approve googlechat <code>`
5. 그룹 스페이스에는 기본적으로 @-멘션이 필요합니다. 멘션 감지에 앱의 사용자 이름이 필요한 경우 `botUser`를 사용하세요.

## 타겟

전송 및 허용 목록에 다음 식별자를 사용하십시오.

- 다이렉트 메시지: `users/<userId>` 또는 `users/<email>` (이메일 주소도 허용됩니다).
- 공백: `spaces/<spaceId>`.

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

참고:

- 서비스 계정 자격 증명은 `serviceAccount`(JSON 문자열)을 사용하여 인라인으로 전달될 수도 있습니다.
- `webhookPath`가 설정되지 않은 경우 기본 웹훅 경로는 `/googlechat`입니다.
- `actions.reactions`가 활성화되면 `reactions` 도구와 `channels action`를 통해 반응이 가능합니다.
- `typingIndicator`는 `none`, `message`(기본값) 및 `reaction`(반응에는 사용자 OAuth가 필요함)를 지원합니다.
- 첨부 파일은 Chat API를 통해 다운로드되고 미디어 파이프라인에 저장됩니다(크기는 `mediaMaxMb`로 제한됨).

## 문제 해결

### 405 메서드가 허용되지 않음

Google Cloud 로그 탐색기에 다음과 같은 오류가 표시되는 경우:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

이는 웹훅 핸들러가 등록되지 않았음을 의미합니다. 일반적인 원인:

1. **채널이 구성되지 않음**: 구성에서 `channels.googlechat` 섹션이 누락되었습니다. 다음을 통해 확인하세요.

```bash
   openclaw config get channels.googlechat
```

"구성 경로를 찾을 수 없음"이 반환되면 구성을 추가합니다([구성 하이라이트](#config-highlights) 참조).

2. **플러그인이 활성화되지 않음**: 플러그인 상태를 확인하세요.

   ```bash
   openclaw plugins list | grep googlechat
   ```

   "비활성화"로 표시되면 구성에 `plugins.entries.googlechat.enabled: true`를 추가하세요.

3. **게이트웨이가 다시 시작되지 않음**: 구성을 추가한 후 게이트웨이를 다시 시작합니다.

   ```bash
   openclaw gateway restart
   ```

채널이 실행 중인지 확인합니다.

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### 기타 문제

- 인증 오류 또는 대상 구성 누락이 있는지 `openclaw channels status --probe`를 확인하세요.
- 메시지가 도착하지 않으면 채팅 앱의 웹훅 URL + 이벤트 구독을 확인하세요.
- 게이팅 블록이 응답하는 경우 `botUser`를 앱의 사용자 리소스 이름으로 설정하고 `requireMention`를 확인합니다.
- 테스트 메시지를 보내는 동안 `openclaw logs --follow`를 사용하여 요청이 게이트웨이에 도달하는지 확인하세요.

관련 문서:

- [게이트웨이 구성](/gateway/configuration)
- [보안](/gateway/security)
- [반응](/tools/reactions)
