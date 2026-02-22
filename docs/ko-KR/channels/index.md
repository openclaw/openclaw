---
summary: "OpenClaw 이 연결할 수 있는 메시징 플랫폼"
read_when:
  - OpenClaw 용 채팅 채널을 선택하고 싶을 때
  - 지원되는 메시징 플랫폼의 간단한 개요가 필요할 때
title: "Chat Channels"
---

# Chat Channels

OpenClaw 는 당신이 이미 사용하고 있는 채팅 앱에서 대화할 수 있습니다. 각 채널은 게이트웨이를 통해 연결됩니다. 텍스트는 모든 곳에서 지원되며, 미디어와 반응은 채널에 따라 다릅니다.

## Supported channels

- [WhatsApp](/ko-KR/channels/whatsapp) — 가장 인기 있으며, Baileys 를 사용하며 QR 페어링이 필요합니다.
- [Telegram](/ko-KR/channels/telegram) — grammY 를 통한 Bot API; 그룹을 지원합니다.
- [Discord](/ko-KR/channels/discord) — Discord Bot API + 게이트웨이; 서버, 채널, 다이렉트 메시지를 지원합니다.
- [IRC](/ko-KR/channels/irc) — 고전적인 IRC 서버; 채널과 다이렉트 메시지를 페어링/허용 목록 컨트롤과 함께 지원합니다.
- [Slack](/ko-KR/channels/slack) — Bolt SDK; 워크스페이스 앱입니다.
- [Feishu](/ko-KR/channels/feishu) — WebSocket 을 통한 Feishu/Lark 봇 (플러그인, 별도로 설치).
- [Google Chat](/ko-KR/channels/googlechat) — HTTP 웹훅을 통한 Google Chat API 앱.
- [Mattermost](/ko-KR/channels/mattermost) — Bot API + WebSocket; 채널, 그룹, 다이렉트 메시지 (플러그인, 별도로 설치).
- [Signal](/ko-KR/channels/signal) — signal-cli; 프라이버시 중점.
- [BlueBubbles](/ko-KR/channels/bluebubbles) — **iMessage 를 위한 추천**; BlueBubbles macOS 서버 REST API 를 사용하여 전체 기능 지원 (수정, 전송 취소, 이펙트, 반응, 그룹 관리 — 수정은 현재 macOS 26 Tahoe 에서 고장).
- [iMessage (legacy)](/ko-KR/channels/imessage) — imsg CLI 를 통한 레거시 macOS 통합 (더 이상 사용되지 않음, 새로운 설치에는 BlueBubbles 사용).
- [Microsoft Teams](/ko-KR/channels/msteams) — Bot Framework; 엔터프라이즈 지원 (플러그인, 별도로 설치).
- [LINE](/ko-KR/channels/line) — LINE Messaging API 봇 (플러그인, 별도로 설치).
- [Nextcloud Talk](/ko-KR/channels/nextcloud-talk) — Nextcloud Talk 를 통한 자가 호스팅 채팅 (플러그인, 별도로 설치).
- [Matrix](/ko-KR/channels/matrix) — Matrix 프로토콜 (플러그인, 별도로 설치).
- [Nostr](/ko-KR/channels/nostr) — NIP-04 를 통한 탈중앙화 다이렉트 메시지 (플러그인, 별도로 설치).
- [Tlon](/ko-KR/channels/tlon) — Urbit 기반 메신저 (플러그인, 별도로 설치).
- [Twitch](/ko-KR/channels/twitch) — IRC 연결을 통한 Twitch 채팅 (플러그인, 별도로 설치).
- [Zalo](/ko-KR/channels/zalo) — Zalo Bot API; 베트남의 인기 메신저 (플러그인, 별도로 설치).
- [Zalo Personal](/ko-KR/channels/zalouser) — QR 로그인에 의한 Zalo 개인 계정 (플러그인, 별도로 설치).
- [WebChat](/ko-KR/web/webchat) — WebSocket 을 통한 게이트웨이 WebChat UI.

## Notes

- 채널은 동시에 실행될 수 있으며, 여러 개를 구성하여 OpenClaw 가 채팅 별로 경로를 지정할 수 있습니다.
- 가장 빠른 설정은 일반적으로 **Telegram** (간단한 봇 토큰)입니다. WhatsApp 은 QR 페어링이 필요하며 더 많은 상태를 디스크에 저장합니다.
- 그룹 동작은 채널에 따라 다릅니다; [Groups](/ko-KR/channels/groups)를 참조하세요.
- 다이렉트 메시지 페어링과 허용 목록은 안전을 위해 적용됩니다; [Security](/ko-KR/gateway/security)를 참조하세요.
- Telegram 내부: [grammY notes](/ko-KR/channels/grammy).
- 문제 해결: [Channel troubleshooting](/ko-KR/channels/troubleshooting).
- 모델 프로바이더는 별도로 문서화되어 있습니다; [Model Providers](/ko-KR/providers/models)를 참조하세요.