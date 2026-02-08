---
summary: "Telegram 봇 지원 상태, 기능, 설정 가이드"
read_when:
  - Telegram 기능이나 웹훅 작업 시
title: "Telegram"
---

# Telegram (Bot API)

상태: grammY를 통한 봇 DM + 그룹에서 프로덕션 준비 완료. 기본적으로 long-polling; 웹훅은 선택사항.

## 빠른 설정 (초보자)

1. **@BotFather**로 봇을 생성합니다 ([직접 링크](https://t.me/BotFather)). 핸들이 정확히 `@BotFather`인지 확인하고 토큰을 복사합니다.
2. 토큰을 설정합니다:
   - 환경변수: `TELEGRAM_BOT_TOKEN=...`
   - 또는 설정: `channels.telegram.botToken: "..."`
   - 둘 다 설정되면 설정이 우선합니다 (환경변수 폴백은 기본 계정만).
3. Gateway를 시작합니다.
4. DM 접근은 기본적으로 페어링입니다; 첫 연락 시 페어링 코드를 승인합니다.

최소 설정:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
    },
  },
}
```

## 이것은 무엇인가

- Gateway가 소유하는 Telegram Bot API 채널입니다.
- 결정적 라우팅: 응답은 Telegram으로 돌아갑니다; 모델은 절대 채널을 선택하지 않습니다.
- DM은 에이전트의 메인 세션을 공유합니다; 그룹은 격리됩니다 (`agent:<agentId>:telegram:group:<chatId>`).

## 설정 (빠른 경로)

### 1) 봇 토큰 생성 (BotFather)

1. Telegram을 열고 **@BotFather**와 채팅합니다 ([직접 링크](https://t.me/BotFather)).
2. `/newbot`을 실행하고 프롬프트를 따릅니다 (이름 + `bot`으로 끝나는 사용자명).
3. 토큰을 복사하고 안전하게 저장합니다.

선택적 BotFather 설정:

- `/setjoingroups` — 그룹에 봇 추가 허용/거부
- `/setprivacy` — 봇이 모든 그룹 메시지를 볼 수 있는지 제어

### 2) 토큰 설정 (환경변수 또는 설정)

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

환경변수 옵션: `TELEGRAM_BOT_TOKEN=...` (기본 계정에 작동).

## 작동 방식 (동작)

- 인바운드 메시지는 응답 컨텍스트와 미디어 플레이스홀더가 포함된 공유 채널 봉투로 정규화됩니다.
- 그룹 응답은 기본적으로 멘션이 필요합니다 (네이티브 @멘션 또는 `messages.groupChat.mentionPatterns`).
- 응답은 항상 같은 Telegram 채팅으로 라우팅됩니다.
- Long-polling은 채팅별 시퀀싱과 함께 grammY 러너를 사용합니다; 전체 동시성은 `agents.defaults.maxConcurrent`로 제한됩니다.

## 드래프트 스트리밍

OpenClaw는 `sendMessageDraft`를 사용하여 Telegram DM에서 부분 응답을 스트리밍할 수 있습니다.

요구사항:

- @BotFather에서 봇에 대해 스레드 모드 활성화 (포럼 토픽 모드)
- 프라이빗 채팅 스레드만 (Telegram이 인바운드 메시지에 `message_thread_id`를 포함)
- `channels.telegram.streamMode`가 `"off"`로 설정되지 않음 (기본값: `"partial"`)

드래프트 스트리밍은 DM 전용입니다; Telegram은 그룹이나 채널에서 지원하지 않습니다.

## 포맷팅 (Telegram HTML)

- 아웃바운드 Telegram 텍스트는 `parse_mode: "HTML"` (Telegram의 지원되는 태그 서브셋)을 사용합니다.
- Markdown 유사 입력은 **Telegram 안전 HTML**로 렌더링됩니다.
- Telegram이 HTML 페이로드를 거부하면 OpenClaw는 같은 메시지를 일반 텍스트로 재시도합니다.

## 명령어 (네이티브 + 커스텀)

OpenClaw는 시작 시 Telegram의 봇 메뉴에 네이티브 명령어 (`/status`, `/reset`, `/model` 등)를 등록합니다.
설정을 통해 메뉴에 커스텀 명령어를 추가할 수 있습니다:

```json5
{
  channels: {
    telegram: {
      customCommands: [
        { command: "backup", description: "Git 백업" },
        { command: "generate", description: "이미지 생성" },
      ],
    },
  },
}
```

## 제한사항

- 아웃바운드 텍스트는 `channels.telegram.textChunkLimit`로 청킹됩니다 (기본값 4000).
- 미디어 다운로드/업로드는 `channels.telegram.mediaMaxMb`로 제한됩니다 (기본값 5).
- 그룹 히스토리 컨텍스트는 `channels.telegram.historyLimit`를 사용합니다 (기본값 50).

## 그룹 활성화 모드

기본적으로 봇은 그룹에서 멘션에만 응답합니다. 이 동작을 변경하려면:

### 설정으로 (권장)

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": { requireMention: false }, // 이 그룹에서 항상 응답
      },
    },
  },
}
```

**중요:** `channels.telegram.groups`를 설정하면 **허용 목록**이 생성됩니다 - 나열된 그룹 또는 `"*"`만 허용됩니다.

모든 그룹에서 항상 응답하도록 허용:

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: false }, // 모든 그룹, 항상 응답
      },
    },
  },
}
```

### 명령어로 (세션 레벨)

그룹에서 전송:

- `/activation always` - 모든 메시지에 응답
- `/activation mention` - 멘션 필요 (기본값)

**참고:** 명령어는 세션 상태만 업데이트합니다. 재시작 후에도 지속되는 동작을 원하면 설정을 사용하세요.

### 그룹 채팅 ID 얻기

그룹에서 메시지를 `@userinfobot`이나 `@getidsbot`으로 포워딩하여 채팅 ID를 확인합니다 (음수 숫자, 예: `-1001234567890`).

## 접근 제어 (DM + 그룹)

### DM 접근

- 기본값: `channels.telegram.dmPolicy = "pairing"`. 알 수 없는 발신자는 페어링 코드를 받습니다; 승인될 때까지 메시지는 무시됩니다 (코드는 1시간 후 만료).
- 승인 방법:
  - `openclaw pairing list telegram`
  - `openclaw pairing approve telegram <코드>`

#### Telegram 사용자 ID 찾기

더 안전한 방법 (제3자 봇 없이):

1. Gateway를 시작하고 봇에 DM을 보냅니다.
2. `openclaw logs --follow`를 실행하고 `from.id`를 찾습니다.

대안 (공식 Bot API):

1. 봇에 DM을 보냅니다.
2. 봇 토큰으로 업데이트를 가져오고 `message.from.id`를 읽습니다:

```bash
curl "https://api.telegram.org/bot<봇_토큰>/getUpdates"
```

### 그룹 접근

두 가지 독립적인 제어:

**1. 어떤 그룹이 허용되는지** (`channels.telegram.groups`를 통한 그룹 허용 목록):

- `groups` 설정 없음 = 모든 그룹 허용
- `groups` 설정 있음 = 나열된 그룹 또는 `"*"`만 허용

**2. 어떤 발신자가 허용되는지** (`channels.telegram.groupPolicy`를 통한 발신자 필터링):

- `"open"` = 허용된 그룹의 모든 발신자가 메시지 가능
- `"allowlist"` = `channels.telegram.groupAllowFrom`에 있는 발신자만 메시지 가능
- `"disabled"` = 그룹 메시지 전혀 수락 안 함

기본값은 `groupPolicy: "allowlist"` (`groupAllowFrom`을 추가하지 않으면 차단됨).

## Long-polling vs 웹훅

- 기본값: long-polling (공개 URL 필요 없음).
- 웹훅 모드: `channels.telegram.webhookUrl`과 `channels.telegram.webhookSecret`을 설정합니다.

## 응답 스레딩

Telegram은 태그를 통한 선택적 스레드 응답을 지원합니다:

- `[[reply_to_current]]` -- 트리거 메시지에 응답.
- `[[reply_to:<id>]]` -- 특정 메시지 ID에 응답.

`channels.telegram.replyToMode`로 제어:

- `first` (기본값), `all`, `off`.

## 오디오 메시지 (음성 vs 파일)

Telegram은 **음성 노트** (둥근 버블)와 **오디오 파일** (메타데이터 카드)을 구분합니다.
OpenClaw는 하위 호환성을 위해 기본적으로 오디오 파일을 사용합니다.

에이전트 응답에서 음성 노트 버블을 강제하려면 응답 어디서나 이 태그를 포함하세요:

- `[[audio_as_voice]]` — 오디오를 파일 대신 음성 노트로 전송.

## 스티커

OpenClaw는 지능형 캐싱을 통해 Telegram 스티커 수신 및 전송을 지원합니다.

### 스티커 수신

사용자가 스티커를 보내면 OpenClaw는 스티커 유형에 따라 처리합니다:

- **정적 스티커 (WEBP):** 다운로드하여 비전을 통해 처리.
- **애니메이션 스티커 (TGS):** 건너뜀 (Lottie 포맷 미지원).
- **비디오 스티커 (WEBM):** 건너뜀 (비디오 포맷 미지원).

### 스티커 전송

에이전트는 `sticker` 및 `sticker-search` 액션을 사용하여 스티커를 전송하고 검색할 수 있습니다. 기본적으로 비활성화되어 있으며 설정에서 활성화해야 합니다:

```json5
{
  channels: {
    telegram: {
      actions: {
        sticker: true,
      },
    },
  },
}
```

## 문제 해결

### 봇이 그룹에서 비멘션 메시지에 응답하지 않음

- `channels.telegram.groups.*.requireMention=false`를 설정했다면, Telegram의 Bot API **프라이버시 모드**를 비활성화해야 합니다.
  - BotFather: `/setprivacy` → **Disable** (그런 다음 그룹에서 봇을 제거 + 다시 추가)
- `openclaw channels status`는 설정이 비멘션 그룹 메시지를 기대할 때 경고를 표시합니다.

### 봇이 그룹 메시지를 전혀 보지 못함

- `channels.telegram.groups`가 설정되어 있으면 그룹이 나열되거나 `"*"`가 사용되어야 함
- @BotFather에서 프라이버시 설정 확인 → "Group Privacy"가 **OFF**여야 함
- 봇이 실제로 멤버인지 확인 (읽기 권한 없는 관리자만이 아닌)

### `/status` 같은 명령어가 작동하지 않음

- Telegram 사용자 ID가 승인되었는지 확인 (페어링 또는 `channels.telegram.allowFrom`을 통해)
- 명령어는 `groupPolicy: "open"`인 그룹에서도 승인이 필요합니다

### 봇이 시작되었다가 조용히 응답을 멈춤

- 일부 호스트는 `api.telegram.org`를 IPv6로 먼저 해석합니다. 서버에 작동하는 IPv6 이그레스가 없으면 grammY가 IPv6 전용 요청에서 멈출 수 있습니다.
- IPv6 이그레스를 활성화하거나 `api.telegram.org`에 대해 IPv4 해석을 강제한 다음 Gateway를 재시작합니다.

## 설정 참조 (Telegram)

전체 설정: [설정](/ko-KR/gateway/configuration)

| 설정 키                            | 설명                                                         |
| ---------------------------------- | ------------------------------------------------------------ |
| `channels.telegram.enabled`        | 채널 시작 활성화/비활성화                                    |
| `channels.telegram.botToken`       | 봇 토큰 (BotFather)                                          |
| `channels.telegram.dmPolicy`       | `pairing \| allowlist \| open \| disabled` (기본값: pairing) |
| `channels.telegram.allowFrom`      | DM 허용 목록 (ID/사용자명)                                   |
| `channels.telegram.groupPolicy`    | `open \| allowlist \| disabled` (기본값: allowlist)          |
| `channels.telegram.groupAllowFrom` | 그룹 발신자 허용 목록                                        |
| `channels.telegram.groups`         | 그룹별 기본값 + 허용 목록                                    |
| `channels.telegram.textChunkLimit` | 아웃바운드 청크 크기 (문자)                                  |
| `channels.telegram.mediaMaxMb`     | 인바운드/아웃바운드 미디어 제한 (MB)                         |
| `channels.telegram.webhookUrl`     | 웹훅 모드 활성화                                             |
| `channels.telegram.webhookSecret`  | 웹훅 시크릿 (필수)                                           |
