---
read_when:
    - Signal 지원 설정
    - 디버깅 신호 보내기/받기
summary: signal-cli(JSON-RPC + SSE), 설정 및 숫자 모델을 통한 신호 지원
title: 신호
x-i18n:
    generated_at: "2026-02-08T15:51:48Z"
    model: gtx
    provider: google-translate
    source_hash: b336b603edeb17a38a66f0d9ccdfb13365a728e77a9c3522e0573b759d94055d
    source_path: channels/signal.md
    workflow: 15
---

# 신호(signal-cli)

상태: 외부 CLI 통합. 게이트웨이가 다음과 대화합니다. `signal-cli` HTTP JSON-RPC + SSE를 통해.

## 빠른 설정(초보자)

1. 사용 **별도의 신호번호** 봇용(권장)
2. 설치하다 `signal-cli` (자바 필요).
3. 봇 장치를 연결하고 데몬을 시작합니다.
   - `signal-cli link -n "OpenClaw"`
4. OpenClaw를 구성하고 게이트웨이를 시작합니다.

최소 구성:

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

## 그것은 무엇입니까

- 신호 채널을 통해 `signal-cli` (임베디드 libsignal이 아님)
- 결정적 라우팅: 응답은 항상 Signal로 돌아갑니다.
- DM은 상담원의 기본 세션을 공유합니다. 그룹은 격리되어 있습니다(`agent:<agentId>:signal:group:<groupId>`).

## 구성 쓰기

기본적으로 Signal은 다음에 의해 트리거되는 구성 업데이트를 쓸 수 있습니다. `/config set|unset` (요구 `commands.config: true`).

다음을 사용하여 비활성화:

```json5
{
  channels: { signal: { configWrites: false } },
}
```

## 숫자 모델(중요)

- 게이트웨이는 **신호 장치** (그만큼 `signal-cli` 계정).
- 봇을 실행하면 **귀하의 개인 Signal 계정**, 자신의 메시지를 무시합니다(루프 보호).
- "봇에게 문자 메시지를 보내면 답장을 보냅니다."의 경우 **별도의 봇 번호**.

## 설정(빠른 경로)

1. 설치하다 `signal-cli` (자바 필요).
2. 봇 계정 연결:
   - `signal-cli link -n "OpenClaw"` 그런 다음 Signal에서 QR을 스캔하세요.
3. Signal을 구성하고 게이트웨이를 시작합니다.

예:

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

다중 계정 지원: 사용 `channels.signal.accounts` 계정별 구성 및 선택 사항 포함 `name`. 보다 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) 공유 패턴의 경우.

## 외부 데몬 모드(httpUrl)

관리하고 싶다면 `signal-cli` 자신(느린 JVM 콜드 스타트, 컨테이너 초기화 또는 공유 CPU)인 경우 데몬을 별도로 실행하고 OpenClaw를 지정합니다.

```json5
{
  channels: {
    signal: {
      httpUrl: "http://127.0.0.1:8080",
      autoStart: false,
    },
  },
}
```

그러면 OpenClaw 내부에서 자동 생성 및 시작 대기가 건너뜁니다. 자동 생성 시 느린 시작을 위해 다음을 설정하세요. `channels.signal.startupTimeoutMs`.

## 액세스 제어(DM + 그룹)

DM:

- 기본: `channels.signal.dmPolicy = "pairing"`.
- 알 수 없는 발신자는 페어링 코드를 받습니다. 메시지는 승인될 때까지 무시됩니다(코드는 1시간 후에 만료됩니다).
- 승인 방법:
  - `openclaw pairing list signal`
  - `openclaw pairing approve signal <CODE>`
- 페어링은 Signal DM의 기본 토큰 교환입니다. 세부: [편성](/channels/pairing)
- UUID 전용 발신자(발신자: `sourceUuid`)는 다음과 같이 저장됩니다. `uuid:<id>` ~에 `channels.signal.allowFrom`.

여러 떼:

- `channels.signal.groupPolicy = open | allowlist | disabled`.
- `channels.signal.groupAllowFrom` 다음과 같은 경우에 그룹으로 트리거할 수 있는 사람을 제어합니다. `allowlist` 설정됩니다.

## 작동 방식(행동)

- `signal-cli` 데몬으로 실행됩니다. 게이트웨이는 SSE를 통해 이벤트를 읽습니다.
- 인바운드 메시지는 공유 채널 봉투로 정규화됩니다.
- 회신은 항상 동일한 번호나 그룹으로 다시 라우팅됩니다.

## 미디어 + 제한

- 아웃바운드 텍스트는 다음과 같이 청크됩니다. `channels.signal.textChunkLimit` (기본값은 4000).
- 선택적 개행 청킹: 설정 `channels.signal.chunkMode="newline"` 길이 청크 전에 빈 줄(단락 경계)로 분할합니다.
- 지원되는 첨부 파일(base64는 다음에서 가져옴) `signal-cli`).
- 기본 미디어 캡: `channels.signal.mediaMaxMb` (기본값 8).
- 사용 `channels.signal.ignoreAttachments` 미디어 다운로드를 건너뛰려면
- 그룹 기록 컨텍스트 사용 `channels.signal.historyLimit` (또는 `channels.signal.accounts.*.historyLimit`), 다음으로 돌아감 `messages.groupChat.historyLimit`. 세트 `0` 비활성화합니다(기본값 50).

## 타이핑 + 읽음 확인

- **입력 표시기**: OpenClaw는 다음을 통해 타이핑 신호를 보냅니다. `signal-cli sendTyping` 응답이 실행되는 동안 새로 고칩니다.
- **읽음 확인**: 언제 `channels.signal.sendReadReceipts` true이면 OpenClaw는 허용된 DM에 대한 읽음 확인을 전달합니다.
- Signal-cli는 그룹에 대한 읽음 확인을 노출하지 않습니다.

## 반응(메시지 도구)

- 사용 `message action=react` ~와 함께 `channel=signal`.
- 대상: 발신자 E.164 또는 UUID(사용 `uuid:<id>` 페어링 출력에서; 베어 UUID도 작동합니다).
- `messageId` 당신이 반응하고 있는 메시지의 Signal 타임스탬프입니다.
- 그룹 반응에는 다음이 필요합니다. `targetAuthor` 또는 `targetAuthorUuid`.

예:

```
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅
```

구성:

- `channels.signal.actions.reactions`: 반응 작업을 활성화/비활성화합니다(기본값은 true).
- `channels.signal.reactionLevel`: `off | ack | minimal | extensive`.
  - `off`/`ack` 에이전트 반응을 비활성화합니다(메시지 도구 `react` 오류가 발생합니다).
  - `minimal`/`extensive` 상담원 반응을 활성화하고 안내 수준을 설정합니다.
- 계정별 재정의: `channels.signal.accounts.<id>.actions.reactions`, `channels.signal.accounts.<id>.reactionLevel`.

## 전달 대상(CLI/cron)

- DM:`signal:+15551234567` (또는 일반 E.164).
- UUID DM: `uuid:<id>` (또는 베어 UUID).
- 여러 떼:`signal:group:<groupId>`.
- 사용자 이름: `username:<name>` (Signal 계정에서 지원하는 경우)

## 문제 해결

먼저 이 사다리를 실행하세요:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

그런 다음 필요한 경우 DM 페어링 상태를 확인합니다.

```bash
openclaw pairing list signal
```

일반적인 오류:

- 데몬에 연결할 수 있지만 응답이 없습니다. 계정/데몬 설정을 확인하세요(`httpUrl`, `account`) 및 수신 모드.
- DM 무시됨: 발신자가 페어링 승인을 보류 중입니다.
- 그룹 메시지 무시됨: 그룹 발신자/멘션 게이팅이 전달을 차단합니다.

분류 흐름의 경우: [/채널/문제해결](/channels/troubleshooting).

## 구성 참조(신호)

전체 구성: [구성](/gateway/configuration)

제공업체 옵션:

- `channels.signal.enabled`: 채널 시작을 활성화/비활성화합니다.
- `channels.signal.account`: 봇 계정의 경우 E.164입니다.
- `channels.signal.cliPath`: 경로 `signal-cli`.
- `channels.signal.httpUrl`: 전체 데몬 URL(호스트/포트 재정의)
- `channels.signal.httpHost`, `channels.signal.httpPort`: 데몬 바인딩(기본값 127.0.0.1:8080).
- `channels.signal.autoStart`: 자동 생성 데몬(기본값은 true인 경우) `httpUrl` 설정되지 않음).
- `channels.signal.startupTimeoutMs`: 시작 대기 시간 초과(ms)(상한 120000)
- `channels.signal.receiveMode`: `on-start | manual`.
- `channels.signal.ignoreAttachments`: 첨부파일 다운로드를 건너뜁니다.
- `channels.signal.ignoreStories`: 데몬의 이야기를 무시합니다.
- `channels.signal.sendReadReceipts`: 읽음 확인을 전달합니다.
- `channels.signal.dmPolicy`: `pairing | allowlist | open | disabled` (기본값: 페어링).
- `channels.signal.allowFrom`: DM 허용 목록(E.164 또는 `uuid:<id>`).`open` 필요하다 `"*"`. Signal에는 사용자 이름이 없습니다. 전화/UUID ID를 사용하십시오.
- `channels.signal.groupPolicy`: `open | allowlist | disabled` (기본값: 허용 목록).
- `channels.signal.groupAllowFrom`: 그룹 발신자 허용 목록.
- `channels.signal.historyLimit`: 컨텍스트로 포함할 최대 그룹 메시지입니다(0은 비활성화됨).
- `channels.signal.dmHistoryLimit`: 사용자 턴의 DM 기록 제한입니다. 사용자별 재정의: `channels.signal.dms["<phone_or_uuid>"].historyLimit`.
- `channels.signal.textChunkLimit`: 아웃바운드 청크 크기(문자)입니다.
- `channels.signal.chunkMode`: `length` (기본값) 또는 `newline` 길이 청크 전에 빈 줄(단락 경계)로 분할합니다.
- `channels.signal.mediaMaxMb`: 인바운드/아웃바운드 미디어 캡(MB)입니다.

관련 전역 옵션:

- `agents.list[].groupChat.mentionPatterns` (Signal은 기본 언급을 지원하지 않습니다).
- `messages.groupChat.mentionPatterns` (전역 대체).
- `messages.responsePrefix`.
