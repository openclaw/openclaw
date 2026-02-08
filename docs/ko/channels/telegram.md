---
summary: "Telegram 봇 지원 상태, 기능 및 구성"
read_when:
  - Telegram 기능 또는 웹훅을 작업할 때
title: "Telegram"
x-i18n:
  source_path: channels/telegram.md
  source_hash: 604e2dc12d2b776d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:25:19Z
---

# Telegram (Bot API)

상태: grammY 를 통한 봇 다이렉트 메시지 + 그룹에 대해 프로덕션 준비 완료. 기본은 롱 폴링이며, 웹훅은 선택 사항입니다.

## 빠른 설정 (초보자)

1. **@BotFather** 로 봇을 생성합니다 ([직접 링크](https://t.me/BotFather)). 핸들이 정확히 `@BotFather` 인지 확인한 다음 토큰을 복사합니다.
2. 토큰을 설정합니다:
   - 환경 변수: `TELEGRAM_BOT_TOKEN=...`
   - 또는 설정: `channels.telegram.botToken: "..."`.
   - 둘 다 설정된 경우 설정 값이 우선합니다 (환경 변수 폴백은 기본 계정에만 적용).
3. Gateway 를 시작합니다.
4. 다이렉트 메시지 접근은 기본적으로 페어링 방식입니다. 첫 연락 시 페어링 코드를 승인합니다.

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

## 개요

- Gateway 가 소유하는 Telegram Bot API 채널입니다.
- 결정적 라우팅: 응답은 항상 Telegram 으로 돌아가며, 모델은 채널을 선택하지 않습니다.
- 다이렉트 메시지는 에이전트의 메인 세션을 공유하고, 그룹은 분리됩니다 (`agent:<agentId>:telegram:group:<chatId>`).

## 설정 (빠른 경로)

### 1) 봇 토큰 생성 (BotFather)

1. Telegram 을 열고 **@BotFather** 와 대화합니다 ([직접 링크](https://t.me/BotFather)). 핸들이 정확히 `@BotFather` 인지 확인합니다.
2. `/newbot` 를 실행한 뒤 안내에 따라 이름과 사용자 이름(끝이 `bot`)을 설정합니다.
3. 토큰을 복사하여 안전하게 보관합니다.

선택적 BotFather 설정:

- `/setjoingroups` — 봇을 그룹에 추가하는 것을 허용/차단합니다.
- `/setprivacy` — 봇이 그룹의 모든 메시지를 볼 수 있는지 제어합니다.

### 2) 토큰 구성 (환경 변수 또는 설정)

예시:

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

환경 변수 옵션: `TELEGRAM_BOT_TOKEN=...` (기본 계정에서 작동).
환경 변수와 설정이 모두 있는 경우 설정이 우선합니다.

다중 계정 지원: 계정별 토큰과 선택적 `name` 를 사용하여 `channels.telegram.accounts` 를 구성합니다. 공통 패턴은 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) 을 참고하십시오.

3. Gateway 를 시작합니다. 토큰이 해석되면 Telegram 이 시작됩니다 (설정 우선, 환경 변수 폴백).
4. 다이렉트 메시지 접근은 기본적으로 페어링입니다. 봇에 처음 연락할 때 코드를 승인합니다.
5. 그룹의 경우: 봇을 추가하고 프라이버시/관리자 동작을 결정한 다음(아래 참고), 언급 게이팅과 허용 목록을 제어하기 위해 `channels.telegram.groups` 를 설정합니다.

## 토큰 + 프라이버시 + 권한 (Telegram 측)

### 토큰 생성 (BotFather)

- `/newbot` 는 봇을 생성하고 토큰을 반환합니다 (비밀로 유지하십시오).
- 토큰이 유출되면 @BotFather 를 통해 폐기/재생성하고 설정을 업데이트하십시오.

### 그룹 메시지 가시성 (프라이버시 모드)

Telegram 봇은 기본적으로 **프라이버시 모드**가 활성화되어 있어 수신하는 그룹 메시지가 제한됩니다.
봇이 그룹의 _모든_ 메시지를 봐야 한다면 두 가지 방법이 있습니다:

- `/setprivacy` 로 프라이버시 모드를 비활성화 **또는**
- 봇을 그룹 **관리자**로 추가 (관리자 봇은 모든 메시지를 수신).

**참고:** 프라이버시 모드를 전환하면, 변경 사항을 적용하려면 Telegram 이 각 그룹에서 봇을 제거한 후 다시 추가할 것을 요구합니다.

### 그룹 권한 (관리자 권한)

관리자 상태는 그룹 내 Telegram UI 에서 설정합니다. 관리자 봇은 항상 모든 그룹 메시지를 수신하므로, 완전한 가시성이 필요하다면 관리자를 사용하십시오.

## 동작 방식

- 수신 메시지는 응답 컨텍스트와 미디어 플레이스홀더를 포함한 공유 채널 엔벨로프로 정규화됩니다.
- 그룹 응답은 기본적으로 언급이 필요합니다 (기본 @멘션 또는 `agents.list[].groupChat.mentionPatterns` / `messages.groupChat.mentionPatterns`).
- 다중 에이전트 오버라이드: `agents.list[].groupChat.mentionPatterns` 에서 에이전트별 패턴을 설정합니다.
- 응답은 항상 동일한 Telegram 채팅으로 라우팅됩니다.
- 롱 폴링은 grammY 러너를 사용하며 채팅별 시퀀싱을 적용합니다. 전체 동시성은 `agents.defaults.maxConcurrent` 로 제한됩니다.
- Telegram Bot API 는 읽음 확인을 지원하지 않으므로 `sendReadReceipts` 옵션은 없습니다.

## 초안 스트리밍

OpenClaw 는 `sendMessageDraft` 를 사용하여 Telegram 다이렉트 메시지에서 부분 응답 스트리밍을 지원합니다.

요구 사항:

- @BotFather 에서 봇에 대해 스레드 모드(포럼 토픽 모드)가 활성화되어 있어야 합니다.
- 비공개 채팅 스레드만 지원됩니다 (Telegram 은 수신 메시지에 `message_thread_id` 를 포함합니다).
- `channels.telegram.streamMode` 가 `"off"` 로 설정되어 있지 않아야 합니다 (기본값: `"partial"`, `"block"` 는 청크 단위 초안 업데이트를 활성화).

초안 스트리밍은 다이렉트 메시지 전용이며, Telegram 은 그룹이나 채널에서는 이를 지원하지 않습니다.

## 포맷팅 (Telegram HTML)

- 발신 Telegram 텍스트는 `parse_mode: "HTML"` (Telegram 이 지원하는 태그 하위 집합)을 사용합니다.
- Markdown 유사 입력은 **Telegram 안전 HTML**(굵게/기울임/취소선/코드/링크)로 렌더링되며, 블록 요소는 줄바꿈/불릿을 포함한 텍스트로 평탄화됩니다.
- 모델이 생성한 원시 HTML 은 Telegram 파싱 오류를 방지하기 위해 이스케이프됩니다.
- Telegram 이 HTML 페이로드를 거부하면, OpenClaw 는 동일한 메시지를 일반 텍스트로 재시도합니다.

## 명령어 (기본 + 사용자 정의)

OpenClaw 는 시작 시 `/status`, `/reset`, `/model` 와 같은 기본 명령어를 Telegram 의 봇 메뉴에 등록합니다.
설정을 통해 메뉴에 사용자 정의 명령어를 추가할 수 있습니다:

```json5
{
  channels: {
    telegram: {
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
    },
  },
}
```

## 설정 문제 해결 (명령어)

- 로그에 `setMyCommands failed` 가 표시되면 일반적으로 `api.telegram.org` 로의 아웃바운드 HTTPS/DNS 가 차단된 것입니다.
- `sendMessage` 또는 `sendChatAction` 실패가 보이면 IPv6 라우팅과 DNS 를 확인하십시오.

추가 도움말: [채널 문제 해결](/channels/troubleshooting).

참고 사항:

- 사용자 정의 명령어는 **메뉴 항목 전용**입니다. OpenClaw 는 별도로 처리하지 않으면 이를 구현하지 않습니다.
- 명령어 이름은 정규화됩니다 (선행 `/` 제거, 소문자화) 그리고 `a-z`, `0-9`, `_` (1–32 자)와 일치해야 합니다.
- 사용자 정의 명령어는 **기본 명령어를 재정의할 수 없습니다**. 충돌은 무시되고 로그에 기록됩니다.
- `commands.native` 가 비활성화되면 사용자 정의 명령어만 등록됩니다 (없으면 제거).

## 제한 사항

- 발신 텍스트는 `channels.telegram.textChunkLimit` 으로 분할됩니다 (기본 4000).
- 선택적 줄바꿈 분할: 길이 분할 전에 빈 줄(문단 경계)에서 분할하려면 `channels.telegram.chunkMode="newline"` 를 설정하십시오.
- 미디어 다운로드/업로드는 `channels.telegram.mediaMaxMb` 로 제한됩니다 (기본 5).
- Telegram Bot API 요청은 `channels.telegram.timeoutSeconds` 후 타임아웃됩니다 (grammY 기준 기본 500). 긴 대기를 피하려면 더 낮게 설정하십시오.
- 그룹 히스토리 컨텍스트는 `channels.telegram.historyLimit` (또는 `channels.telegram.accounts.*.historyLimit`)를 사용하며, `messages.groupChat.historyLimit` 로 폴백합니다. 비활성화하려면 `0` 를 설정하십시오 (기본 50).
- 다이렉트 메시지 히스토리는 `channels.telegram.dmHistoryLimit` (사용자 턴 수)로 제한할 수 있습니다. 사용자별 오버라이드: `channels.telegram.dms["<user_id>"].historyLimit`.

## 그룹 활성화 모드

기본적으로 봇은 그룹에서 언급에만 응답합니다 (`@botname` 또는 `agents.list[].groupChat.mentionPatterns` 의 패턴). 이 동작을 변경하려면:

### 설정을 통해 (권장)

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": { requireMention: false }, // always respond in this group
      },
    },
  },
}
```

**중요:** `channels.telegram.groups` 를 설정하면 **허용 목록**이 생성되어, 목록에 있는 그룹(또는 `"*"`)만 허용됩니다.
포럼 토픽은 `channels.telegram.groups.<groupId>.topics.<topicId>` 아래에 토픽별 오버라이드를 추가하지 않는 한 상위 그룹 설정(allowFrom, requireMention, skills, prompts)을 상속합니다.

모든 그룹에서 항상 응답하도록 허용하려면:

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: false }, // all groups, always respond
      },
    },
  },
}
```

모든 그룹을 언급 전용으로 유지하려면 (기본 동작):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: true }, // or omit groups entirely
      },
    },
  },
}
```

### 명령어를 통해 (세션 수준)

그룹에서 다음을 전송합니다:

- `/activation always` - 모든 메시지에 응답
- `/activation mention` - 언급 요구 (기본값)

**참고:** 명령어는 세션 상태만 업데이트합니다. 재시작 후에도 유지하려면 설정을 사용하십시오.

### 그룹 채팅 ID 가져오기

그룹의 메시지를 Telegram 에서 `@userinfobot` 또는 `@getidsbot` 로 전달하면 채팅 ID(예: `-1001234567890` 와 같은 음수)를 확인할 수 있습니다.

**팁:** 본인 사용자 ID 는 봇에 다이렉트 메시지를 보내면(페어링 메시지) 응답으로 확인할 수 있으며, 명령어가 활성화된 경우 `/whoami` 를 사용할 수도 있습니다.

**프라이버시 참고:** `@userinfobot` 는 서드파티 봇입니다. 원하신다면 봇을 그룹에 추가하고 메시지를 보낸 뒤 `openclaw logs --follow` 를 사용해 `chat.id` 를 확인하거나, Bot API `getUpdates` 를 사용하십시오.

## 설정 쓰기

기본적으로 Telegram 은 채널 이벤트 또는 `/config set|unset` 에 의해 트리거된 설정 업데이트를 쓸 수 있습니다.

다음 경우에 발생합니다:

- 그룹이 슈퍼그룹으로 업그레이드되고 Telegram 이 `migrate_to_chat_id` 을 발생시키는 경우(채팅 ID 변경). OpenClaw 는 `channels.telegram.groups` 을 자동으로 마이그레이션할 수 있습니다.
- Telegram 채팅에서 `/config set` 또는 `/config unset` 를 실행하는 경우(`commands.config: true` 필요).

비활성화하려면:

```json5
{
  channels: { telegram: { configWrites: false } },
}
```

## 토픽 (포럼 슈퍼그룹)

Telegram 포럼 토픽은 메시지마다 `message_thread_id` 를 포함합니다. OpenClaw 는 다음을 수행합니다:

- 각 토픽이 분리되도록 Telegram 그룹 세션 키에 `:topic:<threadId>` 를 추가합니다.
- 응답이 토픽에 유지되도록 `message_thread_id` 로 타이핑 표시와 응답을 전송합니다.
- 일반 토픽(스레드 ID `1`)은 특수합니다. 메시지 전송 시 `message_thread_id` 는 생략됩니다(Telegram 이 이를 거부함). 그러나 타이핑 표시는 여전히 포함됩니다.
- 라우팅/템플릿을 위해 템플릿 컨텍스트에 `MessageThreadId` + `IsForum` 를 노출합니다.
- 토픽별 구성은 `channels.telegram.groups.<chatId>.topics.<threadId>` 아래에서 사용할 수 있습니다(skills, 허용 목록, 자동 응답, 시스템 프롬프트, 비활성화).
- 토픽 구성은 그룹 설정(requireMention, allowlists, skills, prompts, enabled)을 상속하며, 토픽별로 재정의할 수 있습니다.

비공개 채팅에서도 일부 엣지 케이스에서 `message_thread_id` 가 포함될 수 있습니다. OpenClaw 는 다이렉트 메시지 세션 키는 변경하지 않지만, 존재하는 경우 응답/초안 스트리밍에 스레드 ID 를 사용합니다.

## 인라인 버튼

Telegram 은 콜백 버튼이 있는 인라인 키보드를 지원합니다.

```json5
{
  channels: {
    telegram: {
      capabilities: {
        inlineButtons: "allowlist",
      },
    },
  },
}
```

계정별 구성:

```json5
{
  channels: {
    telegram: {
      accounts: {
        main: {
          capabilities: {
            inlineButtons: "allowlist",
          },
        },
      },
    },
  },
}
```

범위:

- `off` — 인라인 버튼 비활성화
- `dm` — 다이렉트 메시지만 (그룹 대상 차단)
- `group` — 그룹만 (다이렉트 메시지 대상 차단)
- `all` — 다이렉트 메시지 + 그룹
- `allowlist` — 다이렉트 메시지 + 그룹, 단 `allowFrom`/`groupAllowFrom` 에 의해 허용된 발신자만 가능(제어 명령과 동일한 규칙)

기본값: `allowlist`.
레거시: `capabilities: ["inlineButtons"]` = `inlineButtons: "all"`.

### 버튼 전송

메시지 도구에서 `buttons` 매개변수를 사용하십시오:

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  message: "Choose an option:",
  buttons: [
    [
      { text: "Yes", callback_data: "yes" },
      { text: "No", callback_data: "no" },
    ],
    [{ text: "Cancel", callback_data: "cancel" }],
  ],
}
```

사용자가 버튼을 클릭하면 콜백 데이터가 다음 형식의 메시지로 에이전트에 전달됩니다:
`callback_data: value`

### 구성 옵션

Telegram 기능은 두 수준에서 구성할 수 있습니다(위에는 객체 형식이 표시됨; 레거시 문자열 배열도 계속 지원됨):

- `channels.telegram.capabilities`: 전역 기본 기능 구성. 재정의되지 않는 한 모든 Telegram 계정에 적용됩니다.
- `channels.telegram.accounts.<account>.capabilities`: 특정 계정에 대해 전역 기본값을 재정의하는 계정별 기능 구성입니다.

모든 Telegram 봇/계정이 동일하게 동작해야 하면 전역 설정을 사용하십시오. 서로 다른 봇이 서로 다른 동작이 필요하면 계정별 구성을 사용하십시오(예: 한 계정은 다이렉트 메시지만 처리하고 다른 계정은 그룹을 허용).

## 접근 제어 (다이렉트 메시지 + 그룹)

### 다이렉트 메시지 접근

- 기본값: `channels.telegram.dmPolicy = "pairing"`. 알 수 없는 발신자는 페어링 코드를 받으며, 승인될 때까지 메시지는 무시됩니다(코드는 1 시간 후 만료).
- 승인 방법:
  - `openclaw pairing list telegram`
  - `openclaw pairing approve telegram <CODE>`
- 페어링은 Telegram 다이렉트 메시지에서 사용하는 기본 토큰 교환 방식입니다. 자세한 내용: [페어링](/channels/pairing)
- `channels.telegram.allowFrom` 은 숫자 사용자 ID(권장) 또는 `@username` 항목을 허용합니다. 이는 봇 사용자 이름이 아니며, 사람 발신자의 ID 를 사용해야 합니다. 마법사는 `@username` 를 허용하고 가능한 경우 숫자 ID 로 해석합니다.

#### Telegram 사용자 ID 찾기

더 안전한 방법(서드파티 봇 없음):

1. Gateway 를 시작하고 봇에 다이렉트 메시지를 보냅니다.
2. `openclaw logs --follow` 를 실행하고 `from.id` 를 확인합니다.

대안(공식 Bot API):

1. 봇에 다이렉트 메시지를 보냅니다.
2. 봇 토큰으로 업데이트를 가져와 `message.from.id` 를 읽습니다:

   ```bash
   curl "https://api.telegram.org/bot<bot_token>/getUpdates"
   ```

서드파티(프라이버시 낮음):

- `@userinfobot` 또는 `@getidsbot` 에 다이렉트 메시지를 보내 반환되는 사용자 ID 를 사용합니다.

### 그룹 접근

서로 독립적인 두 가지 제어가 있습니다:

**1. 허용되는 그룹** (`channels.telegram.groups` 를 통한 그룹 허용 목록):

- `groups` 설정 없음 = 모든 그룹 허용
- `groups` 설정 있음 = 나열된 그룹 또는 `"*"` 만 허용
- 예시: `"groups": { "-1001234567890": {}, "*": {} }` 는 모든 그룹을 허용

**2. 허용되는 발신자** (`channels.telegram.groupPolicy` 를 통한 발신자 필터링):

- `"open"` = 허용된 그룹의 모든 발신자 허용
- `"allowlist"` = `channels.telegram.groupAllowFrom` 에 있는 발신자만 허용
- `"disabled"` = 그룹 메시지를 전혀 수락하지 않음
  기본값은 `groupPolicy: "allowlist"` 입니다(`groupAllowFrom` 을 추가하지 않으면 차단).

대부분의 사용자는 다음을 원합니다: `groupPolicy: "allowlist"` + `groupAllowFrom` + `channels.telegram.groups` 에 특정 그룹 나열

특정 그룹에서 **모든 구성원**이 대화할 수 있도록 허용하면서 제어 명령은 승인된 발신자만 허용하려면, 그룹별 오버라이드를 설정하십시오:

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": {
          groupPolicy: "open",
          requireMention: false,
        },
      },
    },
  },
}
```

## 롱 폴링 vs 웹훅

- 기본값: 롱 폴링(공개 URL 불필요).
- 웹훅 모드: `channels.telegram.webhookUrl` 및 `channels.telegram.webhookSecret` 설정(선택적으로 `channels.telegram.webhookPath`).
  - 로컬 리스너는 `0.0.0.0:8787` 에 바인딩되며 기본적으로 `POST /telegram-webhook` 를 제공합니다.
  - 공개 URL 이 다른 경우 리버스 프록시를 사용하고 `channels.telegram.webhookUrl` 를 공개 엔드포인트로 지정하십시오.

## 응답 스레딩

Telegram 은 태그를 통한 선택적 스레드 응답을 지원합니다:

- `[[reply_to_current]]` -- 트리거 메시지에 대한 답장.
- `[[reply_to:<id>]]` -- 특정 메시지 ID 에 대한 답장.

`channels.telegram.replyToMode` 로 제어됩니다:

- `first` (기본값), `all`, `off`.

## 오디오 메시지 (보이스 vs 파일)

Telegram 은 **보이스 노트**(둥근 말풍선)와 **오디오 파일**(메타데이터 카드)을 구분합니다.
OpenClaw 는 하위 호환성을 위해 기본적으로 오디오 파일을 사용합니다.

에이전트 응답에서 보이스 노트 말풍선을 강제하려면, 응답 어디에든 다음 태그를 포함하십시오:

- `[[audio_as_voice]]` — 파일 대신 보이스 노트로 오디오 전송.

이 태그는 전달되는 텍스트에서 제거됩니다. 다른 채널은 이 태그를 무시합니다.

메시지 도구 전송의 경우, 보이스 호환 오디오 `media` URL 과 함께 `asVoice: true` 를 설정하십시오
(미디어가 있는 경우 `message` 는 선택 사항):

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/voice.ogg",
  asVoice: true,
}
```

## 스티커

OpenClaw 는 지능형 캐싱을 통해 Telegram 스티커의 수신과 전송을 지원합니다.

### 스티커 수신

사용자가 스티커를 보내면, OpenClaw 는 스티커 유형에 따라 다음과 같이 처리합니다:

- **정적 스티커 (WEBP):** 다운로드하여 비전을 통해 처리합니다. 메시지 내용에는 `<media:sticker>` 플레이스홀더로 표시됩니다.
- **애니메이션 스티커 (TGS):** 건너뜁니다(Lottie 형식은 처리 지원되지 않음).
- **비디오 스티커 (WEBM):** 건너뜁니다(비디오 형식은 처리 지원되지 않음).

스티커 수신 시 사용할 수 있는 템플릿 컨텍스트 필드:

- `Sticker` — 다음을 포함하는 객체:
  - `emoji` — 스티커와 연결된 이모지
  - `setName` — 스티커 세트 이름
  - `fileId` — Telegram 파일 ID(동일한 스티커를 다시 전송할 때 사용)
  - `fileUniqueId` — 캐시 조회를 위한 안정 ID
  - `cachedDescription` — 사용 가능 시 캐시된 비전 설명

### 스티커 캐시

스티커는 AI 의 비전 기능을 통해 설명을 생성합니다. 동일한 스티커가 반복해서 전송되는 경우가 많으므로, OpenClaw 는 중복 API 호출을 피하기 위해 설명을 캐시합니다.

**동작 방식:**

1. **첫 번째 수신:** 스티커 이미지를 AI 에 보내 비전 분석을 수행합니다. AI 는 설명을 생성합니다(예: '열정적으로 손을 흔드는 만화 고양이').
2. **캐시 저장:** 설명은 스티커의 파일 ID, 이모지, 세트 이름과 함께 저장됩니다.
3. **이후 수신:** 동일한 스티커가 다시 보이면 캐시된 설명을 바로 사용합니다. 이미지는 AI 로 전송되지 않습니다.

**캐시 위치:** `~/.openclaw/telegram/sticker-cache.json`

**캐시 항목 형식:**

```json
{
  "fileId": "CAACAgIAAxkBAAI...",
  "fileUniqueId": "AgADBAADb6cxG2Y",
  "emoji": "👋",
  "setName": "CoolCats",
  "description": "A cartoon cat waving enthusiastically",
  "cachedAt": "2026-01-15T10:30:00.000Z"
}
```

**장점:**

- 동일한 스티커에 대한 반복 비전 호출을 피하여 API 비용 절감
- 캐시된 스티커에 대한 빠른 응답 시간(비전 처리 지연 없음)
- 캐시된 설명을 기반으로 한 스티커 검색 기능 제공

캐시는 스티커 수신 시 자동으로 채워지며, 수동 관리가 필요하지 않습니다.

### 스티커 전송

에이전트는 `sticker` 및 `sticker-search` 액션을 사용하여 스티커를 전송하고 검색할 수 있습니다. 이는 기본적으로 비활성화되어 있으며 설정에서 활성화해야 합니다:

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

**스티커 전송:**

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "123456789",
  fileId: "CAACAgIAAxkBAAI...",
}
```

매개변수:

- `fileId` (필수) — 스티커의 Telegram 파일 ID. 스티커 수신 시 `Sticker.fileId` 에서 얻거나 `sticker-search` 검색 결과에서 얻을 수 있습니다.
- `replyTo` (선택) — 답장할 메시지 ID.
- `threadId` (선택) — 포럼 토픽의 메시지 스레드 ID.

**스티커 검색:**

에이전트는 설명, 이모지 또는 세트 이름으로 캐시된 스티커를 검색할 수 있습니다:

```json5
{
  action: "sticker-search",
  channel: "telegram",
  query: "cat waving",
  limit: 5,
}
```

캐시에서 일치하는 스티커를 반환합니다:

```json5
{
  ok: true,
  count: 2,
  stickers: [
    {
      fileId: "CAACAgIAAxkBAAI...",
      emoji: "👋",
      description: "A cartoon cat waving enthusiastically",
      setName: "CoolCats",
    },
  ],
}
```

검색은 설명 텍스트, 이모지 문자, 세트 이름 전반에 걸친 퍼지 매칭을 사용합니다.

**스레딩 예시:**

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "-1001234567890",
  fileId: "CAACAgIAAxkBAAI...",
  replyTo: 42,
  threadId: 123,
}
```

## 스트리밍 (초안)

Telegram 은 에이전트가 응답을 생성하는 동안 **초안 말풍선** 스트리밍을 지원합니다.
OpenClaw 는 Bot API `sendMessageDraft` (실제 메시지가 아님)을 사용한 다음,
최종 응답을 일반 메시지로 전송합니다.

요구 사항 (Telegram Bot API 9.3+):

- **토픽이 활성화된 비공개 채팅**(봇에 대한 포럼 토픽 모드).
- 수신 메시지에 `message_thread_id` (비공개 토픽 스레드)가 포함되어야 합니다.
- 그룹/슈퍼그룹/채널에서는 스트리밍이 무시됩니다.

설정:

- `channels.telegram.streamMode: "off" | "partial" | "block"` (기본값: `partial`)
  - `partial`: 최신 스트리밍 텍스트로 초안 말풍선을 업데이트합니다.
  - `block`: 더 큰 블록(청크) 단위로 초안 말풍선을 업데이트합니다.
  - `off`: 초안 스트리밍을 비활성화합니다.
- 선택 사항(`streamMode: "block"` 에만 해당):
  - `channels.telegram.draftChunk: { minChars?, maxChars?, breakPreference? }`
    - 기본값: `minChars: 200`, `maxChars: 800`, `breakPreference: "paragraph"` (`channels.telegram.textChunkLimit` 로 클램프됨).

참고: 초안 스트리밍은 **블록 스트리밍**(채널 메시지)과 별개입니다.
블록 스트리밍은 기본적으로 꺼져 있으며, 초안 업데이트 대신 조기 Telegram 메시지를 원하면 `channels.telegram.blockStreaming: true` 가 필요합니다.

추론 스트림 (Telegram 전용):

- `/reasoning stream` 는 응답이 생성되는 동안 추론을 초안 말풍선으로 스트리밍한 뒤, 추론 없이 최종 답변을 전송합니다.
- `channels.telegram.streamMode` 이 `off` 이면 추론 스트림이 비활성화됩니다.
  자세한 내용: [스트리밍 + 청킹](/concepts/streaming).

## 재시도 정책

아웃바운드 Telegram API 호출은 일시적인 네트워크/429 오류에 대해 지수 백오프와 지터로 재시도합니다. `channels.telegram.retry` 를 통해 구성하십시오. [재시도 정책](/concepts/retry)을 참고하십시오.

## 에이전트 도구 (메시지 + 반응)

- 도구: `telegram` 의 `sendMessage` 액션 (`to`, `content`, 선택적으로 `mediaUrl`, `replyToMessageId`, `messageThreadId`).
- 도구: `telegram` 의 `react` 액션 (`chatId`, `messageId`, `emoji`).
- 도구: `telegram` 의 `deleteMessage` 액션 (`chatId`, `messageId`).
- 반응 제거 의미론: [/tools/reactions](/tools/reactions) 참고.
- 도구 게이팅: `channels.telegram.actions.reactions`, `channels.telegram.actions.sendMessage`, `channels.telegram.actions.deleteMessage` (기본값: 활성화), `channels.telegram.actions.sticker` (기본값: 비활성화).

## 반응 알림

**반응 동작 방식:**
Telegram 반응은 메시지 페이로드의 속성이 아니라 **별도의 `message_reaction` 이벤트**로 도착합니다. 사용자가 반응을 추가하면 OpenClaw 는 다음을 수행합니다:

1. Telegram API 로부터 `message_reaction` 업데이트를 수신
2. 형식이 `"Telegram reaction added: {emoji} by {user} on msg {id}"` 인 **시스템 이벤트**로 변환
3. 일반 메시지와 **동일한 세션 키**를 사용해 시스템 이벤트를 큐에 추가
4. 해당 대화에서 다음 메시지가 도착하면 시스템 이벤트를 드레인하여 에이전트 컨텍스트 앞에 추가

에이전트는 반응을 메시지 메타데이터가 아닌 대화 기록의 **시스템 알림**으로 인식합니다.

**구성:**

- `channels.telegram.reactionNotifications`: 어떤 반응이 알림을 트리거하는지 제어
  - `"off"` — 모든 반응 무시
  - `"own"` — 사용자가 봇 메시지에 반응할 때 알림(베스트 에포트; 인메모리) (기본값)
  - `"all"` — 모든 반응에 대해 알림

- `channels.telegram.reactionLevel`: 에이전트의 반응 기능 제어
  - `"off"` — 에이전트가 메시지에 반응할 수 없음
  - `"ack"` — 봇이 처리 중 확인 반응 전송(👀) (기본값)
  - `"minimal"` — 에이전트가 절제하여 반응 가능(가이드라인: 5–10 회 교환당 1 회)
  - `"extensive"` — 적절한 경우 에이전트가 자유롭게 반응 가능

**포럼 그룹:** 포럼 그룹의 반응에는 `message_thread_id` 가 포함되며, `agent:main:telegram:group:{chatId}:topic:{threadId}` 와 같은 세션 키를 사용합니다. 이를 통해 동일한 토픽의 반응과 메시지가 함께 유지됩니다.

**설정 예시:**

```json5
{
  channels: {
    telegram: {
      reactionNotifications: "all", // See all reactions
      reactionLevel: "minimal", // Agent can react sparingly
    },
  },
}
```

**요구 사항:**

- Telegram 봇은 `allowed_updates` 에서 `message_reaction` 를 명시적으로 요청해야 합니다(OpenClaw 가 자동 구성).
- 웹훅 모드에서는 반응이 웹훅 `allowed_updates` 에 포함됩니다.
- 폴링 모드에서는 반응이 `getUpdates` `allowed_updates` 에 포함됩니다.

## 전송 대상 (CLI/cron)

- 대상은 채팅 ID (`123456789`) 또는 사용자 이름 (`@name`)을 사용할 수 있습니다.
- 예시: `openclaw message send --channel telegram --target 123456789 --message "hi"`.

## 문제 해결

**그룹에서 언급되지 않은 메시지에 봇이 응답하지 않음:**

- `channels.telegram.groups.*.requireMention=false` 를 설정한 경우 Telegram Bot API 의 **프라이버시 모드**를 비활성화해야 합니다.
  - BotFather: `/setprivacy` → **Disable** (그룹에서 봇 제거 후 재추가)
- `openclaw channels status` 는 설정이 언급되지 않은 그룹 메시지를 기대할 때 경고를 표시합니다.
- `openclaw channels status --probe` 는 명시적 숫자 그룹 ID 에 대한 멤버십을 추가로 확인할 수 있습니다(와일드카드 `"*"` 규칙은 감사할 수 없음).
- 빠른 테스트: `/activation always` (세션 전용; 영구 설정은 구성 사용)

**봇이 그룹 메시지를 전혀 보지 못함:**

- `channels.telegram.groups` 가 설정된 경우 그룹이 나열되어 있거나 `"*"` 를 사용해야 합니다.
- @BotFather → "Group Privacy" 에서 프라이버시 설정이 **OFF** 인지 확인
- 봇이 실제로 멤버인지 확인(읽기 권한 없는 관리자만은 아님)
- Gateway 로그 확인: `openclaw logs --follow` ("skipping group message" 확인)

**봇이 언급에는 응답하지만 `/activation always` 에는 응답하지 않음:**

- `/activation` 명령은 세션 상태만 업데이트하며 설정에 영구 저장되지 않습니다.
- 영구 동작을 위해 그룹을 `channels.telegram.groups` 에 `requireMention: false` 로 추가하십시오.

**`/status` 와 같은 명령이 작동하지 않음:**

- Telegram 사용자 ID 가 승인되었는지 확인하십시오(페어링 또는 `channels.telegram.allowFrom`).
- `groupPolicy: "open"` 이 있는 그룹에서도 명령은 인증이 필요합니다.

**Node 22+ 에서 롱 폴링이 즉시 중단됨(프록시/커스텀 fetch 에서 자주 발생):**

- Node 22+ 는 `AbortSignal` 인스턴스에 더 엄격하여, 외부 시그널이 `fetch` 호출을 즉시 중단시킬 수 있습니다.
- 중단 시그널을 정규화한 OpenClaw 빌드로 업그레이드하거나, 업그레이드할 때까지 Node 20 에서 Gateway 를 실행하십시오.

**봇이 시작한 후 조용히 응답을 중단함(또는 `HttpError: Network request ... failed` 로그):**

- 일부 호스트는 `api.telegram.org` 를 IPv6 로 먼저 해석합니다. 서버에 정상적인 IPv6 아웃바운드가 없으면 grammY 가 IPv6 전용 요청에서 멈출 수 있습니다.
- IPv6 아웃바운드를 활성화하거나, `api.telegram.org` 에 대해 IPv4 해석을 강제하십시오(예: IPv4 A 레코드를 사용하는 `/etc/hosts` 항목 추가 또는 OS DNS 스택에서 IPv4 선호), 그런 다음 Gateway 를 재시작하십시오.
- 빠른 확인: `dig +short api.telegram.org A` 및 `dig +short api.telegram.org AAAA` 로 DNS 반환값을 확인하십시오.

## 구성 참조 (Telegram)

전체 구성: [구성](/gateway/configuration)

프로바이더 옵션:

- `channels.telegram.enabled`: 채널 시작 활성화/비활성화.
- `channels.telegram.botToken`: 봇 토큰(BotFather).
- `channels.telegram.tokenFile`: 파일 경로에서 토큰 읽기.
- `channels.telegram.dmPolicy`: `pairing | allowlist | open | disabled` (기본값: 페어링).
- `channels.telegram.allowFrom`: 다이렉트 메시지 허용 목록(ID/사용자 이름). `open` 은 `"*"` 가 필요합니다.
- `channels.telegram.groupPolicy`: `open | allowlist | disabled` (기본값: 허용 목록).
- `channels.telegram.groupAllowFrom`: 그룹 발신자 허용 목록(ID/사용자 이름).
- `channels.telegram.groups`: 그룹별 기본값 + 허용 목록(`"*"` 로 전역 기본값 사용).
  - `channels.telegram.groups.<id>.groupPolicy`: groupPolicy (`open | allowlist | disabled`) 에 대한 그룹별 오버라이드.
  - `channels.telegram.groups.<id>.requireMention`: 언급 게이팅 기본값.
  - `channels.telegram.groups.<id>.skills`: 스킬 필터(생략 = 모든 스킬, 빈 값 = 없음).
  - `channels.telegram.groups.<id>.allowFrom`: 그룹별 발신자 허용 목록 오버라이드.
  - `channels.telegram.groups.<id>.systemPrompt`: 그룹에 대한 추가 시스템 프롬프트.
  - `channels.telegram.groups.<id>.enabled`: `false` 일 때 그룹 비활성화.
  - `channels.telegram.groups.<id>.topics.<threadId>.*`: 토픽별 오버라이드(그룹과 동일한 필드).
  - `channels.telegram.groups.<id>.topics.<threadId>.groupPolicy`: groupPolicy (`open | allowlist | disabled`) 에 대한 토픽별 오버라이드.
  - `channels.telegram.groups.<id>.topics.<threadId>.requireMention`: 토픽별 언급 게이팅 오버라이드.
- `channels.telegram.capabilities.inlineButtons`: `off | dm | group | all | allowlist` (기본값: 허용 목록).
- `channels.telegram.accounts.<account>.capabilities.inlineButtons`: 계정별 오버라이드.
- `channels.telegram.replyToMode`: `off | first | all` (기본값: `first`).
- `channels.telegram.textChunkLimit`: 발신 청크 크기(문자).
- `channels.telegram.chunkMode`: `length` (기본값) 또는 길이 분할 전에 빈 줄(문단 경계)에서 분할하는 `newline`.
- `channels.telegram.linkPreview`: 발신 메시지의 링크 미리보기 토글(기본값: true).
- `channels.telegram.streamMode`: `off | partial | block` (초안 스트리밍).
- `channels.telegram.mediaMaxMb`: 수신/발신 미디어 한도(MB).
- `channels.telegram.retry`: 아웃바운드 Telegram API 호출에 대한 재시도 정책(시도 횟수, minDelayMs, maxDelayMs, jitter).
- `channels.telegram.network.autoSelectFamily`: Node autoSelectFamily 오버라이드(true=활성화, false=비활성화). Node 22 에서는 Happy Eyeballs 타임아웃을 피하기 위해 기본적으로 비활성화됩니다.
- `channels.telegram.proxy`: Bot API 호출을 위한 프록시 URL (SOCKS/HTTP).
- `channels.telegram.webhookUrl`: 웹훅 모드 활성화(`channels.telegram.webhookSecret` 필요).
- `channels.telegram.webhookSecret`: 웹훅 시크릿(웹훅 URL 이 설정된 경우 필수).
- `channels.telegram.webhookPath`: 로컬 웹훅 경로(기본값 `/telegram-webhook`).
- `channels.telegram.actions.reactions`: Telegram 도구 반응 게이팅.
- `channels.telegram.actions.sendMessage`: Telegram 도구 메시지 전송 게이팅.
- `channels.telegram.actions.deleteMessage`: Telegram 도구 메시지 삭제 게이팅.
- `channels.telegram.actions.sticker`: Telegram 스티커 액션(전송 및 검색) 게이팅(기본값: false).
- `channels.telegram.reactionNotifications`: `off | own | all` — 어떤 반응이 시스템 이벤트를 트리거하는지 제어(설정되지 않으면 기본값: `own`).
- `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` — 에이전트의 반응 기능 제어(설정되지 않으면 기본값: `minimal`).

관련 전역 옵션:

- `agents.list[].groupChat.mentionPatterns` (언급 게이팅 패턴).
- `messages.groupChat.mentionPatterns` (전역 폴백).
- `commands.native` (기본값: `"auto"` → Telegram/Discord 에서는 켜짐, Slack 에서는 꺼짐), `commands.text`, `commands.useAccessGroups` (명령 동작). `channels.telegram.commands.native` 로 재정의할 수 있습니다.
- `messages.responsePrefix`, `messages.ackReaction`, `messages.ackReactionScope`, `messages.removeAckAfterReply`.
