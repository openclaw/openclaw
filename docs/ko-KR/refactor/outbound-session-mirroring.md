---
title: Outbound Session Mirroring 리팩터 (Issue #1520)
description: outbound sends를 target channel sessions로 미러링하는 리팩터 노트, 결정, 테스트 및 미해결 항목을 추적합니다.
summary: "대상 채널 세션으로 아웃바운드 sends를 미러링하는 동작에 대한 리팩터 노트"
read_when:
  - Working on outbound transcript/session mirroring behavior
  - Debugging sessionKey derivation for send/message tool paths
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/refactor/outbound-session-mirroring.md
  workflow: 15
---

# Outbound Session Mirroring 리팩터 (Issue #1520)

## 상태

- 진행 중입니다.
- 아웃바운드 미러링을 위해 Core + 플러그인 채널 라우팅을 업데이트했습니다.
- Gateway send는 이제 sessionKey가 생략되면 target session을 파생합니다.

## Context

아웃바운드 sends가 현재 agent session (tool session key)이 아니라 _current_ agent session으로 미러링되었습니다. 인바운드 라우팅은 channel/peer session 키를 사용하므로 아웃바운드 응답이 잘못된 세션에 있었고 first-contact targets는 종종 세션 항목이 부족했습니다.

## 목표

- 아웃바운드 메시지를 target channel session 키로 미러링합니다.
- 누락될 때 아웃바운드 세션 항목을 생성합니다.
- thread/topic 스코핑을 인바운드 세션 키와 정렬된 상태로 유지합니다.
- core 채널 + 번들된 확장을 포함합니다.

## 구현 요약

- 새로운 아웃바운드 세션 라우팅 헬퍼:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute`는 `buildAgentSessionKey` (dmScope + identityLinks)를 사용하여 target sessionKey를 빌드합니다.
  - `ensureOutboundSessionEntry`는 `recordSessionMetaFromInbound`를 통해 최소 `MsgContext`를 씁니다.
- `runMessageAction` (send)는 target sessionKey를 파생하고 미러링을 위해 `executeSendAction`에 전달합니다.
- `message-tool`은 더 이상 직접 미러링하지 않습니다; 현재 세션 키에서만 agentId를 해결합니다.
- 플러그인 send 경로는 파생된 sessionKey를 사용하여 `appendAssistantMessageToSessionTranscript`를 통해 미러링합니다.
- Gateway send는 제공되지 않을 때 target session 키를 파생합니다 (기본 에이전트), 그리고 세션 항목을 보장합니다.

## Thread/Topic 처리

- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (접미사).
- Discord: threadId/replyTo -> `resolveThreadSessionKeys` with `useSuffix=false`를 인바운드와 일치하도록 (thread channel id는 이미 세션을 범위합니다).
- Telegram: topic ID는 `buildTelegramGroupPeerId`를 통해 `chatId:topic:<id>`에 매핑됩니다.

## 포함된 확장

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon.
- 노트:
  - Mattermost targets는 이제 DM 세션 키 라우팅을 위해 `@`를 제거합니다.
  - Zalo Personal은 1:1 targets에 DM peer kind를 사용합니다 (그룹은 `group:`가 있을 때만).
  - BlueBubbles 그룹 targets는 `chat_*` 접두사를 제거하여 인바운드 세션 키와 일치합니다.
  - Slack 자동-thread 미러링은 채널 id를 대소문자-구분되지 않음으로 일치시킵니다.
  - Gateway send는 미러링 전에 제공된 세션 키를 소문자로 변환합니다.

## 결정

- **Gateway send session 파생**: `sessionKey`가 제공되면 사용합니다. 생략되면 target + 기본 에이전트에서 sessionKey를 파생하고 거기에 미러링합니다.
- **세션 항목 생성**: 항상 인바운드 형식에 정렬된 `recordSessionMetaFromInbound`를 `Provider/From/To/ChatType/AccountId/Originating*`과 함께 사용합니다.
- **Target 정규화**: 아웃바운드 라우팅은 available할 때 해결된 targets (post `resolveChannelTarget`)를 사용합니다.
- **세션 키 케이싱**: 쓰기 시 및 마이그레이션 중에 세션 키를 소문자로 정규화합니다.

## 추가/업데이트된 테스트

- `src/infra/outbound/outbound.test.ts`
  - Slack thread session 키.
  - Telegram topic session 키.
  - Discord와 dmScope identityLinks.
- `src/agents/tools/message-tool.test.ts`
  - 세션 키에서 agentId를 파생합니다 (sessionKey가 전달되지 않음).
- `src/gateway/server-methods/send.test.ts`
  - 생략될 때 세션 키를 파생하고 세션 항목을 생성합니다.

## 미해결 항목 / Follow-ups

- Voice-call 플러그인은 custom `voice:<phone>` 세션 키를 사용합니다. 아웃바운드 매핑은 여기에 표준화되지 않습니다; message-tool이 voice-call sends를 지원해야 하면 명시적 매핑을 추가합니다.
- 번들된 세트를 넘어 비-표준 `From/To` 형식을 사용하는 외부 플러그인이 있는지 확인합니다.

## 건드린 파일

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- 테스트:
  - `src/infra/outbound/outbound.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
