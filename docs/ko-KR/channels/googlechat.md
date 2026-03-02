---
summary: "Google Chat 앱 지원 상태, 기능, 그리고 설정"
read_when:
  - Google Chat 채널 기능 작업 중
title: "Google Chat"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/channels/googlechat.md"
  workflow: 15
---

# Google Chat (Chat API)

상태: Google Chat API 웹훅 (HTTP만)를 통한 DM + 스페이스 준비 완료.

## 빠른 설정 (초보자)

1. Google Cloud 프로젝트를 만들고 **Google Chat API**를 활성화합니다.
   - 이동: [Google Chat API 자격증명](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - API가 활성화되어 있지 않으면 활성화합니다.
2. **서비스 계정** 생성:
   - **자격증명 만들기** > **서비스 계정**.
   - 원하는 이름 입력 (예: `openclaw-chat`).
   - 권한은 공백으로 유지 (**계속** 누르기).
   - 접근 권한이 있는 주체를 공백으로 유지 (**완료** 누르기).
3. **JSON 키** 만들고 다운로드:
   - 서비스 계정 목록에서 방금 만든 계정을 클릭.
   - **키** 탭으로 이동.
   - **키 추가** > **새 키 만들기**.
   - **JSON**을 선택하고 **만들기**를 누릅니다.
4. 다운로드된 JSON 파일을 게이트웨이 호스트에 저장합니다 (예: `~/.openclaw/googlechat-service-account.json`).
5. [Google Cloud Console Chat 설정](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat)에서 Google Chat 앱 만들기:
   - **응용 프로그램 정보** 입력:
     - **앱 이름**: (예: `OpenClaw`)
     - **아바타 URL**: (예: `https://openclaw.ai/logo.png`)
     - **설명**: (예: `개인 AI 어시스턴트`)
   - **대화형 기능** 활성화.
   - **기능**에서 **스페이스 및 그룹 대화 참가** 선택.
   - **연결 설정**에서 **HTTP 엔드포인트 URL** 선택.
   - **트리거**에서 **모든 트리거에 일반 HTTP 엔드포인트 URL 사용** 선택하고 게이트웨이의 공개 URL + `/googlechat`로 설정합니다.
     - _팁: `openclaw status`를 실행하여 게이트웨이의 공개 URL을 찾습니다._
   - **표시 유형**에서 **이 Chat 앱을 <도메인>의 특정 사람 및 그룹에만 사용 가능하게 합니다** 선택.
   - 텍스트 상자에 이메일 주소 입력 (예: `user@example.com`).
   - 하단에서 **저장**을 클릭합니다.
6. **앱 상태 활성화**:
   - 저장 후 **페이지 새로고침**.
   - **앱 상태** 섹션 찾기 (저장 후 보통 상단 또는 하단).
   - 상태를 **라이브 - 사용자에게 사용 가능**으로 변경.
   - 다시 **저장**을 클릭합니다.
7. 서비스 계정 경로 + 웹훅 청중으로 OpenClaw 설정:
   - 환경: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - 또는 설정: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`.
8. 웹훅 청중 유형 + 값 설정 (Chat 앱 설정과 일치).
9. 게이트웨이를 시작합니다. Google Chat이 웹훅 경로에 POST합니다.

## Google Chat에 추가

게이트웨이가 실행 중이고 이메일이 표시 유형 목록에 추가되면:

1. [Google Chat](https://chat.google.com/)으로 이동합니다.
2. **직접 메시지** 옆의 **+** (더하기) 아이콘을 클릭합니다.
3. 검색창 (보통 사람을 추가하는 곳)에서 Google Cloud Console에서 설정한 **앱 이름**을 입력합니다.
   - **참고**: "마켓플레이스" 탐색 목록에 봇이 _나타나지 않습니다_ 비공개 앱이기 때문입니다. 이름으로 검색해야 합니다.
4. 결과에서 봇을 선택합니다.
5. **추가** 또는 **채팅**을 클릭하여 1:1 대화를 시작합니다.
6. "안녕하세요"를 보내 어시스턴트를 트리거합니다!

## 공개 URL (웹훅만)

Google Chat 웹훅은 공개 HTTPS 엔드포인트가 필요합니다. 보안상 **`/googlechat` 경로만** 인터넷에 노출합니다. OpenClaw 대시보드 및 기타 민감한 엔드포인트는 비공개 네트워크에 유지합니다.

### 옵션 A: Tailscale Funnel (권장)

비공개 대시보드의 경우 Tailscale Serve를 사용하고 공개 웹훅 경로의 경우 Funnel을 사용합니다. 이는 `/`를 비공개로 유지하면서 `/googlechat`만 노출합니다.

1. **게이트웨이가 바인딩된 주소 확인:**

   ```bash
   ss -tlnp | grep 18789
   ```

   IP 주소를 기록합니다 (예: `127.0.0.1`, `0.0.0.0`, 또는 Tailscale IP like `100.x.x.x`).

2. **대시보드를 tailnet만 노출 (포트 8443):**

   ```bash
   # localhost (127.0.0.1 또는 0.0.0.0)에 바인딩된 경우:
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # Tailscale IP만 (예: 100.106.161.80)에 바인딩된 경우:
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **웹훅 경로만 공개 노출:**

   ```bash
   # localhost (127.0.0.1 또는 0.0.0.0)에 바인딩된 경우:
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # Tailscale IP만 (예: 100.106.161.80)에 바인딩된 경우:
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **Funnel 접근 권한 노드:**
   프롬프트가 나타나면 출력에 표시된 권한 URL을 방문하여 tailnet 정책에서 이 노드에 대한 Funnel을 활성화합니다.

5. **설정 확인:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

공개 웹훅 URL:
`https://<node-name>.<tailnet>.ts.net/googlechat`

비공개 대시보드는 tailnet만 유지:
`https://<node-name>.<tailnet>.ts.net:8443/`

공개 URL (`:8443` 제외)을 Google Chat 앱 설정에 사용합니다.

> 참고: 이 설정은 재부팅 시 유지됩니다. 나중에 제거하려면 `tailscale funnel reset` 및 `tailscale serve reset`을 실행합니다.

### 옵션 B: 역 프록시 (Caddy)

Caddy와 같은 역 프록시를 사용하면 특정 경로만 프록시합니다:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

이 설정으로 `your-domain.com/`에 대한 모든 요청은 무시되거나 404를 반환하고, `your-domain.com/googlechat`은 안전하게 OpenClaw로 라우팅됩니다.

### 옵션 C: Cloudflare Tunnel

터널의 인입 규칙을 웹훅 경로만 라우팅하도록 설정합니다:

- **경로**: `/googlechat` -> `http://localhost:18789/googlechat`
- **기본 규칙**: HTTP 404 (찾을 수 없음)

## 작동 방식

1. Google Chat이 게이트웨이에 웹훅 POST를 보냅니다. 각 요청에는 `Authorization: Bearer <token>` 헤더가 포함됩니다.
2. OpenClaw는 구성된 `audienceType` + `audience`에 대해 토큰을 확인합니다:
   - `audienceType: "app-url"` → audience는 HTTPS 웹훅 URL.
   - `audienceType: "project-number"` → audience는 Cloud 프로젝트 번호.
3. 메시지는 스페이스로 라우팅됩니다:
   - DM은 세션 키 `agent:<agentId>:googlechat:dm:<spaceId>` 사용.
   - 스페이스는 세션 키 `agent:<agentId>:googlechat:group:<spaceId>` 사용.
4. DM 접근은 기본적으로 페어링입니다. 알 수 없는 발신자가 페어링 코드를 받습니다; 승인:
   - `openclaw pairing approve googlechat <code>`
5. 그룹 스페이스는 기본적으로 @-멘션이 필요합니다. 멘션 감지가 앱의 사용자 이름이 필요하면 `botUser`를 사용합니다.

## 대상

배송 및 허용 목록에 다음 식별자를 사용합니다:

- 직접 메시지: `users/<userId>` (권장).
- 원본 이메일 `name@example.com`은 변경 가능하며 `channels.googlechat.dangerouslyAllowNameMatching: true`일 때만 직접 허용 목록 매칭에 사용됩니다.
- 비권장: `users/<email>`은 사용자 ID로 취급되며 이메일 허용 목록이 아닙니다.
- 스페이스: `spaces/<spaceId>`.

## 설정 강조

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      // 또는 serviceAccountRef: { source: "file", provider: "filemain", id: "/channels/googlechat/serviceAccount" }
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // 선택사항; 멘션 감지 도움
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
          systemPrompt: "짧은 답변만.",
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

- 서비스 계정 자격증명은 `serviceAccount` (JSON 문자열)로도 인라인 전달 가능.
- `serviceAccountRef`도 지원됨 (환경/파일 SecretRef), `channels.googlechat.accounts.<id>.serviceAccountRef` 아래 계정별 참조 포함.
- `webhookPath`가 설정되지 않으면 기본 웹훅 경로는 `/googlechat`.
- `dangerouslyAllowNameMatching`은 허용 목록 (break-glass 호환성 모드)에 대해 변경 가능한 이메일 주체 매칭 재활성화.
- 반응은 `channels action`이 `actions.reactions`를 활성화할 때 `reactions` 도구 및 `channels action`을 통해 사용 가능.
- `typingIndicator`는 `none`, `message` (기본값), `reaction` 지원 (반응은 사용자 OAuth 필요).
- 첨부는 Chat API를 통해 다운로드되고 미디어 파이프라인에 저장됨 (`mediaMaxMb`로 한계 제한).

비밀 참조 세부 사항: [비밀 관리](/gateway/secrets).

## 문제 해결

### 405 Method Not Allowed

Google Cloud Logs Explorer가 다음과 같은 오류를 표시하면:

```
상태 코드: 405, 이유 구절: HTTP 오류 응답: HTTP/1.1 405 Method Not Allowed
```

이는 웹훅 핸들러가 등록되지 않았음을 의미합니다. 일반적인 원인:

1. **채널이 설정되지 않음**: `channels.googlechat` 섹션이 설정에서 누락됨. 다음과 같이 확인:

   ```bash
   openclaw config get channels.googlechat
   ```

   "설정 경로를 찾을 수 없음"을 반환하면 설정 추가 ([설정 강조](#설정-강조)).

2. **플러그인이 활성화되지 않음**: 플러그인 상태 확인:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   "비활성화"를 표시하면 `plugins.entries.googlechat.enabled: true`를 설정에 추가.

3. **게이트웨이가 재시작되지 않음**: 설정 추가 후 게이트웨이 재시작:

   ```bash
   openclaw gateway restart
   ```

채널이 실행 중인지 확인:

```bash
openclaw channels status
# 표시해야 함: Google Chat default: enabled, configured, ...
```

### 기타 문제

- 인증 오류 또는 누락된 청중 설정이 있는지 `openclaw channels status --probe` 확인.
- 메시지가 도착하지 않으면 Chat 앱의 웹훅 URL + 이벤트 구독 확인.
- 멘션 게이트가 회신을 차단하면 `botUser`를 앱의 사용자 리소스 이름으로 설정하고 `requireMention` 확인.
- 테스트 메시지를 보내는 동안 `openclaw logs --follow`를 사용하여 요청이 게이트웨이에 도달하는지 확인.

관련 문서:

- [게이트웨이 설정](/gateway/configuration)
- [보안](/gateway/security)
- [반응](/tools/reactions)
