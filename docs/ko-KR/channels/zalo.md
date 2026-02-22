---
summary: "Zalo 봇 지원 상태, 기능 및 설정"
read_when:
  - Zalo 기능 또는 웹훅 작업 시
title: "Zalo"
---

# Zalo (Bot API)

상태: 실험적. 다이렉트 메시지만 지원; 그룹은 Zalo 문서에 따르면 곧 지원 예정.

## 플러그인 필요

Zalo는 플러그인으로 제공되며 기본 설치에 포함되어 있지 않습니다.

- CLI를 통해 설치: `openclaw plugins install @openclaw/zalo`
- 또는 온보딩 중에 **Zalo**를 선택하고 설치 프롬프트를 확인
- 세부 사항: [플러그인](/ko-KR/tools/plugin)

## 빠른 설정 (초보자용)

1. Zalo 플러그인 설치:
   - 소스 체크아웃에서: `openclaw plugins install ./extensions/zalo`
   - npm에서 (출판된 경우): `openclaw plugins install @openclaw/zalo`
   - 또는 온보딩에서 **Zalo**를 선택하고 설치 프롬프트 확인
2. 토큰 설정:
   - 환경 변수: `ZALO_BOT_TOKEN=...`
   - 또는 설정: `channels.zalo.botToken: "..."`.
3. 게이트웨이 재시작 (또는 온보딩 완료).
4. 다이렉트 메시지 접근은 기본적으로 페어링됩니다; 첫 번째 연락 시 페어링 코드를 승인하세요.

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

## Zalo란 무엇인가

Zalo는 베트남을 중심으로 한 메시징 앱입니다; 그 Bot API는 게이트웨이가 1:1 대화를 위한 봇을 실행할 수 있게 합니다. 지원이나 알림에 적합하며, Zalo로의 결정론적 라우팅을 원할 때 좋습니다.

- 게이트웨이가 소유한 Zalo Bot API 채널입니다.
- 결정론적 라우팅: 답변은 다시 Zalo로 돌아갑니다; 모델은 채널을 선택하지 않습니다.
- 다이렉트 메시지는 에이전트의 주요 세션을 공유합니다.
- 그룹은 아직 지원되지 않음 (Zalo 문서에는 "곧 지원 예정"이라고 명시되어 있음).

## 설정 (빠른 경로)

### 1) 봇 토큰 생성 (Zalo Bot Platform)

1. [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com)에 방문하여 로그인합니다.
2. 새 봇을 생성하고 설정을 구성합니다.
3. 봇 토큰 복사 (형식: `12345689:abc-xyz`).

### 2) 토큰 구성 (환경 변수 또는 설정)

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

환경 변수 옵션: `ZALO_BOT_TOKEN=...` (기본 계정에만 작동).

멀티 계정 지원: `channels.zalo.accounts`를 사용하여 계정별 토큰 및 선택적 `name`을 사용하세요.

3. 게이트웨이를 재시작하세요. Zalo는 토큰이 해결될 때 (환경 변수 또는 설정) 시작됩니다.
4. 다이렉트 메시지 접근은 기본적으로 페어링됩니다. 봇이 처음 연락되었을 때 코드를 승인하세요.

## 작동 방식 (동작)

- 수신 메시지는 미디어 자리 표시자가 있는 공유 채널 봉투로 표준화됩니다.
- 응답은 항상 동일한 Zalo 채팅으로 안내됩니다.
- 기본적으로 롱 폴링; `channels.zalo.webhookUrl`로 웹훅 모드 사용 가능.

## 제한 사항

- 발신 텍스트는 2000자 제한으로 분할됩니다 (Zalo API 한도).
- 미디어 다운로드/업로드는 `channels.zalo.mediaMaxMb` (기본 5)로 제한됩니다.
- 스트리밍은 2000자 제한으로 인해 기본적으로 차단되어 있음 (스트리밍이 덜 유용함).

## 접근 제어 (다이렉트 메시지)

### 다이렉트 메시지 접근

- 기본: `channels.zalo.dmPolicy = "pairing"`. 알 수 없는 발신자가 페어링 코드를 받으며, 승인 전에는 메시지가 무시됨 (코드는 1시간 후 만료됨).
- 승인 방법:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- 페어링은 기본 토큰 교환 방식입니다. 세부 정보: [페어링](/ko-KR/channels/pairing)
- `channels.zalo.allowFrom`은 숫자 사용자 ID를 허용합니다 (사용자 이름 조회 불가능).

## 롱 폴링 vs 웹훅

- 기본: 롱 폴링 (공개 URL 필요 없음).
- 웹훅 모드: `channels.zalo.webhookUrl` 및 `channels.zalo.webhookSecret` 설정.
  - 웹훅 비밀은 8-256자여야 합니다.
  - 웹훅 URL은 HTTPS를 사용해야 합니다.
  - Zalo 이벤트와 함께 `X-Bot-Api-Secret-Token` 헤더를 전송하여 검증합니다.
  - 게이트웨이 HTTP는 `channels.zalo.webhookPath` (기본 웹훅 URL 경로)에서 웹훅 요청 처리.
  - 요청은 `Content-Type: application/json` (또는 `+json` 미디어 타입)을 사용해야 합니다.
  - 중복 이벤트 (`event_name + message_id`)는 짧은 재생 창 동안 무시됩니다.
  - 버스트 트래픽은 경로/소스별로 속도 제한이 적용되며 HTTP 429를 반환할 수 있습니다.

**참고:** getUpdates (폴링)와 웹훅은 Zalo API 문서에 따라 상호 배타적입니다.

## 지원되는 메시지 유형

- **텍스트 메시지**: 2000자 분할로 완전 지원.
- **이미지 메시지**: 수신 이미지 다운로드 및 처리; `sendPhoto`를 통해 이미지 전송.
- **스티커**: 로그는 남지만 완전히 처리되지는 않음 (에이전트 응답 없음).
- **지원되지 않는 유형**: 로그에 기록됨 (예: 보호된 사용자로부터의 메시지).

## 기능

| 기능            | 상태                               |
| --------------- | ---------------------------------- |
| 다이렉트 메시지 | ✅ 지원됨                          |
| 그룹            | ❌ 곧 지원 예정 (Zalo 문서에 따라) |
| 미디어 (이미지) | ✅ 지원됨                          |
| 반응            | ❌ 지원되지 않음                   |
| 스레드          | ❌ 지원되지 않음                   |
| 설문조사        | ❌ 지원되지 않음                   |
| 네이티브 명령어 | ❌ 지원되지 않음                   |
| 스트리밍        | ⚠️ 차단됨 (2000자 제한)            |

## 전송 대상 (CLI/cron)

- 대상으로 채팅 ID 사용.
- 예시: `openclaw message send --channel zalo --target 123456789 --message "hi"`.

## 문제 해결

**봇이 응답하지 않음:**

- 토큰이 유효한지 확인: `openclaw channels status --probe`
- 발신자가 승인되었는지 확인 (페어링 또는 allowFrom)
- 게이트웨이 로그 확인: `openclaw logs --follow`

**웹훅 이벤트 수신 안 됨:**

- 웹훅 URL이 HTTPS를 사용하는지 확인
- 비밀 토큰이 8-256자인지 확인
- 게이트웨이 HTTP 엔드포인트가 설정된 경로에서 도달 가능한지 확인
- getUpdates 폴링이 실행 중이지 않은지 확인 (상호 배타적임)

## 설정 참조 (Zalo)

전체 구성: [구성](/ko-KR/gateway/configuration)

프로바이더 옵션:

- `channels.zalo.enabled`: 채널 시작 활성화/비활성화.
- `channels.zalo.botToken`: Zalo Bot Platform의 봇 토큰.
- `channels.zalo.tokenFile`: 파일 경로에서 토큰 읽기.
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (기본: pairing).
- `channels.zalo.allowFrom`: DM 허용 목록 (사용자 ID). `open`은 `"*"`가 필요합니다. 마법사는 숫자 ID를 요청합니다.
- `channels.zalo.mediaMaxMb`: 수신/발신 미디어 한도 (MB, 기본 5).
- `channels.zalo.webhookUrl`: 웹훅 모드 활성화 (HTTPS 필요).
- `channels.zalo.webhookSecret`: 웹훅 비밀 (8-256자).
- `channels.zalo.webhookPath`: 게이트웨이 HTTP 서버의 웹훅 경로.
- `channels.zalo.proxy`: API 요청을 위한 프록시 URL.

다중 계정 옵션:

- `channels.zalo.accounts.<id>.botToken`: 계정별 토큰.
- `channels.zalo.accounts.<id>.tokenFile`: 계정별 토큰 파일.
- `channels.zalo.accounts.<id>.name`: 표시 이름.
- `channels.zalo.accounts.<id>.enabled`: 계정 활성화/비활성화.
- `channels.zalo.accounts.<id>.dmPolicy`: 계정별 DM 정책.
- `channels.zalo.accounts.<id>.allowFrom`: 계정별 허용 목록.
- `channels.zalo.accounts.<id>.webhookUrl`: 계정별 웹훅 URL.
- `channels.zalo.accounts.<id>.webhookSecret`: 계정별 웹훅 비밀.
- `channels.zalo.accounts.<id>.webhookPath`: 계정별 웹훅 경로.
- `channels.zalo.accounts.<id>.proxy`: 계정별 프록시 URL.
