---
read_when:
    - Telegram 또는 grammY 경로 작업
summary: 설정 노트와 함께 grammY를 통한 Telegram Bot API 통합
title: 그램Y
x-i18n:
    generated_at: "2026-02-08T15:46:39Z"
    model: gtx
    provider: google-translate
    source_hash: ea7ef23e6d77801f4ef5fc56685ef4470f79f5aecab448d644a72cbab53521b7
    source_path: channels/grammy.md
    workflow: 15
---

# grammY 통합(텔레그램 봇 API)

# 왜 grammY인가요?

- 장기 폴링 + 웹후크 도우미, 미들웨어, 오류 처리, 속도 제한기가 내장된 TS 최초 Bot API 클라이언트입니다.
- 수동으로 가져오기 + FormData를 수행하는 것보다 더 깔끔한 미디어 도우미입니다. 모든 Bot API 메서드를 지원합니다.
- 확장 가능: 사용자 정의 가져오기, 세션 미들웨어(선택 사항), 유형 안전 컨텍스트를 통한 프록시 지원.

# 우리가 배송한 것

- **단일 클라이언트 경로:** 가져오기 기반 구현이 제거되었습니다. grammY는 이제 기본적으로 grammY 스로틀러가 활성화된 유일한 텔레그램 클라이언트(전송 + 게이트웨이)입니다.
- **게이트웨이:** `monitorTelegramProvider` 문법을 만든다Y `Bot`, 와이어 언급/허용 목록 게이팅, 미디어 다운로드를 통해 `getFile`/`download`, 다음과 같은 답장을 전달합니다. `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. 다음을 통해 장기 폴링 또는 웹훅을 지원합니다. `webhookCallback`.
- **대리:** 선택 과목 `channels.telegram.proxy` 용도 `undici.ProxyAgent` GrammY를 통해 `client.baseFetch`.
- **웹훅 지원:** `webhook-set.ts` 랩 `setWebhook/deleteWebhook`; `webhook.ts` 상태 + 정상적인 종료로 콜백을 호스팅합니다. 게이트웨이는 다음 경우에 웹훅 모드를 활성화합니다. `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` 설정됩니다(그렇지 않으면 롱 폴링됩니다).
- **세션:** 직접 채팅은 상담원 기본 세션으로 축소됩니다(`agent:<agentId>:<mainKey>`); 그룹 사용 `agent:<agentId>:telegram:group:<chatId>`; 응답은 동일한 채널로 다시 라우팅됩니다.
- **구성 손잡이:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (허용 목록 + 기본값 언급), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`.
- **임시 스트리밍:** 선택 과목 `channels.telegram.streamMode` 용도 `sendMessageDraft` 비공개 주제 채팅(Bot API 9.3+). 이는 채널 블록 스트리밍과 별개입니다.
- **테스트:** 그래미 모의 커버 DM + 그룹 언급 게이팅 및 아웃바운드 전송; 더 많은 미디어/웹훅 설비를 환영합니다.

공개 질문

- Bot API 429에 도달하는 경우 선택적인 grammY 플러그인(조절기).
- 더 많은 구조화된 미디어 테스트(스티커, 음성 메모)를 추가합니다.
- 웹후크 청취 포트를 구성 가능하게 만듭니다(게이트웨이를 통해 연결하지 않는 한 현재 8787로 고정됨).
