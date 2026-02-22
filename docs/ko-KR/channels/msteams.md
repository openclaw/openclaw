---
summary: "Microsoft Teams 봇 지원 상태, 기능, 및 설정"
read_when:
  - MS Teams 채널 기능 작업 시
title: "Microsoft Teams"
---

# Microsoft Teams (플러그인)

> "여기에 들어오는 자 모든 희망을 버려라."

업데이트: 2026-01-21

상태: 텍스트 + 다이렉트 메시지 첨부 파일 지원; 채널/그룹 파일 보내기는 `sharePointSiteId` + Graph 권한 필요 (자세한 내용은 [그룹 채팅에서 파일 보내기](#sending-files-in-group-chats) 참조). 투표는 Adaptive Cards를 통해 전송됩니다.

## 플러그인 필수

Microsoft Teams는 플러그인으로 제공되며 코어 설치에 번들되지 않습니다.

**중대한 변경 사항 (2026.1.15):** MS Teams가 코어에서 제거되었습니다. 이를 사용하려면 플러그인을 설치해야 합니다.

이유 설명: 코어 설치를 가볍게 유지하고, MS Teams 종속성을 독립적으로 업데이트할 수 있게 합니다.

CLI를 통해 설치 (npm registry):

```bash
openclaw plugins install @openclaw/msteams
```

로컬 체크아웃 (git 저장소에서 실행할 때):

```bash
openclaw plugins install ./extensions/msteams
```

구성/온보딩 중에 Teams를 선택하고, git 체크아웃이 감지되면 OpenClaw가 자동으로 로컬 설치 경로를 제공합니다.

자세한 내용: [플러그인](/ko-KR/tools/plugin)

## 빠른 설정 (초보자용)

1. Microsoft Teams 플러그인을 설치합니다.
2. **Azure Bot**을 만듭니다 (App ID + 클라이언트 비밀번호 + 테넌트 ID).
3. 해당 자격 증명으로 OpenClaw를 구성합니다.
4. `/api/messages` (기본 포트 3978)를 공용 URL 또는 터널링을 통해 노출합니다.
5. Teams 앱 패키지를 설치하고 게이트웨이를 시작합니다.

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

참고: 기본적으로 그룹 채팅은 차단됩니다 (`channels.msteams.groupPolicy: "allowlist"`). 그룹 답장을 허용하려면 `channels.msteams.groupAllowFrom`을 설정하세요 (또는 `groupPolicy: "open"`을 사용해 멤버를 언급 필요함).

## 목표

- Teams 다이렉트 메시지, 그룹 채팅 또는 채널을 통해 OpenClaw와 대화합니다.
- 라우팅을 결정적으로 유지: 답장은 항상 도착한 채널로 돌아갑니다.
- 기본적으로 안전한 채널 동작을 유지 (언급이 필요함, 다르게 구성하지 않는 한).

## 구성 쓰기

기본적으로, Microsoft Teams는 `/config set|unset`에 의해 트리거된 구성 업데이트를 작성할 수 있습니다 (`commands.config: true` 필요).

비활성화하려면:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## 접근 제어 (다이렉트 메시지 + 그룹)

**다이렉트 메시지 접근**

- 기본값: `channels.msteams.dmPolicy = "pairing"`입니다. 승인될 때까지 알려지지 않은 발신자는 무시됩니다.
- `channels.msteams.allowFrom`은 AAD 객체 ID, UPN 또는 표시 이름을 허용합니다. 마법사는 자격 증명이 허용될 때 Microsoft Graph를 통해 이름을 ID로 해석합니다.

**그룹 접근**

- 기본값: `channels.msteams.groupPolicy = "allowlist"` (차단됨, `groupAllowFrom`을 추가하지 않는 한). 설정되지 않았을 경우 기본값을 덮어쓰려면 `channels.defaults.groupPolicy`를 사용하세요.
- `channels.msteams.groupAllowFrom`은 그룹 채팅/채널에서 트리거할 수 있는 발신자를 제어합니다 (기본값은 `channels.msteams.allowFrom`으로 설정됨).
- `groupPolicy: "open"`을 설정하여 모든 멤버를 허용합니다 (여전히 기본적으로 언급 필요).
- **채널 없음**을 허용하려면, `channels.msteams.groupPolicy: "disabled"`를 설정하세요.

예:

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

- `channels.msteams.teams`에 팀 및 채널을 나열하여 그룹/채널의 응답 범위를 지정합니다.
- 키는 팀 ID 또는 이름일 수 있으며, 채널 키는 대화 ID 또는 이름일 수 있습니다.
- `groupPolicy="allowlist"`이고 팀 허용 목록이 존재할 때, 목록에 있는 팀/채널만 허용됩니다 (언급 필요).
- 구성 마법사는 `Team/Channel` 항목을 허용하고 이를 저장합니다.
- OpenClaw는 시작 시 팀/채널과 사용자 허용 목록 이름을 ID로 해석하고 (Graph 권한이 허용될 때) 매핑을 로그합니다. 해석되지 않은 항목은 유형대로 유지됩니다.

예:

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

## 작동 방식

1. Microsoft Teams 플러그인을 설치합니다.
2. **Azure Bot**을 만듭니다 (App ID + 비밀 + 테넌트 ID).
3. 봇을 참조하고 아래 RSC 권한을 포함하는 **Teams 앱 패키지**를 만듭니다.
4. 팀 (또는 다이렉트 메시지 개인 범위) 내에서 Teams 앱을 업로드/설치합니다.
5. `~/.openclaw/openclaw.json` (또는 환경 변수)에서 `msteams`를 구성하고 게이트웨이를 시작합니다.
6. 게이트웨이는 기본적으로 `/api/messages`에서 Bot Framework 웹훅 트래픽을 수신합니다.

## Azure Bot 설정 (필수 조건)

OpenClaw를 구성하기 전에 Azure Bot 리소스를 생성해야 합니다.

### 1단계: Azure Bot 생성

1. [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)로 이동
2. **기본** 탭 작성:

   | 필드                 | 값                                                         |
   | ------------------- | ----------------------------------------------------------- |
   | **봇 핸들**          | 봇 이름, 예: `openclaw-msteams` (고유해야 함)               |
   | **구독**             | Azure 구독 선택                                            |
   | **리소스 그룹**      | 새로 만들기 또는 기존 사용                                  |
   | **가격 책정 등급**    | 개발/테스트용으로 **무료**                                  |
   | **앱 유형**          | **싱글 테넌트** (권장 - 아래 참고)                          |
   | **생성 유형**        | **Microsoft App ID 새로 만들기**                           |

> **지원 중단 공지:** 새로운 멀티 테넌트 봇 생성이 2025-07-31 이후 지원 중단되었습니다. 새로운 봇에 대해 **싱글 테넌트**를 사용하세요.

3. **검토 + 생성** → **생성** 클릭 (약 1-2분 소요)

### 2단계: 자격 증명 얻기

1. Azure Bot 리소스에 가서 → **Configuration** 클릭
2. **Microsoft App ID**를 복사 → 이는 `appId`입니다
3. **비밀번호 관리** 클릭 → 앱 등록으로 이동
4. **인증서 & 비밀** 아래 → **새 클라이언트 비밀** → **값**을 복사 → 이는 `appPassword`입니다
5. **개요**로 이동 → **디렉토리 (테넌트) ID**를 복사 → 이는 `tenantId`입니다

### 3단계: 메시징 엔드포인트 구성

1. Azure Bot → **Configuration**에서
2. **메시징 엔드포인트**를 웹훅 URL로 설정:
   - 프로덕션: `https://your-domain.com/api/messages`
   - 로컬 개발: 터널 사용 (아래 [로컬 개발](#local-development-tunneling) 참조)

### 4단계: Teams 채널 활성화

1. Azure Bot → **채널**에서
2. **Microsoft Teams** 클릭 → 구성 → 저장
3. 서비스 약관 동의

## 로컬 개발 (터널링)

Teams는 `localhost`에 연결할 수 없습니다. 로컬 개발을 위해 터널을 사용하세요:

**옵션 A: ngrok**

```bash
ngrok http 3978
# https URL 복사, 예: https://abc123.ngrok.io
# 메시징 엔드포인트로 설정: https://abc123.ngrok.io/api/messages
```

**옵션 B: Tailscale Funnel**

```bash
tailscale funnel 3978
# Tailscale funnel URL을 메시징 엔드포인트로 사용
```

## Teams 개발자 포털 (대안)

수동으로 매니페스트 ZIP을 만들지 않고, [Teams Developer Portal](https://dev.teams.microsoft.com/apps)을 사용할 수 있습니다:

1. **+ 새 앱** 클릭
2. 기본 정보 입력 (이름, 설명, 개발자 정보)
3. **앱 기능** → **봇**으로 이동
4. **봇 ID 수동 입력** 선택 후 Azure Bot App ID 붙여넣기
5. 범위 체크: **개인**, **팀**, **그룹 채팅**
6. **배포** 클릭 → **앱 패키지 다운로드**
7. Teams에서: **앱** → **앱 관리** → **커스텀 앱 업로드** → ZIP 선택

이 방법이 JSON 매니페스트를 직접 편집하는 것보다 더 쉽습니다.

## 봇 테스트

**옵션 A: Azure 웹 채팅 (웹훅 먼저 확인)**

1. Azure Portal에서 → Azure Bot 리소스로 가서 → **웹 채팅에서 테스트** 클릭
2. 메시지 보내기 - 응답이 보여야 합니다
3. 이는 Teams 설정 전에 웹훅 엔드포인트가 작동하는지 확인시켜줍니다

**옵션 B: Teams (앱 설치 후)**

1. Teams 앱 설치 (사이드로드 또는 조직 카탈로그)
2. Teams에서 봇 찾기 후 다이렉트 메시지 보내기
3. 게이트웨이 로그에서 들어오는 활동 확인

## 설정 (최소 텍스트 전용)

1. **Microsoft Teams 플러그인 설치**
   - npm에서: `openclaw plugins install @openclaw/msteams`
   - 로컬 체크아웃에서: `openclaw plugins install ./extensions/msteams`

2. **봇 등록**
   - Azure Bot 생성 (위 참조) 및 노트:
     - App ID
     - 클라이언트 비밀 (앱 비밀번호)
     - 테넌트 ID (싱글 테넌트)

3. **Teams 앱 매니페스트**
   - `bot` 항목에 `botId = <App ID>`를 포함하십시오.
   - 범위: `personal`, `team`, `groupChat`.
   - `supportsFiles: true` (개인 범위 파일 처리 필요).
   - RSC 권한 추가 (아래).
   - 아이콘 생성: `outline.png` (32x32) 및 `color.png` (192x192).
   - 모든 세 파일을 `manifest.json`, `outline.png`, `color.png`로 압축합니다.

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

   환경 변수를 구성 키 대신 사용할 수도 있습니다:
   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **봇 엔드포인트**
   - Azure Bot Messaging Endpoint를 설정:
     - `https://<host>:3978/api/messages` (또는 선택한 경로/포트).

6. **게이트웨이 실행**
   - 플러그인이 설치되고 `msteams` 구성이 자격 증명과 함께 존재할 때 Teams 채널이 자동으로 시작됩니다.

## 히스토리 컨텍스트

- `channels.msteams.historyLimit`은 프롬프트에 래핑될 최근 채널/그룹 메시지 수를 제어합니다.
- `messages.groupChat.historyLimit`으로 되돌아갑니다. `0`으로 설정하여 비활성화 (기본값 50).
- 다이렉트 메시지 히스토리는 `channels.msteams.dmHistoryLimit` (사용자 턴)으로 제한할 수 있습니다. 사용자별 오버라이드는 `channels.msteams.dms["<user_id>"].historyLimit`입니다.

## 현재 Teams RSC 권한 (매니페스트)

이들은 우리 Teams 앱 매니페스트에 있는 **기존 리소스별 권한**입니다. 앱이 설치된 팀/채팅 내에서만 적용됩니다.

**채널에 대해 (팀 범위):**

- `ChannelMessage.Read.Group` (애플리케이션) - 모든 채널 메시지를 @언급 없이 수신
- `ChannelMessage.Send.Group` (애플리케이션)
- `Member.Read.Group` (애플리케이션)
- `Owner.Read.Group` (애플리케이션)
- `ChannelSettings.Read.Group` (애플리케이션)
- `TeamMember.Read.Group` (애플리케이션)
- `TeamSettings.Read.Group` (애플리케이션)

**그룹 채팅에 대해:**

- `ChatMessage.Read.Chat` (애플리케이션) - 모든 그룹 채팅 메시지를 @언급 없이 수신

## 예제 Teams 매니페스트 (생략된)

필수 필드가 포함된 최소 유효 예제입니다. ID 및 URL을 대체합니다.

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

### 매니페스트 주의사항 (필수 필드)

- `bots[].botId`는 Azure Bot App ID와 반드시 일치해야 합니다.
- `webApplicationInfo.id`는 Azure Bot App ID와 반드시 일치해야 합니다.
- `bots[].scopes`는 사용할 계획인 표면(`personal`, `team`, `groupChat`)을 포함해야 합니다.
- `bots[].supportsFiles: true`는 개인 범위 파일 처리를 위해 필요합니다.
- `authorization.permissions.resourceSpecific`는 채널 트래픽을 원한다면 채널 읽기/보내기를 포함해야 합니다.

### 기존 앱 업데이트

이미 설치된 Teams 앱을 업데이트하려면 (예: RSC 권한 추가):

1. 새 설정으로 `manifest.json` 업데이트
2. **`version` 필드 증가** (예: `1.0.0` → `1.1.0`)
3. 아이콘과 함께 매니페스트를 **재압축** (`manifest.json`, `outline.png`, `color.png`)
4. 새 zip 업로드:
   - **옵션 A (Teams 관리자 센터):** Teams 관리자 센터 → Teams 앱 → 앱 관리 → 앱 찾기 → 새 버전 업로드
   - **옵션 B (사이드로드):** Teams에서 → 앱 → 앱 관리 → 커스텀 앱 업로드
5. **팀 채널의 경우:** 새 권한이 적용되도록 각 팀에서 앱을 다시 설치
6. **Teams를 완전히 종료한 후 다시 시작** (창을 닫는 것만으로는 안 됩니다)하여 캐시된 앱 메타데이터를 지웁니다.

## 기능: RSC 전용 vs Graph

### **Teams RSC 전용**으로 (앱 설치, Graph API 권한 없음)

작동:

- **채널 메시지 텍스트** 내용 읽기.
- **채널 메시지 텍스트** 내용 보내기.
- **개인 (다이렉트 메시지)** 파일 첨부 수신.

작동하지 않음:

- 채널/그룹 **이미지 또는 파일 내용** (페이로드에 HTML 스텁만 포함).
- SharePoint/OneDrive에 저장된 첨부 파일 다운로드.
- 메시히스토리 읽기 (실시간 웹훅 이벤트 제외).

### **Teams RSC + Microsoft Graph 애플리케이션 권한**으로

추가 기능:

- 호스팅된 콘텐츠 다운로드 (메시지에 붙여넣은 이미지).
- SharePoint/OneDrive에 저장된 파일 첨부 다운로드.
- Graph를 통한 채널/채팅 메시지 히스토리 읽기.

### RSC vs Graph API

| 기능                    | RSC 권한              | Graph API                          |
| ----------------------- | -------------------- | ---------------------------------- |
| **실시간 메시지**       | 예 (웹훅을 통해)     | 아니오 (폴링 전용)                  |
| **히스토리 메시지**     | 아니오               | 예 (히스토리 쿼리 가능)            |
| **설정 복잡성**         | 앱 매니페스트만 필요 | 관리자 동의 + 토큰 흐름 필요        |
| **오프라인 작동 여부**  | 아니오 (실행 중이어야 함) | 예 (언제든지 쿼리 가능)             |

**결론:** RSC는 실시간 수신을 위한 것이고, Graph API는 히스토리 접근을 위한 것입니다. 오프라인 상태에서 놓친 메시지를 다시 확인하려면 관리자 동의가 필요한 `ChannelMessage.Read.All` Graph API가 필요합니다.

## Graph로 가능해진 미디어 + 히스토리 (채널에 필요)

**채널**에서 이미지/파일이 필요하거나 **메시지 히스토리**를 가져오려면 Microsoft Graph 권한을 활성화하고 관리자 동의를 해야 합니다.

1. Entra ID (Azure AD) **앱 등록**에서 Microsoft Graph **애플리케이션 권한**을 추가:
   - `ChannelMessage.Read.All` (채널 첨부 + 히스토리)
   - `Chat.Read.All` 또는 `ChatMessage.Read.All` (그룹 채팅)
2. **테넌트에 관리자 동의**.
3. Teams 앱 **매니페스트 버전**을 높이고, 재업로드하고 **Teams에서 앱을 재설치**합니다.
4. 캐시된 앱 메타데이터를 지우기 위해 **Teams를 완전히 종료한 후 다시 시작**합니다.

**사용자 언급에 대한 추가 권한:** 사용자 @언급은 대화 내의 사용자에 대해 기본적으로 작동합니다. 그러나 **현재 대화에 없는 사용자**를 동적으로 검색하고 언급하려면 `User.Read.All` (애플리케이션) 권한을 추가하고 관리자 동의를 하십시오.

## 알려진 제한 사항

### 웹훅 타임아웃

Teams는 HTTP 웹훅을 통해 메시지를 전달합니다. 처리에 시간이 오래 걸리면 (예: 느린 LLM 응답), 다음과 같은 문제가 발생할 수 있습니다:

- 게이트웨이 타임아웃
- Teams가 메시지를 재전송함 (중복 발생)
- 응답이 누락됨

OpenClaw는 빠르게 반환하고 응답을 능동적으로 보내는 방식으로 처리하지만, 매우 느린 응답은 여전히 문제를 일으킬 수 있습니다.

### 서식

Teams 마크다운은 Slack이나 Discord보다 제한적입니다:

- 기본 서식 작동: **굵게**, _기울임꼴_, `코드`, 링크
- 복잡한 마크다운 (표, 중첩 목록)은 올바르게 표시되지 않을 수 있음
- Adaptive Cards는 투표 및 임의 카드 전송에 지원됨 (아래 참조)

## 구성

주요 설정 (공유 채널 패턴에 대해서는 `/gateway/configuration` 참조):

- `channels.msteams.enabled`: 채널 활성화/비활성화.
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: 봇 자격 증명.
- `channels.msteams.webhook.port` (기본 `3978`)
- `channels.msteams.webhook.path` (기본 `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (기본값: pairing)
- `channels.msteams.allowFrom`: 다이렉트 메시지에 대한 허용 목록 (AAD 객체 ID, UPN 또는 표시 이름). Graph 액세스가 가능할 때 설정 중에 마법사는 이름을 ID로 해석합니다.
- `channels.msteams.textChunkLimit`: 발신 텍스트 청크 크기.
- `channels.msteams.chunkMode`: `length` (기본값) 또는 `newline`으로 빈 줄 (단락 경계)에서 분할 후 길이 청크.
- `channels.msteams.mediaAllowHosts`: 인바운드 첨부 파일 호스트에 대한 허용 목록 (기본적으로 Microsoft/Teams 도메인).
- `channels.msteams.mediaAuthAllowHosts`: 미디어 재시도 시 승인 헤더를 첨부할 허용 호스트 목록 (기본적으로 Graph + Bot Framework 호스트).
- `channels.msteams.requireMention`: 채널/그룹에서 @언급 필수 (기본값 true).
- `channels.msteams.replyStyle`: `thread | top-level` (자세한 내용은 [답글 스타일](#reply-style-threads-vs-posts) 참조).
- `channels.msteams.teams.<teamId>.replyStyle`: 팀별 오버라이드.
- `channels.msteams.teams.<teamId>.requireMention`: 팀별 오버라이드.
- `channels.msteams.teams.<teamId>.tools`: 채널 오버라이드가 누락될 경우 사용되는 기본 팀별 도구 정책 오버라이드 (`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.toolsBySender`: 팀별 발신자별 도구 정책 오버라이드의 기본값 (`"*"` 와일드카드 지원).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: 채널별 오버라이드.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: 채널별 오버라이드.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: 채널별 도구 정책 오버라이드 (`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: 채널별 발신자별 도구 정책 오버라이드 (`"*"` 와일드카드 지원).
- `channels.msteams.sharePointSiteId`: 그룹 채팅/채널에서 파일 업로드를 위한 SharePoint 사이트 ID (자세한 내용은 [그룹 채팅에서 파일 보내기](#sending-files-in-group-chats) 참조).

## 라우팅 및 세션

- 세션 키는 표준 에이전트 형식을 따릅니다 (자세한 내용은 [/concepts/session](/ko-KR/concepts/session) 참조):
  - 다이렉트 메시지는 메인 세션을 공유합니다 (`agent:<agentId>:<mainKey>`).
  - 채널/그룹 메시지는 대화 ID를 사용합니다:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## 답글 스타일: 쓰레드 vs 포스트

Teams는 최근 동일한 기초 데이터 모델을 기반으로 두 가지 채널 UI 스타일을 도입했습니다:

| 스타일                   | 설명                                               | 추천 `replyStyle`       |
| ------------------------ | -------------------------------------------------- | --------------------- |
| **포스트** (클래식)      | 메시지가 카드로 나타나고 그 아래에 쓰레드된 답글   | `thread` (기본값)     |
| **쓰레드** (Slack 유사) | 메시지가 선형으로 흐르며, Slack과 유사              | `top-level`          |

**문제:** Teams API는 채널이 어떤 UI 스타일을 사용하는지 노출하지 않습니다. 잘못된 `replyStyle`을 사용할 경우:

- Threads 스타일 채널에서 `thread` → 답글이 어색하게 중첩됨
- Posts 스타일 채널에서 `top-level` → 답글이 개별 최상위 포스트로 나타남

**해결책:** 채널이 설정된 방식을 기반으로 `replyStyle`을 채널별로 설정하십시오:

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

## 첨부 파일 및 이미지

**현재 제한 사항:**

- **다이렉트 메시지:** 이미지 및 파일 첨부는 Teams 봇 파일 API를 통해 작동합니다.
- **채널/그룹:** 첨부 파일은 M365 스토리지 (SharePoint/OneDrive)에 있습니다. 웹훅 페이로드는 실제 파일 바이트가 아닌 HTML 스텁만 포함합니다. 채널 첨부 파일을 다운로드하려면 **Graph API 권한이 필요합니다**.

Graph 권한이 없으면 이미지가 포함된 채널 메시지는 텍스트로만 수신됩니다 (이미지 콘텐츠는 봇에서 액세스할 수 없습니다).
기본적으로, OpenClaw는 Microsoft/Teams 호스트명에서만 미디어를 다운로드합니다. `channels.msteams.mediaAllowHosts`로 오버라이드 (모든 호스트를 허용하려면 `["*"]` 사용).
승인 헤더는 `channels.msteams.mediaAuthAllowHosts`에 있는 호스트에 대해서만 첨부됩니다 (기본값은 Graph + Bot Framework 호스트). 이 목록은 엄격하게 유지하십시오 (멀티 테넌트 접미사 피하기).

## 그룹 채팅에서 파일 보내기

봇은 내장된 FileConsentCard 흐름을 사용하여 다이렉트 메시지로 파일을 보낼 수 있습니다. 그러나 **그룹 채팅/채널에서 파일을 보내려면** 추가 설정이 필요합니다:

| 컨텍스트                | 파일이 보내지는 방식                             | 필요한 설정                              |
| ----------------------- | ---------------------------------------------- | ------------------------------------- |
| **다이렉트 메시지**     | FileConsentCard → 사용자 수락 → 봇 업로드         | 기본 설정으로 작동                     |
| **그룹 채팅/채널**      | SharePoint에 업로드 → 공유 링크                 | `sharePointSiteId` + Graph 권한 필요 |
| **이미지 (모든 컨텍스트)** | Base64로 인코딩된 인라인                          | 기본 설정으로 작동                     |

### 왜 그룹 채팅에 SharePoint가 필요한가

봇은 개인 OneDrive 드라이브가 없습니다 (`/me/drive` Graph API 엔드포인트는 응용 프로그램 ID에 대해 작동 안 함). 그룹 채팅/채널에서 파일을 보내려면, 봇은 **SharePoint 사이트**에 업로드하고 공유 링크를 생성합니다.

### 설정

1. Entra ID (Azure AD)에서 **Graph API 권한** 추가 → 앱 등록:
   - `Sites.ReadWrite.All` (애플리케이션) - SharePoint에 파일 업로드
   - `Chat.Read.All` (애플리케이션) - 선택 사항, 사용자별 공유 링크 활성화

2. **테넌트에 관리자 동의**.

3. **자신의 SharePoint 사이트 ID를 찾으세요:**

   ```bash
   # Graph Explorer 또는 유효한 토큰으로 curl을 통해:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # 예: "contoso.sharepoint.com/sites/BotFiles"에 있는 사이트의 경우
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # 응답에는 다음이 포함됩니다: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **OpenClaw 구성:**

   ```json5
   {
     channels: {
       msteams: {
         // ... 다른 구성 ...
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
       },
     },
   }
   ```

### 공유 동작

| 권한                                   | 공유 동작                                    |
| ------------------------------------- | ----------------------------------------- |
| `Sites.ReadWrite.All`만               | 조직 전체에 공유 링크 (조직 내 누구든지 액세스 가능) |
| `Sites.ReadWrite.All` + `Chat.Read.All` | 사용자별 공유 링크 (채팅 멤버만 액세스 가능)           |

사용자별 공유는 더 안전하며, 채팅 참가자만 파일에 액세스할 수 있습니다. `Chat.Read.All` 권한이 없으면 봇은 조직 전체에 공유로 다시 돌아갑니다.

### 대체 동작

| 시나리오                                          | 결과                                          |
| ------------------------------------------------- | ------------------------------------------- |
| 그룹 채팅 + 파일 + `sharePointSiteId` 구성됨      | SharePoint에 업로드, 공유 링크 전송          |
| 그룹 채팅 + 파일 + `sharePointSiteId` 없음         | OneDrive 업로드 시도 (실패 가능), 텍스트만 전송 |
| 개인 채팅 + 파일                                   | FileConsentCard 흐름 (SharePoint 없이 작동) |
| 모든 컨텍스트 + 이미지                             | Base64로 인코딩된 인라인 (SharePoint 없이 작동) |

### 파일 저장 위치

업로드된 파일은 구성된 SharePoint 사이트의 기본 문서 라이브러리 내 `/OpenClawShared/` 폴더에 저장됩니다.

## 투표 (Adaptive Cards)

OpenClaw는 Teams 투표를 Adaptive Cards로 전송합니다 (Teams에는 기본 투표 API가 없습니다).

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- 투표는 `~/.openclaw/msteams-polls.json`에 있는 게이트웨이에 의해 기록됩니다.
- 게이트웨이는 투표를 기록하기 위해 온라인 상태를 유지해야 합니다.
- 투표는 아직 자동으로 결과 요약을 게시하지 않습니다 (필요한 경우 저장 파일을 검사).

## Adaptive Cards (임의)

`message` 도구나 CLI를 사용하여 Teams 사용자나 대화에 임의의 Adaptive Card JSON을 보냅니다.

`card` 매개변수는 Adaptive Card JSON 객체를 수락합니다. `card`가 제공되면 메시지 텍스트는 선택 사항입니다.

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

카드 스키마 및 예제에 대한 자세한 내용은 [Adaptive Cards 문서](https://adaptivecards.io/)를 참조하세요. 대상 형식의 세부 사항은 [대상 형식](#target-formats) 아래 참조하십시오.

## 대상 형식

MSTeams 대상은 사용자와 대화를 구분하기 위해 접두사를 사용합니다:

| 대상 유형           | 형식                              | 예제                                           |
| ------------------- | -------------------------------- | -------------------------------------------- |
| 사용자 (ID로)        | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197` |
| 사용자 (이름으로)    | `user:<display-name>`            | `user:John Smith` (Graph API 필요)            |
| 그룹/채널           | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`      |
| 그룹/채널 (원시값)   | `<conversation-id>`              | `19:abc123...@thread.tacv2` (`@thread` 포함 시) |

**CLI 예제:**

```bash
# 사용자에게 ID로 전송
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# 사용자에게 표시 이름으로 전송 (Graph API 조회 결과)
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# 그룹 채팅 또는 채널로 전송
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# 대화에 Adaptive Card 전송
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'
```

**에이전트 도구 예제:**

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

참고: `user:` 접두사가 없으면 이름은 그룹/팀 해석으로 기본값이 설정됩니다. 표시 이름으로 사람을 대상으로 할 때 항상 `user:`를 사용하십시오.

## 능동적 메시지 전송

- 능동적 메시지는 사용자가 상호작용한 후에만 가능합니다, 그 시점에서 대화 참조를 저장하기 때문입니다.
- `/gateway/configuration`에서 `dmPolicy` 및 허용 목록 게이트에 대한 내용을 참조하십시오.

## 팀 및 채널 ID (일반적인 실수 주의)

Teams URL의 `groupId` 쿼리 매개변수는 **구성에 사용된 팀 ID가 아닙니다**. 대신 URL 경로에서 ID를 추출합니다:

**팀 URL:**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    팀 ID (URL 디코드)
```

**채널 URL:**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      채널 ID (URL 디코드)
```

**구성을 위한:**

- 팀 ID = `/team/` 이후 경로 세그먼트 (URL 디코드, 예: `19:Bk4j...@thread.tacv2`)
- 채널 ID = `/channel/` 이후 경로 세그먼트 (URL 디코드)
- `groupId` 쿼리 매개변수는 **무시**하십시오

## 비공개 채널

봇은 비공개 채널에서 제한적 지원을 제공합니다:

| 기능                        | 표준 채널           | 비공개 채널                |
| ------------------------ | ----------------- | -------------------------- |
| 봇 설치                    | 예               | 제한적                     |
| 실시간 메시지 (웹훅)        | 예               | 작동하지 않을 수 있음     |
| RSC 권한                  | 예               | 다르게 작동할 수 있음     |
| @언급                     | 예               | 봇이 접근 가능한 경우    |
| Graph API 히스토리         | 예               | 예 (권한 필요)            |

**비공개 채널이 작동하지 않을 경우 해결 방법:**

1. 봇 상호작용을 위한 표준 채널 사용
2. 다이렉트 메시지 사용 - 사용자는 항상 봇에게 메시지를 보낼 수 있음
3. 히스토리 접근을 위한 Graph API 사용 (ChannelMessage.Read.All 필요)

## 문제 해결

### 일반적인 문제

- **채널에서 이미지가 표시되지 않음:** Graph 권한 또는 관리자 동의 누락. Teams 앱을 재설치하고 완전히 종료 후 다시 열기.
- **채널에서 응답이 없음:** 기본적으로 언급이 필요함; 팀/채널별로 설정하거나 `channels.msteams.requireMention=false`로 설정.
- **버전 불일치 (Teams에 여전히 이전 매니페스트 표시):** 앱 제거 + 재추가 후 Teams를 완전히 종료하여 새로고침.
- **웹훅에서 401 인증 실패:** Azure JWT 없이 수동 테스트 시 예상됨 - 엔드포인트에 도달하지만 인증 실패. Azure 웹 채팅을 사용하여 제대로 테스트하십시오.

### 매니페스트 업로드 오류

- **"아이콘 파일이 비어 있을 수 없음":** 매니페스트가 제대로 되어 있지 않은 아이콘 파일을 참조함. 유효한 PNG 아이콘 생성 (`outline.png` 32x32, `color.png` 192x192).
- **"webApplicationInfo.Id 이미 사용 중":** 앱이 다른 팀/채팅에 설치되어 있음. 먼저 앱을 찾고 제거하거나 5-10분 기다려 전파.
- **"업로드 중 오류 발생":** [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com)에서 업로드, 브라우저 개발자 도구 (F12) → 네트워크 탭 열기 후 실제 오류 확인.
- **사이드로드 실패:** "조직의 앱 카탈로그에 앱 업로드"를 시도하여 사이드로드 제한을 우회하는 것이 종종 효과적임.

### RSC 권한이 작동하지 않음

1. `webApplicationInfo.id`가 봇의 App ID와 정확히 일치하는지 확인
2. 앱을 재업로드하고 팀/채팅에 재설치
3. 조직 관리자가 RSC 권한을 차단했는지 확인
4. 올바른 범위를 사용하고 있는지 확인: 팀을 위한 `ChannelMessage.Read.Group`, 그룹 채트를 위한 `ChatMessage.Read.Chat`

## 참고 문헌

- [Azure Bot 생성](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - Azure Bot 설정 가이드
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) - Teams 앱 생성/관리
- [Teams 앱 매니페스트 스키마](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [RSC로 채널 메시지 수신](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC 권한 참조](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams 봇 파일 처리](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (채널/그룹에는 Graph 필요)
- [능동적 메시지 전송](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)