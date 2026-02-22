```markdown
---
title: 아웃바운드 세션 미러링 리팩토링 (이슈 #1520)
description: 아웃바운드 세션 미러링 리팩토링의 노트, 결정, 테스트, 미결 항목 추적.
---

# 아웃바운드 세션 미러링 리팩토링 (이슈 #1520)

## 상태

- 진행 중.
- 코어 + 플러그인 채널 라우팅이 아웃바운드 미러링을 위해 업데이트됨.
- 게이트웨이 전송은 이제 sessionKey가 생략될 때 대상 세션을 유도함.

## 배경

아웃바운드 전송은 대상 채널 세션이 아닌 _현재_ 에이전트 세션(도구 세션 키)으로 미러링되었습니다. 인바운드 라우팅은 채널/피어 세션 키를 사용하여, 아웃바운드 응답이 잘못된 세션에 착지하게 되며, 첫 접촉 대상에는 세션 항목이 부족한 경우가 많았습니다.

## 목표

- 아웃바운드 메시지를 대상 채널 세션 키에 미러링.
- 아웃바운드 시 세션 항목이 없을 경우 생성.
- 스레드/주제 범위를 인바운드 세션 키와 일치하도록 유지.
- 코어 채널 뿐만 아니라 번들 확장도 포함.

## 구현 요약

- 새로운 아웃바운드 세션 라우팅 헬퍼:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute`는 `buildAgentSessionKey` (dmScope + identityLinks)를 사용하여 대상 sessionKey를 빌드함.
  - `ensureOutboundSessionEntry`는 `recordSessionMetaFromInbound`를 통해 최소한의 `MsgContext`를 기록함.
- `runMessageAction` (send)는 대상 sessionKey를 유도하고 이를 미러링하기 위해 `executeSendAction`에 전달함.
- `message-tool`은 더 이상 직접 미러링하지 않고, 현 세션 키에서 agentId만 추출함.
- 플러그인 전송 경로는 유도된 sessionKey를 사용하여 `appendAssistantMessageToSessionTranscript`를 통해 미러링함.
- 게이트웨이 전송은 session key가 제공되지 않을 때 (기본 에이전트) 대상 세션 키를 유도하고 세션 항목을 보장함.

## 스레드/주제 처리

- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (접미사 사용).
- Discord: threadId/replyTo -> `resolveThreadSessionKeys`와 `useSuffix=false`를 사용하여 인바운드와 일치함 (스레드 채널 ID가 이미 세션 범위를 잡음).
- Telegram: topic IDs는 `buildTelegramGroupPeerId`를 통해 `chatId:topic:<id>`로 매핑.

## 포함된 확장

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon.
- 노트:
  - Mattermost 대상은 이제 DM 세션 키 라우팅을 위해 `@`를 제거.
  - Zalo Personal은 1:1 대상에 대해 DM 피어 타입을 사용 (`group:`이 있을 경우 그룹으로만).
  - BlueBubbles 그룹 대상은 `chat_*` 접두사를 제거하여 인바운드 세션 키와 일치시킴.
  - Slack 자동 스레드 미러링은 채널 ID를 대소문자 구분 없이 일치시킴.
  - 게이트웨이 전송은 제공된 세션 키를 미러링하기 전에 소문자로 변환.

## 결정

- **게이트웨이 전송 세션 유도**: `sessionKey`가 제공되면 사용. 생략되면 대상 + 기본 에이전트로부터 sessionKey를 유도하고 거기에 미러링.
- **세션 항목 생성**: 항상 인바운드 형식에 맞춰 `Provider/From/To/ChatType/AccountId/Originating*`을 사용하여 `recordSessionMetaFromInbound` 사용.
- **대상 표준화**: 아웃바운드 라우팅은 가능할 경우 해결된 대상(post `resolveChannelTarget`) 사용.
- **세션 키 대소문자 맞춤**: 세션 키를 소문자로 정규화하여 쓰기 및 마이그레이션 중 사용.

## 추가/업데이트된 테스트

- `src/infra/outbound/outbound-session.test.ts`
  - Slack 스레드 세션 키.
  - Telegram 주제 세션 키.
  - Discord와 함께 dmScope identityLinks.
- `src/agents/tools/message-tool.test.ts`
  - 세션 키에서 agentId 유도 (sessionKey를 직접 전달하지 않음).
- `src/gateway/server-methods/send.test.ts`
  - 생략된 경우 세션 키를 유도하고 세션 항목을 생성.

## 미결 항목 / 후속 작업

- 음성 통화 플러그인은 사용자 정의 `voice:<phone>` 세션 키를 사용함. 아웃바운드 매핑은 여기에서 표준화되지 않으며, message-tool이 음성 통화 전송을 지원해야 한다면 명시적 매핑 추가.
- 번들 집합 외에 외부 플러그인이 비표준 `From/To` 형식을 사용하는지 확인.

## 수정된 파일

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- 테스트 파일:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
```
