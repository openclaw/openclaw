---
summary: "Feishu 봇 개요, 기능 및 설정"
read_when:
  - Feishu/Lark 봇을 연결하려고 할 때
  - Feishu 채널을 설정 중일 때
title: Feishu
---

# Feishu 봇

Feishu (Lark)는 기업에서 메시징 및 협업을 위해 사용하는 팀 채팅 플랫폼입니다. 이 플러그인은 공개 웹훅 URL을 노출하지 않고 메시지를 받을 수 있도록 플랫폼의 WebSocket 이벤트 구독을 사용하여 OpenClaw를 Feishu/Lark 봇에 연결합니다.

---

## 필요 플러그인

Feishu 플러그인 설치:

```bash
openclaw plugins install @openclaw/feishu
```

로컬 체크아웃 (git repo 에서 실행하는 경우):

```bash
openclaw plugins install ./extensions/feishu
```

---

## 빠른 시작

Feishu 채널을 추가하는 방법은 두 가지입니다:

### 방법 1: 온보딩 마법사 (권장)

OpenClaw를 방금 설치했다면 마법사를 실행하세요:

```bash
openclaw onboard
```

마법사는 다음 단계를 안내합니다:

1. Feishu 앱 생성 및 자격 증명 수집
2. OpenClaw에 앱 자격 증명 구성
3. 게이트웨이 시작

✅ **구성 후**, 게이트웨이 상태 확인:

- `openclaw gateway status`
- `openclaw logs --follow`

### 방법 2: CLI 설정

초기 설치를 이미 완료한 경우, CLI를 통해 채널 추가:

```bash
openclaw channels add
```

**Feishu**를 선택하고, App ID 및 App Secret을 입력하세요.

✅ **구성 후**, 게이트웨이 관리:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## 1단계: Feishu 앱 생성

### 1. Feishu Open Platform 열기

[Feishu Open Platform](https://open.feishu.cn/app)에 방문하여 로그인하세요.

Lark (글로벌) 테넌트는 [https://open.larksuite.com/app](https://open.larksuite.com/app)을 사용하고 Feishu 설정에서 `domain: "lark"`로 설정해야 합니다.

### 2. 앱 생성

1. **기업용 앱 만들기** 클릭
2. 앱 이름과 설명 입력
3. 앱 아이콘 선택

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. 자격 증명 복사

**자격 증명 및 기본 정보**에서 다음을 복사하세요:

- **App ID** (형식: `cli_xxx`)
- **App Secret**

❗ **중요:** App Secret을 비공개로 유지하세요.

![Get credentials](../images/feishu-step3-credentials.png)

### 4. 권한 설정

**권한**에서 **일괄 가져오기** 클릭 후 붙여넣기:

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

**앱 기능** > **봇**에서:

1. 봇 기능 활성화
2. 봇 이름 설정

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. 이벤트 구독 설정

⚠️ **중요:** 이벤트 구독을 설정하기 전에 다음을 확인하세요:

1. 이미 `openclaw channels add`로 Feishu 채널을 추가했는지 확인
2. 게이트웨이가 실행 중인지 확인 (`openclaw gateway status`)

**이벤트 구독**에서:

1. **이벤트 수신을 위한 장기 연결 사용** 선택 (WebSocket)
2. 이벤트 추가: `im.message.receive_v1`

⚠️ 게이트웨이가 실행 중이 아니면 장기 연결 설정이 저장되지 않을 수 있습니다.

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. 앱 퍼블리시

1. **버전 관리 및 릴리스**에서 버전 생성
2. 검토를 위해 제출하고 퍼블리시
3. 관리자 승인을 기다림 (기업 앱은 보통 자동 승인됨)

---

## 2단계: OpenClaw 설정

### 마법사를 사용한 설정 (권장)

```bash
openclaw channels add
```

**Feishu**를 선택하고, App ID 및 App Secret을 붙여넣기.

### 설정 파일을 통한 구성

`~/.openclaw/openclaw.json` 편집:

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

`connectionMode: "webhook"`을 사용하는 경우 `verificationToken`을 설정하세요. Feishu 웹훅 서버는 기본적으로 `127.0.0.1`에 바인딩됩니다; 다른 바인드 주소가 의도적으로 필요한 경우에만 `webhookHost`를 설정하세요.

### 환경 변수를 통한 구성

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Lark (글로벌) 도메인

테넌트가 Lark (국제)에 있다면 `lark` (또는 전체 도메인 문자열)으로 도메인을 설정하세요. `channels.feishu.domain` 또는 계정별로 설정할 수 있습니다 (`channels.feishu.accounts.<id>.domain`).

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

### 1. 게이트웨이 시작

```bash
openclaw gateway
```

### 2. 테스트 메시지 보내기

Feishu에서 봇을 찾아 메시지를 보내세요.

### 3. 페어링 승인

기본적으로 봇이 페어링 코드를 답장으로 보냅니다. 이를 승인하세요:

```bash
openclaw pairing approve feishu <CODE>
```

승인 후 정상적으로 채팅이 가능합니다.

---

## 개요

- **Feishu 봇 채널**: 게이트웨이에서 관리하는 Feishu 봇
- **결정론적 라우팅**: 항상 Feishu로 돌아가는 응답
- **세션 격리**: 다이렉트 메시지는 메인 세션을 공유하며, 그룹은 격리됨
- **WebSocket 연결**: Feishu SDK를 통한 장기 연결, 공개 URL 불필요

---

## 접근 제어

### 다이렉트 메시지

- **기본값**: `dmPolicy: "pairing"` (알 수 없는 사용자는 페어링 코드를 받음)
- **페어링 승인**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **허용 목록 모드**: `channels.feishu.allowFrom`에 허용된 Open ID 설정

### 그룹 채팅

**1. 그룹 정책** (`channels.feishu.groupPolicy`):

- `"open"` = 그룹의 모든 사람 허용 (기본값)
- `"allowlist"` = `groupAllowFrom`만 허용
- `"disabled"` = 그룹 메시지 비활성화

**2. 언급 요구 사항** (`channels.feishu.groups.<chat_id>.requireMention`):

- `true` = @mention 필요 (기본값)
- `false` = 별도 언급 없이 응답

---

## 그룹 설정 예제

### 모든 그룹 허용, @mention 필요 (기본값)

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // 기본값 requireMention: true
    },
  },
}
```

### 모든 그룹 허용, @mention 불필요

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

### 특정 사용자만 그룹에서 허용

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

그룹 ID는 `oc_xxx` 형식입니다.

**방법 1 (권장)**

1. 게이트웨이를 시작하고 그룹에서 봇을 @mention
2. `openclaw logs --follow`를 실행하고 `chat_id`를 찾으세요

**방법 2**

Feishu API 디버거를 사용하여 그룹 채팅 목록을 확인

### 사용자 ID (open_id)

사용자 ID는 `ou_xxx` 형식입니다.

**방법 1 (권장)**

1. 게이트웨이를 시작하고 봇에 다이렉트 메시지 전송
2. `openclaw logs --follow`를 실행하고 `open_id`를 찾으세요

**방법 2**

사용자 Open ID에 대한 페어링 요청 확인:

```bash
openclaw pairing list feishu
```

---

## 일반 명령어

| Command   | Description        |
| --------- | ------------------ |
| `/status` | 봇 상태 표시하기   |
| `/reset`  | 세션 재설정        |
| `/model`  | 모델 표시/전환하기 |

> 참고: Feishu는 아직 네이티브 명령어 메뉴를 지원하지 않으므로 명령어는 텍스트로 전송해야 합니다.

## 게이트웨이 관리 명령어

| Command                    | Description                 |
| -------------------------- | --------------------------- |
| `openclaw gateway status`  | 게이트웨이 상태 표시        |
| `openclaw gateway install` | 게이트웨이 서비스 설치/시작 |
| `openclaw gateway stop`    | 게이트웨이 서비스 중지      |
| `openclaw gateway restart` | 게이트웨이 서비스 재시작    |
| `openclaw logs --follow`   | 게이트웨이 로그 조회        |

---

## 문제 해결

### 봇이 그룹 채팅에서 응답하지 않음

1. 봇이 그룹에 추가되었는지 확인
2. 기본 동작으로 봇을 @mention 하는지 확인
3. `groupPolicy`가 `"disabled"`로 설정되지 않았는지 확인
4. 로그 확인: `openclaw logs --follow`

### 봇이 메시지를 수신하지 않음

1. 앱이 게시되고 승인되었는지 확인
2. 이벤트 구독에 `im.message.receive_v1`이 포함되어 있는지 확인
3. **장기 연결**이 활성화되었는지 확인
4. 앱 권한이 모두 완료되었는지 확인
5. 게이트웨이가 실행 중인지 확인: `openclaw gateway status`
6. 로그 확인: `openclaw logs --follow`

### App Secret 유출

1. Feishu Open Platform에서 App Secret 재설정
2. 설정에서 App Secret 업데이트
3. 게이트웨이 재시작

### 메시지 전송 실패

1. 앱이 `im:message:send_as_bot` 권한을 가지고 있는지 확인
2. 앱이 게시되었는지 확인
3. 자세한 오류는 로그 확인

---

## 고급 설정

### 다중 계정

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

- `textChunkLimit`: 출력 텍스트 청크 크기 (기본값: 2000 문자)
- `mediaMaxMb`: 미디어 업로드/다운로드 제한 (기본값: 30MB)

### 스트리밍

Feishu는 스트리밍 답장을 인터랙티브 카드로 지원합니다. 활성화되면 봇은 텍스트를 생성하는 동안 카드를 업데이트합니다.

```json5
{
  channels: {
    feishu: {
      streaming: true, // 스트리밍 카드 출력 활성화 (기본값 true)
      blockStreaming: true, // 블록 수준 스트리밍 활성화 (기본값 true)
    },
  },
}
```

`streaming: false`로 설정하면 전체 답장을 보내기 전에 대기합니다.

### 다중 에이전트 라우팅

`bindings`을 사용하여 Feishu 다이렉트 메시지 또는 그룹을 다른 에이전트에 라우팅할 수 있습니다.

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
        peer: { kind: "direct", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "direct", id: "ou_yyy" },
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
- `match.peer.kind`: `"direct"` 또는 `"group"`
- `match.peer.id`: 사용자 Open ID (`ou_xxx`) 또는 그룹 ID (`oc_xxx`)

조회 팁은 [그룹/사용자 ID 가져오기](#get-groupuser-ids)를 참조하세요.

---

## 설정 참조

전체 설정: [게이트웨이 설정](/ko-KR/gateway/configuration)

주요 옵션:

| Setting                                           | Description                       | Default          |
| ------------------------------------------------- | --------------------------------- | ---------------- |
| `channels.feishu.enabled`                         | 채널 활성화/비활성화              | `true`           |
| `channels.feishu.domain`                          | API 도메인 (`feishu` 또는 `lark`) | `feishu`         |
| `channels.feishu.connectionMode`                  | 이벤트 전송 모드                  | `websocket`      |
| `channels.feishu.verificationToken`               | 웹훅 모드에서 필수                | -                |
| `channels.feishu.webhookPath`                     | 웹훅 경로                         | `/feishu/events` |
| `channels.feishu.webhookHost`                     | 웹훅 바인드 호스트                | `127.0.0.1`      |
| `channels.feishu.webhookPort`                     | 웹훅 바인드 포트                  | `3000`           |
| `channels.feishu.accounts.<id>.appId`             | App ID                            | -                |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                        | -                |
| `channels.feishu.accounts.<id>.domain`            | 계정별 API 도메인 덮어쓰기 설정   | `feishu`         |
| `channels.feishu.dmPolicy`                        | DM 정책                           | `pairing`        |
| `channels.feishu.allowFrom`                       | DM 허용목록 (open_id 목록)        | -                |
| `channels.feishu.groupPolicy`                     | 그룹 정책                         | `open`           |
| `channels.feishu.groupAllowFrom`                  | 그룹 허용 목록                    | -                |
| `channels.feishu.groups.<chat_id>.requireMention` | @mention 요구                     | `true`           |
| `channels.feishu.groups.<chat_id>.enabled`        | 그룹 활성화                       | `true`           |
| `channels.feishu.textChunkLimit`                  | 메시지 청크 크기                  | `2000`           |
| `channels.feishu.mediaMaxMb`                      | 미디어 크기 제한                  | `30`             |
| `channels.feishu.streaming`                       | 스트리밍 카드 출력 활성화         | `true`           |
| `channels.feishu.blockStreaming`                  | 블록 스트리밍 활성화              | `true`           |

---

## dmPolicy 참조

| Value         | Behavior                                                    |
| ------------- | ----------------------------------------------------------- |
| `"pairing"`   | **기본값.** 알 수 없는 사용자는 페어링 코드 받음; 승인 필요 |
| `"allowlist"` | `allowFrom`에 있는 사용자만 채팅 가능                       |
| `"open"`      | 모든 사용자 채팅 허용 (`allowFrom`에 `"*"` 필요)            |
| `"disabled"`  | DM 비활성화                                                 |

---

## 지원 메시지 유형

### 수신

- ✅ 문서
- ✅ 리치 텍스트 (포스트)
- ✅ 이미지
- ✅ 파일
- ✅ 오디오
- ✅ 비디오
- ✅ 스티커

### 송신

- ✅ 문서
- ✅ 이미지
- ✅ 파일
- ✅ 오디오
- ⚠️ 리치 텍스트 (일부 지원)
