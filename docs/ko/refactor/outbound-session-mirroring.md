---
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
title: 아웃바운드 세션 미러링 리팩터링(문제
x-i18n:
    generated_at: "2026-02-08T16:07:50Z"
    model: gtx
    provider: google-translate
    source_hash: b88a72f36f7b6d8a71fde9d014c0a87e9a8b8b0d449b67119cf3b6f414fa2b81
    source_path: refactor/outbound-session-mirroring.md
    workflow: 15
---

# 아웃바운드 세션 미러링 리팩터링(문제 #1520)

## 상태

- 진행 중입니다.
- 아웃바운드 미러링을 위해 코어 + 플러그인 채널 라우팅이 업데이트되었습니다.
- 이제 sessionKey가 생략되면 게이트웨이 전송이 대상 세션을 파생합니다.

## 문맥

아웃바운드 전송이 _현재의_ 대상 채널 세션이 아닌 에이전트 세션(도구 세션 키)입니다. 인바운드 라우팅은 채널/피어 세션 키를 사용하므로 아웃바운드 응답이 잘못된 세션에 전달되고 첫 번째 접촉 대상에는 세션 항목이 부족한 경우가 많습니다.

## 목표

- 아웃바운드 메시지를 대상 채널 세션 키로 미러링합니다.
- 누락된 경우 아웃바운드에 세션 항목을 만듭니다.
- 스레드/주제 범위를 인바운드 세션 키에 맞춰 유지하세요.
- 핵심 채널과 번들 확장 프로그램을 다룹니다.

## 구현 요약

- 새로운 아웃바운드 세션 라우팅 도우미:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` 다음을 사용하여 대상 sessionKey를 빌드합니다. `buildAgentSessionKey` (dmScope + IdentityLinks).
  - `ensureOutboundSessionEntry` 최소한의 글을 쓴다 `MsgContext` ~을 통해 `recordSessionMetaFromInbound`.
- `runMessageAction` (보내기) 대상 sessionKey를 파생하여 전달합니다. `executeSendAction` 미러링용.
- `message-tool` 더 이상 직접적으로 미러링되지 않습니다. 현재 세션 키의 AgentId만 확인합니다.
- 플러그인은 다음을 통해 경로 미러를 보냅니다. `appendAssistantMessageToSessionTranscript` 파생된 sessionKey를 사용합니다.
- 게이트웨이 전송은 아무것도 제공되지 않은 경우(기본 에이전트) 대상 세션 키를 파생하고 세션 항목을 보장합니다.

## 스레드/주제 처리

- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (접미사).
- 불일치: threadId/replyTo -> `resolveThreadSessionKeys` ~와 함께 `useSuffix=false` 인바운드와 일치합니다(스레드 채널 ID가 이미 세션 범위를 지정함).
- 텔레그램: 주제 ID가 다음에 매핑됩니다. `chatId:topic:<id>` ~을 통해 `buildTelegramGroupPeerId`.

## 적용되는 확장

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon.
- 참고:
  - 이제 가장 중요한 대상이 제거됩니다. `@` DM 세션 키 라우팅을 위해.
  - Zalo Personal은 1:1 대상에 대해 DM 피어 종류를 사용합니다. `group:` 존재합니다).
  - BlueBubbles 그룹 타겟 스트립 `chat_*` 인바운드 세션 키와 일치하는 접두사.
  - Slack 자동 스레드 미러링은 채널 ID를 대소문자를 구분하지 않고 일치시킵니다.
  - 게이트웨이는 미러링 전에 제공된 세션 키를 소문자로 보냅니다.

## 결정

- **게이트웨이 전송 세션 파생**: 만약에 `sessionKey` 제공되므로 이용하세요. 생략하는 경우 대상 + 기본 에이전트에서 sessionKey를 파생하고 거기에 미러링합니다.
- **세션 항목 생성**: 항상 사용 `recordSessionMetaFromInbound` ~와 함께 `Provider/From/To/ChatType/AccountId/Originating*` 인바운드 형식에 맞춰 조정됩니다.
- **목표 정규화**: 아웃바운드 라우팅은 해결된 대상을 사용합니다(포스트 `resolveChannelTarget`) 가능한 경우.
- **세션 키 케이스**: 쓰기 및 마이그레이션 중에 세션 키를 소문자로 정규화합니다.

## 테스트 추가/업데이트

- `src/infra/outbound/outbound-session.test.ts`
  - Slack 스레드 세션 키.
  - 텔레그램 주제 세션 키입니다.
  - dmScope IDDiscord와의 링크.
- `src/agents/tools/message-tool.test.ts`
  - 세션 키에서 에이전트 ID를 파생합니다(sessionKey가 전달되지 않음).
- `src/gateway/server-methods/send.test.ts`
  - 생략 시 세션 키를 파생하여 세션 항목을 생성합니다.

## 열린 항목/후속 조치

- 음성 통화 플러그인은 사용자 정의를 사용합니다. `voice:<phone>` 세션 키. 아웃바운드 매핑은 여기서 표준화되지 않습니다. 메시지 도구가 음성 통화 전송을 지원해야 하는 경우 명시적인 매핑을 추가하세요.
- 비표준을 사용하는 외부 플러그인이 있는지 확인 `From/To` 번들 세트 이상의 형식.

## 터치된 파일

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- 테스트 대상:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
