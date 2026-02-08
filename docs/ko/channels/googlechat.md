---
read_when:
    - Google Chat 채널 기능 작업 중
summary: Google Chat 앱 지원 상태, 기능, 구성
title: 구글 채팅
x-i18n:
    generated_at: "2026-02-08T15:47:35Z"
    model: gtx
    provider: google-translate
    source_hash: 3d557dd25946ad11b0f9613f8bc6df5cfeb9b4705fdaede983a8d3e9f12c0aac
    source_path: channels/googlechat.md
    workflow: 15
---

# Google 채팅(채팅 API)

상태: Google Chat API 웹후크를 통해 DM + 스페이스를 사용할 수 있습니다(HTTP만 해당).

## 빠른 설정(초보자)

1. Google Cloud 프로젝트를 만들고 사용 설정하세요. **Google 채팅 API**.
   - 이동: [Google Chat API 자격증명](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - API가 아직 활성화되지 않은 경우 활성화합니다.
2. 만들기 **서비스 계정**:
   - 누르다 **자격 증명 만들기** > **서비스 계정**.
   - 원하는 대로 이름을 지정하세요(예: `openclaw-chat`).
   - 권한을 비워두세요(누름 **계속하다**).
   - 액세스 권한이 있는 주 구성원을 비워 두세요(누름 **완료**).
3. 생성 및 다운로드 **JSON 키**:
   - 서비스 계정 목록에서 방금 만든 계정을 클릭합니다.
   - 로 이동 **열쇠** 꼬리표.
   - 딸깍 하는 소리 **키 추가** > **새 키 만들기**.
   - 선택하다 **JSON** 그리고 누르세요 **만들다**.
4. 다운로드한 JSON 파일을 게이트웨이 호스트에 저장합니다(예: `~/.openclaw/googlechat-service-account.json`).
5. 다음에서 Google Chat 앱을 만듭니다. [Google Cloud Console 채팅 구성](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat):
   - 다음을 입력하세요. **신청정보**:
     - **앱 이름**: (예: `OpenClaw`)
     - **아바타 URL**: (예: `https://openclaw.ai/logo.png`)
     - **설명**: (예: `Personal AI Assistant`)
   - 할 수 있게 하다 **대화형 기능**.
   - 아래에 **기능성**, 확인하다 **스페이스 및 그룹 대화에 참여하기**.
   - 아래에 **연결 설정**, 선택하다 **HTTP 엔드포인트 URL**.
   - 아래에 **트리거**, 선택하다 **모든 트리거에 공통 HTTP 엔드포인트 URL을 사용하세요.** 게이트웨이의 공개 URL과 그 뒤에 오는 URL로 설정합니다. `/googlechat`.
     - _팁: 실행 `openclaw status` 게이트웨이의 공개 URL을 찾으려면_
   - 아래에 **시계**, 확인하다 **&lt;내 도메인&gt;의 특정 사용자 및 그룹이 이 Chat 앱을 사용할 수 있도록 설정**.
   - 이메일 주소를 입력하세요(예: `user@example.com`)를 텍스트 상자에 입력합니다.
   - 딸깍 하는 소리 **구하다** 하단에.
6. **앱 상태 활성화**:
   - 저장 후, **페이지 새로 고침**.
   - 다음을 찾으세요. **앱 상태** 섹션(보통 저장 후 상단 또는 하단 근처).
   - 상태를 다음으로 변경합니다. **실시간 - 사용자가 사용할 수 있음**.
   - 딸깍 하는 소리 **구하다** 다시.
7. 서비스 계정 경로 + 웹훅 대상으로 OpenClaw를 구성합니다.
   - 환경: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - 또는 구성: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`.
8. 웹훅 대상 유형 + 값을 설정합니다(채팅 앱 구성과 일치).
9. 게이트웨이를 시작하십시오. Google Chat은 웹훅 경로에 게시됩니다.

## Google 채팅에 추가

게이트웨이가 실행되고 이메일이 공개 목록에 추가되면:

1. 이동 [구글 채팅](https://chat.google.com/).
2. 다음을 클릭하세요. **+** 옆에 있는 (더하기) 아이콘 **직접 메시지**.
3. 검색창(보통 사람을 추가하는 곳)에 **앱 이름** Google Cloud Console에서 구성했습니다.
   - **메모**: 봇이 _~ 아니다_ 비공개 앱이기 때문에 "Marketplace" 검색 목록에 표시됩니다. 이름으로 검색하셔야 합니다.
4. 결과에서 봇을 선택하세요.
5. 딸깍 하는 소리 **추가하다** 또는 **채팅** 1:1 대화를 시작합니다.
6. 어시스턴트를 트리거하려면 "Hello"를 보내세요!

## 공개 URL(웹훅 전용)

Google Chat 웹훅에는 공개 HTTPS 엔드포인트가 필요합니다. 보안을 위해, **만 노출한다 `/googlechat` 길** 인터넷에. OpenClaw 대시보드와 기타 민감한 엔드포인트를 개인 네트워크에 유지하세요.

### 옵션 A: 테일스케일 깔때기(권장)

비공개 대시보드에는 Tailscale Serve를 사용하고 공개 웹훅 경로에는 Funnel을 사용하세요. 이것은 유지한다 `/` 노출하는 동안에만 비공개 `/googlechat`.

1. **게이트웨이가 어떤 주소에 바인딩되어 있는지 확인하세요.**

   ```bash
   ss -tlnp | grep 18789
   ```

   IP 주소(예: `127.0.0.1`, `0.0.0.0`또는 Tailscale IP와 같은 `100.x.x.x`).

2. **대시보드를 tailnet에만 노출합니다(포트 8443).**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **웹훅 경로만 공개적으로 노출합니다.**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **유입경로 액세스를 위해 노드를 승인합니다.**
   메시지가 표시되면 출력에 표시된 인증 URL을 방문하여 tailnet 정책에서 이 노드에 대한 Funnel을 활성화하십시오.

5. **구성을 확인합니다.**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

귀하의 공개 웹훅 URL은 다음과 같습니다:
`https://<node-name>.<tailnet>.ts.net/googlechat`

비공개 대시보드는 tailnet 전용으로 유지됩니다.
`https://<node-name>.<tailnet>.ts.net:8443/`

공개 URL을 사용하십시오( `:8443`) Google Chat 앱 구성에 있습니다.

> 참고: 이 구성은 재부팅 후에도 유지됩니다. 나중에 제거하려면 다음을 실행하세요. `tailscale funnel reset` 그리고 `tailscale serve reset`.

### 옵션 B: 역방향 프록시(캐디)

Caddy와 같은 역방향 프록시를 사용하는 경우 특정 경로만 프록시하세요.

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

이 구성을 사용하면 다음에 대한 모든 요청이 `your-domain.com/` 무시되거나 404로 반환됩니다. `your-domain.com/googlechat` OpenClaw로 안전하게 라우팅됩니다.

### 옵션 C: Cloudflare 터널

웹훅 경로만 라우팅하도록 터널의 수신 규칙을 구성합니다.

- **길**:`/googlechat` -> `http://localhost:18789/googlechat`
- **기본 규칙**: HTTP 404(찾을 수 없음)

## 작동 원리

1. Google Chat은 웹훅 POST를 게이트웨이로 보냅니다. 각 요청에는 `Authorization: Bearer <token>` 헤더.
2. OpenClaw는 구성된 토큰에 대해 토큰을 확인합니다. `audienceType`+`audience`:
   - `audienceType: "app-url"` → 대상은 HTTPS 웹훅 URL입니다.
   - `audienceType: "project-number"` → 대상은 Cloud 프로젝트 번호입니다.
3. 메시지는 공간을 기준으로 라우팅됩니다.
   - DM은 세션 키를 사용합니다. `agent:<agentId>:googlechat:dm:<spaceId>`.
   - Spaces는 세션 키를 사용합니다. `agent:<agentId>:googlechat:group:<spaceId>`.
4. DM접속은 기본적으로 페어링 되어있습니다. 알 수 없는 발신자는 페어링 코드를 받습니다. 다음으로 승인하세요:
   - `openclaw pairing approve googlechat <code>`
5. 그룹 스페이스에는 기본적으로 @멘션이 필요합니다. 사용 `botUser` 멘션 감지에 앱의 사용자 이름이 필요한 경우.

## 대상

전송 및 허용 목록에 다음 식별자를 사용하십시오.

- 직접 메시지: `users/<userId>` 또는 `users/<email>` (이메일 주소도 허용됩니다).
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

- 서비스 계정 사용자 인증 정보는 인라인으로 전달될 수도 있습니다. `serviceAccount` (JSON 문자열).
- 기본 웹훅 경로는 다음과 같습니다. `/googlechat` 만약에 `webhookPath` 설정되어 있지 않습니다.
- 반응은 다음을 통해 제공됩니다. `reactions` 도구와 `channels action` 언제 `actions.reactions` 활성화되었습니다.
- `typingIndicator` 지원하다 `none`, `message` (기본값) 및 `reaction` (반응에는 사용자 OAuth가 필요합니다).
- 첨부 파일은 Chat API를 통해 다운로드되고 미디어 파이프라인에 저장됩니다(크기 제한: `mediaMaxMb`).

## 문제 해결

### 405 메서드가 허용되지 않음

Google Cloud 로그 탐색기에 다음과 같은 오류가 표시되는 경우:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

이는 웹훅 핸들러가 등록되지 않았음을 의미합니다. 일반적인 원인:

1. **채널이 구성되지 않았습니다.**: `channels.googlechat` 섹션이 구성에서 누락되었습니다. 다음을 통해 확인하세요.

   ```bash
   openclaw config get channels.googlechat
   ```

   "구성 경로를 찾을 수 없음"이 반환되면 구성을 추가하십시오(참조: [구성 하이라이트](#config-highlights)).

2. **플러그인이 활성화되지 않았습니다**: 플러그인 상태를 확인하세요:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   "비활성화"로 표시되면 추가하세요. `plugins.entries.googlechat.enabled: true` 귀하의 구성에.

3. **게이트웨이가 다시 시작되지 않았습니다.**: 구성을 추가한 후 게이트웨이를 다시 시작합니다.

   ```bash
   openclaw gateway restart
   ```

채널이 실행 중인지 확인합니다.

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### 기타 문제

- 확인하다 `openclaw channels status --probe` 인증 오류 또는 대상 구성 누락.
- 메시지가 도착하지 않으면 Chat 앱의 웹훅 URL + 이벤트 구독을 확인하세요.
- 게이팅 블록이 응답한다고 언급하면 ​​다음을 설정합니다. `botUser` 앱의 사용자 리소스 이름에 연결하고 확인합니다. `requireMention`.
- 사용 `openclaw logs --follow` 요청이 게이트웨이에 도달하는지 확인하기 위해 테스트 메시지를 보내는 동안.

관련 문서:

- [게이트웨이 구성](/gateway/configuration)
- [보안](/gateway/security)
- [반응](/tools/reactions)
