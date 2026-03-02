---
summary: "OpenClaw 가 연결할 수 있는 메시징 플랫폼"
read_when:
  - OpenClaw 를 위한 채팅 채널을 선택하고 싶을 때
  - 지원되는 메시징 플랫폼에 대해 빠르게 알아보고 싶을 때
title: "채팅 채널"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: channels/index.md
  workflow: 15
---

# 채팅 채널

OpenClaw 는 당신이 이미 사용 중인 모든 채팅 앱에서 당신과 대화할 수 있습니다. 각 채널은 Gateway 게이트웨이를 통해 연결됩니다.
텍스트는 모든 곳에서 지원됩니다. 미디어와 반응은 채널에 따라 다릅니다.

## 지원되는 채널

- [WhatsApp](/channels/whatsapp) — 가장 인기 있음. Baileys 사용, QR 페어링 필요.
- [Telegram](/channels/telegram) — grammY 를 통한 Bot API. 그룹 지원.
- [Discord](/channels/discord) — Discord Bot API + Gateway. 서버, 채널, DM 지원.
- [IRC](/channels/irc) — 클래식 IRC 서버. 채널 + 페어링/허용 목록 제어가 있는 DM.
- [Slack](/channels/slack) — Bolt SDK. 워크스페이스 앱.
- [Feishu](/channels/feishu) — Feishu/Lark 봇 (WebSocket 통해, 플러그인, 별도 설치 필요).
- [Google Chat](/channels/googlechat) — HTTP webhook 을 통한 Google Chat API 앱.
- [Mattermost](/channels/mattermost) — Bot API + WebSocket. 채널, 그룹, DM (플러그인, 별도 설치 필요).
- [Signal](/channels/signal) — signal-cli. 개인정보 보호 중심.
- [BlueBubbles](/channels/bluebubbles) — **iMessage 에 권장**. BlueBubbles macOS 서버 REST API 사용, 완전한 기능 지원 (편집, 취소, 효과, 반응, 그룹 관리 — 편집은 현재 macOS 26 Tahoe 에서 작동하지 않음).
- [iMessage (레거시)](/channels/imessage) — imsg CLI 를 통한 레거시 macOS 통합 (deprecated, 새로운 설정은 BlueBubbles 사용).
- [Microsoft Teams](/channels/msteams) — Bot Framework. 엔터프라이즈 지원 (플러그인, 별도 설치 필요).
- [Synology Chat](/channels/synology-chat) — Synology NAS Chat (발신/수신 webhook, 플러그인, 별도 설치 필요).
- [LINE](/channels/line) — LINE Messaging API 봇 (플러그인, 별도 설치 필요).
- [Nextcloud Talk](/channels/nextcloud-talk) — Nextcloud Talk 를 통한 자체 호스팅 채팅 (플러그인, 별도 설치 필요).
- [Matrix](/channels/matrix) — Matrix 프로토콜 (플러그인, 별도 설치 필요).
- [Nostr](/channels/nostr) — NIP-04 를 통한 분산형 DM (플러그인, 별도 설치 필요).
- [Tlon](/channels/tlon) — Urbit 기반 메신저 (플러그인, 별도 설치 필요).
- [Twitch](/channels/twitch) — IRC 연결을 통한 Twitch 채팅 (플러그인, 별도 설치 필요).
- [Zalo](/channels/zalo) — Zalo Bot API. 베트남의 인기 있는 메신저 (플러그인, 별도 설치 필요).
- [Zalo Personal](/channels/zalouser) — QR 로그인을 통한 Zalo 개인 계정 (플러그인, 별도 설치 필요).
- [WebChat](/web/webchat) — WebSocket 을 통한 Gateway WebChat UI.

## 참고사항

- 채널은 동시에 실행될 수 있습니다. 여러 채널을 구성하면 OpenClaw 는 채팅별로 라우팅합니다.
- 가장 빠른 설정은 보통 **Telegram** 입니다 (간단한 봇 토큰). WhatsApp 은 QR 페어링이 필요하고
  디스크에 더 많은 상태를 저장합니다.
- 그룹 동작은 채널에 따라 다릅니다. [그룹](/channels/groups) 을 참고하세요.
- DM 페어링과 허용 목록은 보안을 위해 강제됩니다. [보안](/gateway/security) 을 참고하세요.
- 문제 해결: [채널 문제 해결](/channels/troubleshooting).
- 모델 공급자는 별도로 문서화됩니다. [모델 공급자](/providers/models) 를 참고하세요.
