---
read_when:
    - OpenClaw의 채팅 채널을 선택하고 싶습니다.
    - 지원되는 메시징 플랫폼에 대한 간략한 개요가 필요합니다.
summary: OpenClaw가 연결할 수 있는 메시징 플랫폼
title: 채팅 채널
x-i18n:
    generated_at: "2026-02-08T15:47:33Z"
    model: gtx
    provider: google-translate
    source_hash: 6a0e2c70133776d3cbb9e2e09f03ad40cdf457195bde8020fda89f0d94bc5536
    source_path: channels/index.md
    workflow: 15
---

# 채팅 채널

OpenClaw는 귀하가 이미 사용하고 있는 모든 채팅 앱에서 귀하와 대화할 수 있습니다. 각 채널은 게이트웨이를 통해 연결됩니다.
텍스트는 어디에서나 지원됩니다. 미디어와 반응은 채널에 따라 다릅니다.

## 지원되는 채널

- [왓츠앱](/channels/whatsapp) — 가장 인기 있는; Baileys를 사용하며 QR 페어링이 필요합니다.
- [전보](/channels/telegram) — grammY를 통한 봇 API; 그룹을 지원합니다.
- [불화](/channels/discord) — Discord Bot API + 게이트웨이; 서버, 채널 및 DM을 지원합니다.
- [느슨하게](/channels/slack) — 볼트 SDK; 작업 공간 앱.
- [페이슈](/channels/feishu) — WebSocket을 통한 Feishu/Lark 봇(플러그인, 별도 설치)
- [구글 채팅](/channels/googlechat) — HTTP 웹훅을 통한 Google Chat API 앱.
- [가장 중요한](/channels/mattermost) — 봇 API + WebSocket; 채널, 그룹, DM(플러그인, 별도 설치).
- [신호](/channels/signal) — 신호-cli; 개인 정보 보호에 중점을 둡니다.
- [블루버블스](/channels/bluebubbles) — **iMessage에 권장됨**; 전체 기능 지원(편집, 보내기 취소, 효과, 반응, 그룹 관리 - 현재 macOS 26 Tahoe에서 편집이 중단됨)과 함께 BlueBubbles macOS 서버 REST API를 사용합니다.
- [iMessage(레거시)](/channels/imessage) — imsg CLI를 통한 레거시 macOS 통합(더 이상 사용되지 않음, 새 설정에는 BlueBubbles 사용)
- [마이크로소프트 팀즈](/channels/msteams) — 봇 프레임워크; 기업 지원(플러그인, 별도 설치)
- [선](/channels/line) — LINE Messaging API 봇(플러그인, 별도 설치)
- [넥스트클라우드톡](/channels/nextcloud-talk) — Nextcloud Talk를 통한 자체 호스팅 채팅(플러그인, 별도 설치)
- [행렬](/channels/matrix) — 매트릭스 프로토콜(플러그인, 별도로 설치됨).
- [노스트르](/channels/nostr) — NIP-04(플러그인, 별도 설치)를 통한 분산형 DM.
- [트론](/channels/tlon) — Urbit 기반 메신저 (플러그인, 별도 설치).
- [경련](/channels/twitch) — IRC 연결을 통한 Twitch 채팅(플러그인, 별도 설치)
- [잘로](/channels/zalo) — Zalo 봇 API; 베트남의 인기 메신저(플러그인, 별도 설치)입니다.
- [Zalo 개인](/channels/zalouser) — QR 로그인을 통한 Zalo 개인 계정 (플러그인, 별도 설치)
- [웹채팅](/web/webchat) — WebSocket을 통한 게이트웨이 WebChat UI.

## 메모

- 채널은 동시에 실행될 수 있습니다. 여러 개를 구성하면 OpenClaw가 채팅별로 라우팅합니다.
- 가장 빠른 설정은 일반적으로 **전보** (간단한 봇 토큰). WhatsApp에는 QR 페어링이 필요하며
  디스크에 더 많은 상태를 저장합니다.
- 그룹 행동은 채널에 따라 다릅니다. 보다 [여러 떼](/channels/groups).
- 안전을 위해 DM 페어링 및 허용 목록이 시행됩니다. 보다 [보안](/gateway/security).
- 텔레그램 내부: [문법 노트](/channels/grammy).
- 문제 해결: [채널 문제 해결](/channels/troubleshooting).
- 모델 공급자는 별도로 문서화되어 있습니다. 보다 [모델 제공자](/providers/models).
