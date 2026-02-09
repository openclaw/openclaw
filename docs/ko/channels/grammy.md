---
summary: "grammY 를 통한 Telegram Bot API 통합과 설정 참고 사항"
read_when:
  - Telegram 또는 grammY 경로를 작업할 때
title: grammY
---

# grammY 통합 (Telegram Bot API)

# 왜 grammY 인가

- TS 우선 Bot API 클라이언트로, 내장된 long-poll + webhook 헬퍼, 미들웨어, 오류 처리, 레이트 리미터를 제공합니다.
- fetch + FormData 를 직접 구성하는 방식보다 미디어 헬퍼가 깔끔하며, 모든 Bot API 메서드를 지원합니다.
- 확장 가능: 커스텀 fetch 를 통한 프록시 지원, 세션 미들웨어(선택 사항), 타입 안전한 컨텍스트를 제공합니다.

# 우리가 제공한 것

- **단일 클라이언트 경로:** fetch 기반 구현을 제거하고, grammY 를 기본적으로 throttler 가 활성화된 유일한 Telegram 클라이언트(전송 + Gateway)로 사용합니다.
- **Gateway:** `monitorTelegramProvider` 는 grammY `Bot` 를 구성하고, 멘션/허용 목록 게이팅을 연결하며, `getFile`/`download` 를 통한 미디어 다운로드와 `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument` 를 통한 응답 전달을 처리합니다. `webhookCallback` 를 통해 long-poll 또는 webhook 를 지원합니다.
- **프록시:** 선택 사항인 `channels.telegram.proxy` 는 grammY 의 `client.baseFetch` 를 통해 `undici.ProxyAgent` 를 사용합니다.
- **Webhook 지원:** `webhook-set.ts` 는 `setWebhook/deleteWebhook` 를 래핑하며, `webhook.ts` 는 헬스 체크 + 정상 종료를 포함한 콜백을 호스팅합니다. Gateway 는 `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` 가 설정되면 webhook 모드를 활성화하고(그렇지 않으면 long-poll 을 사용합니다).
- **세션:** 다이렉트 메시지 채팅은 에이전트 메인 세션(`agent:<agentId>:<mainKey>`)으로 병합되며, 그룹은 `agent:<agentId>:telegram:group:<chatId>` 를 사용합니다. 응답은 동일한 채널로 라우팅됩니다.
- **설정 노브:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (허용 목록 + 멘션 기본값), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`.
- **초안 스트리밍:** 선택 사항인 `channels.telegram.streamMode` 는 개인 토픽 채팅(Bot API 9.3+)에서 `sendMessageDraft` 를 사용합니다. 이는 채널 블록 스트리밍과는 별개입니다.
- **테스트:** grammY 모킹은 다이렉트 메시지 + 그룹 멘션 게이팅과 아웃바운드 전송을 커버합니다. 추가적인 미디어/webhook 픽스처는 환영합니다.

미해결 질문

- Bot API 429 오류가 발생할 경우 선택적인 grammY 플러그인(throttler) 적용 여부.
- 더 구조화된 미디어 테스트 추가(스티커, 음성 노트).
- webhook 리스닝 포트를 설정 가능하게 만들기(현재는 Gateway 를 통해 연결되지 않는 한 8787 로 고정됨).
