---
summary: "WhatsApp 채널 지원, 접근 제어, 배달 동작 및 작업"
read_when:
  - WhatsApp/Web 채널 동작 또는 받은 편지함 라우팅 작업 중
title: "WhatsApp"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: channels/whatsapp.md
  workflow: 15
---

# WhatsApp (Web 채널)

상태: WhatsApp Web (Baileys) 을 통한 프로덕션 준비 완료. Gateway 는 연결된 세션을 소유합니다.

<CardGroup cols={3}>
  <Card title="페어링" icon="link" href="/channels/pairing">
    기본 DM 정책은 알 수 없는 발신자를 위한 페어링입니다.
  </Card>
  <Card title="채널 문제 해결" icon="wrench" href="/channels/troubleshooting">
    채널 간 진단 및 복구 플레이북.
  </Card>
  <Card title="Gateway 구성" icon="settings" href="/gateway/configuration">
    전체 채널 구성 패턴 및 예제.
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

    특정 계정의 경우:

```bash
openclaw channels login --channel whatsapp --account work
```

  </Step>

  <Step title="Gateway 시작">

```bash
openclaw gateway
```

  </Step>

  <Step title="첫 번째 페어링 요청 승인 (페어링 모드 사용 시)">

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <CODE>
```

    페어링 요청은 1 시간 후 만료됩니다. 대기 중인 요청은 채널당 3 개로 제한됩니다.

  </Step>
</Steps>

<Note>
OpenClaw 는 가능하면 별도의 번호에서 WhatsApp 을 실행할 것을 권장합니다. (채널 메타데이터 및 온보딩 흐름은 해당 설정에 최적화되어 있지만 개인 번호 설정도 지원됩니다.)
</Note>

## 배포 패턴

<AccordionGroup>
  <Accordion title="전용 번호 (권장)">
    이것이 가장 깔끔한 운영 모드입니다:

    - OpenClaw 를 위한 별도의 WhatsApp 신원
    - 더 명확한 DM 허용 목록 및 라우팅 경계
    - 자체 채팅 혼동 가능성 감소

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

  <Accordion title="개인 번호 폴백">
    온보딩은 개인 번호 모드를 지원하고 자체 채팅에 친화적인 기준을 작성합니다:

    - `dmPolicy: "allowlist"`
    - `allowFrom` 에는 개인 번호 포함
    - `selfChatMode: true`

    런타임에는 자체 채팅 보호는 연결된 자체 번호 및 `allowFrom` 을 기준으로 합니다.

  </Accordion>

  <Accordion title="WhatsApp Web 전용 채널 범위">
    메시징 플랫폼 채널은 현재 OpenClaw 채널 아키텍처에서 WhatsApp Web 기반 (`Baileys`) 입니다.

    기본 제공 채팅 채널 레지스트리에는 별도의 Twilio WhatsApp 메시징 채널이 없습니다.

  </Accordion>
</AccordionGroup>

## 런타임 모델

- Gateway 는 WhatsApp 소켓과 재연결 루프를 소유합니다.
- 아웃바운드 전송은 대상 계정의 활성 WhatsApp 리스너가 필요합니다.
- 상태 및 브로드캐스트 채팅은 무시됩니다 (`@status`, `@broadcast`).
- 직접 채팅은 DM 세션 규칙을 사용합니다 (`session.dmScope`. 기본값 `main` 은 DM 을 에이전트 주 세션으로 축소).
- 그룹 세션은 격리됩니다 (`agent:<agentId>:whatsapp:group:<jid>`).

## 접근 제어 및 활성화

<Tabs>
  <Tab title="DM 정책">
    `channels.whatsapp.dmPolicy` 는 직접 채팅 접근을 제어합니다:

    - `pairing` (기본)
    - `allowlist`
    - `open` (`allowFrom` 에 `"*"` 포함 필요)
    - `disabled`

    `allowFrom` 은 E.164 스타일 번호를 허용합니다 (내부적으로 정규화됨).

    다중 계정 재정의: `channels.whatsapp.accounts.<id>.dmPolicy` (및 `allowFrom`) 는 해당 계정의 채널 수준 기본값을 재정의합니다.

    런타임 동작 세부 정보:

    - 페어링은 채널 허용 저장소에 지속되며 구성된 `allowFrom` 과 병합됨
    - 허용 목록이 구성되지 않은 경우 연결된 자체 번호는 기본적으로 허용됨
    - 아웃바운드 `fromMe` DM 은 절대 자동으로 페어링되지 않음

  </Tab>

  <Tab title="그룹 정책 + 허용 목록">
    그룹 접근에는 두 가지 계층이 있습니다:

    1. **그룹 멤버십 허용 목록** (`channels.whatsapp.groups`)
       - `groups` 을 생략하면 모든 그룹이 허용됨
       - `groups` 이 있으면 그룹 허용 목록으로 작동함 (`"*"` 허용)

    2. **그룹 발신자 정책** (`channels.whatsapp.groupPolicy` + `groupAllowFrom`)
       - `open`: 발신자 허용 목록 무시
       - `allowlist`: 발신자는 `groupAllowFrom` 과 일치해야 함 (또는 `*`)
       - `disabled`: 모든 그룹 인바운드 차단

    발신자 허용 목록 폴백:

    - `groupAllowFrom` 이 설정되지 않으면 런타임은 사용 가능할 때 `allowFrom` 으로 폴백함
    - 발신자 허용 목록은 언급/회신 활성화 전에 평가됨

    참고: `channels.whatsapp` 블록이 전혀 없으면 `channels.defaults.groupPolicy` 이 설정되어도 런타임 그룹 정책 폴백은 `allowlist` 입니다 (경고 로그 포함).

  </Tab>

  <Tab title="언급 + /활성화">
    그룹 회신은 기본적으로 언급이 필요합니다.

    언급 감지에 포함됨:

    - 봇 신원의 명시적 WhatsApp 언급
    - 구성된 언급 정규식 패턴 (`agents.list[].groupChat.mentionPatterns`, 폴백 `messages.groupChat.mentionPatterns`)
    - 암시적 회신-봇 감지 (회신 발신자가 봇 신원과 일치)

    보안 참고:

    - 인용/회신은 언급 게이팅만 만족합니다. 발신자 권한을 부여하지 **않습니다**
    - `groupPolicy: "allowlist"` 을 사용하면 허용 목록에 없는 발신자는 허용 목록에 있는 사용자의 메시지에 회신하더라도 차단됩니다

    세션 수준 활성화 명령:

    - `/activation mention`
    - `/activation always`

    `activation` 은 세션 상태를 업데이트합니다 (전역 구성이 아님). 소유자로 게이트됩니다.

  </Tab>
</Tabs>

## 개인 번호 및 자체 채팅 동작

연결된 자체 번호가 `allowFrom` 에도 있을 때 WhatsApp 자체 채팅 보호가 활성화됩니다:

- 자체 채팅 회전에 대한 읽음 확인 건너뛰기
- 그렇지 않으면 자신을 ping 하는 언급-JID 자동 트리거 동작 무시
- `messages.responsePrefix` 이 설정되지 않으면 자체 채팅 회신은 기본값 `[{identity.name}]` 또는 `[openclaw]`

## 메시지 정규화 및 컨텍스트

<AccordionGroup>
  <Accordion title="인바운드 봉투 + 회신 컨텍스트">
    들어오는 WhatsApp 메시지는 공유 인바운드 봉투에 래핑됩니다.

    인용 회신이 있으면 컨텍스트는 다음과 같은 형식으로 추가됩니다:

    ```text
    [Replying to <sender> id:<stanzaId>]
    <quoted body or media placeholder>
    [/Replying]
    ```

    회신 메타데이터 필드도 사용 가능할 때 채워집니다 (`ReplyToId`, `ReplyToBody`, `ReplyToSender`, 발신자 JID/E.164).

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

  <Accordion title="대기 중인 그룹 이력 삽입">
    그룹의 경우 처리되지 않은 메시지는 버퍼링되어 봇이 마지막으로 트리거될 때 컨텍스트로 삽입될 수 있습니다.

    - 기본값 제한: `50`
    - 구성: `channels.whatsapp.historyLimit`
    - 폴백: `messages.groupChat.historyLimit`
    - `0` 은 비활성화

    삽입 표시:

    - `[Chat messages since your last reply - for context]`
    - `[Current message - respond to this]`

  </Accordion>

  <Accordion title="읽음 확인">
    읽음 확인은 허용된 인바운드 WhatsApp 메시지에 대해 기본적으로 활성화됩니다.

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

    자체 채팅 회전은 전역적으로 활성화된 경우에도 읽음 확인을 건너뜁니다.

  </Accordion>
</AccordionGroup>

## 배달, 청킹 및 미디어

<AccordionGroup>
  <Accordion title="텍스트 청킹">
    - 기본 청크 제한: `channels.whatsapp.textChunkLimit = 4000`
    - `channels.whatsapp.chunkMode = "length" | "newline"`
    - `newline` 모드는 단락 경계 (빈 줄)를 선호한 후 길이 안전 청킹으로 폴백
  </Accordion>

  <Accordion title="아웃바운드 미디어 동작">
    - 이미지, 비디오, 오디오 (PTT 음성 노트) 및 문서 페이로드 지원
    - `audio/ogg` 은 음성 노트 호환성을 위해 `audio/ogg; codecs=opus` 로 다시 작성됨
    - 애니메이션 GIF 재생은 비디오 전송 시 `gifPlayback: true` 를 통해 지원됨
    - 캡션은 다중 미디어 회신 페이로드 전송 시 첫 번째 미디어 항목에 적용됨
    - 미디어 소스는 HTTP(S), `file://` 또는 로컬 경로일 수 있음
  </Accordion>

  <Accordion title="미디어 크기 제한 및 폴백 동작">
    - 인바운드 미디어 저장 제한: `channels.whatsapp.mediaMaxMb` (기본 `50`)
    - 자동 회신에 대한 아웃바운드 미디어 제한: `agents.defaults.mediaMaxMb` (기본 `5MB`)
    - 이미지는 제한에 맞게 자동 최적화됨 (크기 조정/품질 스윕)
    - 미디어 전송 실패 시 첫 항목 폴백은 응답을 자동으로 삭제하지 않고 대신 텍스트 경고를 보냄
  </Accordion>
</AccordionGroup>

## 승인 반응

WhatsApp 은 `channels.whatsapp.ackReaction` 를 통한 인바운드 수신 시 즉시 ack 반응을 지원합니다.

```json5
{
  channels: {
    whatsapp: {
      ackReaction: {
        emoji: "👀",
        direct: true,
        group: "mentions", // always | mentions | never
      },
    },
  },
}
```

동작 참고:

- 인바운드 허용 직후 전송됨 (사전 회신)
- 실패는 로깅되지만 일반 회신 배달을 차단하지 않음
- 그룹 모드 `mentions` 는 언급 트리거 회전에 반응함. 그룹 활성화 `always` 는 이 확인에 대한 무시로 작동
- WhatsApp 은 `channels.whatsapp.ackReaction` 을 사용합니다 (레거시 `messages.ackReaction` 은 여기에 사용되지 않음)

## 다중 계정 및 자격증명

<AccordionGroup>
  <Accordion title="계정 선택 및 기본값">
    - 계정 ID 는 `channels.whatsapp.accounts` 에서 나옴
    - 기본 계정 선택: 있으면 `default`, 그렇지 않으면 첫 번째 구성된 계정 ID (정렬됨)
    - 계정 ID 는 내부적으로 조회를 위해 정규화됨
  </Accordion>

  <Accordion title="자격증명 경로 및 레거시 호환성">
    - 현재 인증 경로: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
    - 백업 파일: `creds.json.bak`
    - 레거시 기본 인증 (`~/.openclaw/credentials/` 에 있음) 은 여전히 기본 계정 흐름에 대해 인식/마이그레이션됨
  </Accordion>

  <Accordion title="로그아웃 동작">
    `openclaw channels logout --channel whatsapp [--account <id>]` 는 해당 계정의 WhatsApp 인증 상태를 지웁니다.

    레거시 인증 디렉토리에서 `oauth.json` 은 유지되고 Baileys 인증 파일은 제거됩니다.

  </Accordion>
</AccordionGroup>

## 도구, 작업 및 구성 쓰기

- 에이전트 도구 지원에는 WhatsApp 반응 작업 (`react`) 이 포함됩니다.
- 작업 게이트:
  - `channels.whatsapp.actions.reactions`
  - `channels.whatsapp.actions.polls`
- 채널 시작 구성 쓰기는 기본적으로 활성화됩니다 (`channels.whatsapp.configWrites=false` 를 통해 비활성화).

## 문제 해결

<AccordionGroup>
  <Accordion title="연결되지 않음 (QR 필요)">
    증상: 채널 상태가 연결되지 않음으로 보고됨.

    수정:

    ```bash
    openclaw channels login --channel whatsapp
    openclaw channels status
    ```

  </Accordion>

  <Accordion title="연결되었지만 연결 끊김 / 재연결 루프">
    증상: 반복되는 연결 해제 또는 재연결 시도가 있는 연결된 계정.

    수정:

    ```bash
    openclaw doctor
    openclaw logs --follow
    ```

    필요한 경우 `channels login` 으로 다시 연결합니다.

  </Accordion>

  <Accordion title="전송 시 활성 리스너 없음">
    아웃바운드 전송은 대상 계정에 대한 활성 gateway 리스너가 없을 때 빠르게 실패합니다.

    gateway 가 실행 중이고 계정이 연결되어 있는지 확인하세요.

  </Accordion>

  <Accordion title="그룹 메시지가 예기치 않게 무시됨">
    이 순서대로 확인하세요:

    - `groupPolicy`
    - `groupAllowFrom` / `allowFrom`
    - `groups` 허용 목록 항목
    - 언급 게이팅 (`requireMention` + 언급 패턴)
    - `openclaw.json` 의 중복 키 (JSON5): 나중 항목이 이전 항목을 재정의하므로 범위당 단일 `groupPolicy` 유지

  </Accordion>

  <Accordion title="Bun 런타임 경고">
    WhatsApp gateway 런타임은 Node 를 사용해야 합니다. Bun 은 안정적인 WhatsApp/Telegram gateway 작동과 호환되지 않는 것으로 표시됩니다.
  </Accordion>
</AccordionGroup>

## 구성 참조 포인터

주요 참조:

- [구성 참조 - WhatsApp](/gateway/configuration-reference#whatsapp)

높은 신호 WhatsApp 필드:

- 접근: `dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, `groups`
- 배달: `textChunkLimit`, `chunkMode`, `mediaMaxMb`, `sendReadReceipts`, `ackReaction`
- 다중 계정: `accounts.<id>.enabled`, `accounts.<id>.authDir`, 계정 수준 재정의
- 작업: `configWrites`, `debounceMs`, `web.enabled`, `web.heartbeatSeconds`, `web.reconnect.*`
- 세션 동작: `session.dmScope`, `historyLimit`, `dmHistoryLimit`, `dms.<id>.historyLimit`

## 관련

- [페어링](/channels/pairing)
- [채널 라우팅](/channels/channel-routing)
- [다중 에이전트 라우팅](/concepts/multi-agent)
- [문제 해결](/channels/troubleshooting)
