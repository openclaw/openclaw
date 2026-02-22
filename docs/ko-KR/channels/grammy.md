---
summary: "Telegram Bot API 를 grammY 를 통해 통합하고 설정 노트를 제공합니다"
read_when:
  - Telegram 또는 grammY 경로를 작업하고 있습니다
title: grammY
---

# grammY Integration (Telegram Bot API)

# Why grammY

- 기본적으로 long-poll + 웹훅 도우미, 미들웨어, 오류 처리, 속도 제한기가 내장된 TS 우선 Bot API 클라이언트입니다.
- 직접 fetch + FormData 를 작성하는 것보다 더 깔끔한 미디어 헬퍼; 모든 Bot API 메서드를 지원합니다.
- 확장 가능: 사용자 정의 fetch 를 통한 프록시 지원, (선택 사항) 세션 미들웨어, 타입-세이프 컨텍스트.

# What we shipped

- **Single client path:** fetch 기반 구현이 제거되었습니다; grammY 는 이제 유일한 Telegram 클라이언트입니다 (발송 + 게이트웨이) 기본적으로 grammY 스로틀러가 활성화되어 있습니다.
- **Gateway:** `monitorTelegramProvider` 는 grammY `Bot` 을 빌드하고, 멘션/허용 목록 게이트를 연결하며, `getFile`/`download` 를 통해 미디어를 다운로드하고 `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument` 로 응답을 전송합니다. `webhookCallback` 을 통해 long-poll 또는 웹훅을 지원합니다.
- **Proxy:** 선택적인 `channels.telegram.proxy` 는 grammY의 `client.baseFetch` 를 통해 `undici.ProxyAgent` 를 사용합니다.
- **Webhook support:** `webhook-set.ts` 는 `setWebhook/deleteWebhook` 을 래핑합니다; `webhook.ts` 는 건강 + 우아한 종료를 가진 콜백을 호스팅합니다. `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` 가 설정되면 Gateway 는 webhook 모드를 활성화합니다 (그렇지 않으면 long-polling 합니다).
- **Sessions:** 직접 채팅은 에이전트 메인 세션 (`agent:<agentId>:<mainKey>`) 으로 병합됩니다; 그룹은 `agent:<agentId>:telegram:group:<chatId>` 를 사용합니다; 응답은 동일한 채널로 라우팅됩니다.
- **Config knobs:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (허용 목록 + 기본 멘션), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`, `channels.telegram.webhookHost`.
- **Live stream preview:** 선택적인 `channels.telegram.streamMode` 는 임시 메시지를 보내고 이를 `editMessageText` 로 업데이트합니다. 이는 채널의 블록 스트리밍과는 별도입니다.
- **Tests:** grammy 모의 테스트는 DM + 그룹 멘션 게이팅과 송신 발송을 다룹니다; 더 많은 미디어/웹훅 픽스처가 여전히 환영입니다.

Open questions

- Bot API 429 가 발생하면 선택적으로 grammY 플러그인 (토슬러) 를 사용할 수 있습니다.
- 더 구조화된 미디어 테스트 (스티커, 음성 메모) 를 추가합니다.
- 웹훅 듣기 포트를 구성 가능하게 만듭니다 (현재 게이트웨이를 통해 연결되지 않으면 8787로 고정됨).