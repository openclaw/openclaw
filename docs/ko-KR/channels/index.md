---
summary: "Messaging platforms OpenClaw can connect to"
read_when:
  - You want to choose a chat channel for OpenClaw
  - You need a quick overview of supported messaging platforms
title: "Chat Channels"
x-i18n:
  source_hash: a414b140ce8446e405535a5f1f1186d980a8ec60238c373f5cad25c8d7f9236e
---

# 채팅 채널

OpenClaw는 귀하가 이미 사용하고 있는 모든 채팅 앱에서 귀하와 대화할 수 있습니다. 각 채널은 게이트웨이를 통해 연결됩니다.
텍스트는 어디에서나 지원됩니다. 미디어와 반응은 채널에 따라 다릅니다.

## 지원 채널

- [WhatsApp](/channels/whatsapp) — 가장 인기가 있습니다. Baileys를 사용하며 QR 페어링이 필요합니다.
- [Telegram](/channels/telegram) — grammY를 통한 봇 API; 그룹을 지원합니다.
- [Discord](/channels/discord) — Discord Bot API + 게이트웨이; 서버, 채널 및 DM을 지원합니다.
- [IRC](/channels/irc) — 클래식 IRC 서버; 채널 + 페어링/허용 목록 제어 기능이 있는 DM.
- [Slack](/channels/slack) — 볼트 SDK; 작업 공간 앱.
- [Feishu](/channels/feishu) — WebSocket을 통한 Feishu/Lark 봇(플러그인, 별도로 설치됨).
- [Google Chat](/channels/googlechat) — HTTP 웹훅을 통한 Google Chat API 앱입니다.
- [Mattermost](/channels/mattermost) — 봇 API + WebSocket; 채널, 그룹, DM(플러그인, 별도 설치).
- [신호](/channels/signal) — signal-cli; 개인 정보 보호에 중점을 둡니다.
- [BlueBubbles](/channels/bluebubbles) — **iMessage에 권장됨**; 전체 기능 지원(편집, 보내기 취소, 효과, 반응, 그룹 관리 - 현재 macOS 26 Tahoe에서 편집이 중단됨)과 함께 BlueBubbles macOS 서버 REST API를 사용합니다.
- [iMessage(레거시)](/channels/imessage) — imsg CLI를 통한 레거시 macOS 통합(더 이상 사용되지 않음, 새 설정에는 BlueBubbles 사용)
- [Microsoft Teams](/channels/msteams) — 봇 프레임워크; 기업 지원(플러그인, 별도 설치)
- [LINE](/channels/line) — LINE 메시징 API 봇(플러그인, 별도 설치)
- [Nextcloud Talk](/channels/nextcloud-talk) — Nextcloud Talk를 통한 자체 호스팅 채팅(플러그인, 별도 설치).
- [Matrix](/channels/matrix) — 매트릭스 프로토콜(플러그인, 별도 설치).
- [Nostr](/channels/nostr) — NIP-04를 통한 분산형 DM(플러그인, 별도로 설치됨).
- [Tlon](/channels/tlon) — Urbit 기반 메신저(플러그인, 별도 설치).
- [Twitch](/channels/twitch) — IRC 연결을 통한 Twitch 채팅(플러그인, 별도 설치).
- [Zalo](/channels/zalo) — Zalo 봇 API; 베트남의 인기 메신저(플러그인, 별도 설치)입니다.
- [Zalo Personal](/channels/zalouser) — QR 로그인을 통한 Zalo 개인 계정(플러그인, 별도 설치).
- [WebChat](/web/webchat) — WebSocket을 통한 게이트웨이 WebChat UI입니다.

## 메모

- 채널은 동시에 실행될 수 있습니다. 여러 개를 구성하면 OpenClaw가 채팅별로 라우팅합니다.
- 가장 빠른 설정은 일반적으로 **텔레그램**(간단한 봇 토큰)입니다. WhatsApp에는 QR 페어링이 필요하며
  디스크에 더 많은 상태를 저장합니다.
- 그룹 행동은 채널에 따라 다릅니다. [그룹](/channels/groups)을 참조하세요.
- 안전을 위해 DM 페어링 및 허용 목록이 시행됩니다. [보안](/gateway/security)을 참조하세요.
- 텔레그램 내부: [grammY 노트](/channels/grammy).
- 문제 해결: [채널 문제 해결](/channels/troubleshooting).
- 모델 제공자는 별도로 문서화됩니다. [모델 제공자](/providers/models)를 참조하세요.
