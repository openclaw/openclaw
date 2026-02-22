---
summary: "WhatsApp 채널 지원, 접근 제어, 전송 동작, 운영 관리"
read_when:
  - Working on WhatsApp/web channel behavior or inbox routing
title: "WhatsApp"
---

# WhatsApp (웹 채널)

상태: WhatsApp Web (Baileys)을 통해 프로덕션 준비 완료. 게이트웨이가 연결된 세션을 소유합니다.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/ko-KR/channels/pairing">
    기본 다이렉트 메시지 정책은 미확인 발신자에 대한 페어링입니다.
  </Card>
  <Card title="채널 문제 해결" icon="wrench" href="/ko-KR/channels/troubleshooting">
    크로스 채널 진단 및 복구 가이드.
  </Card>
  <Card title="게이트웨이 구성" icon="settings" href="/ko-KR/gateway/configuration">
    전체 채널 구성 패턴 및 예.
  </Card>
</CardGroup>

## 빠른 설정

<Steps>
  <Step title="WhatsApp 접근 정책 구성">

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing",
      allowFrom: ["+15551234567"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

  </Step>

  <Step title="WhatsApp 연결 (QR)">

```bash
openclaw channels login --channel whatsapp
```

    특정 계정을 위한:

```bash
openclaw channels login --channel whatsapp --account work
```

  </Step>

  <Step title="게이트웨이 시작">

```bash
openclaw gateway
```

  </Step>

  <Step title="첫 번째 페어링 요청 승인 (페어링 모드 사용 시)">

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <CODE>
```

    페어링 요청은 1시간 후에 만료됩니다. 대기 중인 요청은 채널당 최대 3개로 제한됩니다.

  </Step>
</Steps>

<Note>
OpenClaw는 가능하면 별도의 번호에서 WhatsApp을 실행하는 것을 권장합니다. (채널 메타데이터 및 온보딩 흐름은 해당 설정에 최적화되어 있으나 개인 번호 설정도 지원됩니다.)
</Note>

## 배포 패턴

<AccordionGroup>
  <Accordion title="전용 번호 (권장)">
    가장 깔끔한 운영 모드입니다:

    - OpenClaw 전용 WhatsApp 식별
    - 더 명확한 다이렉트 메시지 허용 목록 및 라우팅 경계
    - 셀프 챗 혼동 가능성 낮음

    최소 정책 패턴:

    ```json5
    {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["+15551234567"],
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="개인 번호 대체">
    온보딩은 개인 번호 모드를 지원하고 셀프 챗에 친화적인 기본값을 작성합니다:

    - `dmPolicy: "allowlist"`
    - `allowFrom`에 개인 번호가 포함됨
    - `selfChatMode: true`

    런타임에서는 연결된 셀프 번호와 `allowFrom`을 기준으로 셀프 챗 보호가 동작합니다.

  </Accordion>

  <Accordion title="WhatsApp Web 전용 채널 범위">
    메시징 플랫폼 채널은 현재 OpenClaw 채널 아키텍처에서 WhatsApp Web 기반(Baileys)입니다.

    내장된 채팅 채널 레지스트리에 별도의 Twilio WhatsApp 메시징 채널은 없습니다.

  </Accordion>
</AccordionGroup>

## 런타임 모델

- 게이트웨이 소유: WhatsApp 소켓 및 재연결 루프.
- 아웃바운드 전송은 대상 계정에 대한 활성 WhatsApp 리스너가 필요합니다.
- 상태 및 브로드캐스트 채팅은 무시됩니다 (`@status`, `@broadcast`).
- 직접 채팅은 다이렉트 메시지 세션 규칙을 사용합니다 (`session.dmScope`; 기본값 `main`은 에이전트 메인 세션으로 다이렉트 메시지를 통합).
- 그룹 세션은 격리됩니다 (`agent:<agentId>:whatsapp:group:<jid>`).

## 접근 제어 및 활성화

<Tabs>
  <Tab title="DM 정책">
    `channels.whatsapp.dmPolicy`는 직접 채팅 접근을 제어합니다:

    - `pairing` (기본값)
    - `allowlist`
    - `open` (`allowFrom`에 `"*"` 포함 필요)
    - `disabled`

    `allowFrom`은 E.164 스타일의 번호를 수용합니다 (내부적으로 정규화됨).

    다중 계정 재정의: `channels.whatsapp.accounts.<id>.dmPolicy` (및 `allowFrom`)가 해당 계정에 대한 채널 수준 기본 설정보다 우선합니다.

    런타임 동작 세부 사항:

    - 페어링은 채널 허용 저장소에 영구 저장되며, 구성된 `allowFrom`과 병합됩니다.
    - 허용목록이 구성되지 않은 경우 연결된 셀프 번호가 기본적으로 허용됩니다.
    - 아웃바운드 `fromMe` 다이렉트 메시지는 자동 페어링되지 않습니다.

  </Tab>

  <Tab title="그룹 정책 + 허용 목록">
    그룹 접근에는 두 개의 계층이 있습니다:

    1. **그룹 멤버십 허용목록** (`channels.whatsapp.groups`)
       - `groups`가 누락된 경우, 모든 그룹이 사용 가능합니다.
       - `groups`가 있는 경우, 그룹 허용 목록 역할을 합니다 (`"*"` 허용).

    2. **그룹 발신자 정책** (`channels.whatsapp.groupPolicy` + `groupAllowFrom`)
       - `open`: 발신자 허용목록을 우회합니다.
       - `allowlist`: 발신자가 `groupAllowFrom` (또는 `*`)과 일치해야 합니다.
       - `disabled`: 모든 그룹 인바운드를 차단합니다.

    발신자 허용목록 대체:

    - `groupAllowFrom`이 설정되지 않은 경우, 런타임은 `allowFrom`을 사용할 수 있을 때 대체합니다.
    - 발신자 허용 목록은 멘션/답장 활성화 전에 평가됩니다.

    참고: `channels.whatsapp` 블록이 전혀 없는 경우 런타임 그룹 정책 대체는 실질적으로 `open`입니다.

  </Tab>

  <Tab title="멘션 + /activation">
    기본적으로 그룹 응답은 멘션이 필요합니다.

    멘션 감지는 다음을 포함합니다:

    - 봇 식별에 대한 WhatsApp 명시적 멘션
    - 구성된 멘션 정규식 패턴 (`agents.list[].groupChat.mentionPatterns`, 대체값 `messages.groupChat.mentionPatterns`)
    - 봇에 대한 응답을 암시적으로 감지 (응답 발신자가 봇 식별과 일치)

    보안 주의사항:

    - 인용/답장은 멘션 게이팅만 충족시킵니다; 발신자 권한을 부여하지 **않습니다**
    - `groupPolicy: "allowlist"` 설정 시, 허용 목록에 없는 발신자는 허용된 사용자의 메시지에 답장하더라도 여전히 차단됩니다

    세션 수준 활성화 명령:

    - `/activation mention`
    - `/activation always`

    `activation`은 세션 상태를 업데이트합니다 (글로벌 구성은 아닙니다). 소유자에 의해 통제됩니다.

  </Tab>
</Tabs>

## 개인 번호 및 셀프 챗 동작

연결된 셀프 번호가 `allowFrom`에도 있는 경우, WhatsApp 셀프 챗 보호 기능이 활성화됩니다:

- 셀프 챗 차례에서는 읽음 확인을 건너뜁니다.
- 멘션 JID 자동 트리거 동작을 무시하여 자신을 핑하지 않습니다.
- `messages.responsePrefix`가 설정되지 않은 경우, 셀프 챗 응답은 기본적으로 `[{identity.name}]` 또는 `[openclaw]`로 설정됩니다.

## 메시지 정규화 및 컨텍스트

<AccordionGroup>
  <Accordion title="인바운드 봉투 + 응답 컨텍스트">
    들어오는 WhatsApp 메시지는 공유된 인바운드 봉투에 감싸져 있습니다.

    인용된 응답이 존재하는 경우, 이는 다음 형식으로 컨텍스트가 추가됩니다:

    ```text
    [Replying to <sender> id:<stanzaId>]
    <quoted body or media placeholder>
    [/Replying]
    ```

    사용 가능한 경우 응답 메타데이터 필드도 채워집니다 (`ReplyToId`, `ReplyToBody`, `ReplyToSender`, 발신자 JID/E.164).

  </Accordion>

  <Accordion title="미디어 자리 표시자 및 위치/연락처 추출">
    미디어 전용 인바운드 메시지는 다음과 같은 자리 표시자로 정규화됩니다:

    - `<media:image>`
    - `<media:video>`
    - `<media:audio>`
    - `<media:document>`
    - `<media:sticker>`

    위치 및 연락처 페이로드는 라우팅 전에 텍스트 컨텍스트로 정규화됩니다.

  </Accordion>

  <Accordion title="대기 중인 그룹 히스토리 주입">
    그룹의 경우, 처리되지 않은 메시지는 버퍼링될 수 있으며, 봇이 최종적으로 실행될 때 컨텍스트로 주입될 수 있습니다.

    - 기본 한도: `50`
    - 구성: `channels.whatsapp.historyLimit`
    - 대체: `messages.groupChat.historyLimit`
    - `0`은 비활성화됩니다.

    주입 마커:

    - `[Chat messages since your last reply - for context]`
    - `[Current message - respond to this]`

  </Accordion>

  <Accordion title="읽음 확인">
    기본적으로 수신 WhatsApp 메시지가 수락되면 읽음 확인이 활성화됩니다.

    전역 비활성화:

    ```json5
    {
      channels: {
        whatsapp: {
          sendReadReceipts: false,
        },
      },
    }
    ```

    계정별 재정의:

    ```json5
    {
      channels: {
        whatsapp: {
          accounts: {
            work: {
              sendReadReceipts: false,
            },
          },
        },
      },
    }
    ```

    전역적으로 활성화된 경우에도 셀프 챗 차례는 읽음 확인을 건너뜁니다.

  </Accordion>
</AccordionGroup>

## 전송, 청크 처리, 미디어

<AccordionGroup>
  <Accordion title="텍스트 청크 처리">
    - 기본 청크 한도: `channels.whatsapp.textChunkLimit = 4000`
    - `channels.whatsapp.chunkMode = "length" | "newline"`
    - `newline` 모드는 문단 경계 (빈 줄)를 우선한 후 길이 안전한 청크 처리를 사용합니다.
  </Accordion>

  <Accordion title="아웃바운드 미디어 동작">
    - 이미지, 비디오, 오디오 (PTT 음성 메모) 및 문서 페이로드를 지원합니다.
    - `audio/ogg`는 음성 메모 호환성을 위해 `audio/ogg; codecs=opus`로 재작성됩니다.
    - 비디오 전송 시 `gifPlayback: true`로 애니메이션 GIF 재생이 지원됩니다.
    - 첫 번째 미디어 항목 전송 시 캡션이 적용됩니다.
    - 미디어 소스는 HTTP(S), `file://` 또는 로컬 경로일 수 있습니다.
  </Accordion>

  <Accordion title="미디어 크기 제한 및 대체 동작">
    - 인바운드 미디어 저장 한도: `channels.whatsapp.mediaMaxMb` (기본값 `50MB`)
    - 자동 응답 아웃바운드 미디어 한도: `agents.defaults.mediaMaxMb` (기본값 `5MB`)
    - 이미지의 경우 제한을 맞추기 위해 자동으로 최적화됩니다 (크기 조정/품질 조정).
    - 미디어 전송 실패 시, 첫 번째 항목 대체 전송은 경고 텍스트를 보냅니다 (응답을 조용히 드롭하지 않습니다).
  </Accordion>
</AccordionGroup>

## 확인 리액션

WhatsApp은 수신 시 `channels.whatsapp.ackReaction`을 통해 즉각적인 확인 리액션을 지원합니다.

```json5
{
  channels: {
    whatsapp: {
      ackReaction: {
        emoji: "👀",
        direct: true,
        group: "mentions",
      },
    },
  },
}
```

동작 노트:

- 수신이 수락된 후 즉시 전송됩니다 (응답 전).
- 실패는 로그되지만 정상적인 응답 제공을 차단하지 않습니다.
- 그룹 모드 `mentions`는 멘션 트리거 차례에 반응합니다. 그룹 활성화 `always`는 이 검사를 우회합니다.
- WhatsApp은 `channels.whatsapp.ackReaction`을 사용합니다 (레거시 `messages.ackReaction`은 여기서 사용되지 않습니다).

## 다중 계정 및 인증

<AccordionGroup>
  <Accordion title="계정 선택 및 기본값">
    - 계정 ID는 `channels.whatsapp.accounts`에서 옵니다.
    - 기본 계정 선택: `default`가 있는 경우, 없으면 첫 번째로 구성된 계정 ID (정렬된)입니다.
    - 계정 ID는 내부적으로 조회를 위해 정규화됩니다.
  </Accordion>

  <Accordion title="인증 경로 및 레거시 호환성">
    - 현재 인증 경로: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
    - 백업 파일: `creds.json.bak`
    - 레거시 기본 인증은 여전히 인식/마이그레이션됩니다 (기본 계정 흐름용).
  </Accordion>

  <Accordion title="로그아웃 동작">
    `openclaw channels logout --channel whatsapp [--account <id>]`는 해당 계정의 WhatsApp 인증 상태를 제거합니다.

    레거시 인증 디렉토리에서는 `oauth.json`이 보존되고 Baileys 인증 파일이 제거됩니다.

  </Accordion>
</AccordionGroup>

## 도구, 액션, 구성 쓰기

- 에이전트 도구 지원에는 WhatsApp 리액션 액션 (`react`)이 포함됩니다.
- 액션 게잇:
  - `channels.whatsapp.actions.reactions`
  - `channels.whatsapp.actions.polls`
- 채널 시작 구성 쓰기는 기본적으로 활성화되어 있습니다 (비활성화는 `channels.whatsapp.configWrites=false`를 통해 가능).

## 문제 해결

<AccordionGroup>
  <Accordion title="연결되지 않음 (QR 필요)">
    증상: 채널 상태에 연결되지 않았다고 보고됩니다.

    해결:

    ```bash
    openclaw channels login --channel whatsapp
    openclaw channels status
    ```

  </Accordion>

  <Accordion title="연결되었지만 연결 끊김/재연결 루프">
    증상: 연결된 계정 상태에서 반복적인 연결 끊김 또는 재연결 시도.

    해결:

    ```bash
    openclaw doctor
    openclaw logs --follow
    ```

    필요시 `channels login`을 통해 재연결합니다.

  </Accordion>

  <Accordion title="전송 시 활성 리스너 없음">
    대상 계정에 대한 활성 게이트웨이 리스너가 없으면 아웃바운드 전송이 빠르게 실패합니다.

    게이트웨이가 실행 중이고 계정이 연결되어 있는지 확인하십시오.

  </Accordion>

  <Accordion title="그룹 메시지가 예기치 않게 무시됨">
    이 순서대로 확인하십시오:

    - `groupPolicy`
    - `groupAllowFrom` / `allowFrom`
    - `groups` 허용 목록 항목
    - 멘션 게이팅 (`requireMention` + 멘션 패턴)
    - `openclaw.json`의 중복 키 (JSON5): 나중 항목이 이전 항목을 덮어쓰므로, 스코프당 하나의 `groupPolicy`만 유지하세요

  </Accordion>

  <Accordion title="Bun 런타임 경고">
    WhatsApp 게이트웨이 런타임은 Node를 사용해야 합니다. Bun은 안정적인 WhatsApp/Telegram 게이트웨이 운영에 비호환으로 플래그 지정됩니다.
  </Accordion>
</AccordionGroup>

## 구성 참조 포인터

주요 참조:

- [구성 참조 - WhatsApp](/ko-KR/gateway/configuration-reference#whatsapp)

높은 신호의 WhatsApp 필드:

- 접근: `dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, `groups`
- 전달: `textChunkLimit`, `chunkMode`, `mediaMaxMb`, `sendReadReceipts`, `ackReaction`
- 다중 계정: `accounts.<id>.enabled`, `accounts.<id>.authDir`, 계정 수준 재정의
- 작업: `configWrites`, `debounceMs`, `web.enabled`, `web.heartbeatSeconds`, `web.reconnect.*`
- 세션 동작: `session.dmScope`, `historyLimit`, `dmHistoryLimit`, `dms.<id>.historyLimit`

## 관련 문서

- [Pairing](/ko-KR/channels/pairing)
- [채널 라우팅](/ko-KR/channels/channel-routing)
- [멀티 에이전트 라우팅](/ko-KR/concepts/multi-agent)
- [문제 해결](/ko-KR/channels/troubleshooting)
