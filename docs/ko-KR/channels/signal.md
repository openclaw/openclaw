---
summary: "signal-cli (JSON-RPC + SSE)를 통한 Signal 지원, 설정 경로 및 번호 모델"
read_when:
  - Signal 지원 설정하기
  - Signal 송수신 디버깅
title: "Signal"
---

# Signal (signal-cli)

상태: 외부 CLI 통합. 게이트웨이는 `signal-cli`와 HTTP JSON-RPC + SSE를 통해 통신합니다.

## Prerequisites

- 서버에 OpenClaw가 설치되어 있어야 합니다 (아래 Linux 흐름은 Ubuntu 24에서 테스트됨).
- `signal-cli`는 게이트웨이가 실행되는 호스트에 있어야 합니다.
- SMS 등록 경로를 위한 SMS 인증을 받을 수 있는 전화번호가 필요합니다.
- 등록 중 Signal captcha (`signalcaptchas.org`)를 위한 브라우저 액세스.

## Quick setup (beginner)

1. 봇을 위한 **별도의 Signal 번호**를 사용합니다 (권장).
2. `signal-cli`를 설치합니다 (JVM 빌드를 사용할 경우 Java 필요).
3. 하나의 설정 경로를 선택하세요:
   - **경로 A (QR 링크):** `signal-cli link -n "OpenClaw"`를 실행하고 Signal로 QR을 스캔합니다.
   - **경로 B (SMS 등록):** 캡차 + SMS 인증을 통해 전용 번호를 등록합니다.
4. OpenClaw를 구성하고 게이트웨이를 재시작합니다.
5. 첫 번째 다이렉트 메시지를 보내고 페어링을 승인합니다 (`openclaw pairing approve signal <CODE>`).

Minimal config:

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

Field reference:

| Field       | Description                                       |
| ----------- | ------------------------------------------------- |
| `account`   | Bot phone number in E.164 format (`+15551234567`) |
| `cliPath`   | Path to `signal-cli` (`signal-cli` if on `PATH`)  |
| `dmPolicy`  | DM access policy (`pairing` recommended)          |
| `allowFrom` | Phone numbers or `uuid:<id>` values allowed to DM |

## What it is

- Signal 채널은 `signal-cli`를 통합니다 (임베디드 libsignal 아님).
- 결정적 라우팅: 응답은 항상 Signal로 되돌아갑니다.
- 다이렉트 메시지는 에이전트의 메인 세션을 공유하며, 그룹은 격리됩니다 (`agent:<agentId>:signal:group:<groupId>`).

## Config writes

기본적으로, Signal은 `/config set|unset`에 의해 트리거되는 설정 업데이트를 쓰도록 허용됩니다 (`commands.config: true` 필요).

비활성화 방법:

```json5
{
  channels: { signal: { configWrites: false } },
}
```

## The number model (important)

- 게이트웨이는 **Signal 장치** (`signal-cli` 계정)에 연결됩니다.
- **개인 Signal 계정**에 봇을 실행하면, 자신의 메시지를 무시하게 됩니다 (루프 보호).
- "나는 봇에게 문자를 보내고 봇이 응답한다"는 기능을 수행하려면, **별도의 봇 번호**를 사용하세요.

## Setup path A: link existing Signal account (QR)

1. `signal-cli`를 설치합니다 (JVM 또는 네이티브 빌드).
2. 봇 계정을 연결합니다:
   - `signal-cli link -n "OpenClaw"`를 실행한 후 Signal로 QR을 스캔합니다.
3. Signal을 구성하고 게이트웨이를 시작합니다.

Example:

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

멀티 계정 지원: 각 계정별 설정과 선택적 `name`을 사용하여 `channels.signal.accounts`를 사용하세요. 공유 패턴에 대한 내용은 [`gateway/configuration`](/ko-KR/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts)을 참조하십시오.

## Setup path B: register dedicated bot number (SMS, Linux)

기존 Signal 앱 계정을 연결하는 대신 전용 봇 번호를 사용하고자 할 때 이 방법을 사용하세요.

1. SMS를 받을 수 있는 번호를 준비합니다 (또는 유선 전화용 음성 인증).
   - 계정/세션 충돌을 피하기 위해 전용 봇 번호를 사용하세요.
2. 게이트웨이 호스트에 `signal-cli`를 설치합니다:

```bash
VERSION=$(curl -Ls -o /dev/null -w %{url_effective} https://github.com/AsamK/signal-cli/releases/latest | sed -e 's/^.*\/v//')
curl -L -O "https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}-Linux-native.tar.gz"
sudo tar xf "signal-cli-${VERSION}-Linux-native.tar.gz" -C /opt
sudo ln -sf /opt/signal-cli /usr/local/bin/
signal-cli --version
```

JVM 빌드(`signal-cli-${VERSION}.tar.gz`)를 사용할 경우, 우선 JRE 25+를 설치하세요. `signal-cli`를 업데이트 상태로 유지하세요; 상위 릴리스가 Signal 서버 API 변경에 따라 깨질 수 있습니다.

3. 번호를 등록하고 인증 받습니다:

```bash
signal-cli -a +<BOT_PHONE_NUMBER> register
```

캡차가 필요한 경우:

1. `https://signalcaptchas.org/registration/generate.html`을 엽니다.
2. 캡차를 완료하고 "Open Signal"에서 `signalcaptcha://...` 링크 대상을 복사합니다.
3. 가능한 경우, 브라우저 세션과 동일한 외부 IP에서 실행합니다.
4. 즉시 등록을 다시 실행합니다 (캡차 토큰은 빨리 만료됩니다):

```bash
signal-cli -a +<BOT_PHONE_NUMBER> register --captcha '<SIGNALCAPTCHA_URL>'
signal-cli -a +<BOT_PHONE_NUMBER> verify <VERIFICATION_CODE>
```

4. OpenClaw를 구성하고, 게이트웨이를 재시작하고, 채널을 확인합니다:

```bash
# 사용자 시스템d 서비스로 게이트웨이를 실행하는 경우:
systemctl --user restart openclaw-gateway

# 그런 다음 확인:
openclaw doctor
openclaw channels status --probe
```

5. DM 발신자를 페어링합니다:
   - 봇 번호로 메시지를 보냅니다.
   - 서버에서 코드를 승인합니다: `openclaw pairing approve signal <PAIRING_CODE>`.
   - 전화기에 봇 번호를 연락처로 저장하여 "알 수 없는 연락처"를 방지하세요.

중요: `signal-cli`로 전화번호 계정을 등록하는 것은 해당 번호의 메인 Signal 앱 세션을 비인증화할 수 있습니다. 전용 봇 번호를 사용하거나, 기존 전화 앱 설정을 유지하기 위해 QR 링크 모드를 사용하세요.

상위 자료:

- `signal-cli` README: `https://github.com/AsamK/signal-cli`
- 캡차 흐름: `https://github.com/AsamK/signal-cli/wiki/Registration-with-captcha`
- 연결 흐름: `https://github.com/AsamK/signal-cli/wiki/Linking-other-devices-(Provisioning)`

## External daemon mode (httpUrl)

`signal-cli`를 직접 관리하려는 경우 (느린 JVM 콜드 스타트, 컨테이너 초기화, 공유 CPU), 별도로 데몬을 실행하고 OpenClaw에 지시하십시오:

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

이렇게 하면 OpenClaw 내부에서 자동 스폰 및 시작 대기 시간이 건너뜁니다. 자동 스폰 시 느린 스타트업을 피하려면 `channels.signal.startupTimeoutMs`를 설정하세요.

## Access control (DMs + groups)

DMs:

- 기본값: `channels.signal.dmPolicy = "pairing"`.
- 알려지지 않은 발신자는 페어링 코드를 받으며, 승인 전까지 메시지가 무시됩니다 (코드는 1시간 후 만료).
- 다음을 통해 승인:
  - `openclaw pairing list signal`
  - `openclaw pairing approve signal <CODE>`
- 페어링은 Signal 다이렉트 메시지의 기본 토큰 교환입니다. 자세한 내용: [Pairing](/ko-KR/channels/pairing)
- UUID 전용 발신자 (`sourceUuid`에서)는 `channels.signal.allowFrom`에 `uuid:<id>`로 저장됩니다.

Groups:

- `channels.signal.groupPolicy = open | allowlist | disabled`.
- `allowlist`가 설정된 경우 `channels.signal.groupAllowFrom`이 그룹 내에서 트리거할 수 있는 대상자를 제어합니다.

## How it works (behavior)

- `signal-cli`는 데몬으로 실행되며, 게이트웨이는 SSE를 통해 이벤트를 읽습니다.
- 수신 메시지는 공유 채널 봉투로 정규화됩니다.
- 응답은 항상 동일한 번호 또는 그룹으로 되돌아갑니다.

## Media + limits

- 아웃바운드 텍스트는 `channels.signal.textChunkLimit`로 청크됩니다 (기본값 4000).
- 선택적 새줄 청크 처리: `channels.signal.chunkMode="newline"`을 설정하여 길이 청크 처리 전 빈 줄(단락 경계)에서 분할합니다.
- 첨부 파일 지원(base64는 `signal-cli`에서 가져옵니다).
- 기본 미디어 상한: `channels.signal.mediaMaxMb` (기본값 8).
- `channels.signal.ignoreAttachments`를 사용하여 미디어 다운로드를 건너뜁니다.
- 그룹의 이력 맥락은 `channels.signal.historyLimit`(또는 `channels.signal.accounts.*.historyLimit`)을 사용하며, 기본적으로 `messages.groupChat.historyLimit`로 되돌아 갑니다. 비활성화하려면 `0`으로 설정합니다 (기본값 50).

## Typing + read receipts

- **입력 지시자**: OpenClaw는 `signal-cli sendTyping`를 통해 입력 신호를 보내며, 응답이 실행 중일 때 이를 갱신합니다.
- **읽음 확인**: `channels.signal.sendReadReceipts`가 true이면, OpenClaw는 승인된 다이렉트 메시지의 읽음 확인을 전달합니다.
- Signal-cli는 그룹에 대한 읽음 확인을 노출하지 않습니다.

## Reactions (message tool)

- `channel=signal`로 `message action=react`를 사용합니다.
- 대상: 발신자 E.164 또는 UUID (`uuid:<id>`를 페어링 출력에서 사용; 맨 숫자 UUID도 작동).
- `messageId`는 반응할 메시지의 Signal 타임스탬프입니다.
- 그룹 반응은 `targetAuthor` 또는 `targetAuthorUuid`가 필요합니다.

예:

```
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅
```

Config:

- `channels.signal.actions.reactions`: 반응 액션 활성화/비활성화 (기본값 true).
- `channels.signal.reactionLevel`: `off | ack | minimal | extensive`.
  - `off`/`ack`는 에이전트 반응을 비활성화합니다 (메시지 도구 `react`는 오류를 발생시킴).
  - `minimal`/`extensive`는 에이전트 반응을 활성화하고 안내 수준을 설정합니다.
- 계정별 오버라이드: `channels.signal.accounts.<id>.actions.reactions`, `channels.signal.accounts.<id>.reactionLevel`.

## Delivery targets (CLI/cron)

- DMs: `signal:+15551234567` (또는 평범한 E.164).
- UUID DMs: `uuid:<id>` (또는 단순 UUID).
- 그룹: `signal:group:<groupId>`.
- 사용자 이름: `username:<name>` (Signal 계정에서 지원되는 경우).

## Troubleshooting

다음 계단을 먼저 실행하세요:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

필요한 경우 DM 페어링 상태를 확인하세요:

```bash
openclaw pairing list signal
```

일반적인 실패:

- 데몬 도달 가능하지만 응답 없음: 계정/데몬 설정(`httpUrl`, `account`)과 수신 모드를 확인하세요.
- 무시된 DMs: 발신자가 페어링 승인을 기다리는 중입니다.
- 무시된 그룹 메시지: 그룹 발신자/멘션 게이팅이 전송을 차단합니다.
- 수정 후 구성 검증 오류: `openclaw doctor --fix`를 실행하세요.
- 진단에서 Signal이 누락: `channels.signal.enabled: true`를 확인하세요.

추가 확인:

```bash
openclaw pairing list signal
pgrep -af signal-cli
grep -i "signal" "/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log" | tail -20
```

문제해결 흐름: [/channels/troubleshooting](/ko-KR/channels/troubleshooting).

## Security notes

- `signal-cli`는 계정 키를 로컬에 저장합니다 (일반적으로 `~/.local/share/signal-cli/data/`).
- 서버 마이그레이션 또는 재설치 전에 Signal 계정 상태를 백업하세요.
- `channels.signal.dmPolicy: "pairing"`을 유지하세요. 더 넓은 DM 접근을 명시적으로 원하는 경우가 아니면.
- SMS 인증은 등록이나 복구 흐름에만 필요하며, 번호/계정 관리가 어려워질 수 있습니다.

## Configuration reference (Signal)

전체 구성: [Configuration](/ko-KR/gateway/configuration)

프로바이더 옵션:

- `channels.signal.enabled`: 채널 시작 활성화/비활성화.
- `channels.signal.account`: E.164 형식의 봇 계정.
- `channels.signal.cliPath`: `signal-cli`의 경로.
- `channels.signal.httpUrl`: 전체 데몬 URL (호스트/포트 우선).
- `channels.signal.httpHost`, `channels.signal.httpPort`: 데몬 바인드 (기본값 127.0.0.1:8080).
- `channels.signal.autoStart`: 데몬 자동 스폰 (기본 true, `httpUrl` 미설정 시).
- `channels.signal.startupTimeoutMs`: 시작 대기 시간 제한 (ms 기준, 상한 120000).
- `channels.signal.receiveMode`: `on-start | manual`.
- `channels.signal.ignoreAttachments`: 첨부 파일 다운로드 건너뜀.
- `channels.signal.ignoreStories`: 데몬의 스토리 무시.
- `channels.signal.sendReadReceipts`: 읽음 확인 전달.
- `channels.signal.dmPolicy`: `pairing | allowlist | open | disabled` (기본값: pairing).
- `channels.signal.allowFrom`: DM 허용 목록 (E.164 또는 `uuid:<id>`). `open`은 `"*"` 필요. Signal에는 사용자 이름이 없으므로 전화번호/UUID ids 사용.
- `channels.signal.groupPolicy`: `open | allowlist | disabled` (기본값: allowlist).
- `channels.signal.groupAllowFrom`: 그룹 발신자 허용 목록.
- `channels.signal.historyLimit`: 맥락에 포함할 최대 그룹 메시지 수 (0은 비활성화).
- `channels.signal.dmHistoryLimit`: 사용자 턴 내 DM 히스토리 제한. 사용자별 오버라이드: `channels.signal.dms["<phone_or_uuid>"].historyLimit`.
- `channels.signal.textChunkLimit`: 아웃바운드 청크 크기 (문자 기준).
- `channels.signal.chunkMode`: `length` (기본값) 또는 `newline`을 선택하여, 길이 청크 처리 전 빈 줄(단락 경계)에서 분할.
- `channels.signal.mediaMaxMb`: 인바운드/아웃바운드 미디어 상한 (MB).

관련 글로벌 옵션:

- `agents.list[].groupChat.mentionPatterns` (Signal은 네이티브 멘션을 지원하지 않음).
- `messages.groupChat.mentionPatterns` (글로벌 백업).
- `messages.responsePrefix`.
