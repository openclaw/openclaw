---
summary: "Microsoft Teams bot support status, capabilities, and configuration"
read_when:
  - Working on MS Teams channel features
title: "Microsoft Teams"
x-i18n:
  source_hash: cec0b5a6eb3ff1ac9823fc1e663b6087885ea8fc62fed3ab43b57fcdc4c6b152
---

# 마이크로소프트 팀즈(플러그인)

> "여기에 들어오는 자여, 모든 희망을 버리라."

업데이트 날짜: 2026-01-21

상태: 텍스트 + DM 첨부 파일이 지원됩니다. 채널/그룹 파일 전송에는 `sharePointSiteId` + 그래프 권한이 필요합니다([그룹 채팅에서 파일 전송](#sending-files-in-group-chats) 참조). 설문조사는 적응형 카드를 통해 전송됩니다.

## 플러그인이 필요합니다

Microsoft Teams는 플러그인으로 제공되며 핵심 설치와 함께 번들로 제공되지 않습니다.

**주요 변경 사항(2026.1.15):** MS Teams가 핵심에서 벗어났습니다. 사용하실 경우 플러그인을 설치하셔야 합니다.

설명 가능: 핵심 설치를 더 가볍게 유지하고 MS Teams 종속성을 독립적으로 업데이트할 수 있습니다.

CLI(npm 레지스트리)를 통해 설치:

```bash
openclaw plugins install @openclaw/msteams
```

로컬 체크아웃(git repo에서 실행하는 경우):

```bash
openclaw plugins install ./extensions/msteams
```

구성/온보딩 중에 Teams를 선택하고 git 체크아웃이 감지되면
OpenClaw는 로컬 설치 경로를 자동으로 제공합니다.

세부정보: [플러그인](/tools/plugin)

## 빠른 설정(초보자)

1. 마이크로소프트 팀즈 플러그인을 설치하세요.
2. **Azure Bot**(앱 ID + 클라이언트 암호 + 테넌트 ID)을 만듭니다.
3. 해당 자격 증명으로 OpenClaw를 구성합니다.
4. 공개 URL이나 터널을 통해 `/api/messages`(기본적으로 포트 3978)을 노출합니다.
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

참고: 그룹 채팅은 기본적으로 차단됩니다(`channels.msteams.groupPolicy: "allowlist"`). 그룹 답글을 허용하려면 `channels.msteams.groupAllowFrom`를 설정하세요(또는 `groupPolicy: "open"`를 사용하여 모든 회원을 멘션 제한하도록 허용하세요).

## 목표

- Teams DM, 그룹 채팅 또는 채널을 통해 OpenClaw와 대화하세요.
- 결정적인 라우팅 유지: 응답은 항상 응답이 도착한 채널로 돌아갑니다.
- 안전한 채널 동작을 기본값으로 합니다(달리 구성하지 않는 한 언급이 필요함).

## 구성 쓰기

기본적으로 Microsoft Teams는 `/config set|unset`에 의해 트리거되는 구성 업데이트를 작성할 수 있습니다(`commands.config: true` 필요).

다음을 사용하여 비활성화:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## 접근 제어(DM + 그룹)

**DM접수**

- 기본값 : `channels.msteams.dmPolicy = "pairing"`. 알 수 없는 발신자는 승인될 때까지 무시됩니다.
- `channels.msteams.allowFrom`는 AAD 개체 ID, UPN 또는 표시 이름을 허용합니다. 자격 증명이 허용되면 마법사는 Microsoft Graph를 통해 이름을 ID로 확인합니다.

**그룹 액세스**

- 기본값: `channels.msteams.groupPolicy = "allowlist"` (`groupAllowFrom`를 추가하지 않으면 차단됨). 설정되지 않은 경우 기본값을 무시하려면 `channels.defaults.groupPolicy`를 사용하세요.
- `channels.msteams.groupAllowFrom`는 그룹 채팅/채널에서 어떤 발신자가 트리거할 수 있는지 제어합니다(`channels.msteams.allowFrom`으로 대체).
- 모든 구성원을 허용하려면 `groupPolicy: "open"`를 설정합니다(기본적으로 여전히 멘션 차단됨).
- **채널 없음**을 허용하려면 `channels.msteams.groupPolicy: "disabled"`를 설정하세요.

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

**팀 + 채널 허용 목록**

- `channels.msteams.teams` 아래에 팀 및 채널을 나열하여 범위 그룹/채널 응답.
- 키는 팀 ID 또는 이름일 수 있습니다. 채널 키는 대화 ID 또는 이름일 수 있습니다.
- `groupPolicy="allowlist"` 및 팀 허용 목록이 있는 경우 나열된 팀/채널만 허용됩니다(멘션 제한).
- 구성 마법사는 `Team/Channel` 항목을 수락하고 저장합니다.
- 시작 시 OpenClaw는 팀/채널 및 사용자 허용 목록 이름을 ID로 확인합니다(그래프 권한이 허용되는 경우).
  매핑을 기록합니다. 해결되지 않은 항목은 입력한 대로 유지됩니다.

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

1. 마이크로소프트 팀즈 플러그인을 설치하세요.
2. **Azure Bot**(앱 ID + 비밀 + 테넌트 ID)을 만듭니다.
3. 봇을 참조하고 아래 RSC 권한을 포함하는 **Teams 앱 패키지**를 빌드합니다.
4. Teams 앱을 팀(또는 DM의 경우 개인 범위)에 업로드/설치합니다.
5. `~/.openclaw/openclaw.json`(또는 환경 변수)에서 `msteams`를 구성하고 게이트웨이를 시작합니다.
6. 게이트웨이는 기본적으로 `/api/messages`에서 Bot Framework 웹후크 트래픽을 수신합니다.

## Azure Bot 설정(전제 조건)

OpenClaw를 구성하기 전에 Azure Bot 리소스를 만들어야 합니다.

### 1단계: Azure Bot 만들기

1. [Azure Bot 생성](https://portal.azure.com/#create/Microsoft.AzureBot)으로 이동합니다.
2. **기본** 탭을 작성합니다.

   | 필드               | 가치                                        |
   | ------------------ | ------------------------------------------- |
   | **봇 핸들**        | 봇 이름(예: `openclaw-msteams`(고유해야 함) |
   | **구독**           | Azure 구독 선택                             |
   | **리소스 그룹**    | 새로 만들기 또는 기존 사용                  |
   | **가격 책정 등급** | **무료** 개발/테스트용                      |
   | **앱 유형**        | **단일 테넌트**(권장 - 아래 참고 참조)      |
   | **생성 유형**      | **새 Microsoft 앱 ID 만들기**               |

> **지원 중단 알림:** 새로운 다중 테넌트 봇 생성은 2025년 7월 31일 이후 더 이상 지원되지 않습니다. 새 봇에는 **단일 테넌트**를 사용하세요.

3. **검토 + 생성** → **만들기**를 클릭합니다(1~2분 정도 대기).

### 2단계: 자격 증명 받기

1. Azure Bot 리소스 → **구성**으로 이동합니다.
2. **Microsoft 앱 ID**를 복사 → 이것이 귀하의 `appId`입니다.
3. **비밀번호 관리** 클릭 → 앱 등록으로 이동
4. **인증서 및 비밀** → **새 클라이언트 비밀** → **값** 복사 → `appPassword`입니다.
5. **개요**로 이동 → **디렉터리(테넌트) ID** 복사 → `tenantId`입니다.

### 3단계: 메시징 끝점 구성

1. Azure Bot에서 → **구성**
2. **메시징 끝점**을 웹훅 URL로 설정합니다.
   - 생산 : `https://your-domain.com/api/messages`
   - 로컬 개발: 터널 사용(아래 [로컬 개발](#local-development-tunneling) 참조)

### 4단계: Teams 채널 활성화

1. Azure Bot에서 → **채널**
2. **Microsoft Teams** → 구성 → 저장을 클릭합니다.
3. 서비스 약관에 동의하세요.

## 지역 개발(터널링)

팀은 `localhost`에 연결할 수 없습니다. 로컬 개발을 위해 터널을 사용하십시오.

**옵션 A: ngrok**

```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages
```

**옵션 B: 테일스케일 깔때기**

```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

## Teams 개발자 포털(대체)

매니페스트 ZIP을 수동으로 생성하는 대신 [Teams 개발자 포털](https://dev.teams.microsoft.com/apps)을 사용할 수 있습니다.

1. **+ 새 앱**을 클릭합니다.
2. 기본 정보(이름, 설명, 개발자 정보)를 입력합니다.
3. **앱 기능** → **봇**으로 이동합니다.
4. **수동으로 봇 ID 입력**을 선택하고 Azure Bot App ID를 붙여넣습니다.
5. 범위 확인: **개인**, **팀**, **그룹 채팅**
6. **배포** → **앱 패키지 다운로드**를 클릭합니다.
7. Teams에서: **앱** → **앱 관리** → **맞춤형 앱 업로드** → ZIP 선택

이는 JSON 매니페스트를 직접 편집하는 것보다 더 쉬운 경우가 많습니다.

## 봇 테스트

**옵션 A: Azure 웹 채팅(먼저 웹후크 확인)**

1. Azure Portal → Azure Bot 리소스 → **웹 채팅에서 테스트**
2. 메시지 보내기 - 응답이 표시됩니다.
3. 그러면 Teams 설정 전에 웹후크 끝점이 작동하는지 확인됩니다.

**옵션 B: 팀(앱 설치 후)**

1. Teams 앱 설치(사이드로드 또는 조직 카탈로그)
2. Teams에서 봇을 찾아 DM 보내기
3. 들어오는 활동에 대한 게이트웨이 로그를 확인하세요.

## 설정(최소 텍스트 전용)

1. **Microsoft Teams 플러그인 설치**
   - npm에서: `openclaw plugins install @openclaw/msteams`
   - 현지 결제에서: `openclaw plugins install ./extensions/msteams`

2. **봇 등록**
   - Azure Bot을 생성하고(위 참조) 다음 사항에 유의하세요.
     - 앱 ID
     - 클라이언트 비밀번호(앱 비밀번호)
     - 테넌트 ID(싱글 테넌트)

3. **Teams 앱 매니페스트**
   - `bot` 항목을 `botId = <App ID>`와 함께 포함합니다.
   - 범위: `personal`, `team`, `groupChat`.
   - `supportsFiles: true` (개인 범위 파일 처리에 필요).
   - RSC 권한을 추가합니다(아래).
   - 아이콘 생성: `outline.png`(32x32) 및 `color.png`(192x192).
   - 세 개의 파일을 모두 함께 압축합니다: `manifest.json`, `outline.png`, `color.png`.

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

   구성 키 대신 환경 변수를 사용할 수도 있습니다.
   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **봇 엔드포인트**
   - Azure Bot 메시징 끝점을 다음으로 설정합니다.
     - `https://<host>:3978/api/messages` (또는 선택한 경로/포트).

6. **게이트웨이 실행**
   - 플러그인이 설치되고 `msteams` 구성이 자격 증명과 함께 존재하면 Teams 채널이 자동으로 시작됩니다.

## 역사 맥락

- `channels.msteams.historyLimit`는 프롬프트에 래핑되는 최근 채널/그룹 메시지 수를 제어합니다.
- `messages.groupChat.historyLimit`로 돌아갑니다. `0`를 비활성화로 설정합니다(기본값 50).
- DM 내역은 `channels.msteams.dmHistoryLimit`(사용자 차례)로 제한할 수 있습니다. 사용자별 재정의: `channels.msteams.dms["<user_id>"].historyLimit`.

## 현재 팀 RSC 권한(매니페스트)

이는 Teams 앱 매니페스트의 **기존 리소스별 권한**입니다. 앱이 설치된 팀/채팅 내부에만 적용됩니다.

**채널(팀 범위)의 경우:**

- `ChannelMessage.Read.Group` (어플리케이션) - @멘션 없이 모든 채널 메시지 수신
- `ChannelMessage.Send.Group` (응용프로그램)
- `Member.Read.Group` (응용프로그램)
- `Owner.Read.Group` (응용프로그램)
- `ChannelSettings.Read.Group` (응용프로그램)
- `TeamMember.Read.Group` (응용프로그램)
- `TeamSettings.Read.Group` (응용프로그램)

**그룹 채팅의 경우:**

- `ChatMessage.Read.Chat` (어플리케이션) - @멘션 없이 모든 그룹 채팅 메시지를 받습니다.

## 팀 매니페스트 예시(수정됨)

필수 필드가 포함된 최소한의 유효한 예입니다. ID와 URL을 바꿉니다.

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

### 매니페스트 주의 사항(필수 필드)

- `bots[].botId` **반드시** Azure Bot App ID와 일치해야 합니다.
- `webApplicationInfo.id` **반드시** Azure Bot App ID와 일치해야 합니다.
- `bots[].scopes`에는 사용하려는 표면이 포함되어야 합니다(`personal`, `team`, `groupChat`).
- 개인 범위에서 파일을 처리하려면 `bots[].supportsFiles: true`가 필요합니다.
- `authorization.permissions.resourceSpecific` 채널 트래픽을 원할 경우 채널 읽기/전송을 포함해야 합니다.

### 기존 앱 업데이트

이미 설치된 Teams 앱을 업데이트하려면(예: RSC 권한 추가):

1. `manifest.json`을 새로운 설정으로 업데이트하세요
2. **`version` 필드를 증가시킵니다** (예: `1.0.0` → `1.1.0`)
3. 아이콘(`manifest.json`, `outline.png`, `color.png`)이 포함된 매니페스트를 **다시 압축**합니다.
4. 새 zip을 업로드합니다.
   - **옵션 A(팀 관리 센터):** 팀 관리 센터 → 팀 앱 → 앱 관리 → 앱 찾기 → 새 버전 업로드
   - **옵션 B(사이드로드):** Teams → 앱 → 앱 관리 → 맞춤형 앱 업로드
5. **팀 채널의 경우:** 새 권한을 적용하려면 각 팀에 앱을 다시 설치하세요.
6. 캐시된 앱 메타데이터를 지우려면 **Teams를 완전히 종료하고 다시 시작**(창만 닫는 것이 아님)

## 기능: RSC만 vs 그래프

### **Teams RSC만** 사용(앱 설치, Graph API 권한 없음)

작품:

- 채널 메시지 **텍스트** 내용을 읽어보세요.
- 채널 메시지 **텍스트** 내용을 보냅니다.
- **개인(DM)** 첨부파일을 받습니다.

작동하지 않습니다:

- 채널/그룹 **이미지 또는 파일 콘텐츠**(페이로드에는 HTML 스텁만 포함됨).
- SharePoint/OneDrive에 저장된 첨부 파일을 다운로드합니다.
- 메시지 기록 읽기(라이브 웹훅 이벤트 이후)

### **Teams RSC + Microsoft Graph 응용 프로그램 권한** 포함

추가:

- 호스팅된 콘텐츠(메시지에 붙여넣은 이미지) 다운로드.
- SharePoint/OneDrive에 저장된 첨부 파일을 다운로드합니다.
- 그래프를 통해 채널/채팅 메시지 기록을 읽어옵니다.

### RSC 대 그래프 API

| 능력                  | RSC 권한                 | 그래프 API                   |
| --------------------- | ------------------------ | ---------------------------- |
| **실시간 메시지**     | 예(웹훅을 통해)          | 아니요(폴링에만 해당)        |
| **역사적 메시지**     | 아니요                   | 예(기록 쿼리 가능)           |
| **설정 복잡성**       | 앱 매니페스트만          | 관리자 동의 + 토큰 흐름 필요 |
| **오프라인으로 작동** | 아니요(실행 중이어야 함) | 예(언제든지 문의 가능)       |

**요점:** RSC는 실시간 청취를 위한 것입니다. 그래프 API는 기록 액세스를 위한 것입니다. 오프라인 상태에서 놓친 메시지를 확인하려면 `ChannelMessage.Read.All`를 사용하는 Graph API가 필요합니다(관리자 동의 필요).

## 그래프 지원 미디어 + 기록(채널에 필요)

**채널**에 이미지/파일이 필요하거나 **메시지 기록**을 가져오려면 Microsoft Graph 권한을 활성화하고 관리자 동의를 부여해야 합니다.

1. Entra ID(Azure AD) **앱 등록**에서 Microsoft Graph **애플리케이션 권한**을 추가합니다.
   - `ChannelMessage.Read.All` (채널 첨부 파일 + 기록)
   - `Chat.Read.All` 또는 `ChatMessage.Read.All` (그룹 채팅)
2. 테넌트에 대한 **관리자 동의**를 부여합니다.
3. Teams 앱 **매니페스트 버전**을 확인하고 다시 업로드한 다음 **Teams에 앱을 다시 설치**하세요.
4. **Teams를 완전히 종료하고 다시 시작**하여 캐시된 앱 메타데이터를 지웁니다.

## 알려진 제한 사항

### 웹훅 시간 초과

Teams는 HTTP 웹후크를 통해 메시지를 전달합니다. 처리 시간이 너무 오래 걸리는 경우(예: 느린 LLM 응답) 다음이 표시될 수 있습니다.

- 게이트웨이 시간 초과
- 팀이 메시지를 재시도함(중복 발생)
- 답변이 삭제되었습니다.

OpenClaw는 신속하게 반환하고 적극적으로 응답을 보내 이를 처리하지만 매우 느린 응답은 여전히 문제를 일으킬 수 있습니다.

### 서식 지정

Teams 마크다운은 Slack이나 Discord보다 더 제한적입니다.

- 기본 서식 작동: **굵게**, _기울임꼴_, `code`, 링크
- 복잡한 마크다운(테이블, 중첩 목록)이 올바르게 렌더링되지 않을 수 있습니다.
- 폴링 및 임의 카드 전송에 적응형 카드가 지원됩니다(아래 참조).

## 구성

주요 설정(공유 채널 패턴은 `/gateway/configuration` 참조):

- `channels.msteams.enabled`: 채널을 활성화/비활성화합니다.
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: 봇 자격 증명.
- `channels.msteams.webhook.port` (기본값 `3978`)
- `channels.msteams.webhook.path` (기본값 `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (기본값: 페어링)
- `channels.msteams.allowFrom`: DM(AAD 개체 ID, UPN 또는 표시 이름)에 대한 허용 목록입니다. 마법사는 그래프 액세스가 가능할 때 설정 중에 이름을 ID로 확인합니다.
- `channels.msteams.textChunkLimit`: 아웃바운드 텍스트 청크 크기.
- `channels.msteams.chunkMode`: `length` (기본값) 또는 `newline` 길이 청크 전에 빈 줄(단락 경계)로 분할합니다.
- `channels.msteams.mediaAllowHosts`: 인바운드 첨부 파일 호스트에 대한 허용 목록(기본값은 Microsoft/Teams 도메인).
- `channels.msteams.mediaAuthAllowHosts`: 미디어 재시도 시 인증 헤더를 첨부하기 위한 허용 목록(기본값은 Graph + Bot Framework 호스트).
- `channels.msteams.requireMention`: 채널/그룹에 @멘션이 필요합니다(기본값은 true).
- `channels.msteams.replyStyle`: `thread | top-level` ([답글 스타일](#reply-style-threads-vs-posts) 참조).
- `channels.msteams.teams.<teamId>.replyStyle`: 팀별 재정의.
- `channels.msteams.teams.<teamId>.requireMention`: 팀별 재정의.
- `channels.msteams.teams.<teamId>.tools`: 채널 재정의가 누락된 경우 사용되는 기본 팀별 도구 정책 재정의(`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.toolsBySender`: 기본 팀별 발신자별 도구 정책 재정의(`"*"` 와일드카드 지원).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: 채널별 재정의.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: 채널별 재정의.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: 채널별 도구 정책을 재정의합니다(`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: 채널별 발신자별 도구 정책 재정의(`"*"` 와일드카드 지원).
- `channels.msteams.sharePointSiteId`: 그룹 채팅/채널에서 파일 업로드를 위한 SharePoint 사이트 ID([그룹 채팅에서 파일 보내기](#sending-files-in-group-chats) 참조).

## 라우팅 및 세션

- 세션 키는 표준 에이전트 형식을 따릅니다([/concepts/session](/concepts/session) 참조).
  - 다이렉트 메시지는 기본 세션(`agent:<agentId>:<mainKey>`)을 공유합니다.
  - 채널/그룹 메시지는 대화 ID를 사용합니다:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## 응답 스타일: 스레드와 게시물

Teams는 최근 동일한 기본 데이터 모델에 대해 두 가지 채널 UI 스타일을 도입했습니다.

| 스타일                 | 설명                                                                    | 추천 `replyStyle` |
| ---------------------- | ----------------------------------------------------------------------- | ----------------- |
| **게시물**(클래식)     | 메시지는 아래에 스레드 답글이 있는 카드로 표시됩니다. `thread` (기본값) |
| **스레드**(Slack 유사) | 메시지는 Slack                                                          | `top-level`       |

**문제:** Teams API는 채널이 사용하는 UI 스타일을 노출하지 않습니다. 잘못된 `replyStyle`를 사용하는 경우:

- `thread` Threads 스타일 채널 → 답변이 어색하게 중첩되어 나타남
- 게시물 스타일 채널의 `top-level` → 답변이 스레드 내가 아닌 별도의 최상위 게시물로 표시됩니다.

**해결책:** 채널 설정 방법에 따라 채널별로 `replyStyle`를 구성합니다.

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

**현재 제한사항:**

- **DM:** 이미지와 첨부 파일은 Teams 봇 파일 API를 통해 작동합니다.
- **채널/그룹:** 첨부 파일은 M365 저장소(SharePoint/OneDrive)에 있습니다. 웹훅 페이로드에는 실제 파일 바이트가 아닌 HTML 스텁만 포함됩니다. 채널 첨부파일을 다운로드하려면 **그래프 API 권한이 필요합니다**.

그래프 권한이 없으면 이미지가 포함된 채널 메시지가 텍스트로만 수신됩니다(봇이 이미지 콘텐츠에 액세스할 수 없음).
기본적으로 OpenClaw는 Microsoft/Teams 호스트 이름에서만 미디어를 다운로드합니다. `channels.msteams.mediaAllowHosts`로 재정의합니다(모든 호스트를 허용하려면 `["*"]` 사용).
인증 헤더는 `channels.msteams.mediaAuthAllowHosts`의 호스트에만 첨부됩니다(기본값은 Graph + Bot Framework 호스트). 이 목록을 엄격하게 유지하세요(다중 테넌트 접미사 방지).

## 그룹 채팅에서 파일 보내기

봇은 FileConsentCard 흐름(내장)을 사용하여 DM으로 파일을 보낼 수 있습니다. 그러나 **그룹 채팅/채널에서 파일을 전송**하려면 추가 설정이 필요합니다.

| 컨텍스트                  | 파일 전송 방법                            | 설정 필요                             |
| ------------------------- | ----------------------------------------- | ------------------------------------- |
| **DM**                    | FileConsentCard → 사용자 수락 → 봇 업로드 | 즉시 사용 가능                        |
| **그룹 채팅/채널**        | SharePoint에 업로드 → 링크 공유           | `sharePointSiteId` + 그래프 권한 필요 |
| **이미지(모든 컨텍스트)** | Base64로 인코딩된 인라인                  | 즉시 사용 가능                        |

### 그룹 채팅에 SharePoint가 필요한 이유

봇에는 개인 OneDrive 드라이브가 없습니다(`/me/drive` 그래프 API 엔드포인트는 애플리케이션 ID에 대해 작동하지 않습니다). 그룹 채팅/채널에서 파일을 보내기 위해 봇은 **SharePoint 사이트**에 업로드하고 공유 링크를 생성합니다.

### 설정

1. Entra ID(Azure AD) → 앱 등록에서 **Graph API 권한 추가**:
   - `Sites.ReadWrite.All` (응용 프로그램) - SharePoint에 파일 업로드
   - `Chat.Read.All` (애플리케이션) - 선택 사항, 사용자별 공유 링크 활성화

2. 테넌트에 대한 **관리자 동의**를 부여합니다.

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

### 공유 행동

| 허가                                    | 공유행동                                        |
| --------------------------------------- | ----------------------------------------------- |
| `Sites.ReadWrite.All` 전용              | 조직 전체 공유 링크(조직 내 누구나 액세스 가능) |
| `Sites.ReadWrite.All` + `Chat.Read.All` | 사용자별 공유링크(채팅회원만 접속 가능)         |

채팅 참가자만 파일에 액세스할 수 있으므로 사용자별 공유가 더욱 안전합니다. `Chat.Read.All` 권한이 없으면 봇은 조직 전체 공유로 대체됩니다.

### 대체 동작

| 시나리오                                     | 결과                                                  |
| -------------------------------------------- | ----------------------------------------------------- |
| 그룹채팅 + 파일 + `sharePointSiteId` 구성    | SharePoint에 업로드, 공유 링크 보내기                 |
| 그룹 채팅 + 파일 + 아니요 `sharePointSiteId` | OneDrive 업로드 시도(실패할 수 있음), 텍스트만 보내기 |
| 개인채팅 + 파일                              | FileConsentCard 흐름(SharePoint 없이 작동)            |
| 모든 컨텍스트 + 이미지                       | Base64로 인코딩된 인라인(SharePoint 없이 작동)        |

### 파일 저장 위치

업로드된 파일은 구성된 SharePoint 사이트의 기본 문서 라이브러리에 있는 `/OpenClawShared/` 폴더에 저장됩니다.

## 설문조사(적응형 카드)

OpenClaw는 Teams 설문조사를 적응형 카드로 보냅니다(기본 Teams 설문조사 API는 없음).

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- 투표는 `~/.openclaw/msteams-polls.json`의 게이트웨이에 의해 기록됩니다.
- 투표를 기록하려면 게이트웨이가 온라인 상태를 유지해야 합니다.
- 설문조사는 아직 결과 요약을 자동으로 게시하지 않습니다(필요한 경우 저장 파일을 검사하세요).

## 적응형 카드(임의)

`message` 도구 또는 CLI를 사용하여 적응형 카드 JSON을 Teams 사용자 또는 대화에 보냅니다.

`card` 매개변수는 적응형 카드 JSON 개체를 허용합니다. `card`가 제공되면 메시지 텍스트는 선택 사항입니다.

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

카드 스키마 및 예시는 [적응형 카드 문서](https://adaptivecards.io/)를 참조하세요. 대상 형식에 대한 자세한 내용은 아래 [대상 형식](#target-formats)을 참조하세요.

## 대상 형식

MSTeams 대상은 접두사를 사용하여 사용자와 대화를 구별합니다.

| 대상 유형       | 형식                             | 예                                                      |
| --------------- | -------------------------------- | ------------------------------------------------------- |
| 사용자(ID별)    | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`             |
| 사용자(이름별)  | `user:<display-name>`            | `user:John Smith` (그래프 API 필요)                     |
| 그룹/채널       | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`                |
| 그룹/채널(원시) | `<conversation-id>`              | `19:abc123...@thread.tacv2` (`@thread`를 포함하는 경우) |

**CLI 예:**

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

**에이전트 도구 예:**

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

참고: `user:` 접두사가 없으면 이름은 기본적으로 그룹/팀 확인으로 지정됩니다. 표시 이름으로 사람을 타겟팅할 때는 항상 `user:`를 사용하세요.

## 사전 예방적 메시지

- 대화 참조는 해당 시점에 저장되므로 사전 대응 메시지는 사용자가 상호작용한 **후**에만 가능합니다.
- `dmPolicy` 및 허용 목록 게이팅에 대해서는 `/gateway/configuration`를 참조하세요.

## 팀 및 채널 ID(공통 사항)

Teams URL의 `groupId` 쿼리 매개변수는 구성에 사용되는 팀 ID가 **아닙니다**. 대신 URL 경로에서 ID를 추출하세요.

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

**구성의 경우:**

- 팀 ID = `/team/` 뒤의 경로 세그먼트(URL로 디코딩됨, 예: `19:Bk4j...@thread.tacv2`)
- 채널 ID = `/channel/` 뒤의 경로 세그먼트(URL 디코딩됨)
- `groupId` 쿼리 매개변수 **무시**

## 비공개 채널

봇은 비공개 채널에서 제한적으로 지원됩니다.

| 기능                | 표준 채널 | 비공개 채널                |
| ------------------- | --------- | -------------------------- |
| 봇 설치             | 예        | 한정                       |
| 실시간 메시지(웹훅) | 예        | 작동하지 않을 수 있음      |
| RSC 권한            | 예        | 다르게 동작할 수 있음      |
| @멘션               | 예        | 봇에 액세스할 수 있는 경우 |
| 그래프 API 기록     | 예        | 예(권한 있음)              |

**비공개 채널이 작동하지 않는 경우 해결 방법:**

1. 봇 상호작용에 표준 채널을 사용하세요.
2. DM 사용 - 사용자는 언제든지 봇에게 직접 메시지를 보낼 수 있습니다.
3. 기록 액세스를 위해 그래프 API를 사용합니다(`ChannelMessage.Read.All` 필요).

## 문제 해결

### 일반적인 문제

- **채널에 이미지가 표시되지 않음:** 그래프 권한 또는 관리자 동의가 누락되었습니다. Teams 앱을 다시 설치하고 Teams를 완전히 종료하거나 다시 엽니다.
- **채널에 응답 없음:** 기본적으로 멘션이 필요합니다. `channels.msteams.requireMention=false`를 설정하거나 팀/채널별로 구성하세요.
- **버전 불일치(Teams는 여전히 이전 매니페스트를 표시함):** 앱을 제거하고 다시 추가한 다음 Teams를 완전히 종료하여 새로 고칩니다.
- **401 웹후크에서 인증되지 않음:** Azure JWT 없이 수동으로 테스트할 때 예상됩니다. - 엔드포인트에 연결할 수 있지만 인증에 실패했음을 의미합니다. Azure 웹 채팅을 사용하여 올바르게 테스트하세요.

### 매니페스트 업로드 오류

- **"아이콘 파일은 비워둘 수 없습니다.":** 매니페스트는 0바이트인 아이콘 파일을 참조합니다. 유효한 PNG 아이콘을 만듭니다(`outline.png`의 경우 32x32, `color.png`의 경우 192x192).
- **"webApplicationInfo.Id 이미 사용 중":** 앱이 아직 다른 팀/채팅에 설치되어 있습니다. 먼저 찾아서 제거하거나 전파될 때까지 5~10분 정도 기다리세요.
- **업로드 시 "문제가 발생했습니다.":** 대신 [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com)을 통해 업로드하고 브라우저 DevTools(F12) → 네트워크 탭을 열고 응답 본문에서 실제 오류를 확인하세요.
- **사이드로드 실패:** "사용자 정의 앱 업로드" 대신 "조직의 앱 카탈로그에 앱 업로드"를 시도하십시오. 이는 종종 사이드로드 제한을 우회합니다.

### RSC 권한이 작동하지 않습니다.

1. `webApplicationInfo.id`가 봇의 앱 ID와 정확히 일치하는지 확인하세요.
2. 앱을 다시 업로드하고 팀/채팅에 다시 설치하세요.
3. 조직 관리자가 RSC 권한을 차단했는지 확인하세요.
4. 올바른 범위를 사용하고 있는지 확인하세요: 팀의 경우 `ChannelMessage.Read.Group`, 그룹 채팅의 경우 `ChatMessage.Read.Chat`

## 참고자료

- [Azure Bot 생성](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - Azure Bot 설정 가이드
- [Teams 개발자 포털](https://dev.teams.microsoft.com/apps) - Teams 앱 생성/관리
- [Teams 앱 매니페스트 스키마](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [RSC로 채널 메시지 수신](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC 권한 참조](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams 봇 파일 처리](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (채널/그룹에는 Graph 필요)
- [사전 메시지](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
