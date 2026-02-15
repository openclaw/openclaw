---
summary: "LINE Messaging API plugin setup, config, and usage"
read_when:
  - You want to connect OpenClaw to LINE
  - You need LINE webhook + credential setup
  - You want LINE-specific message options
title: LINE
x-i18n:
  source_hash: 52eb66d06d616173e6f7b89a538014b631d4d3098ddc8beef581cf16731ec862
---

# LINE(플러그인)

LINE은 LINE Messaging API를 통해 OpenClaw에 연결됩니다. 플러그인은 웹훅으로 실행됩니다.
게이트웨이의 수신기에서 채널 액세스 토큰 + 채널 비밀번호를 사용합니다.
인증.

상태: 플러그인을 통해 지원됩니다. 쪽지, 그룹 채팅, 미디어, 위치, Flex
메시지, 템플릿 메시지, 빠른 답장이 지원됩니다. 반응과 스레드
지원되지 않습니다.

## 플러그인이 필요합니다

LINE 플러그인을 설치합니다:

```bash
openclaw plugins install @openclaw/line
```

로컬 체크아웃(git repo에서 실행하는 경우):

```bash
openclaw plugins install ./extensions/line
```

## 설정

1. LINE 개발자 계정을 만들고 콘솔을 엽니다.
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. 공급자를 생성(또는 선택)하고 **메시징 API** 채널을 추가합니다.
3. 채널 설정에서 **채널 액세스 토큰** 및 **채널 비밀번호**를 복사하세요.
4. 메시징 API 설정에서 **웹훅 사용**을 활성화합니다.
5. 웹후크 URL을 게이트웨이 엔드포인트로 설정합니다(HTTPS 필요).

```
https://gateway-host/line/webhook
```

게이트웨이는 LINE의 웹훅 확인(GET)과 인바운드 이벤트(POST)에 응답합니다.
사용자 정의 경로가 필요한 경우 `channels.line.webhookPath`를 설정하거나
`channels.line.accounts.<id>.webhookPath` 이에 따라 URL을 업데이트하세요.

## 구성

최소 구성:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

환경 변수(기본 계정만 해당):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

토큰/비밀 파일:

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

여러 계정:

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## 접근 제어

다이렉트 메시지는 기본적으로 페어링으로 설정됩니다. 알 수 없는 발신자는 페어링 코드와 상대방의 메시지를 받습니다.
메시지는 승인될 때까지 무시됩니다.

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

허용 목록 및 정책:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: DM에 허용된 LINE 사용자 ID
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: 그룹에 허용된 LINE 사용자 ID입니다.
- 그룹별 재정의: `channels.line.groups.<groupId>.allowFrom`

LINE ID는 대소문자를 구분합니다. 유효한 ID는 다음과 같습니다.

- 사용자: `U` + 32개의 16진수 문자
- 그룹: `C` + 32개의 16진수 문자
- 방: `R` + 32개의 16진수 문자

## 메시지 동작

- 텍스트는 5000자로 분할됩니다.
- 마크다운 형식이 제거되었습니다. 코드 블록과 테이블은 Flex로 변환됩니다.
  가능하면 카드.
- 스트리밍 응답은 버퍼링됩니다. LINE은 로딩을 통해 전체 청크를 수신합니다.
  에이전트가 작동하는 동안 애니메이션이 표시됩니다.
- 미디어 다운로드는 `channels.line.mediaMaxMb`(기본값 10)로 제한됩니다.

## 채널 데이터(리치 메시지)

빠른 답장, 위치, Flex 카드 또는 템플릿을 보내려면 `channelData.line`를 사용하세요.
메시지.

```json5
{
  text: "Here you go",
  channelData: {
    line: {
      quickReplies: ["Status", "Help"],
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Status card",
        contents: {
          /* Flex payload */
        },
      },
      templateMessage: {
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
      },
    },
  },
}
```

LINE 플러그인은 Flex 메시지 사전 설정을 위한 `/card` 명령도 제공합니다.

```
/card info "Welcome" "Thanks for joining!"
```

## 문제 해결

- **웹훅 확인 실패:** 웹훅 URL이 HTTPS이고
  `channelSecret`는 LINE 콘솔과 일치합니다.
- **인바운드 이벤트 없음:** 웹훅 경로가 `channels.line.webhookPath`와 일치하는지 확인하세요.
  게이트웨이는 LINE에서 연결할 수 있습니다.
- **미디어 다운로드 오류:** 미디어가 다음을 초과하는 경우 `channels.line.mediaMaxMb` 발생
  기본 한도.
