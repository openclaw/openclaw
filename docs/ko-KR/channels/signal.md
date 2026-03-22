---
summary: "signal-cli (JSON-RPC + SSE) 를 통한 Signal 지원, 설정 경로, 번호 모델"
read_when:
  - Signal 지원을 설정하는 경우
  - Signal 송수신을 디버깅하는 경우
title: "Signal"
x-i18n:
  source_path: docs/channels/signal.md
---

# Signal (signal-cli)

상태: 외부 CLI 통합. Gateway 는 HTTP JSON-RPC + SSE 를 통해 `signal-cli` 와 통신합니다.

## 사전 요구 사항

- 서버에 OpenClaw 설치 (아래 Linux 흐름은 Ubuntu 24 에서 테스트됨).
- Gateway 가 실행되는 호스트에서 `signal-cli` 사용 가능.
- 인증 SMS 를 수신할 수 있는 전화번호 (SMS 등록 경로용).
- 등록 중 Signal captcha (`signalcaptchas.org`) 를 위한 브라우저 접근.

## 빠른 설정 (초보자)

1. 봇용 **별도의 Signal 번호** 사용 (권장).
2. `signal-cli` 설치 (JVM 빌드를 사용하는 경우 Java 필요).
3. 설정 경로 중 하나를 선택합니다:
   - **경로 A (QR 링크):** `signal-cli link -n "OpenClaw"` 후 Signal 로 스캔.
   - **경로 B (SMS 등록):** captcha + SMS 인증으로 전용 번호 등록.
4. OpenClaw 를 구성하고 Gateway 를 재시작합니다.
5. 첫 DM 을 보내고 페어링을 승인합니다 (`openclaw pairing approve signal <CODE>`).

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

필드 참조:

| 필드        | 설명                                              |
| ----------- | ------------------------------------------------- |
| `account`   | E.164 형식의 봇 전화번호 (`+15551234567`)         |
| `cliPath`   | `signal-cli` 경로 (`PATH` 에 있으면 `signal-cli`) |
| `dmPolicy`  | DM 접근 정책 (`pairing` 권장)                     |
| `allowFrom` | DM 이 허용된 전화번호 또는 `uuid:<id>` 값         |

## 이것이 무엇인가

- `signal-cli` 를 통한 Signal 채널 (내장 libsignal 아님).
- 결정적 라우팅: 응답은 항상 Signal 로 돌아갑니다.
- DM 은 에이전트의 메인 세션을 공유합니다. 그룹은 격리됩니다 (`agent:<agentId>:signal:group:<groupId>`).

## 구성 쓰기

기본적으로 Signal 은 `/config set|unset` 에 의해 트리거되는 구성 업데이트를 쓸 수 있습니다 (`commands.config: true` 필요).

비활성화:

```json5
{
  channels: { signal: { configWrites: false } },
}
```

## 번호 모델 (중요)

- Gateway 는 **Signal 장치** (`signal-cli` 계정) 에 연결합니다.
- **개인 Signal 계정**에서 봇을 실행하면 자신의 메시지를 무시합니다 (루프 보호).
- "내가 봇에 문자를 보내면 답장하는" 경우에는 **별도의 봇 번호**를 사용합니다.

## 설정 경로 A: 기존 Signal 계정 연결 (QR)

1. `signal-cli` 설치 (JVM 또는 네이티브 빌드).
2. 봇 계정 연결:
   - `signal-cli link -n "OpenClaw"` 후 Signal 에서 QR 스캔.
3. Signal 을 구성하고 Gateway 를 시작합니다.

다중 계정 지원: 계정별 구성과 선택적 `name` 으로 `channels.signal.accounts` 를 사용합니다. 공유 패턴은 [`gateway/configuration`](/gateway/configuration-reference#multi-account-all-channels) 을 참조하세요.

## 설정 경로 B: 전용 봇 번호 등록 (SMS, Linux)

기존 Signal 앱 계정을 연결하는 대신 전용 봇 번호가 필요할 때 사용합니다.

1. SMS 를 수신할 수 있는 번호를 받습니다.
2. Gateway 호스트에 `signal-cli` 를 설치합니다.
3. 번호를 등록하고 인증합니다.
4. OpenClaw 를 구성하고 Gateway 를 재시작하고 채널을 확인합니다.
5. DM 발신자를 페어링합니다.

중요: `signal-cli` 로 전화번호 계정을 등록하면 해당 번호의 메인 Signal 앱 세션이 인증 해제될 수 있습니다. 전용 봇 번호를 권장하거나, 기존 전화 앱 설정을 유지해야 하는 경우 QR 링크 모드를 사용하세요.

## 외부 데몬 모드 (httpUrl)

`signal-cli` 를 직접 관리하려면 (느린 JVM 콜드 스타트, 컨테이너 초기화, 공유 CPU) 데몬을 별도로 실행하고 OpenClaw 를 가리킵니다:

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

## 접근 제어 (DM + 그룹)

DM:

- 기본값: `channels.signal.dmPolicy = "pairing"`.
- 알 수 없는 발신자에게 페어링 코드가 제공됩니다. 승인될 때까지 메시지가 무시됩니다 (코드는 1 시간 후 만료).
- 승인:
  - `openclaw pairing list signal`
  - `openclaw pairing approve signal <CODE>`
- UUID 전용 발신자 (`sourceUuid` 에서) 는 `channels.signal.allowFrom` 에 `uuid:<id>` 로 저장됩니다.

그룹:

- `channels.signal.groupPolicy = open | allowlist | disabled`.
- `channels.signal.groupAllowFrom` 은 `allowlist` 가 설정될 때 그룹에서 트리거할 수 있는 사람을 제어합니다.
- `channels.signal.groups["<group-id>" | "*"]` 로 `requireMention`, `tools`, `toolsBySender` 를 통해 그룹 동작을 재정의할 수 있습니다.

## 미디어 + 제한

- 아웃바운드 텍스트는 `channels.signal.textChunkLimit` (기본값 4000) 로 청크됩니다.
- 선택적 줄바꿈 청킹: `channels.signal.chunkMode="newline"` 설정.
- 첨부 파일 지원 (base64, `signal-cli` 에서 가져옴).
- 기본 미디어 제한: `channels.signal.mediaMaxMb` (기본값 8).

## 타이핑 + 읽음 확인

- **타이핑 인디케이터**: OpenClaw 는 `signal-cli sendTyping` 을 통해 타이핑 신호를 보내고 응답 실행 중 갱신합니다.
- **읽음 확인**: `channels.signal.sendReadReceipts` 가 true 이면, OpenClaw 는 허용된 DM 에 대해 읽음 확인을 전달합니다.

## 리액션 (message 도구)

- `channel=signal` 로 `message action=react` 를 사용합니다.
- 대상: 발신자 E.164 또는 UUID.
- `messageId` 는 리액션할 메시지의 Signal 타임스탬프입니다.
- 그룹 리액션에는 `targetAuthor` 또는 `targetAuthorUuid` 가 필요합니다.

구성:

- `channels.signal.actions.reactions`: 리액션 액션 활성화/비활성화 (기본값 true).
- `channels.signal.reactionLevel`: `off | ack | minimal | extensive`.

## 전달 대상 (CLI/cron)

- DM: `signal:+15551234567` (또는 평문 E.164).
- UUID DM: `uuid:<id>` (또는 베어 UUID).
- 그룹: `signal:group:<groupId>`.
- 사용자명: `username:<name>` (Signal 계정이 지원하는 경우).

## 문제 해결

먼저 이 순서를 실행합니다:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

그런 다음 필요한 경우 DM 페어링 상태를 확인합니다:

```bash
openclaw pairing list signal
```

일반적인 실패:

- 데몬 도달 가능하지만 응답 없음: 계정/데몬 설정 (`httpUrl`, `account`) 및 수신 모드를 확인합니다.
- DM 무시됨: 발신자가 페어링 승인 대기 중.
- 그룹 메시지 무시됨: 그룹 발신자/멘션 게이팅이 전달을 차단합니다.
- 편집 후 구성 검증 오류: `openclaw doctor --fix` 를 실행합니다.
- 진단에서 Signal 누락: `channels.signal.enabled: true` 를 확인합니다.

분류 흐름은: [/channels/troubleshooting](/channels/troubleshooting) 을 참조하세요.

## 보안 참고

- `signal-cli` 는 계정 키를 로컬에 저장합니다 (일반적으로 `~/.local/share/signal-cli/data/`).
- 서버 마이그레이션이나 재빌드 전에 Signal 계정 상태를 백업하세요.
- 더 넓은 DM 접근을 명시적으로 원하지 않는 한 `channels.signal.dmPolicy: "pairing"` 을 유지하세요.

## 구성 참조 (Signal)

전체 구성: [Configuration](/gateway/configuration)

프로바이더 옵션:

- `channels.signal.enabled`: 채널 시작 활성화/비활성화.
- `channels.signal.account`: 봇 계정의 E.164.
- `channels.signal.cliPath`: `signal-cli` 경로.
- `channels.signal.httpUrl`: 전체 데몬 URL (host/port 재정의).
- `channels.signal.httpHost`, `channels.signal.httpPort`: 데몬 바인드 (기본값 127.0.0.1:8080).
- `channels.signal.autoStart`: 데몬 자동 생성 (`httpUrl` 이 미설정이면 기본값 true).
- `channels.signal.startupTimeoutMs`: 시작 대기 타임아웃 (ms, 최대 120000).
- `channels.signal.dmPolicy`: `pairing | allowlist | open | disabled` (기본값: pairing).
- `channels.signal.allowFrom`: DM 허용 목록 (E.164 또는 `uuid:<id>`). `open` 은 `"*"` 필요.
- `channels.signal.groupPolicy`: `open | allowlist | disabled` (기본값: allowlist).
- `channels.signal.groupAllowFrom`: 그룹 발신자 허용 목록.
- `channels.signal.groups`: Signal 그룹 ID (또는 `"*"`) 로 키가 지정된 그룹별 재정의.
- `channels.signal.historyLimit`: 컨텍스트로 포함할 최대 그룹 메시지 (0 은 비활성화).
- `channels.signal.textChunkLimit`: 아웃바운드 청크 크기 (문자).
- `channels.signal.chunkMode`: `length` (기본값) 또는 `newline`.
- `channels.signal.mediaMaxMb`: 인바운드/아웃바운드 미디어 제한 (MB).

관련 전역 옵션:

- `agents.list[].groupChat.mentionPatterns` (Signal 은 네이티브 멘션을 지원하지 않음).
- `messages.groupChat.mentionPatterns` (전역 폴백).
- `messages.responsePrefix`.
