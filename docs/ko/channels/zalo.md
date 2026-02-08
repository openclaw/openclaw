---
read_when:
    - Zalo 기능 또는 웹훅 작업
summary: Zalo 봇 지원 상태, 기능 및 구성
title: 잘로
x-i18n:
    generated_at: "2026-02-08T15:48:47Z"
    model: gtx
    provider: google-translate
    source_hash: bd14c0d008a2355230d1751e40bfaa5a15e2cd2f0dcd44fede8f02a1ad43e1c8
    source_path: channels/zalo.md
    workflow: 15
---

# Zalo(봇 API)

상태: 실험적. 직접 메시지만 가능합니다. Zalo 문서에 따라 그룹이 곧 제공될 예정입니다.

## 플러그인 필요

Zalo는 플러그인으로 제공되며 핵심 설치와 함께 번들로 제공되지 않습니다.

- CLI를 통해 설치: `openclaw plugins install @openclaw/zalo`
- 또는 선택 **잘로** 온보딩 중에 설치 프롬프트를 확인하세요.
- 세부: [플러그인](/tools/plugin)

## 빠른 설정(초보자)

1. Zalo 플러그인을 설치합니다.
   - 소스 체크아웃에서: `openclaw plugins install ./extensions/zalo`
   - npm에서(게시된 경우): `openclaw plugins install @openclaw/zalo`
   - 아니면 선택하세요 **잘로** 온보딩에서 설치 프롬프트를 확인하세요.
2. 토큰을 설정합니다:
   - 환경: `ZALO_BOT_TOKEN=...`
   - 또는 구성: `channels.zalo.botToken: "..."`.
3. 게이트웨이를 다시 시작합니다(또는 온보딩을 완료합니다).
4. DM 액세스는 기본적으로 페어링됩니다. 첫 번째 연락 시 페어링 코드를 승인하세요.

최소 구성:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

## 그것은 무엇입니까

Zalo는 베트남에 초점을 맞춘 메시징 앱입니다. Bot API를 사용하면 게이트웨이가 1:1 대화를 위해 봇을 실행할 수 있습니다.
Zalo로 다시 결정적인 라우팅을 원하는 지원 또는 알림에 적합합니다.

- 게이트웨이가 소유한 Zalo Bot API 채널입니다.
- 결정적 라우팅: 응답이 Zalo로 돌아갑니다. 모델은 채널을 선택하지 않습니다.
- DM은 상담원의 기본 세션을 공유합니다.
- 그룹은 아직 지원되지 않습니다(Zalo 문서에는 "곧 출시 예정"이라고 명시되어 있음).

## 설정(빠른 경로)

### 1) 봇 토큰 생성(Zalo Bot Platform)

1. 이동 [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) 그리고 로그인하세요.
2. 새 봇을 만들고 설정을 구성합니다.
3. 봇 토큰을 복사합니다(형식: `12345689:abc-xyz`).

### 2) 토큰 구성(env 또는 config)

예:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

환경 옵션: `ZALO_BOT_TOKEN=...` (기본 계정에서만 작동합니다).

다중 계정 지원: 사용 `channels.zalo.accounts` 계정별 토큰 및 선택 사항 포함 `name`.

3. 게이트웨이를 다시 시작하십시오. Zalo는 토큰이 확인되면(env 또는 config) 시작됩니다.
4. DM 액세스는 기본적으로 페어링으로 설정됩니다. 봇에 처음 접속할 때 코드를 승인하세요.

## 작동 방식(행동)

- 인바운드 메시지는 미디어 자리 표시자가 있는 공유 채널 봉투로 정규화됩니다.
- 답변은 항상 동일한 Zalo 채팅으로 다시 라우팅됩니다.
- 기본적으로 긴 폴링; 웹훅 모드 사용 가능 `channels.zalo.webhookUrl`.

## 제한

- 아웃바운드 텍스트는 2000자로 청크됩니다(Zalo API 제한).
- 미디어 다운로드/업로드는 다음으로 제한됩니다. `channels.zalo.mediaMaxMb` (기본값 5).
- 스트리밍은 2000자 제한으로 인해 기본적으로 차단되어 스트리밍의 유용성이 떨어집니다.

## 액세스 제어(DM)

### DM접속

- 기본: `channels.zalo.dmPolicy = "pairing"`. 알 수 없는 발신자는 페어링 코드를 받습니다. 메시지는 승인될 때까지 무시됩니다(코드는 1시간 후에 만료됩니다).
- 승인 방법:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- 페어링은 기본 토큰 교환입니다. 세부: [편성](/channels/pairing)
- `channels.zalo.allowFrom` 숫자로 된 사용자 ID를 허용합니다(사용자 이름 조회가 가능하지 않음).

## 긴 폴링과 웹훅 비교

- 기본값: 긴 폴링(공개 URL이 필요하지 않음)
- 웹훅 모드: 설정 `channels.zalo.webhookUrl` 그리고 `channels.zalo.webhookSecret`.
  - 웹훅 비밀번호는 8~256자여야 합니다.
  - 웹훅 URL은 HTTPS를 사용해야 합니다.
  - Zalo는 다음을 사용하여 이벤트를 보냅니다. `X-Bot-Api-Secret-Token` 확인용 헤더입니다.
  - 게이트웨이 HTTP는 다음에서 웹훅 요청을 처리합니다. `channels.zalo.webhookPath` (기본값은 웹훅 URL 경로입니다).

**메모:** getUpdates(폴링) 및 웹후크는 Zalo API 문서별로 상호 배타적입니다.

## 지원되는 메시지 유형

- **문자 메시지**: 2000자 청킹을 완벽하게 지원합니다.
- **이미지 메시지**: 인바운드 이미지를 다운로드하고 처리합니다. 다음을 통해 이미지 보내기 `sendPhoto`.
- **스티커**: 기록되었지만 완전히 처리되지 않았습니다(에이전트 응답 없음).
- **지원되지 않는 유형**: 기록됩니다(예: 보호된 사용자의 메시지).

## 기능

| Feature         | Status                         |
| --------------- | ------------------------------ |
| Direct messages | ✅ Supported                   |
| Groups          | ❌ Coming soon (per Zalo docs) |
| Media (images)  | ✅ Supported                   |
| Reactions       | ❌ Not supported               |
| Threads         | ❌ Not supported               |
| Polls           | ❌ Not supported               |
| Native commands | ❌ Not supported               |
| Streaming       | ⚠️ Blocked (2000 char limit)   |

## 전달 대상(CLI/cron)

- 채팅 ID를 대상으로 사용하세요.
- 예:`openclaw message send --channel zalo --target 123456789 --message "hi"`.

## 문제 해결

**봇이 응답하지 않습니다:**

- 토큰이 유효한지 확인하세요. `openclaw channels status --probe`
- 발신자가 승인되었는지 확인하세요(페어링 또는 허용)
- 게이트웨이 로그를 확인하세요. `openclaw logs --follow`

**웹훅이 이벤트를 수신하지 않음:**

- 웹훅 URL이 HTTPS를 사용하는지 확인하세요.
- 비밀 토큰이 8~256자인지 확인하세요.
- 구성된 경로에서 게이트웨이 HTTP 엔드포인트에 연결할 수 있는지 확인하세요.
- getUpdates 폴링이 실행되고 있지 않은지 확인하세요(상호 배타적임).

## 구성 참조(Zalo)

전체 구성: [구성](/gateway/configuration)

제공업체 옵션:

- `channels.zalo.enabled`: 채널 시작을 활성화/비활성화합니다.
- `channels.zalo.botToken`: Zalo Bot Platform의 봇 토큰입니다.
- `channels.zalo.tokenFile`: 파일 경로에서 토큰을 읽습니다.
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (기본값: 페어링).
- `channels.zalo.allowFrom`: DM 허용 목록(사용자 ID)입니다. `open` 필요하다 `"*"`. 마법사는 숫자 ID를 요구합니다.
- `channels.zalo.mediaMaxMb`: 인바운드/아웃바운드 미디어 용량(MB, 기본값 5).
- `channels.zalo.webhookUrl`: 웹훅 모드를 활성화합니다(HTTPS 필요).
- `channels.zalo.webhookSecret`: 웹훅 비밀(8~256자)
- `channels.zalo.webhookPath`: 게이트웨이 HTTP 서버의 웹훅 경로입니다.
- `channels.zalo.proxy`: API 요청을 위한 프록시 URL입니다.

다중 계정 옵션:

- `channels.zalo.accounts.<id>.botToken`: 계정별 토큰입니다.
- `channels.zalo.accounts.<id>.tokenFile`: 계정별 토큰 파일입니다.
- `channels.zalo.accounts.<id>.name`: 표시 이름.
- `channels.zalo.accounts.<id>.enabled`: 계정을 활성화/비활성화합니다.
- `channels.zalo.accounts.<id>.dmPolicy`: 계정별 DM 정책입니다.
- `channels.zalo.accounts.<id>.allowFrom`: 계정별 허용 목록입니다.
- `channels.zalo.accounts.<id>.webhookUrl`: 계정별 웹훅 URL입니다.
- `channels.zalo.accounts.<id>.webhookSecret`: 계정별 웹훅 비밀입니다.
- `channels.zalo.accounts.<id>.webhookPath`: 계정별 웹훅 경로입니다.
- `channels.zalo.accounts.<id>.proxy`: 계정별 프록시 URL입니다.
