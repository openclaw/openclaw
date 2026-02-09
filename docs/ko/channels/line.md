---
summary: "LINE Messaging API 플러그인 설정, 구성 및 사용법"
read_when:
  - OpenClaw 를 LINE 에 연결하려는 경우
  - LINE 웹훅 및 자격 증명 설정이 필요한 경우
  - LINE 전용 메시지 옵션을 사용하려는 경우
title: LINE
---

# LINE (플러그인)

LINE 은 LINE Messaging API 를 통해 OpenClaw 에 연결됩니다. 이 플러그인은 Gateway(게이트웨이) 에서 웹훅 수신기로 실행되며, 인증을 위해 채널 액세스 토큰과 채널 시크릿을 사용합니다.

상태: 플러그인을 통해 지원됩니다. 다이렉트 메시지, 그룹 채팅, 미디어, 위치, Flex 메시지, 템플릿 메시지 및 빠른 응답이 지원됩니다. 반응 및 스레드는 지원되지 않습니다.

## 플러그인 필요

LINE 플러그인을 설치합니다:

```bash
openclaw plugins install @openclaw/line
```

로컬 체크아웃 (git 리포지토리에서 실행하는 경우):

```bash
openclaw plugins install ./extensions/line
```

## 설정

1. LINE Developers 계정을 생성하고 콘솔을 엽니다:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. 프로바이더를 생성(또는 선택)하고 **Messaging API** 채널을 추가합니다.
3. 채널 설정에서 **Channel access token** 과 **Channel secret** 을 복사합니다.
4. Messaging API 설정에서 **Use webhook** 을 활성화합니다.
5. 웹훅 URL 을 Gateway(게이트웨이) 엔드포인트로 설정합니다 (HTTPS 필수):

```
https://gateway-host/line/webhook
```

Gateway(게이트웨이) 는 LINE 의 웹훅 검증 (GET) 및 인바운드 이벤트 (POST) 에 응답합니다.
사용자 지정 경로가 필요한 경우 `channels.line.webhookPath` 또는
`channels.line.accounts.<id>.webhookPath` 을 설정하고 URL 을 그에 맞게 업데이트하십시오.

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

환경 변수 (기본 계정만):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

토큰 / 시크릿 파일:

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

다중 계정:

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

다이렉트 메시지는 기본적으로 페어링을 사용합니다. 알 수 없는 발신자는 페어링 코드를 받으며, 승인될 때까지 해당 메시지는 무시됩니다.

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

허용 목록 및 정책:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: 다이렉트 메시지용 허용된 LINE 사용자 ID
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: 그룹용 허용된 LINE 사용자 ID
- 그룹별 재정의: `channels.line.groups.<groupId>.allowFrom`

LINE ID 는 대소문자를 구분합니다. 유효한 ID 형식은 다음과 같습니다:

- 사용자: `U` + 32 자리 16진수 문자
- 그룹: `C` + 32 자리 16진수 문자
- 룸: `R` + 32 자리 16진수 문자

## 메시지 동작

- 텍스트는 5000 자 단위로 분할됩니다.
- Markdown 서식은 제거되며, 코드 블록과 표는 가능한 경우 Flex 카드로 변환됩니다.
- 스트리밍 응답은 버퍼링되며, 에이전트가 작업하는 동안 LINE 은 로딩 애니메이션과 함께 전체 청크를 수신합니다.
- 미디어 다운로드는 `channels.line.mediaMaxMb` 로 제한됩니다 (기본값 10).

## 채널 데이터 (리치 메시지)

`channelData.line` 를 사용하여 빠른 응답, 위치, Flex 카드 또는 템플릿 메시지를 전송합니다.

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

LINE 플러그인에는 Flex 메시지 프리셋을 위한 `/card` 명령도 포함되어 있습니다:

```
/card info "Welcome" "Thanks for joining!"
```

## 문제 해결

- **웹훅 검증 실패:** 웹훅 URL 이 HTTPS 인지 확인하고,
  `channelSecret` 이 LINE 콘솔과 일치하는지 확인하십시오.
- **인바운드 이벤트 없음:** 웹훅 경로가 `channels.line.webhookPath` 와 일치하는지,
  그리고 Gateway(게이트웨이) 가 LINE 에서 접근 가능한지 확인하십시오.
- **미디어 다운로드 오류:** 미디어가 기본 제한을 초과하는 경우
  `channels.line.mediaMaxMb` 값을 증가시키십시오.
