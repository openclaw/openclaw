---
read_when:
    - OpenClaw가 지원하는 전체 목록을 원합니다.
summary: 채널, 라우팅, 미디어 및 UX 전반에 걸친 OpenClaw 기능.
title: 특징
x-i18n:
    generated_at: "2026-02-08T15:53:53Z"
    model: gtx
    provider: google-translate
    source_hash: 1b6aee0bfda751824cb6b3a99080b4c80c00ffb355a96f9cff1b596d55d15ed4
    source_path: concepts/features.md
    workflow: 15
---

## 하이라이트

<Columns>
  <Card title="Channels" icon="message-square">
    단일 게이트웨이를 사용하는 WhatsApp, Telegram, Discord 및 iMessage.
  </Card>
  <Card title="Plugins" icon="plug">
    확장 기능을 사용하여 Mattermost 등을 추가하세요.
  </Card>
  <Card title="Routing" icon="route">
    격리된 세션을 사용한 다중 에이전트 라우팅.
  </Card>
  <Card title="Media" icon="image">
    이미지, 오디오, 문서가 들어오고 나가고 있습니다.
  </Card>
  <Card title="Apps and UI" icon="monitor">
    웹 컨트롤 UI 및 macOS 동반 앱.
  </Card>
  <Card title="Mobile nodes" icon="smartphone">
    Canvas를 지원하는 iOS 및 Android 노드.
  </Card>
</Columns>

## 전체 목록

- WhatsApp 웹을 통한 WhatsApp 통합(Baileys)
- 텔레그램 봇 지원(grammY)
- Discord 봇 지원(channels.discord.js)
- Mattermost 봇 지원(플러그인)
- 로컬 imsg CLI를 통한 iMessage 통합(macOS)
- 도구 스트리밍을 사용하는 RPC 모드의 Pi용 에이전트 브리지
- 긴 응답을 위한 스트리밍 및 청킹
- 작업 공간 또는 발신자별로 격리된 세션을 위한 다중 에이전트 라우팅
- OAuth를 통한 Anthropic 및 OpenAI 구독 인증
- 세션: 직접 채팅이 공유로 축소됩니다. `main`; 그룹은 고립되어 있다
- 멘션 기반 활성화를 통한 그룹 채팅 지원
- 이미지, 오디오, 문서에 대한 미디어 지원
- 선택적 음성 메모 전사 후크
- WebChat 및 macOS 메뉴 표시줄 앱
- 페어링 및 Canvas 표면이 있는 iOS 노드
- 페어링, 캔버스, 채팅, 카메라가 포함된 Android 노드

<Note>
레거시 Claude, Codex, Gemini 및 Opencode 경로가 제거되었습니다. 파이는 유일한
코딩 에이전트 경로.
</Note>
