---
summary: "Feishu bot overview, features, and configuration"
read_when:
  - You want to connect a Feishu/Lark bot
  - You are configuring the Feishu channel
title: Feishu
x-i18n:
  source_hash: 949120c506f41da1164b0732d18d894ee03a46ba0711581671d4f4e66b978e94
---

# 페이슈 봇

Feishu(Lark)는 회사에서 메시징 및 협업을 위해 사용하는 팀 채팅 플랫폼입니다. 이 플러그인은 플랫폼의 WebSocket 이벤트 구독을 사용하여 OpenClaw를 Feishu/Lark 봇에 연결하므로 공개 웹훅 URL을 노출하지 않고도 메시지를 수신할 수 있습니다.

---

## 플러그인이 필요합니다

Feishu 플러그인을 설치합니다:

```bash
openclaw plugins install @openclaw/feishu
```

로컬 체크아웃(git repo에서 실행하는 경우):

```bash
openclaw plugins install ./extensions/feishu
```

---

## 빠른 시작

Feishu 채널을 추가하는 방법에는 두 가지가 있습니다.

### 방법 1: 온보딩 마법사(권장)

방금 OpenClaw를 설치한 경우 마법사를 실행하세요.

```bash
openclaw onboard
```

마법사는 다음을 안내합니다.

1. Feishu 앱 생성 및 자격 증명 수집
2. OpenClaw에서 앱 자격 증명 구성
3. 게이트웨이 시작

✅ **구성 후** 게이트웨이 상태를 확인하세요.

- `openclaw gateway status`
- `openclaw logs --follow`

### 방법 2: CLI 설정

초기 설치를 이미 완료한 경우 CLI를 통해 채널을 추가하세요.

```bash
openclaw channels add
```

**Feishu**를 선택한 다음 앱 ID와 앱 비밀번호를 입력하세요.

✅ **구성 후** 게이트웨이를 관리하세요.

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## 1단계: Feishu 앱 만들기

### 1. Feishu 오픈 플랫폼을 오픈하세요

[Feishu 오픈 플랫폼](https://open.feishu.cn/app)을 방문하여 로그인하세요.

Lark(글로벌) 테넌트는 [https://open.larksuite.com/app](https://open.larksuite.com/app)을 사용하고 Feishu 구성에서 `domain: "lark"`를 설정해야 합니다.

### 2. 앱 만들기

1. **엔터프라이즈 앱 만들기**를 클릭합니다.
2. 앱 이름 + 설명을 입력하세요
3. 앱 아이콘을 선택하세요

![기업용 앱 만들기](../../images/feishu-step2-create-app.png)

### 3. 자격 증명 복사

**자격 증명 및 기본 정보**에서 다음을 복사하세요.

- **앱 ID**(형식: `cli_xxx`)
- **앱 비밀**

❗ **중요:** 앱 비밀번호를 비공개로 유지하세요.

![자격 증명 받기](../../images/feishu-step3-credentials.png)

### 4. 권한 구성

**권한**에서 **일괄 가져오기**를 클릭하고 다음을 붙여넣습니다.

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

![권한 구성](../../images/feishu-step4-permissions.png)

### 5. 봇 기능 활성화

**앱 기능** > **봇**에서:

1. 봇 기능 활성화
2. 봇 이름 설정

![봇 기능 활성화](../../images/feishu-step5-bot-capability.png)

### 6. 이벤트 구독 구성

⚠️ **중요:** 이벤트 구독을 설정하기 전에 다음을 확인하세요.

1. Feishu에 대해 이미 `openclaw channels add`를 실행했습니다.
2. 게이트웨이가 실행 중입니다. (`openclaw gateway status`)

**이벤트 구독**에서:

1. **긴 연결을 사용하여 이벤트 수신**(WebSocket)을 선택합니다.
2. 이벤트 추가: `im.message.receive_v1`

⚠️ 게이트웨이가 실행되지 않는 경우 장시간 연결 설정이 저장되지 않을 수 있습니다.

![이벤트 구독 구성](../../images/feishu-step6-event-subscription.png)

### 7. 앱 게시

1. **버전 관리 및 릴리스**에서 버전 생성
2. 검토를 위해 제출하고 게시합니다.
3. 관리자 승인을 기다립니다(기업 앱은 일반적으로 자동 승인).

---

## 2단계: OpenClaw 구성

### 마법사를 사용하여 구성(권장)

```bash
openclaw channels add
```

**Feishu**를 선택하고 앱 ID + 앱 비밀번호를 붙여넣습니다.

### 구성 파일을 통해 구성

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

### 환경 변수를 통해 구성

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Lark(글로벌) 도메인

테넌트가 Lark(국제)에 있는 경우 도메인을 `lark`(또는 전체 도메인 문자열)로 설정합니다. `channels.feishu.domain` 또는 계정별(`channels.feishu.accounts.<id>.domain`)로 설정할 수 있습니다.

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

## 3단계: 시작 + 테스트

### 1. 게이트웨이를 시작합니다

```bash
openclaw gateway
```

### 2. 테스트 메시지 보내기

Feishu에서 봇을 찾아 메시지를 보내세요.

### 3. 페어링 승인

기본적으로 봇은 페어링 코드로 응답합니다. 승인하세요:

```bash
openclaw pairing approve feishu <CODE>
```

승인 후 정상적으로 채팅이 가능합니다.

---

## 개요

- **Feishu 봇 채널**: 게이트웨이에서 관리하는 Feishu 봇
- **결정적 라우팅**: 응답은 항상 Feishu로 돌아갑니다.
- **세션 격리**: DM은 기본 세션을 공유합니다. 그룹은 고립되어 있다
- **WebSocket 연결**: Feishu SDK를 통한 긴 연결, 공개 URL이 필요하지 않음

---

## 접근 제어

### 다이렉트 메시지

- **기본값**: `dmPolicy: "pairing"` (알 수 없는 사용자가 페어링 코드를 받음)
- **페어링 승인**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **허용 목록 모드**: 허용된 Open ID로 `channels.feishu.allowFrom`를 설정합니다.

### 그룹 채팅

**1. 그룹 정책** (`channels.feishu.groupPolicy`):

- `"open"` = 그룹의 모든 사람을 허용합니다(기본값)
- `"allowlist"` = `groupAllowFrom`만 허용
- `"disabled"` = 그룹 메시지 비활성화

**2. 언급 요구사항** (`channels.feishu.groups.<chat_id>.requireMention`):

- `true` = @멘션 필요(기본값)
- `false` = 언급 없이 응답

---

## 그룹 구성 예

### 모든 그룹 허용, @멘션 필요(기본값)

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

### 모든 그룹 허용, @멘션 필요 없음

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

### 그룹의 특정 사용자만 허용

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

### 그룹 ID(chat_id)

그룹 ID는 `oc_xxx`와 같습니다.

**방법 1(권장)**

1. 게이트웨이를 시작하고 그룹에서 봇을 @멘션합니다.
2. `openclaw logs --follow`를 실행하고 `chat_id`를 찾습니다.

**방법 2**

Feishu API 디버거를 사용하여 그룹 채팅을 나열하세요.

### 사용자 ID(open_id)

사용자 ID는 `ou_xxx`와 같습니다.

**방법 1(권장)**

1. 게이트웨이를 시작하고 봇에게 DM 보내기
2. `openclaw logs --follow`를 실행하고 `open_id`를 찾습니다.

**방법 2**

사용자 Open ID에 대한 페어링 요청을 확인하세요.

```bash
openclaw pairing list feishu
```

---

## 일반적인 명령

| 명령      | 설명           |
| --------- | -------------- |
| `/status` | 봇 상태 표시   |
| `/reset`  | 세션 재설정    |
| `/model`  | 모델 표시/전환 |

> 참고: Feishu는 아직 기본 명령 메뉴를 지원하지 않으므로 명령을 텍스트로 전송해야 합니다.

## 게이트웨이 관리 명령어

| 명령                       | 설명                        |
| -------------------------- | --------------------------- |
| `openclaw gateway status`  | 게이트웨이 상태 표시        |
| `openclaw gateway install` | 게이트웨이 서비스 설치/시작 |
| `openclaw gateway stop`    | 게이트웨이 서비스 중지      |
| `openclaw gateway restart` | 게이트웨이 서비스 다시 시작 |
| `openclaw logs --follow`   | Tail 게이트웨이 로그        |

---

## 문제 해결

### 봇이 그룹 채팅에 응답하지 않습니다.

1. 봇이 그룹에 추가되었는지 확인하세요.
2. 봇을 @멘션했는지 확인하세요(기본 동작)
3. `groupPolicy`가 `"disabled"`로 설정되어 있지 않은지 확인하세요.
4. 로그 확인: `openclaw logs --follow`

### 봇이 메시지를 수신하지 않습니다.

1. 앱이 게시되고 승인되었는지 확인하세요.
2. 이벤트 구독에 `im.message.receive_v1`이 포함되어 있는지 확인하세요.
3. **긴 연결**이 활성화되어 있는지 확인하세요.
4. 앱 권한이 완전한지 확인하세요
5. 게이트웨이가 실행 중인지 확인합니다. `openclaw gateway status`
6. 로그 확인: `openclaw logs --follow`

### 앱 비밀 유출

1. Feishu 오픈 플랫폼에서 앱 비밀번호 재설정
2. 구성에서 앱 비밀을 업데이트하세요.
3. 게이트웨이 다시 시작

### 메시지 전송 실패

1. 앱에 `im:message:send_as_bot` 권한이 있는지 확인하세요.
2. 앱이 게시되었는지 확인하세요.
3. 자세한 오류는 로그를 확인하세요.

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

- `textChunkLimit`: 아웃바운드 텍스트 청크 크기(기본값: 2000자)
- `mediaMaxMb`: 미디어 업로드/다운로드 제한 (기본값: 30MB)

### 스트리밍

Feishu는 대화형 카드를 통한 스트리밍 응답을 지원합니다. 활성화되면 봇은 텍스트를 생성할 때 카드를 업데이트합니다.

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

보내기 전에 전체 응답을 기다리도록 `streaming: false`을 설정하세요.

### 다중 에이전트 라우팅

Feishu DM 또는 그룹을 다른 에이전트에게 라우팅하려면 `bindings`을 사용하세요.

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
- `match.peer.id`: 사용자 오픈 ID(`ou_xxx`) 또는 그룹 ID(`oc_xxx`)

검색 팁은 [그룹/사용자 ID 가져오기](#get-groupuser-ids)를 참조하세요.

---

## 구성 참조

전체 구성: [게이트웨이 구성](/gateway/configuration)

주요 옵션:

| 설정                                              | 설명                              | 기본값    |
| ------------------------------------------------- | --------------------------------- | --------- |
| `channels.feishu.enabled`                         | 채널 활성화/비활성화              | `true`    |
| `channels.feishu.domain`                          | API 도메인 (`feishu` 또는 `lark`) | `feishu`  |
| `channels.feishu.accounts.<id>.appId`             | 앱 ID                             | -         |
| `channels.feishu.accounts.<id>.appSecret`         | 앱 비밀                           | -         |
| `channels.feishu.accounts.<id>.domain`            | 계정별 API 도메인 재정의          | `feishu`  |
| `channels.feishu.dmPolicy`                        | DM 정책                           | `pairing` |
| `channels.feishu.allowFrom`                       | DM 허용 목록(open_id 목록)        | -         |
| `channels.feishu.groupPolicy`                     | 그룹 정책                         | `open`    |
| `channels.feishu.groupAllowFrom`                  | 그룹 허용 목록                    | -         |
| `channels.feishu.groups.<chat_id>.requireMention` | @멘션 필요                        | `true`    |
| `channels.feishu.groups.<chat_id>.enabled`        | 그룹 활성화                       | `true`    |
| `channels.feishu.textChunkLimit`                  | 메시지 청크 크기                  | `2000`    |
| `channels.feishu.mediaMaxMb`                      | 미디어 크기 제한                  | `30`      |
| `channels.feishu.streaming`                       | 스트리밍 카드 출력 활성화         | `true`    |
| `channels.feishu.blockStreaming`                  | 블록 스트리밍 활성화              | `true`    |

---

## dmPolicy 참조

| 가치          | 행동                                                                         |
| ------------- | ---------------------------------------------------------------------------- |
| `"pairing"`   | **기본값.** 알 수 없는 사용자는 페어링 코드를 받습니다. 승인을 받아야 합니다 |
| `"allowlist"` | `allowFrom`에 있는 사용자만 채팅을 할 수 있습니다                            |
| `"open"`      | 모든 사용자 허용(allowFrom에 `"*"` 필요)                                     |
| `"disabled"`  | DM 비활성화                                                                  |

---

## 지원되는 메시지 유형

### 받기

- ✅ 텍스트
- ✅ 리치 텍스트(게시물)
- ✅ 이미지
- ✅ 파일
- ✅ 오디오
- ✅ 동영상
- ✅ 스티커

### 보내기

- ✅ 텍스트
- ✅ 이미지
- ✅ 파일
- ✅ 오디오
- ⚠️ 서식 있는 텍스트(부분 지원)
