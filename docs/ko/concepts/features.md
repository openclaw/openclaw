---
summary: "채널, 라우팅, 미디어, UX 전반에 걸친 OpenClaw 기능."
read_when:
  - OpenClaw 가 지원하는 전체 목록이 필요할 때
title: "기능"
---

## 주요 사항

<Columns>
  <Card title="Channels" icon="message-square">
    단일 Gateway(게이트웨이)로 WhatsApp, Telegram, Discord, iMessage 를 지원합니다.
  </Card>
  <Card title="Plugins" icon="plug">
    확장으로 Mattermost 등 다양한 서비스를 추가합니다.
  </Card>
  <Card title="Routing" icon="route">
    격리된 세션을 갖춘 다중 에이전트 라우팅.
  </Card>
  <Card title="Media" icon="image">
    이미지, 오디오, 문서의 입출력.
  </Card>
  <Card title="Apps and UI" icon="monitor">
    웹 제어 UI 와 macOS 컴패니언 앱.
  </Card>
  <Card title="Mobile nodes" icon="smartphone">
    Canvas 지원을 포함한 iOS 및 Android 노드.
  </Card>
</Columns>

## 전체 목록

- WhatsApp Web(Baileys)을 통한 WhatsApp 통합
- Telegram 봇 지원(grammY)
- Discord 봇 지원(channels.discord.js)
- Mattermost 봇 지원(플러그인)
- 로컬 imsg CLI(macOS)를 통한 iMessage 통합
- 도구 스트리밍을 포함한 RPC 모드의 Pi 용 에이전트 브리지
- 긴 응답을 위한 스트리밍 및 청킹
- 워크스페이스 또는 발신자별로 격리된 세션을 위한 다중 에이전트 라우팅
- OAuth 를 통한 Anthropic 및 OpenAI 구독 인증
- 세션: 다이렉트 채팅은 공유된 `main` 으로 병합되며, 그룹은 격리됩니다
- 멘션 기반 활성화를 포함한 그룹 채팅 지원
- 이미지, 오디오, 문서에 대한 미디어 지원
- 선택적 음성 메모 전사 훅
- WebChat 및 macOS 메뉴 바 앱
- 페어링과 Canvas 표면을 갖춘 iOS 노드
- 페어링, Canvas, 채팅, 카메라를 포함한 Android 노드

<Note>
레거시 Claude, Codex, Gemini, Opencode 경로는 제거되었습니다. Pi 가 유일한
코딩 에이전트 경로입니다.
</Note>
