---
summary: "Zalo 봇 지원 상태, 기능, 구성"
read_when:
  - Zalo 기능이나 웹훅을 작업하는 경우
title: "Zalo"
x-i18n:
  source_path: docs/channels/zalo.md
---

# Zalo (Bot API)

상태: 실험적. DM 이 지원됩니다. 아래 [기능](#capabilities) 섹션은 현재 Marketplace 봇 동작을 반영합니다.

## 플러그인 필요

Zalo 는 플러그인으로 제공되며 코어 설치에 번들되지 않습니다.

- CLI 를 통한 설치: `openclaw plugins install @openclaw/zalo`
- 또는 설정 중 **Zalo** 를 선택하고 설치 프롬프트를 확인
- 자세한 내용: [Plugins](/tools/plugin)

## 빠른 설정 (초보자)

1. Zalo 플러그인을 설치합니다.
2. 토큰을 설정합니다:
   - 환경: `ZALO_BOT_TOKEN=...`
   - 또는 구성: `channels.zalo.accounts.default.botToken: "..."`.
3. Gateway 를 재시작합니다 (또는 설정을 완료합니다).
4. DM 접근은 기본적으로 페어링입니다. 첫 연락 시 페어링 코드를 승인합니다.

최소 구성:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      accounts: {
        default: {
          botToken: "12345689:abc-xyz",
          dmPolicy: "pairing",
        },
      },
    },
  },
}
```

## 이것이 무엇인가

Zalo 는 베트남 중심의 메시징 앱입니다. Bot API 를 통해 Gateway 가 1:1 대화용 봇을 실행할 수 있습니다.
Zalo 로의 결정적 라우팅이 필요한 지원이나 알림에 적합합니다.

이 페이지는 **Zalo Bot Creator / Marketplace 봇**의 현재 OpenClaw 동작을 반영합니다.

## 제한 사항

- 아웃바운드 텍스트는 2000 자로 청크됩니다 (Zalo API 제한).
- 미디어 다운로드/업로드는 `channels.zalo.mediaMaxMb` (기본값 5) 로 제한됩니다.
- 2000 자 제한으로 스트리밍이 덜 유용하여 기본적으로 스트리밍이 차단됩니다.

## 접근 제어 (DM)

- 기본값: `channels.zalo.dmPolicy = "pairing"`. 알 수 없는 발신자에게 페어링 코드가 제공됩니다. 메시지는 승인될 때까지 무시됩니다 (코드는 1 시간 후 만료).
- 승인:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- `channels.zalo.allowFrom` 은 숫자 사용자 ID 를 허용합니다 (사용자명 조회 불가).

## 접근 제어 (그룹)

**Zalo Bot Creator / Marketplace 봇**의 경우, 봇을 그룹에 전혀 추가할 수 없어 그룹 지원이 실제로 사용 불가능했습니다.

그룹 정책 값 (봇 표면에서 그룹 접근이 가능한 경우):

- `groupPolicy: "disabled"` — 모든 그룹 메시지를 차단합니다.
- `groupPolicy: "open"` — 모든 그룹 멤버를 허용합니다 (멘션 게이팅).
- `groupPolicy: "allowlist"` — 실패 시 닫기 기본값. 허용된 발신자만 수락됩니다.

## 롱 폴링 vs 웹훅

- 기본값: 롱 폴링 (공개 URL 불필요).
- 웹훅 모드: `channels.zalo.webhookUrl` 과 `channels.zalo.webhookSecret` 을 설정합니다.
  - 웹훅 시크릿은 8-256 자여야 합니다.
  - 웹훅 URL 은 HTTPS 를 사용해야 합니다.

**참고:** getUpdates (폴링) 과 웹훅은 Zalo API 문서에 따라 상호 배타적입니다.

## 기능

| 기능                     | 상태                         |
| ------------------------ | ---------------------------- |
| 다이렉트 메시지          | 지원됨                       |
| 그룹                     | Marketplace 봇에서 사용 불가 |
| 미디어 (인바운드 이미지) | 제한적 / 환경에서 확인       |
| 평문 URL                 | 지원됨                       |
| 링크 미리보기            | Marketplace 봇에서 불안정    |
| 리액션                   | 미지원                       |
| 스레드                   | 미지원                       |
| 투표                     | 미지원                       |
| 스트리밍                 | 차단됨 (2000 자 제한)        |

## 전달 대상 (CLI/cron)

- 채팅 ID 를 대상으로 사용합니다.
- 예시: `openclaw message send --channel zalo --target 123456789 --message "hi"`.

## 문제 해결

**봇이 응답하지 않음:**

- 토큰이 유효한지 확인: `openclaw channels status --probe`
- 발신자가 승인되었는지 확인 (페어링 또는 allowFrom)
- Gateway 로그 확인: `openclaw logs --follow`

## 구성 참조 (Zalo)

전체 구성: [Configuration](/gateway/configuration)

프로바이더 옵션:

- `channels.zalo.enabled`: 채널 시작 활성화/비활성화.
- `channels.zalo.botToken`: Zalo Bot Platform 의 봇 토큰.
- `channels.zalo.tokenFile`: 일반 파일 경로에서 토큰 읽기. 심볼릭 링크는 거부됩니다.
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (기본값: pairing).
- `channels.zalo.allowFrom`: DM 허용 목록 (사용자 ID). `open` 은 `"*"` 필요.
- `channels.zalo.groupPolicy`: `open | allowlist | disabled` (기본값: allowlist).
- `channels.zalo.groupAllowFrom`: 그룹 발신자 허용 목록 (사용자 ID). 미설정 시 `allowFrom` 으로 폴백.
- `channels.zalo.mediaMaxMb`: 인바운드/아웃바운드 미디어 제한 (MB, 기본값 5).
- `channels.zalo.webhookUrl`: 웹훅 모드 활성화 (HTTPS 필수).
- `channels.zalo.webhookSecret`: 웹훅 시크릿 (8-256 자).
- `channels.zalo.webhookPath`: Gateway HTTP 서버의 웹훅 경로.
- `channels.zalo.proxy`: API 요청용 프록시 URL.
