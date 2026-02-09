---
summary: "OpenClaw 가 연결할 수 있는 메시징 플랫폼"
read_when:
  - OpenClaw 에 사용할 채팅 채널을 선택하려는 경우
  - 지원되는 메시징 플랫폼의 빠른 개요가 필요한 경우
title: "채팅 채널"
---

# 채팅 채널

OpenClaw 는 이미 사용 중인 어떤 채팅 앱에서도 대화할 수 있습니다. 각 채널은 Gateway(게이트웨이)를 통해 연결됩니다.
텍스트는 모든 채널에서 지원되며, 미디어와 반응은 채널에 따라 다릅니다.

## 지원되는 채널

- [WhatsApp](/channels/whatsapp) — 가장 인기 있음; Baileys 를 사용하며 QR 페어링이 필요합니다.
- [Telegram](/channels/telegram) — grammY 를 통한 Bot API; 그룹을 지원합니다.
- [Discord](/channels/discord) — Discord Bot API + Gateway(게이트웨이); 서버, 채널 및 다이렉트 메시지를 지원합니다.
- [Slack](/channels/slack) — Bolt SDK; 워크스페이스 앱.
- [Feishu](/channels/feishu) — WebSocket 을 통한 Feishu/Lark 봇 (플러그인, 별도 설치).
- [Google Chat](/channels/googlechat) — HTTP 웹훅을 통한 Google Chat API 앱.
- [Mattermost](/channels/mattermost) — Bot API + WebSocket; 채널, 그룹, 다이렉트 메시지 (플러그인, 별도 설치).
- [Signal](/channels/signal) — signal-cli; 개인정보 보호 중심.
- [BlueBubbles](/channels/bluebubbles) — **iMessage 에 권장**; 전체 기능 지원으로 BlueBubbles macOS 서버 REST API 를 사용합니다 (편집, 전송 취소, 효과, 반응, 그룹 관리 — 편집은 현재 macOS 26 Tahoe 에서 동작하지 않음).
- [iMessage (legacy)](/channels/imessage) — imsg CLI 를 통한 레거시 macOS 통합 (사용 중단 예정, 신규 설정에는 BlueBubbles 사용 권장).
- [Microsoft Teams](/channels/msteams) — Bot Framework; 엔터프라이즈 지원 (플러그인, 별도 설치).
- [LINE](/channels/line) — LINE Messaging API 봇 (플러그인, 별도 설치).
- [Nextcloud Talk](/channels/nextcloud-talk) — Nextcloud Talk 을 통한 자체 호스팅 채팅 (플러그인, 별도 설치).
- [Matrix](/channels/matrix) — Matrix 프로토콜 (플러그인, 별도 설치).
- [Nostr](/channels/nostr) — NIP-04 를 통한 분산형 다이렉트 메시지 (플러그인, 별도 설치).
- [Tlon](/channels/tlon) — Urbit 기반 메신저 (플러그인, 별도 설치).
- [Twitch](/channels/twitch) — IRC 연결을 통한 Twitch 채팅 (플러그인, 별도 설치).
- [Zalo](/channels/zalo) — Zalo Bot API; 베트남의 인기 메신저 (플러그인, 별도 설치).
- [Zalo Personal](/channels/zalouser) — QR 로그인 기반 Zalo 개인 계정 (플러그인, 별도 설치).
- [WebChat](/web/webchat) — WebSocket 을 통한 Gateway(게이트웨이) WebChat UI.

## 참고

- 채널은 동시에 실행할 수 있으며, 여러 개를 구성하면 OpenClaw 가 채팅별로 라우팅합니다.
- 가장 빠른 설정은 보통 **Telegram** 입니다 (간단한 봇 토큰). WhatsApp 은 QR 페어링이 필요하며
  디스크에 더 많은 상태를 저장합니다.
- 그룹 동작은 채널마다 다릅니다. [Groups](/channels/groups)를 참고하십시오.
- 안전을 위해 다이렉트 메시지 페어링과 허용 목록이 적용됩니다. [Security](/gateway/security)를 참고하십시오.
- Telegram 내부 동작: [grammY notes](/channels/grammy).
- 문제 해결: [Channel troubleshooting](/channels/troubleshooting).
- 모델 프로바이더는 별도로 문서화되어 있습니다. [Model Providers](/providers/models)를 참고하십시오.
