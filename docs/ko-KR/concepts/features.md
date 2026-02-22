---
summary: "OpenClaw의 채널, 라우팅, 미디어 및 사용자 경험에 대한 기능."
read_when:
  - OpenClaw에서 지원하는 모든 기능 목록을 원할 때
title: "기능"
---

## 주요 사항

<Columns>
  <Card title="채널" icon="message-square">
    WhatsApp, Telegram, Discord 및 iMessage를 단일 게이트웨이로 연결.
  </Card>
  <Card title="플러그인" icon="plug">
    Mattermost 및 기타 기능을 확장으로 추가.
  </Card>
  <Card title="라우팅" icon="route">
    격리된 세션을 통한 다중 에이전트 라우팅.
  </Card>
  <Card title="미디어" icon="image">
    이미지, 오디오 및 문서를 입출력.
  </Card>
  <Card title="앱 및 UI" icon="monitor">
    웹 제어 UI 및 macOS 동반 앱.
  </Card>
  <Card title="모바일 노드" icon="smartphone">
    Canvas 지원 iOS 및 Android 노드.
  </Card>
</Columns>

## 전체 목록

- WhatsApp Web (Baileys)을 통한 WhatsApp 통합
- Telegram 봇 지원 (grammY)
- Discord 봇 지원 (channels.discord.js)
- Mattermost 봇 지원 (플러그인)
- 로컬 imsg CLI (macOS)를 통한 iMessage 통합
- Pi의 RPC 모드에서 도구 스트리밍을 위한 에이전트 브리지
- 긴 응답에 대한 스트리밍 및 청킹
- 작업 공간 또는 발신자별로 격리된 세션을 위한 다중 에이전트 라우팅
- Anthropic 및 OpenAI에 대한 OAuth 기반 구독 인증
- 세션: 다이렉트 채팅은 공유 `main` 으로 통합; 그룹은 격리됨
- 언급 기반 활성화 기능의 그룹 채팅 지원
- 이미지, 오디오 및 문서에 대한 미디어 지원
- 선택적 음성 메모 전사 훅
- WebChat 및 macOS 메뉴 막대 앱
- 페어링 및 Canvas 표면을 지원하는 iOS 노드
- 페어링, Canvas, 채팅 및 카메라를 지원하는 Android 노드

<Note>
기존 Claude, Codex, Gemini 및 Opencode 경로가 제거되었습니다. Pi는 유일한 코딩 에이전트 경로입니다.
</Note>