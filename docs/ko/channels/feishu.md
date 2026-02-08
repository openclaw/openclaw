---
summary: "Feishu 봇 개요, 기능 및 구성"
read_when:
  - Feishu/Lark 봇을 연결하려는 경우
  - Feishu 채널을 구성하는 경우
title: Feishu
x-i18n:
  source_path: channels/feishu.md
  source_hash: c9349983562d1a98
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:24:08Z
---

# Feishu 봇

Feishu (Lark) 는 기업에서 메시징과 협업을 위해 사용하는 팀 채팅 플랫폼입니다. 이 플러그인은 플랫폼의 WebSocket 이벤트 구독을 사용하여 OpenClaw 를 Feishu/Lark 봇에 연결하므로, 공개 webhook URL 을 노출하지 않고도 메시지를 수신할 수 있습니다.

---

## 필요한 플러그인

Feishu 플러그인을 설치합니다:

```bash
openclaw plugins install @openclaw/feishu
```

로컬 체크아웃 (git repo 에서 실행하는 경우):

```bash
openclaw plugins install ./extensions/feishu
```

---

## 빠른 시작

Feishu 채널을 추가하는 방법은 두 가지가 있습니다:

### 방법 1: 온보딩 마법사 (권장)

OpenClaw 를 방금 설치했다면 마법사를 실행합니다:

```bash
openclaw onboard
```

마법사는 다음 과정을 안내합니다:

1. Feishu 앱 생성 및 자격 증명 수집
2. OpenClaw 에 앱 자격 증명 구성
3. Gateway(게이트웨이) 시작

✅ **구성 후**, Gateway 상태를 확인합니다:

- `openclaw gateway status`
- `openclaw logs --follow`

### 방법 2: CLI 설정

이미 초기 설치를 완료했다면 CLI 를 통해 채널을 추가합니다:

```bash
openclaw channels add
```

**Feishu** 를 선택한 다음 App ID 와 App Secret 을 입력합니다.

✅ **구성 후**, Gateway 를 관리합니다:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## 1단계: Feishu 앱 생성

### 1. Feishu Open Platform 열기

[Feishu Open Platform](https://open.feishu.cn/app) 에 접속하여 로그인합니다.

Lark (글로벌) 테넌트는 [https://open.larksuite.com/app](https://open.larksuite.com/app) 을 사용하고 Feishu 설정에서 `domain: "lark"` 를 설정해야 합니다.

### 2. 앱 생성

1. **Create enterprise app** 을 클릭합니다
2. 앱 이름과 설명을 입력합니다
3. 앱 아이콘을 선택합니다

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. 자격 증명 복사

**Credentials & Basic Info** 에서 다음을 복사합니다:

- **App ID** (형식: `cli_xxx`)
- **App Secret**

❗ **중요:** App Secret 은 반드시 비공개로 유지하십시오.

![Get credentials](../images/feishu-step3-credentials.png)

### 4. 권한 구성

**Permissions** 에서 **Batch import** 를 클릭하고 다음을 붙여넣습니다:

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]
  }
}
```

![Configure permissions](../images/feishu-step4-permissions.png)

### 5. 봇 기능 활성화

**App Capability** > **Bot** 에서:

1. 봇 기능을 활성화합니다
2. 봇 이름을 설정합니다

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. 이벤트 구독 구성

⚠️ **중요:** 이벤트 구독을 설정하기 전에 다음을 확인하십시오:

1. Feishu 용 `openclaw channels add` 를 이미 실행했습니다
2. Gateway 가 실행 중입니다 (`openclaw gateway status`)

**Event Subscription** 에서:

1. **Use long connection to receive events** (WebSocket) 를 선택합니다
2. 이벤트를 추가합니다: `im.message.receive_v1`

⚠️ Gateway 가 실행 중이 아니면 long-connection 설정이 저장되지 않을 수 있습니다.

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. 앱 게시

1. **Version Management & Release** 에서 버전을 생성합니다
2. 심사를 제출하고 게시합니다
3. 관리자 승인을 기다립니다 (엔터프라이즈 앱은 보통 자동 승인됩니다)

---

## 2단계: OpenClaw 구성

### 마법사로 구성 (권장)

```bash
openclaw channels add
```

**Feishu** 를 선택하고 App ID 와 App Secret 을 붙여넣습니다.

### 구성 파일로 설정

`~/.openclaw/openclaw.json` 를 편집합니다:

```json5
{
  channels: {
    feishu: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "My AI assistant",
        },
      },
    },
  },
}
```

### 환경 변수로 구성

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Lark (글로벌) 도메인

테넌트가 Lark (국제) 인 경우 도메인을 `lark` (또는 전체 도메인 문자열) 로 설정하십시오. 이는 `channels.feishu.domain` 또는 계정별 (`channels.feishu.accounts.<id>.domain`) 로 설정할 수 있습니다.

```json5
{
  channels: {
    feishu: {
      domain: "lark",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
        },
      },
    },
  },
}
```

---

## 3단계: 시작 및 테스트

### 1. Gateway 시작

```bash
openclaw gateway
```

### 2. 테스트 메시지 전송

Feishu 에서 봇을 찾아 메시지를 전송합니다.

### 3. 페어링 승인

기본적으로 봇은 페어링 코드를 응답합니다. 이를 승인합니다:

```bash
openclaw pairing approve feishu <CODE>
```

승인 후 정상적으로 대화할 수 있습니다.

---

## 개요

- **Feishu 봇 채널**: Gateway 가 관리하는 Feishu 봇
- **결정적 라우팅**: 응답은 항상 Feishu 로 반환됩니다
- **세션 격리**: 다이렉트 메시지 는 메인 세션을 공유하며, 그룹은 서로 격리됩니다
- **WebSocket 연결**: Feishu SDK 를 통한 장기 연결, 공개 URL 불필요

---

## 접근 제어

### 다이렉트 메시지

- **기본값**: `dmPolicy: "pairing"` (알 수 없는 사용자는 페어링 코드를 받음)
- **페어링 승인**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **허용 목록 모드**: 허용된 Open ID 를 사용하여 `channels.feishu.allowFrom` 를 설정합니다

### 그룹 채팅

**1. 그룹 정책** (`channels.feishu.groupPolicy`):

- `"open"` = 그룹의 모든 사용자 허용 (기본값)
- `"allowlist"` = `groupAllowFrom` 만 허용
- `"disabled"` = 그룹 메시지 비활성화

**2. 멘션 요구 사항** (`channels.feishu.groups.<chat_id>.requireMention`):

- `true` = @멘션 필요 (기본값)
- `false` = 멘션 없이 응답

---

## 그룹 구성 예시

### 모든 그룹 허용, @멘션 필요 (기본값)

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // Default requireMention: true
    },
  },
}
```

### 모든 그룹 허용, @멘션 불필요

```json5
{
  channels: {
    feishu: {
      groups: {
        oc_xxx: { requireMention: false },
      },
    },
  },
}
```

### 그룹에서 특정 사용자만 허용

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["ou_xxx", "ou_yyy"],
    },
  },
}
```

---

## 그룹/사용자 ID 가져오기

### 그룹 ID (chat_id)

그룹 ID 는 `oc_xxx` 와 같은 형태입니다.

**방법 1 (권장)**

1. Gateway 를 시작하고 그룹에서 봇을 @멘션합니다
2. `openclaw logs --follow` 를 실행하고 `chat_id` 를 찾습니다

**방법 2**

Feishu API 디버거를 사용하여 그룹 채팅 목록을 조회합니다.

### 사용자 ID (open_id)

사용자 ID 는 `ou_xxx` 과 같은 형태입니다.

**방법 1 (권장)**

1. Gateway 를 시작하고 봇에게 다이렉트 메시지 를 보냅니다
2. `openclaw logs --follow` 를 실행하고 `open_id` 를 찾습니다

**방법 2**

페어링 요청에서 사용자 Open ID 를 확인합니다:

```bash
openclaw pairing list feishu
```

---

## 공통 명령어

| Command   | Description    |
| --------- | -------------- |
| `/status` | 봇 상태 표시   |
| `/reset`  | 세션 초기화    |
| `/model`  | 모델 표시/전환 |

> 참고: Feishu 는 아직 네이티브 명령 메뉴를 지원하지 않으므로, 명령은 텍스트로 전송해야 합니다.

## Gateway 관리 명령어

| Command                    | Description              |
| -------------------------- | ------------------------ |
| `openclaw gateway status`  | Gateway 상태 표시        |
| `openclaw gateway install` | Gateway 서비스 설치/시작 |
| `openclaw gateway stop`    | Gateway 서비스 중지      |
| `openclaw gateway restart` | Gateway 서비스 재시작    |
| `openclaw logs --follow`   | Gateway 로그 실시간 조회 |

---

## 문제 해결

### 그룹 채팅에서 봇이 응답하지 않는 경우

1. 봇이 그룹에 추가되어 있는지 확인합니다
2. 봇을 @멘션했는지 확인합니다 (기본 동작)
3. `groupPolicy` 가 `"disabled"` 로 설정되어 있지 않은지 확인합니다
4. 로그를 확인합니다: `openclaw logs --follow`

### 봇이 메시지를 수신하지 못하는 경우

1. 앱이 게시 및 승인되었는지 확인합니다
2. 이벤트 구독에 `im.message.receive_v1` 이 포함되어 있는지 확인합니다
3. **long connection** 이 활성화되어 있는지 확인합니다
4. 앱 권한이 완전한지 확인합니다
5. Gateway 가 실행 중인지 확인합니다: `openclaw gateway status`
6. 로그를 확인합니다: `openclaw logs --follow`

### App Secret 유출

1. Feishu Open Platform 에서 App Secret 을 재설정합니다
2. 구성에서 App Secret 을 업데이트합니다
3. Gateway 를 재시작합니다

### 메시지 전송 실패

1. 앱에 `im:message:send_as_bot` 권한이 있는지 확인합니다
2. 앱이 게시되었는지 확인합니다
3. 상세 오류를 위해 로그를 확인합니다

---

## 고급 구성

### 여러 계정

```json5
{
  channels: {
    feishu: {
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "Primary bot",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          botName: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

### 메시지 제한

- `textChunkLimit`: 발신 텍스트 청크 크기 (기본값: 2000자)
- `mediaMaxMb`: 미디어 업로드/다운로드 제한 (기본값: 30MB)

### 스트리밍

Feishu 는 인터랙티브 카드를 통한 스트리밍 응답을 지원합니다. 활성화하면 봇이 텍스트를 생성하는 동안 카드를 업데이트합니다.

```json5
{
  channels: {
    feishu: {
      streaming: true, // enable streaming card output (default true)
      blockStreaming: true, // enable block-level streaming (default true)
    },
  },
}
```

전체 응답을 받은 후 전송하려면 `streaming: false` 를 설정합니다.

### 멀티 에이전트 라우팅

`bindings` 를 사용하여 Feishu 다이렉트 메시지 또는 그룹을 서로 다른 에이전트로 라우팅합니다.

```json5
{
  agents: {
    list: [
      { id: "main" },
      {
        id: "clawd-fan",
        workspace: "/home/user/clawd-fan",
        agentDir: "/home/user/.openclaw/agents/clawd-fan/agent",
      },
      {
        id: "clawd-xi",
        workspace: "/home/user/clawd-xi",
        agentDir: "/home/user/.openclaw/agents/clawd-xi/agent",
      },
    ],
  },
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_yyy" },
      },
    },
    {
      agentId: "clawd-xi",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

라우팅 필드:

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"dm"` 또는 `"group"`
- `match.peer.id`: 사용자 Open ID (`ou_xxx`) 또는 그룹 ID (`oc_xxx`)

조회 팁은 [그룹/사용자 ID 가져오기](#get-groupuser-ids) 를 참고하십시오.

---

## 구성 참조

전체 구성: [Gateway configuration](/gateway/configuration)

주요 옵션:

| Setting                                           | Description                              | Default   |
| ------------------------------------------------- | ---------------------------------------- | --------- |
| `channels.feishu.enabled`                         | 채널 활성화/비활성화                     | `true`    |
| `channels.feishu.domain`                          | API 도메인 (`feishu` 또는 `lark`)        | `feishu`  |
| `channels.feishu.accounts.<id>.appId`             | App ID                                   | -         |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                               | -         |
| `channels.feishu.accounts.<id>.domain`            | 계정별 API 도메인 재정의                 | `feishu`  |
| `channels.feishu.dmPolicy`                        | 다이렉트 메시지 정책                     | `pairing` |
| `channels.feishu.allowFrom`                       | 다이렉트 메시지 허용 목록 (open_id 목록) | -         |
| `channels.feishu.groupPolicy`                     | 그룹 정책                                | `open`    |
| `channels.feishu.groupAllowFrom`                  | 그룹 허용 목록                           | -         |
| `channels.feishu.groups.<chat_id>.requireMention` | @멘션 필요                               | `true`    |
| `channels.feishu.groups.<chat_id>.enabled`        | 그룹 활성화                              | `true`    |
| `channels.feishu.textChunkLimit`                  | 메시지 청크 크기                         | `2000`    |
| `channels.feishu.mediaMaxMb`                      | 미디어 크기 제한                         | `30`      |
| `channels.feishu.streaming`                       | 스트리밍 카드 출력 활성화                | `true`    |
| `channels.feishu.blockStreaming`                  | 블록 스트리밍 활성화                     | `true`    |

---

## dmPolicy 참조

| Value         | Behavior                                                       |
| ------------- | -------------------------------------------------------------- |
| `"pairing"`   | **기본값.** 알 수 없는 사용자는 페어링 코드를 받으며 승인 필요 |
| `"allowlist"` | `allowFrom` 에 있는 사용자만 대화 가능                         |
| `"open"`      | 모든 사용자 허용 (`"*"` 이 allowFrom 에 필요)                  |
| `"disabled"`  | 다이렉트 메시지 비활성화                                       |

---

## 지원되는 메시지 유형

### 수신

- ✅ 텍스트
- ✅ 리치 텍스트 (post)
- ✅ 이미지
- ✅ 파일
- ✅ 오디오
- ✅ 비디오
- ✅ 스티커

### 발신

- ✅ 텍스트
- ✅ 이미지
- ✅ 파일
- ✅ 오디오
- ⚠️ 리치 텍스트 (부분 지원)
