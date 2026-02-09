---
title: "아웃바운드 세션 미러링 리팩터링 (이슈 #1520)" #1520)
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
---

# 아웃바운드 세션 미러링 리팩터링 (이슈 #1520)

## 상태

- 진행 중.
- 아웃바운드 미러링을 위해 코어 + 플러그인 채널 라우팅이 업데이트됨.
- Gateway send 는 sessionKey 가 생략된 경우 대상 세션을 파생함.

## Context

아웃바운드 전송은 대상 채널 세션이 아니라 _현재_ 에이전트 세션(도구 세션 키)으로 미러링되고 있었습니다. 인바운드 라우팅은 채널/피어 세션 키를 사용하므로, 아웃바운드 응답이 잘못된 세션에 기록되었고 최초 접촉 대상은 세션 엔트리가 없는 경우가 많았습니다.

## 목표

- 아웃바운드 메시지를 대상 채널 세션 키로 미러링합니다.
- 누락된 경우 아웃바운드 시 세션 엔트리를 생성합니다.
- 스레드/토픽 스코핑을 인바운드 세션 키와 정렬합니다.
- 코어 채널과 번들 확장을 포함합니다.

## 구현 요약

- 새로운 아웃바운드 세션 라우팅 헬퍼:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` 는 `buildAgentSessionKey` (dmScope + identityLinks) 를 사용해 대상 sessionKey 를 구성합니다.
  - `ensureOutboundSessionEntry` 는 `recordSessionMetaFromInbound` 를 통해 최소한의 `MsgContext` 를 기록합니다.
- `runMessageAction` (send) 는 대상 sessionKey 를 파생하고 이를 `executeSendAction` 에 전달하여 미러링합니다.
- `message-tool` 는 더 이상 직접 미러링하지 않으며, 현재 세션 키에서 agentId 만 해석합니다.
- 플러그인 send 경로는 파생된 sessionKey 를 사용해 `appendAssistantMessageToSessionTranscript` 를 통해 미러링합니다.
- Gateway send 는 제공된 키가 없을 때 대상 세션 키를 파생(기본 에이전트)하고 세션 엔트리를 보장합니다.

## 스레드/토픽 처리

- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (접미사).
- Discord: threadId/replyTo -> 인바운드와 일치하도록 `useSuffix=false` 를 사용하는 `resolveThreadSessionKeys` (스레드 채널 id 가 이미 세션을 스코프함).
- Telegram: 토픽 ID 는 `buildTelegramGroupPeerId` 를 통해 `chatId:topic:<id>` 로 매핑됩니다.

## 포함된 확장

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon.
- 참고:
  - Mattermost 대상은 DM 세션 키 라우팅을 위해 이제 `@` 를 제거합니다.
  - Zalo Personal 은 1:1 대상에 DM 피어 종류를 사용합니다(`group:` 이 존재하는 경우에만 그룹).
  - BlueBubbles 그룹 대상은 인바운드 세션 키와 일치하도록 `chat_*` 접두사를 제거합니다.
  - Slack 자동 스레드 미러링은 채널 id 를 대소문자 구분 없이 일치시킵니다.
  - Gateway send 는 미러링 전에 제공된 세션 키를 소문자로 변환합니다.

## 결정 사항

- **Gateway send 세션 파생**: `sessionKey` 이 제공되면 이를 사용합니다. 생략된 경우 대상 + 기본 에이전트로부터 sessionKey 를 파생하여 해당 위치로 미러링합니다.
- **세션 엔트리 생성**: 인바운드 형식에 맞춰 `Provider/From/To/ChatType/AccountId/Originating*` 와 함께 항상 `recordSessionMetaFromInbound` 를 사용합니다.
- **대상 정규화**: 아웃바운드 라우팅은 가능한 경우(`resolveChannelTarget` 이후) 해석된 대상을 사용합니다.
- **세션 키 대소문자**: 기록 시와 마이그레이션 중에 세션 키를 소문자로 정규화합니다.

## 추가/업데이트된 테스트

- `src/infra/outbound/outbound-session.test.ts`
  - Slack 스레드 세션 키.
  - Telegram 토픽 세션 키.
  - Discord 에서 dmScope identityLinks.
- `src/agents/tools/message-tool.test.ts`
  - 세션 키로부터 agentId 를 파생함(세션 키를 전달하지 않음).
- `src/gateway/server-methods/send.test.ts`
  - 생략된 경우 세션 키를 파생하고 세션 엔트리를 생성함.

## 미해결 항목 / 후속 조치

- 음성 통화 플러그인은 사용자 정의 `voice:<phone>` 세션 키를 사용합니다. 여기서는 아웃바운드 매핑이 표준화되어 있지 않으므로, message-tool 이 음성 통화 전송을 지원해야 한다면 명시적 매핑을 추가하십시오.
- 번들된 세트 외에 비표준 `From/To` 형식을 사용하는 외부 플러그인이 있는지 확인하십시오.

## 수정된 파일

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- 테스트:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
