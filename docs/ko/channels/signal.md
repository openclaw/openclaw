---
summary: "signal-cli (JSON-RPC + SSE)를 통한 Signal 지원, 설정 및 번호 모델"
read_when:
  - Signal 지원 설정
  - Signal 송수신 디버깅
title: "Signal"
---

# Signal (signal-cli)

상태: 외부 CLI 통합. Gateway(게이트웨이)는 HTTP JSON-RPC + SSE를 통해 `signal-cli` 와 통신합니다.

## 빠른 설정 (초보자)

1. 봇을 위해 **별도의 Signal 번호**를 사용합니다 (권장).
2. `signal-cli` 를 설치합니다 (Java 필요).
3. 봇 디바이스를 연결하고 데몬을 시작합니다:
   - `signal-cli link -n "OpenClaw"`
4. OpenClaw 를 구성하고 게이트웨이를 시작합니다.

최소 설정:

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

## 무엇인가요

- `signal-cli` 를 통한 Signal 채널 (libsignal 내장 아님).
- 결정적 라우팅: 응답은 항상 Signal 로 되돌아갑니다.
- 다이렉트 메시지 (DM)는 에이전트의 메인 세션을 공유하며, 그룹은 격리됩니다 (`agent:<agentId>:signal:group:<groupId>`).

## 구성 쓰기

기본적으로 Signal 은 `/config set|unset` 에 의해 트리거되는 구성 업데이트 쓰기가 허용됩니다 (`commands.config: true` 필요).

비활성화하려면 다음을 사용합니다:

```json5
{
  channels: { signal: { configWrites: false } },
}
```

## 번호 모델 (중요)

- 게이트웨이는 **Signal 디바이스** (`signal-cli` 계정) 에 연결됩니다.
- **개인 Signal 계정**으로 봇을 실행하면, 자신의 메시지는 무시됩니다 (루프 보호).
- "봇에게 문자를 보내면 답장하는" 경우에는 **별도의 봇 번호**를 사용하세요.

## 설정 (빠른 경로)

1. `signal-cli` 를 설치합니다 (Java 필요).
2. 봇 계정을 연결합니다:
   - `signal-cli link -n "OpenClaw"` 실행 후 Signal 에서 QR 을 스캔합니다.
3. Signal 을 구성하고 게이트웨이를 시작합니다.

예시:

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

다중 계정 지원: 계정별 구성과 선택적 `name` 와 함께 `channels.signal.accounts` 를 사용합니다. 공통 패턴은 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) 를 참고하십시오.

## 외부 데몬 모드 (httpUrl)

JVM 콜드 스타트가 느리거나, 컨테이너 초기화 또는 공유 CPU 등으로 인해 `signal-cli` 를 직접 관리하려면, 데몬을 별도로 실행하고 OpenClaw 에 해당 URL 을 지정합니다:

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

이 방식은 OpenClaw 내부의 자동 스폰과 시작 대기를 건너뜁니다. 자동 스폰 시 느린 시작이 문제라면 `channels.signal.startupTimeoutMs` 을 설정합니다.

## 접근 제어 (DM + 그룹)

DM:

- 기본값: `channels.signal.dmPolicy = "pairing"`.
- 알 수 없는 발신자는 페어링 코드를 받으며, 승인될 때까지 메시지는 무시됩니다 (코드는 1 시간 후 만료).
- 승인 방법:
  - `openclaw pairing list signal`
  - `openclaw pairing approve signal <CODE>`
- 페어링은 Signal DM 의 기본 토큰 교환 방식입니다. 자세한 내용은 [Pairing](/channels/pairing) 을 참고하십시오.
- `sourceUuid` 에서 온 UUID 전용 발신자는 `channels.signal.allowFrom` 에서 `uuid:<id>` 로 저장됩니다.

그룹:

- `channels.signal.groupPolicy = open | allowlist | disabled`.
- `allowlist` 이 설정된 경우, 그룹에서 누가 트리거할 수 있는지는 `channels.signal.groupAllowFrom` 가 제어합니다.

## 동작 방식 (동작)

- `signal-cli` 는 데몬으로 실행되며, 게이트웨이는 SSE 를 통해 이벤트를 읽습니다.
- 수신 메시지는 공통 채널 엔벨로프로 정규화됩니다.
- 응답은 항상 동일한 번호 또는 그룹으로 라우팅됩니다.

## 미디어 + 제한

- 발신 텍스트는 `channels.signal.textChunkLimit` 로 분할됩니다 (기본값 4000).
- 선택적 줄바꿈 분할: 길이 분할 전에 빈 줄 (문단 경계) 기준으로 나누려면 `channels.signal.chunkMode="newline"` 을 설정합니다.
- 첨부 파일 지원 ( `signal-cli` 에서 base64 로 가져옴).
- 기본 미디어 제한: `channels.signal.mediaMaxMb` (기본값 8).
- 미디어 다운로드를 건너뛰려면 `channels.signal.ignoreAttachments` 을 사용합니다.
- 그룹 히스토리 컨텍스트는 `channels.signal.historyLimit` (또는 `channels.signal.accounts.*.historyLimit`) 를 사용하며, 없으면 `messages.groupChat.historyLimit` 로 대체됩니다. 비활성화하려면 `0` 을 설정합니다 (기본값 50).

## 타이핑 + 읽음 확인

- **타이핑 표시**: OpenClaw 는 `signal-cli sendTyping` 를 통해 타이핑 신호를 전송하고, 응답이 실행되는 동안 이를 갱신합니다.
- **읽음 확인**: `channels.signal.sendReadReceipts` 가 true 인 경우, OpenClaw 는 허용된 DM 에 대해 읽음 확인을 전달합니다.
- signal-cli 는 그룹에 대한 읽음 확인을 노출하지 않습니다.

## 반응 (메시지 도구)

- `channel=signal` 와 함께 `message action=react` 를 사용합니다.
- 대상: 발신자 E.164 또는 UUID (페어링 출력의 `uuid:<id>` 사용, 순수 UUID 도 가능).
- `messageId` 는 반응을 추가할 메시지의 Signal 타임스탬프입니다.
- 그룹 반응에는 `targetAuthor` 또는 `targetAuthorUuid` 이 필요합니다.

예시:

```
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅
```

구성:

- `channels.signal.actions.reactions`: 반응 액션 활성화/비활성화 (기본값 true).
- `channels.signal.reactionLevel`: `off | ack | minimal | extensive`.
  - `off`/`ack` 는 에이전트 반응을 비활성화합니다 (메시지 도구 `react` 는 오류 발생).
  - `minimal`/`extensive` 는 에이전트 반응을 활성화하고 가이드 수준을 설정합니다.
- 계정별 오버라이드: `channels.signal.accounts.<id>.actions.reactions`, `channels.signal.accounts.<id>.reactionLevel`.

## 전달 대상 (CLI/cron)

- DM: `signal:+15551234567` (또는 일반 E.164).
- UUID DM: `uuid:<id>` (또는 순수 UUID).
- 그룹: `signal:group:<groupId>`.
- 사용자 이름: `username:<name>` (Signal 계정에서 지원되는 경우).

## 문제 해결

먼저 다음 단계를 실행하십시오:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

그다음 필요 시 DM 페어링 상태를 확인합니다:

```bash
openclaw pairing list signal
```

일반적인 실패 사례:

- 데몬에는 연결되지만 응답이 없음: 계정/데몬 설정 (`httpUrl`, `account`) 과 수신 모드를 확인합니다.
- DM 이 무시됨: 발신자가 페어링 승인 대기 중입니다.
- 그룹 메시지가 무시됨: 그룹 발신자/멘션 게이팅이 전달을 차단합니다.

트리아지 흐름은 [/channels/troubleshooting](/channels/troubleshooting) 을 참고하십시오.

## 구성 참조 (Signal)

전체 구성: [Configuration](/gateway/configuration)

프로바이더 옵션:

- `channels.signal.enabled`: 채널 시작 활성화/비활성화.
- `channels.signal.account`: 봇 계정의 E.164.
- `channels.signal.cliPath`: `signal-cli` 경로.
- `channels.signal.httpUrl`: 전체 데몬 URL (host/port 재정의).
- `channels.signal.httpHost`, `channels.signal.httpPort`: 데몬 바인드 (기본값 127.0.0.1:8080).
- `channels.signal.autoStart`: 데몬 자동 스폰 ( `httpUrl` 미설정 시 기본 true).
- `channels.signal.startupTimeoutMs`: 시작 대기 타임아웃 (ms, 최대 120000).
- `channels.signal.receiveMode`: `on-start | manual`.
- `channels.signal.ignoreAttachments`: 첨부 파일 다운로드 건너뛰기.
- `channels.signal.ignoreStories`: 데몬의 스토리 무시.
- `channels.signal.sendReadReceipts`: 읽음 확인 전달.
- `channels.signal.dmPolicy`: `pairing | allowlist | open | disabled` (기본값: 페어링).
- `channels.signal.allowFrom`: DM 허용 목록 (E.164 또는 `uuid:<id>`). `open` 는 `"*"` 이 필요합니다. Signal 은 사용자 이름이 없으므로 전화번호/UUID ID 를 사용합니다.
- `channels.signal.groupPolicy`: `open | allowlist | disabled` (기본값: 허용 목록).
- `channels.signal.groupAllowFrom`: 그룹 발신자 허용 목록.
- `channels.signal.historyLimit`: 컨텍스트로 포함할 최대 그룹 메시지 수 (0 은 비활성화).
- `channels.signal.dmHistoryLimit`: 사용자 턴 기준 DM 히스토리 제한. 사용자별 오버라이드: `channels.signal.dms["<phone_or_uuid>"].historyLimit`.
- `channels.signal.textChunkLimit`: 발신 분할 크기 (문자 수).
- `channels.signal.chunkMode`: 길이 분할 전에 빈 줄 (문단 경계) 기준으로 나누는 `length` (기본값) 또는 `newline`.
- `channels.signal.mediaMaxMb`: 수신/발신 미디어 제한 (MB).

관련 전역 옵션:

- `agents.list[].groupChat.mentionPatterns` (Signal 은 네이티브 멘션을 지원하지 않습니다).
- `messages.groupChat.mentionPatterns` (전역 폴백).
- `messages.responsePrefix`.
