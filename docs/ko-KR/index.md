---
title: "OpenClaw"
summary: "OpenClaw 는 모든 OS 에서 실행되는 AI 에이전트 멀티 채널 게이트웨이입니다."
read_when:
  - OpenClaw 를 처음 접하는 사람에게 소개할 때
x-i18n:
  source_path: docs/index.md
---

# OpenClaw 🦞

<p align="center">
    <img
        src="/assets/openclaw-logo-text-dark.png"
        alt="OpenClaw"
        width="500"
        class="dark:hidden"
    />
    <img
        src="/assets/openclaw-logo-text.png"
        alt="OpenClaw"
        width="500"
        class="hidden dark:block"
    />
</p>

> _"EXFOLIATE! EXFOLIATE!"_ — 아마도 우주 랍스터

<p align="center">
  <strong>WhatsApp, Telegram, Discord, iMessage 등을 지원하는 모든 OS 용 AI 에이전트 게이트웨이.</strong><br />
  메시지를 보내면 주머니 속에서 에이전트 응답을 받을 수 있습니다. 플러그인으로 Mattermost 등을 추가할 수 있습니다.
</p>

<Columns>
  <Card title="시작하기" href="/start/getting-started" icon="rocket">
    OpenClaw 를 설치하고 몇 분 안에 Gateway 를 실행하세요.
  </Card>
  <Card title="온보딩 실행" href="/start/wizard" icon="sparkles">
    `openclaw onboard` 와 페어링 흐름을 통한 가이드 설정.
  </Card>
  <Card title="Control UI 열기" href="/web/control-ui" icon="layout-dashboard">
    채팅, 설정, 세션을 위한 브라우저 대시보드를 실행하세요.
  </Card>
</Columns>

## OpenClaw 란?

OpenClaw 는 여러분이 즐겨 사용하는 채팅 앱 — WhatsApp, Telegram, Discord, iMessage 등 — 을 Pi 같은 AI 코딩 에이전트에 연결하는 **셀프 호스팅 게이트웨이**입니다. 자신의 머신(또는 서버)에서 단일 Gateway 프로세스를 실행하면, 메시징 앱과 항상 사용 가능한 AI 어시스턴트 사이의 다리 역할을 합니다.

**누구를 위한 것인가요?** 데이터 통제권을 포기하거나 호스팅 서비스에 의존하지 않고, 어디서나 메시지를 보낼 수 있는 개인 AI 어시스턴트를 원하는 개발자와 파워 유저를 위한 것입니다.

**무엇이 다른가요?**

- **셀프 호스팅**: 자신의 하드웨어에서 실행, 자신의 규칙
- **멀티 채널**: 하나의 Gateway 로 WhatsApp, Telegram, Discord 등을 동시에 서비스
- **에이전트 네이티브**: 도구 사용, 세션, 메모리, 멀티 에이전트 라우팅을 위해 설계
- **오픈 소스**: MIT 라이선스, 커뮤니티 주도

**무엇이 필요한가요?** Node 24 (권장) 또는 호환성을 위한 Node 22 LTS (`22.16+`), 선택한 프로바이더의 API 키, 그리고 5 분. 최상의 품질과 보안을 위해 최신 세대의 가장 강력한 모델을 사용하세요.

## 작동 방식

```mermaid
flowchart LR
  A["채팅 앱 + 플러그인"] --> B["Gateway"]
  B --> C["Pi 에이전트"]
  B --> D["CLI"]
  B --> E["Web Control UI"]
  B --> F["macOS 앱"]
  B --> G["iOS 및 Android 노드"]
```

Gateway 는 세션, 라우팅, 채널 연결의 단일 진실 소스입니다.

## 주요 기능

<Columns>
  <Card title="멀티 채널 게이트웨이" icon="network">
    단일 Gateway 프로세스로 WhatsApp, Telegram, Discord, iMessage 를 지원합니다.
  </Card>
  <Card title="플러그인 채널" icon="plug">
    확장 패키지로 Mattermost 등을 추가할 수 있습니다.
  </Card>
  <Card title="멀티 에이전트 라우팅" icon="route">
    에이전트, 워크스페이스 또는 발신자별로 격리된 세션을 제공합니다.
  </Card>
  <Card title="미디어 지원" icon="image">
    이미지, 오디오, 문서를 송수신할 수 있습니다.
  </Card>
  <Card title="Web Control UI" icon="monitor">
    채팅, 설정, 세션, 노드를 위한 브라우저 대시보드입니다.
  </Card>
  <Card title="모바일 노드" icon="smartphone">
    Canvas, 카메라, 음성 지원 워크플로를 위해 iOS 및 Android 노드를 페어링할 수 있습니다.
  </Card>
</Columns>

## 빠른 시작

<Steps>
  <Step title="OpenClaw 설치">
    ```bash
    npm install -g openclaw@latest
    ```
  </Step>
  <Step title="온보딩 및 서비스 설치">
    ```bash
    openclaw onboard --install-daemon
    ```
  </Step>
  <Step title="채팅">
    브라우저에서 Control UI 를 열고 메시지를 보내세요:

    ```bash
    openclaw dashboard
    ```

    또는 채널을 연결하고 ([Telegram](/channels/telegram) 이 가장 빠릅니다) 휴대폰에서 채팅하세요.

  </Step>
</Steps>

전체 설치 및 개발 설정이 필요하신가요? [시작하기](/start/getting-started)를 참조하세요.

## 대시보드

Gateway 가 시작된 후 브라우저에서 Control UI 를 여세요.

- 로컬 기본값: [http://127.0.0.1:18789/](http://127.0.0.1:18789/)
- 원격 접속: [웹 서피스](/web) 및 [Tailscale](/gateway/tailscale)

<p align="center">
  <img src="/whatsapp-openclaw.jpg" alt="OpenClaw" width="420" />
</p>

## 설정 (선택 사항)

설정 파일은 `~/.openclaw/openclaw.json` 에 있습니다.

- **아무것도 하지 않으면**, OpenClaw 는 RPC 모드로 번들된 Pi 바이너리를 발신자별 세션과 함께 사용합니다.
- 보안을 강화하려면 `channels.whatsapp.allowFrom` 과 (그룹의 경우) 멘션 규칙부터 시작하세요.

예시:

```json5
{
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
  messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
}
```

## 여기서 시작하세요

<Columns>
  <Card title="문서 허브" href="/start/hubs" icon="book-open">
    사용 사례별로 정리된 모든 문서와 가이드.
  </Card>
  <Card title="설정" href="/gateway/configuration" icon="settings">
    핵심 Gateway 설정, 토큰, 프로바이더 설정.
  </Card>
  <Card title="원격 접속" href="/gateway/remote" icon="globe">
    SSH 및 tailnet 접속 패턴.
  </Card>
  <Card title="채널" href="/channels/telegram" icon="message-square">
    WhatsApp, Telegram, Discord 등의 채널별 설정.
  </Card>
  <Card title="노드" href="/nodes" icon="smartphone">
    페어링, Canvas, 카메라, 디바이스 액션이 포함된 iOS 및 Android 노드.
  </Card>
  <Card title="도움말" href="/help" icon="life-buoy">
    일반적인 수정 사항 및 문제 해결 진입점.
  </Card>
</Columns>

## 더 알아보기

<Columns>
  <Card title="전체 기능 목록" href="/concepts/features" icon="list">
    전체 채널, 라우팅, 미디어 기능.
  </Card>
  <Card title="멀티 에이전트 라우팅" href="/concepts/multi-agent" icon="route">
    워크스페이스 격리 및 에이전트별 세션.
  </Card>
  <Card title="보안" href="/gateway/security" icon="shield">
    토큰, 허용 목록, 안전 제어.
  </Card>
  <Card title="문제 해결" href="/gateway/troubleshooting" icon="wrench">
    Gateway 진단 및 일반적인 오류.
  </Card>
  <Card title="프로젝트 소개 및 크레딧" href="/reference/credits" icon="info">
    프로젝트 기원, 기여자, 라이선스.
  </Card>
</Columns>
