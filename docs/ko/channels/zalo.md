---
summary: "Zalo 봇 지원 상태, 기능 및 구성"
read_when:
  - Zalo 기능 또는 웹훅 작업 시
title: "Zalo"
---

# Zalo (Bot API)

상태: 실험적입니다. 다이렉트 메시지만 지원하며, 그룹은 Zalo 문서에 따라 곧 제공될 예정입니다.

## Plugin required

Zalo 는 플러그인으로 제공되며 코어 설치에 번들되어 있지 않습니다.

- CLI 로 설치: `openclaw plugins install @openclaw/zalo`
- 또는 온보딩 중 **Zalo** 를 선택하고 설치 프롬프트를 확인합니다.
- 자세한 내용: [Plugins](/tools/plugin)

## Quick setup (beginner)

1. Zalo 플러그인을 설치합니다:
   - 소스 체크아웃에서: `openclaw plugins install ./extensions/zalo`
   - npm 에서 (게시된 경우): `openclaw plugins install @openclaw/zalo`
   - 또는 온보딩에서 **Zalo** 를 선택하고 설치 프롬프트를 확인합니다.
2. 토큰을 설정합니다:
   - Env: `ZALO_BOT_TOKEN=...`
   - 또는 구성: `channels.zalo.botToken: "..."`.
3. Gateway(게이트웨이) 를 재시작합니다(또는 온보딩을 완료합니다).
4. DM 접근은 기본적으로 페어링입니다. 최초 접촉 시 페어링 코드를 승인합니다.

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

## What it is

Zalo 는 베트남 중심의 메시징 앱입니다. Bot API 를 통해 Gateway(게이트웨이) 가 1:1 대화를 위한 봇을 실행할 수 있습니다.
결정론적 라우팅으로 Zalo 로의 응답이 보장되어야 하는 지원 또는 알림에 적합합니다.

- Gateway(게이트웨이) 가 소유한 Zalo Bot API 채널입니다.
- 결정론적 라우팅: 응답은 Zalo 로 되돌아가며, 모델은 채널을 선택하지 않습니다.
- DM 은 에이전트의 메인 세션을 공유합니다.
- 그룹은 아직 지원되지 않습니다(Zalo 문서에 "곧 제공"으로 명시됨).

## Setup (fast path)

### 1. 봇 토큰 생성 (Zalo Bot Platform)

1. [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) 로 이동하여 로그인합니다.
2. 새 봇을 생성하고 설정을 구성합니다.
3. 봇 토큰을 복사합니다(형식: `12345689:abc-xyz`).

### 2) 토큰 구성 (환경 변수 또는 구성)

예시:

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

환경 변수 옵션: `ZALO_BOT_TOKEN=...` (기본 계정에만 동작).

다중 계정 지원: 계정별 토큰과 선택적 `name` 을 사용하여 `channels.zalo.accounts` 를 사용합니다.

3. Gateway(게이트웨이) 를 재시작합니다. 토큰이 해결되면(환경 변수 또는 구성) Zalo 가 시작됩니다.
4. DM 접근은 기본적으로 페어링입니다. 봇이 처음 연락을 받을 때 코드를 승인합니다.

## How it works (behavior)

- 수신 메시지는 미디어 플레이스홀더와 함께 공유 채널 엔벨로프로 정규화됩니다.
- 응답은 항상 동일한 Zalo 채팅으로 라우팅됩니다.
- 기본값은 롱 폴링입니다. `channels.zalo.webhookUrl` 로 웹훅 모드를 사용할 수 있습니다.

## Limits

- 발신 텍스트는 2000 자로 분할됩니다(Zalo API 제한).
- 미디어 다운로드/업로드는 `channels.zalo.mediaMaxMb` 로 제한됩니다(기본값 5).
- 2000 자 제한으로 스트리밍의 효용이 낮아 기본적으로 스트리밍은 차단됩니다.

## Access control (DMs)

### DM access

- 기본값: `channels.zalo.dmPolicy = "pairing"`. 알 수 없는 발신자는 페어링 코드를 받으며, 승인될 때까지 메시지는 무시됩니다(코드는 1 시간 후 만료).
- 승인 방법:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- 페어링은 기본 토큰 교환 방식입니다. 자세한 내용: [Pairing](/channels/pairing)
- `channels.zalo.allowFrom` 는 숫자 사용자 ID 를 허용합니다(사용자명 조회는 제공되지 않음).

## Long-polling vs webhook

- 기본값: 롱 폴링(공개 URL 불필요).
- 웹훅 모드: `channels.zalo.webhookUrl` 및 `channels.zalo.webhookSecret` 을 설정합니다.
  - 웹훅 시크릿은 8-256 자여야 합니다.
  - 웹훅 URL 은 HTTPS 를 사용해야 합니다.
  - Zalo 는 검증을 위해 `X-Bot-Api-Secret-Token` 헤더와 함께 이벤트를 전송합니다.
  - Gateway(게이트웨이) HTTP 는 `channels.zalo.webhookPath` 에서 웹훅 요청을 처리합니다(기본값은 웹훅 URL 경로).

**참고:** Zalo API 문서에 따라 getUpdates(폴링) 와 웹훅은 상호 배타적입니다.

## Supported message types

- **텍스트 메시지**: 2000 자 분할로 완전 지원.
- **이미지 메시지**: 수신 이미지 다운로드 및 처리, `sendPhoto` 를 통해 이미지 전송.
- **스티커**: 기록되지만 완전히 처리되지는 않습니다(에이전트 응답 없음).
- **미지원 유형**: 기록됨(예: 보호된 사용자로부터의 메시지).

## Capabilities

| 기능                           | 상태                                     |
| ---------------------------- | -------------------------------------- |
| 다이렉트 메시지                     | ✅ 지원됨                                  |
| 그룹                           | ❌ 곧 제공 (Zalo 문서 기준) |
| 미디어 (이미지) | ✅ 지원됨                                  |
| 반응                           | ❌ 미지원                                  |
| 스레드                          | ❌ 미지원                                  |
| 투표                           | ❌ 미지원                                  |
| 네이티브 명령                      | ❌ 미지원                                  |
| 스트리밍                         | ⚠️ 차단됨 (2000 자 제한)  |

## Delivery targets (CLI/cron)

- 대상에 채팅 ID 를 사용합니다.
- 예시: `openclaw message send --channel zalo --target 123456789 --message "hi"`.

## Troubleshooting

**봇이 응답하지 않음:**

- 토큰이 유효한지 확인합니다: `openclaw channels status --probe`
- 발신자가 승인되었는지 확인합니다(페어링 또는 allowFrom)
- Gateway(게이트웨이) 로그를 확인합니다: `openclaw logs --follow`

**웹훅이 이벤트를 수신하지 않는 경우:**

- 웹훅 URL 이 HTTPS 인지 확인합니다.
- 시크릿 토큰이 8-256 자인지 확인합니다.
- 구성된 경로에서 Gateway(게이트웨이) HTTP 엔드포인트에 접근 가능한지 확인합니다.
- getUpdates 폴링이 실행 중이 아닌지 확인합니다(상호 배타적).

## Configuration reference (Zalo)

전체 구성: [Configuration](/gateway/configuration)

프로바이더 옵션:

- `channels.zalo.enabled`: 채널 시작 활성화/비활성화.
- `channels.zalo.botToken`: Zalo Bot Platform 의 봇 토큰.
- `channels.zalo.tokenFile`: 파일 경로에서 토큰 읽기.
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (기본값: 페어링).
- `channels.zalo.allowFrom`: DM 허용 목록(사용자 ID). `open` 는 `"*"` 가 필요합니다. 마법사는 숫자 ID 를 요청합니다.
- `channels.zalo.mediaMaxMb`: 수신/발신 미디어 한도(MB, 기본값 5).
- `channels.zalo.webhookUrl`: 웹훅 모드 활성화(HTTPS 필요).
- `channels.zalo.webhookSecret`: 웹훅 시크릿(8-256 자).
- `channels.zalo.webhookPath`: Gateway(게이트웨이) HTTP 서버의 웹훅 경로.
- `channels.zalo.proxy`: API 요청용 프록시 URL.

다중 계정 옵션:

- `channels.zalo.accounts.<id>.botToken`: 계정별 토큰.
- `channels.zalo.accounts.<id>.tokenFile`: 계정별 토큰 파일.
- `channels.zalo.accounts.<id>.name`: 표시 이름.
- `channels.zalo.accounts.<id>.enabled`: 계정 활성화/비활성화.
- `channels.zalo.accounts.<id>.dmPolicy`: 계정별 DM 정책.
- `channels.zalo.accounts.<id>.allowFrom`: 계정별 허용 목록.
- `channels.zalo.accounts.<id>.webhookUrl`: 계정별 웹훅 URL.
- `channels.zalo.accounts.<id>.webhookSecret`: 계정별 웹훅 시크릿.
- `channels.zalo.accounts.<id>.webhookPath`: 계정별 웹훅 경로.
- `channels.zalo.accounts.<id>.proxy`: 계정별 프록시 URL.
