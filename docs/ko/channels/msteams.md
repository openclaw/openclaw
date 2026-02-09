---
summary: "Microsoft Teams 봇 지원 상태, 기능 및 구성"
read_when:
  - MS Teams 채널 기능 작업 중
title: "Microsoft Teams"
---

# Microsoft Teams (플러그인)

> "여기에 들어오는 자, 모든 희망을 버려라."

업데이트: 2026-01-21

상태: 텍스트 + 다이렉트 메시지 첨부 파일은 지원됩니다. 채널/그룹 파일 전송에는 `sharePointSiteId` + Graph 권한이 필요합니다( [그룹 채팅에서 파일 보내기](#sending-files-in-group-chats) 참고). 설문은 Adaptive Cards 로 전송됩니다.

## 플러그인 필요

Microsoft Teams 는 플러그인으로 제공되며 코어 설치에 번들되지 않습니다.

**호환성 파괴 변경 (2026.1.15):** MS Teams 가 코어에서 분리되었습니다. 사용하려면 플러그인을 설치해야 합니다.

설명: 코어 설치를 가볍게 유지하고 MS Teams 의존성을 독립적으로 업데이트할 수 있습니다.

CLI 로 설치 (npm 레지스트리):

```bash
openclaw plugins install @openclaw/msteams
```

로컬 체크아웃 (git repo 에서 실행 시):

```bash
openclaw plugins install ./extensions/msteams
```

구성/온보딩 중 Teams 를 선택하고 git 체크아웃이 감지되면,
OpenClaw 가 로컬 설치 경로를 자동으로 제안합니다.

자세한 내용: [Plugins](/tools/plugin)

## 빠른 설정 (초보자)

1. Microsoft Teams 플러그인을 설치합니다.
2. **Azure Bot** (App ID + client secret + tenant ID)를 생성합니다.
3. 해당 자격 증명으로 OpenClaw 를 구성합니다.
4. `/api/messages` (기본 포트 3978)을 퍼블릭 URL 또는 터널로 노출합니다.
5. Teams 앱 패키지를 설치하고 Gateway(게이트웨이)를 시작합니다.

최소 구성:

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      appPassword: "<APP_PASSWORD>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

참고: 그룹 채팅은 기본적으로 차단됩니다(`channels.msteams.groupPolicy: "allowlist"`). 그룹 응답을 허용하려면 `channels.msteams.groupAllowFrom` 을 설정하거나(또는 멘션 게이트를 유지한 채 모든 멤버를 허용하려면 `groupPolicy: "open"` 를 사용합니다).

## 목표

- Teams 다이렉트 메시지, 그룹 채팅 또는 채널을 통해 OpenClaw 와 대화합니다.
- 라우팅을 결정적으로 유지합니다: 응답은 항상 수신된 채널로 돌아갑니다.
- 안전한 채널 동작을 기본값으로 합니다(구성되지 않은 경우 멘션 필요).

## 구성 쓰기

기본적으로 Microsoft Teams 는 `/config set|unset` 에 의해 트리거되는 구성 업데이트를 쓸 수 있습니다(`commands.config: true` 필요).

비활성화:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## 접근 제어 (다이렉트 메시지 + 그룹)

**다이렉트 메시지 접근**

- 기본값: `channels.msteams.dmPolicy = "pairing"`. 알 수 없는 발신자는 승인될 때까지 무시됩니다.
- `channels.msteams.allowFrom` 는 AAD 객체 ID, UPN 또는 표시 이름을 허용합니다. 마법사는 자격 증명이 허용될 때 Microsoft Graph 를 통해 이름을 ID 로 해석합니다.

**그룹 접근**

- 기본값: `channels.msteams.groupPolicy = "allowlist"` (`groupAllowFrom` 를 추가하지 않으면 차단). 미설정 시 기본값을 재정의하려면 `channels.defaults.groupPolicy` 을 사용합니다.
- `channels.msteams.groupAllowFrom` 는 그룹 채팅/채널에서 어떤 발신자가 트리거할 수 있는지 제어합니다(`channels.msteams.allowFrom` 로 폴백).
- `groupPolicy: "open"` 를 설정하면 모든 멤버를 허용합니다(기본적으로 여전히 멘션 게이트).
- **채널을 전혀 허용하지 않으려면** `channels.msteams.groupPolicy: "disabled"` 를 설정합니다.

예시:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
  },
}
```

**Teams + 채널 허용 목록**

- `channels.msteams.teams` 아래에 팀과 채널을 나열하여 그룹/채널 응답 범위를 제한합니다.
- 키는 팀 ID 또는 이름일 수 있으며, 채널 키는 대화 ID 또는 이름일 수 있습니다.
- `groupPolicy="allowlist"` 이고 팀 허용 목록이 존재하면, 나열된 팀/채널만 허용됩니다(멘션 게이트).
- 구성 마법사는 `Team/Channel` 항목을 받아 저장합니다.
- 시작 시 OpenClaw 는 팀/채널 및 사용자 허용 목록 이름을 ID 로 해석하고( Graph 권한이 허용될 때)
  매핑을 로그로 기록합니다.

예시:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      teams: {
        "My Team": {
          channels: {
            General: { requireMention: true },
          },
        },
      },
    },
  },
}
```

## 동작 방식

1. Microsoft Teams 플러그인을 설치합니다.
2. **Azure Bot** (App ID + secret + tenant ID)를 생성합니다.
3. 봇을 참조하고 아래 RSC 권한을 포함하는 **Teams 앱 패키지**를 빌드합니다.
4. Teams 앱을 팀에 업로드/설치합니다(또는 다이렉트 메시지를 위한 개인 범위).
5. `~/.openclaw/openclaw.json` (또는 환경 변수)에 `msteams` 를 구성하고 Gateway(게이트웨이)를 시작합니다.
6. 게이트웨이는 기본적으로 `/api/messages` 에서 Bot Framework 웹훅 트래픽을 수신합니다.

## Azure Bot 설정 (사전 요구 사항)

OpenClaw 를 구성하기 전에 Azure Bot 리소스를 생성해야 합니다.

### 1단계: Azure Bot 생성

1. [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot) 로 이동합니다.
2. **Basics** 탭을 채웁니다:

   | 필드                 | 값                                                                                                           |
   | ------------------ | ----------------------------------------------------------------------------------------------------------- |
   | **Bot handle**     | Your bot name, e.g., `openclaw-msteams` (must be unique) |
   | **Subscription**   | Azure 구독 선택                                                                                                 |
   | **Resource group** | 새로 생성 또는 기존 사용                                                                                              |
   | **Pricing tier**   | 개발/테스트용 **Free**                                                                                            |
   | **Type of App**    | **Single Tenant** (권장 - 아래 참고)                                                           |
   | **Creation type**  | **Create new Microsoft App ID**                                                                             |

> **사용 중단 공지:** 새 멀티 테넌트 봇 생성은 2025-07-31 이후로 중단되었습니다. 신규 봇은 **Single Tenant** 를 사용하십시오.

3. **Review + create** → **Create** 를 클릭합니다(약 1~2분 대기).

### 2단계: 자격 증명 가져오기

1. Azure Bot 리소스 → **Configuration** 으로 이동합니다.
2. **Microsoft App ID** 를 복사합니다 → 이것이 `appId` 입니다.
3. **Manage Password** 를 클릭하여 App Registration 으로 이동합니다.
4. **Certificates & secrets** → **New client secret** → **Value** 를 복사합니다 → 이것이 `appPassword` 입니다.
5. **Overview** → **Directory (tenant) ID** 를 복사합니다 → 이것이 `tenantId` 입니다.

### 3단계: 메시징 엔드포인트 구성

1. Azure Bot → **Configuration**
2. **Messaging endpoint** 를 웹훅 URL 로 설정합니다:
   - 프로덕션: `https://your-domain.com/api/messages`
   - 로컬 개발: 터널 사용(아래 [로컬 개발](#local-development-tunneling) 참고)

### 4단계: Teams 채널 활성화

1. Azure Bot → **Channels**
2. **Microsoft Teams** → Configure → Save 클릭
3. 서비스 약관에 동의합니다.

## 로컬 개발 (터널링)

Teams 는 `localhost` 에 접근할 수 없습니다. 로컬 개발에는 터널을 사용하십시오:

**옵션 A: ngrok**

```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages
```

**옵션 B: Tailscale Funnel**

```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

## Teams Developer Portal (대안)

매니페스트 ZIP 을 수동으로 생성하는 대신 [Teams Developer Portal](https://dev.teams.microsoft.com/apps) 을 사용할 수 있습니다:

1. **+ New app** 클릭
2. 기본 정보 입력(이름, 설명, 개발자 정보)
3. **App features** → **Bot**
4. **Enter a bot ID manually** 선택 후 Azure Bot App ID 붙여넣기
5. 범위 선택: **Personal**, **Team**, **Group Chat**
6. **Distribute** → **Download app package**
7. Teams 에서 **Apps** → **Manage your apps** → **Upload a custom app** → ZIP 선택

이는 JSON 매니페스트를 직접 편집하는 것보다 종종 더 쉽습니다.

## 봇 테스트

**옵션 A: Azure Web Chat (웹훅 먼저 검증)**

1. Azure Portal → Azure Bot 리소스 → **Test in Web Chat**
2. 메시지를 전송하여 응답을 확인합니다.
3. Teams 설정 전에 웹훅 엔드포인트가 작동함을 확인합니다.

**옵션 B: Teams (앱 설치 후)**

1. Teams 앱 설치(사이드로드 또는 조직 카탈로그)
2. Teams 에서 봇을 찾아 다이렉트 메시지 전송
3. 게이트웨이 로그에서 수신 활동 확인

## 설정 (최소 텍스트 전용)

1. **Microsoft Teams 플러그인 설치**
   - npm: `openclaw plugins install @openclaw/msteams`
   - 로컬 체크아웃: `openclaw plugins install ./extensions/msteams`

2. **봇 등록**
   - Azure Bot 생성(위 참고) 후 다음을 기록:
     - App ID
     - Client secret (App password)
     - Tenant ID (싱글 테넌트)

3. **Teams 앱 매니페스트**
   - `botId = <App ID>` 를 포함한 `bot` 항목을 추가합니다.
   - 범위: `personal`, `team`, `groupChat`.
   - `supportsFiles: true` (개인 범위 파일 처리에 필요).
   - RSC 권한 추가(아래).
   - 아이콘 생성: `outline.png` (32x32) 및 `color.png` (192x192).
   - 세 파일을 함께 ZIP: `manifest.json`, `outline.png`, `color.png`.

4. **OpenClaw 구성**

   ```json
   {
     "msteams": {
       "enabled": true,
       "appId": "<APP_ID>",
       "appPassword": "<APP_PASSWORD>",
       "tenantId": "<TENANT_ID>",
       "webhook": { "port": 3978, "path": "/api/messages" }
     }
   }
   ```

   구성 키 대신 환경 변수를 사용할 수도 있습니다:

   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **봇 엔드포인트**
   - Azure Bot Messaging Endpoint 를 다음으로 설정:
     - `https://<host>:3978/api/messages` (또는 선택한 경로/포트)

6. **게이트웨이 실행**
   - 플러그인이 설치되고 자격 증명이 포함된 `msteams` 구성이 존재하면 Teams 채널이 자동으로 시작됩니다.

## 히스토리 컨텍스트

- `channels.msteams.historyLimit` 는 최근 채널/그룹 메시지를 프롬프트에 포함하는 개수를 제어합니다.
- `messages.groupChat.historyLimit` 로 폴백합니다. 비활성화하려면 `0` 를 설정합니다(기본 50).
- 다이렉트 메시지 히스토리는 `channels.msteams.dmHistoryLimit` (사용자 턴)로 제한할 수 있습니다. 사용자별 재정의: `channels.msteams.dms["<user_id>"].historyLimit`.

## 현재 Teams RSC 권한 (매니페스트)

다음은 Teams 앱 매니페스트의 **기존 resourceSpecific 권한** 입니다. 앱이 설치된 팀/채팅 내에서만 적용됩니다.

**채널용 (팀 범위):**

- `ChannelMessage.Read.Group` (Application) - @멘션 없이 모든 채널 메시지 수신
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**그룹 채팅용:**

- `ChatMessage.Read.Chat` (Application) - @멘션 없이 모든 그룹 채팅 메시지 수신

## 예시 Teams 매니페스트 (가림)

필수 필드를 포함한 최소 유효 예시입니다. ID 와 URL 을 교체하십시오.

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  "manifestVersion": "1.23",
  "version": "1.0.0",
  "id": "00000000-0000-0000-0000-000000000000",
  "name": { "short": "OpenClaw" },
  "developer": {
    "name": "Your Org",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "description": { "short": "OpenClaw in Teams", "full": "OpenClaw in Teams" },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#5B6DEF",
  "bots": [
    {
      "botId": "11111111-1111-1111-1111-111111111111",
      "scopes": ["personal", "team", "groupChat"],
      "isNotificationOnly": false,
      "supportsCalling": false,
      "supportsVideo": false,
      "supportsFiles": true
    }
  ],
  "webApplicationInfo": {
    "id": "11111111-1111-1111-1111-111111111111"
  },
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "ChannelMessage.Read.Group", "type": "Application" },
        { "name": "ChannelMessage.Send.Group", "type": "Application" },
        { "name": "Member.Read.Group", "type": "Application" },
        { "name": "Owner.Read.Group", "type": "Application" },
        { "name": "ChannelSettings.Read.Group", "type": "Application" },
        { "name": "TeamMember.Read.Group", "type": "Application" },
        { "name": "TeamSettings.Read.Group", "type": "Application" },
        { "name": "ChatMessage.Read.Chat", "type": "Application" }
      ]
    }
  }
}
```

### 매니페스트 주의 사항 (필수 필드)

- `bots[].botId` 는 Azure Bot App ID 와 **반드시** 일치해야 합니다.
- `webApplicationInfo.id` 는 Azure Bot App ID 와 **반드시** 일치해야 합니다.
- `bots[].scopes` 는 사용할 표면(`personal`, `team`, `groupChat`)을 포함해야 합니다.
- `bots[].supportsFiles: true` 는 개인 범위 파일 처리에 필요합니다.
- 채널 트래픽을 원하면 `authorization.permissions.resourceSpecific` 에 채널 읽기/전송이 포함되어야 합니다.

### 기존 앱 업데이트

이미 설치된 Teams 앱을 업데이트하려면(예: RSC 권한 추가):

1. 새로운 설정으로 `manifest.json` 를 업데이트합니다.
2. **`version` 필드를 증가**시킵니다(예: `1.0.0` → `1.1.0`).
3. 아이콘과 함께 매니페스트를 **다시 ZIP** 합니다(`manifest.json`, `outline.png`, `color.png`).
4. 새 ZIP 업로드:
   - **옵션 A (Teams Admin Center):** Teams Admin Center → Teams apps → Manage apps → 앱 찾기 → Upload new version
   - **옵션 B (사이드로드):** Teams → Apps → Manage your apps → Upload a custom app
5. **팀 채널의 경우:** 새 권한 적용을 위해 각 팀에서 앱을 재설치합니다.
6. **Teams 를 완전히 종료 후 재실행**합니다(창 닫기만으로는 불충분).

## 기능: RSC 전용 vs Graph

### **Teams RSC 전용** (앱 설치, Graph API 권한 없음)

동작:

- 채널 메시지 **텍스트** 읽기
- 채널 메시지 **텍스트** 전송
- **개인(다이렉트 메시지)** 파일 첨부 수신

동작하지 않음:

- 채널/그룹 **이미지 또는 파일 내용** (페이로드에는 HTML 스텁만 포함)
- SharePoint/OneDrive 에 저장된 첨부 파일 다운로드
- 메시지 히스토리 읽기(실시간 웹훅 이벤트 이후)

### **Teams RSC + Microsoft Graph Application 권한**

추가:

- 호스팅된 콘텐츠 다운로드(메시지에 붙여넣은 이미지)
- SharePoint/OneDrive 에 저장된 파일 첨부 다운로드
- Graph 를 통한 채널/채팅 메시지 히스토리 읽기

### RSC vs Graph API

| 기능          | RSC 권한                        | Graph API                                  |
| ----------- | ----------------------------- | ------------------------------------------ |
| **실시간 메시지** | 예(웹훅)      | 아니오(폴링만)                |
| **과거 메시지**  | 아니오                           | Yes (can query history) |
| **설정 복잡도**  | App manifest only             | 관리자 동의 + 토큰 플로우 필요                         |
| **오프라인 동작** | 아니오(실행 필요) | 예(언제든 쿼리)               |

**결론:** RSC 는 실시간 수신용이며, Graph API 는 과거 접근용입니다. 오프라인 중 누락된 메시지를 따라잡으려면 Graph API 와 `ChannelMessage.Read.All` 가 필요합니다(관리자 동의 필요).

## Graph 활성화 미디어 + 히스토리 (채널에 필요)

**채널**에서 이미지/파일이 필요하거나 **메시지 히스토리**를 가져오려면 Microsoft Graph 권한을 활성화하고 관리자 동의를 부여해야 합니다.

1. Entra ID (Azure AD) **App Registration** 에서 Microsoft Graph **Application 권한** 추가:
   - `ChannelMessage.Read.All` (채널 첨부 + 히스토리)
   - `Chat.Read.All` 또는 `ChatMessage.Read.All` (그룹 채팅)
2. 테넌트에 대해 **관리자 동의**를 부여합니다.
3. Teams 앱 **매니페스트 버전**을 올리고, 다시 업로드한 뒤 **Teams 에서 앱을 재설치**합니다.
4. **Teams 를 완전히 종료 후 재실행**하여 캐시된 앱 메타데이터를 지웁니다.

## 알려진 제한 사항

### 웹훅 타임아웃

Teams 는 HTTP 웹훅으로 메시지를 전달합니다. 처리 시간이 너무 길면(예: 느린 LLM 응답):

- 게이트웨이 타임아웃
- Teams 의 메시지 재시도(중복 발생)
- 응답 드롭

OpenClaw 는 빠르게 반환하고 선제적으로 응답을 보내지만, 매우 느린 응답은 여전히 문제를 일으킬 수 있습니다.

### Formatting

Teams 마크다운은 Slack 이나 Discord 보다 제한적입니다:

- 기본 포맷팅은 동작: **굵게**, _기울임_, `code`, 링크
- 복잡한 마크다운(표, 중첩 리스트)은 올바르게 렌더링되지 않을 수 있음
- Adaptive Cards 는 설문 및 임의 카드 전송에 지원됨(아래 참고)

## 구성

주요 설정(`/gateway/configuration` 의 공통 채널 패턴 참고):

- `channels.msteams.enabled`: 채널 활성화/비활성화.
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: 봇 자격 증명.
- `channels.msteams.webhook.port` (기본 `3978`)
- `channels.msteams.webhook.path` (기본 `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (기본: 페어링)
- `channels.msteams.allowFrom`: 다이렉트 메시지 허용 목록(AAD 객체 ID, UPN 또는 표시 이름). 설정 중 Graph 접근이 가능하면 마법사가 이름을 ID 로 해석합니다.
- `channels.msteams.textChunkLimit`: 아웃바운드 텍스트 청크 크기.
- `channels.msteams.chunkMode`: `length` (기본) 또는 길이 청크 이전에 빈 줄(문단 경계) 기준으로 분할하려면 `newline`.
- `channels.msteams.mediaAllowHosts`: 인바운드 첨부 호스트 허용 목록(기본 Microsoft/Teams 도메인).
- `channels.msteams.mediaAuthAllowHosts`: 미디어 재시도 시 Authorization 헤더를 첨부할 호스트 허용 목록(기본 Graph + Bot Framework 호스트).
- `channels.msteams.requireMention`: 채널/그룹에서 @멘션 요구(기본 true).
- `channels.msteams.replyStyle`: `thread | top-level` ([Reply Style](#reply-style-threads-vs-posts) 참고).
- `channels.msteams.teams.<teamId>.replyStyle`: 팀별 재정의.
- `channels.msteams.teams.<teamId>.requireMention`: 팀별 재정의.
- `channels.msteams.teams.<teamId>.tools`: 채널 재정의가 없을 때 사용되는 팀별 기본 도구 정책 재정의(`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.toolsBySender`: 팀별·발신자별 기본 도구 정책 재정의(`"*"` 와일드카드 지원).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: 채널별 재정의.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: 채널별 재정의.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: 채널별 도구 정책 재정의(`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: 채널별·발신자별 도구 정책 재정의(`"*"` 와일드카드 지원).
- `channels.msteams.sharePointSiteId`: 그룹 채팅/채널에서 파일 업로드를 위한 SharePoint 사이트 ID([그룹 채팅에서 파일 보내기](#sending-files-in-group-chats) 참고).

## 라우팅 & 세션

- 세션 키는 표준 에이전트 형식을 따릅니다([/concepts/session](/concepts/session) 참고):
  - 다이렉트 메시지는 메인 세션(`agent:<agentId>:<mainKey>`)을 공유합니다.
  - 채널/그룹 메시지는 대화 ID 를 사용합니다:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## 응답 스타일: 스레드 vs 게시물

Teams 는 동일한 기본 데이터 모델 위에 두 가지 채널 UI 스타일을 최근 도입했습니다:

| 스타일                                   | 설명                         | 권장 `replyStyle`                  |
| ------------------------------------- | -------------------------- | -------------------------------- |
| **게시물** (클래식)      | 메시지가 카드로 표시되고 그 아래에 스레드 응답 | `thread` (기본) |
| **스레드** (Slack 유사) | 메시지가 Slack 처럼 선형으로 흐름      | `top-level`                      |

**문제:** Teams API 는 채널이 어떤 UI 스타일을 사용하는지 노출하지 않습니다. 잘못된 `replyStyle` 를 사용하면:

- 스레드 스타일 채널에서 `thread` → 응답이 어색하게 중첩됨
- 게시물 스타일 채널에서 `top-level` → 응답이 스레드가 아닌 최상위 게시물로 표시됨

**해결책:** 채널 설정에 따라 채널별로 `replyStyle` 를 구성합니다:

```json
{
  "msteams": {
    "replyStyle": "thread",
    "teams": {
      "19:abc...@thread.tacv2": {
        "channels": {
          "19:xyz...@thread.tacv2": {
            "replyStyle": "top-level"
          }
        }
      }
    }
  }
}
```

## 첨부 파일 & 이미지

**현재 제한 사항:**

- **다이렉트 메시지:** Teams 봇 파일 API 를 통해 이미지 및 파일 첨부가 작동합니다.
- **채널/그룹:** 첨부 파일은 M365 스토리지(SharePoint/OneDrive)에 있습니다. 웹훅 페이로드에는 실제 파일 바이트가 아닌 HTML 스텁만 포함됩니다. **채널 첨부를 다운로드하려면 Graph API 권한이 필요합니다.**

Graph 권한이 없으면 이미지가 포함된 채널 메시지는 텍스트 전용으로 수신됩니다(이미지 콘텐츠는 봇이 접근할 수 없음).
기본적으로 OpenClaw 는 Microsoft/Teams 호스트 이름에서만 미디어를 다운로드합니다. `channels.msteams.mediaAllowHosts` 로 재정의할 수 있으며(`["*"]` 로 모든 호스트 허용).
Authorization 헤더는 `channels.msteams.mediaAuthAllowHosts` 에 있는 호스트에만 첨부됩니다(기본 Graph + Bot Framework 호스트). 이 목록은 엄격하게 유지하십시오(멀티 테넌트 접미사 회피).

## 그룹 채팅에서 파일 보내기

봇은 FileConsentCard 플로우를 사용하여 다이렉트 메시지에서 파일을 보낼 수 있습니다(기본 제공). 그러나 **그룹 채팅/채널에서 파일을 보내려면** 추가 설정이 필요합니다:

| 컨텍스트                                | 파일 전송 방식                         | 필요한 설정                           |
| ----------------------------------- | -------------------------------- | -------------------------------- |
| **다이렉트 메시지**                        | FileConsentCard → 사용자 승인 → 봇 업로드 | Works out of the box             |
| **그룹 채팅/채널**                        | SharePoint 업로드 → 링크 공유           | `sharePointSiteId` + Graph 권한 필요 |
| **이미지(모든 컨텍스트)** | Base64 인라인 인코딩                   | Works out of the box             |

### 그룹 채팅에 SharePoint 가 필요한 이유

봇에는 개인 OneDrive 드라이브가 없습니다(`/me/drive` Graph API 엔드포인트는 애플리케이션 ID 에서 작동하지 않음). 그룹 채팅/채널에서 파일을 보내려면 봇이 **SharePoint 사이트**에 업로드하고 공유 링크를 생성합니다.

### 설정

1. Entra ID (Azure AD) → App Registration 에서 **Graph API 권한 추가**:
   - `Sites.ReadWrite.All` (Application) - SharePoint 에 파일 업로드
   - `Chat.Read.All` (Application) - 선택 사항, 사용자별 공유 링크 활성화

2. 테넌트에 대해 **관리자 동의**를 부여합니다.

3. **SharePoint 사이트 ID 가져오기:**

   ```bash
   # Via Graph Explorer or curl with a valid token:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **OpenClaw 구성:**

   ```json5
   {
     channels: {
       msteams: {
         // ... other config ...
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
       },
     },
   }
   ```

### 공유 동작

| 권한                                      | 공유 동작                                          |
| --------------------------------------- | ---------------------------------------------- |
| `Sites.ReadWrite.All` 만                 | 조직 전체 공유 링크(조직 내 누구나 접근 가능) |
| `Sites.ReadWrite.All` + `Chat.Read.All` | 사용자별 공유 링크(채팅 멤버만 접근 가능)    |

사용자별 공유가 더 안전합니다. `Chat.Read.All` 권한이 없으면 봇은 조직 전체 공유로 폴백합니다.

### 폴백 동작

| 시나리오                                | 결과                                                       |
| ----------------------------------- | -------------------------------------------------------- |
| 그룹 채팅 + 파일 + `sharePointSiteId` 구성됨 | SharePoint 업로드 후 공유 링크 전송                                |
| 그룹 채팅 + 파일 + `sharePointSiteId` 없음  | OneDrive 업로드 시도(실패 가능), 텍스트만 전송       |
| 개인 채팅 + 파일                          | FileConsentCard 플로우(SharePoint 없이 작동) |
| 모든 컨텍스트 + 이미지                       | Base64 인라인 인코딩(SharePoint 없이 작동)      |

### 파일 저장 위치

업로드된 파일은 구성된 SharePoint 사이트의 기본 문서 라이브러리 내 `/OpenClawShared/` 폴더에 저장됩니다.

## 설문 (Adaptive Cards)

OpenClaw 는 Teams 설문을 Adaptive Cards 로 전송합니다(네이티브 Teams 설문 API 없음).

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- 투표는 게이트웨이가 `~/.openclaw/msteams-polls.json` 에 기록합니다.
- 투표 기록을 위해 게이트웨이는 온라인 상태를 유지해야 합니다.
- 설문 결과 요약 자동 게시 기능은 아직 없습니다(필요 시 저장 파일을 확인).

## Adaptive Cards (임의)

`message` 도구 또는 CLI 를 사용하여 Teams 사용자 또는 대화로 임의의 Adaptive Card JSON 을 전송할 수 있습니다.

`card` 파라미터는 Adaptive Card JSON 객체를 받습니다. `card` 가 제공되면 메시지 텍스트는 선택 사항입니다.

**에이전트 도구:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:<id>",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello!" }]
  }
}
```

**CLI:**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello!"}]}'
```

카드 스키마와 예시는 [Adaptive Cards documentation](https://adaptivecards.io/) 를 참고하십시오. 대상 형식에 대한 자세한 내용은 아래 [Target formats](#target-formats) 를 참고하십시오.

## 대상 형식

MSTeams 대상은 사용자와 대화를 구분하기 위해 접두사를 사용합니다:

| 대상 유형                         | 형식                               | 예시                                                              |
| ----------------------------- | -------------------------------- | --------------------------------------------------------------- |
| 사용자(ID 기준) | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`                     |
| 사용자(이름 기준) | `user:<display-name>`            | `user:John Smith` (Graph API 필요)             |
| 그룹/채널                         | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`                        |
| 그룹/채널(원시)  | `<conversation-id>`              | `19:abc123...@thread.tacv2` (`@thread` 포함 시) |

**CLI 예시:**

```bash
# Send to a user by ID
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# Send to a user by display name (triggers Graph API lookup)
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# Send to a group chat or channel
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# Send an Adaptive Card to a conversation
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'
```

**에이전트 도구 예시:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:John Smith",
  "message": "Hello!"
}
```

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "conversation:19:abc...@thread.tacv2",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello" }]
  }
}
```

참고: `user:` 접두사가 없으면 이름은 기본적으로 그룹/팀 해석으로 처리됩니다. 표시 이름으로 사람을 지정할 때는 항상 `user:` 를 사용하십시오.

## 선제적 메시징

- 선제적 메시지는 사용자가 **상호작용한 이후에만** 가능합니다. 이 시점에 대화 참조를 저장하기 때문입니다.
- `dmPolicy` 및 허용 목록 게이팅에 대해서는 `/gateway/configuration` 를 참고하십시오.

## 팀 및 채널 ID (자주 발생하는 함정)

Teams URL 의 `groupId` 쿼리 파라미터는 구성에 사용하는 팀 ID 가 **아닙니다**. 대신 URL 경로에서 ID 를 추출하십시오:

**팀 URL:**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team ID (URL-decode this)
```

**채널 URL:**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      Channel ID (URL-decode this)
```

**구성 시:**

- 팀 ID = `/team/` 뒤의 경로 세그먼트(URL 디코딩, 예: `19:Bk4j...@thread.tacv2`)
- 채널 ID = `/channel/` 뒤의 경로 세그먼트(URL 디코딩)
- `groupId` 쿼리 파라미터는 **무시**

## 프라이빗 채널

봇은 프라이빗 채널에서 제한적으로 지원됩니다:

| 기능                             | 표준 채널 | 프라이빗 채널                     |
| ------------------------------ | ----- | --------------------------- |
| 봇 설치                           | 예     | 제한적                         |
| 실시간 메시지(웹훅) | 예     | 작동하지 않을 수 있음                |
| RSC 권한                         | 예     | 다르게 동작할 수 있음                |
| @멘션               | 예     | If bot is accessible        |
| Graph API 히스토리                 | 예     | 예(권한 필요) |

**프라이빗 채널이 작동하지 않을 때의 우회 방법:**

1. 봇 상호작용에는 표준 채널을 사용합니다.
2. 다이렉트 메시지를 사용합니다(사용자는 항상 봇에 직접 메시지를 보낼 수 있음).
3. 과거 접근에는 Graph API 를 사용합니다(`ChannelMessage.Read.All` 필요).

## 문제 해결

### 일반적인 문제

- **채널에서 이미지가 보이지 않음:** Graph 권한 또는 관리자 동의가 누락되었습니다. Teams 앱을 재설치하고 Teams 를 완전히 종료/재실행하십시오.
- **채널에서 응답 없음:** 기본적으로 멘션이 필요합니다. `channels.msteams.requireMention=false` 를 설정하거나 팀/채널별로 구성하십시오.
- **버전 불일치(Teams 에서 이전 매니페스트 표시):** 앱을 제거 후 다시 추가하고 Teams 를 완전히 종료하여 새로고침하십시오.
- **웹훅에서 401 Unauthorized:** Azure JWT 없이 수동 테스트 시 정상입니다. 엔드포인트 도달 가능하나 인증 실패를 의미합니다. Azure Web Chat 으로 올바르게 테스트하십시오.

### 매니페스트 업로드 오류

- **"Icon file cannot be empty":** 매니페스트가 0바이트 아이콘 파일을 참조합니다. 유효한 PNG 아이콘을 생성하십시오( `outline.png` 용 32x32, `color.png` 용 192x192).
- **"webApplicationInfo.Id already in use":** 앱이 다른 팀/채팅에 아직 설치되어 있습니다. 먼저 찾아 제거하거나 전파를 위해 5~10분 대기하십시오.
- **업로드 시 "Something went wrong":** 대신 [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com) 를 통해 업로드하고, 브라우저 DevTools(F12) → Network 탭에서 응답 본문을 확인하십시오.
- **사이드로드 실패:** "Upload a custom app" 대신 "Upload an app to your org's app catalog" 를 시도하십시오. 이는 종종 사이드로드 제한을 우회합니다.

### RSC 권한이 작동하지 않음

1. `webApplicationInfo.id` 이 봇의 App ID 와 정확히 일치하는지 확인합니다.
2. 앱을 다시 업로드하고 팀/채팅에 재설치합니다.
3. 조직 관리자가 RSC 권한을 차단했는지 확인합니다.
4. 올바른 범위를 사용하는지 확인합니다: 팀은 `ChannelMessage.Read.Group`, 그룹 채팅은 `ChatMessage.Read.Chat`.

## 참고 자료

- [Create Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - Azure Bot 설정 가이드
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) - Teams 앱 생성/관리
- [Teams app manifest schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [Receive channel messages with RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC permissions reference](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams bot file handling](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (채널/그룹은 Graph 필요)
- [Proactive messaging](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
