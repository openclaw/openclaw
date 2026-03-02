---
summary: "OpenClaw의 macOS 앱 first-run onboarding 흐름"
read_when:
  - macOS onboarding 어시스턴트 설계 중
  - auth 또는 identity 설정 구현 중
title: "Onboarding (macOS App)"
sidebarTitle: "Onboarding: macOS App"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/start/onboarding.md
  workflow: 15
---

# Onboarding (macOS App)

이 문서는 **현재** first-run onboarding 흐름을 설명합니다. 목표는 매끄러운 "day 0" 경험입니다: Gateway를 실행할 위치 선택, auth 연결, wizard 실행, agent가 자기 자신을 bootstrap하도록 하기.
일반적인 onboarding 경로는 [Onboarding Overview](/start/onboarding-overview)를 참조하세요.

<Steps>
<Step title="macOS 경고 승인">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="로컬 네트워크 찾기 승인">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="환영 및 보안 공지">
<Frame caption="표시된 보안 공지를 읽고 그에 따라 결정합니다">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>

보안 신뢰 모델:

- 기본적으로 OpenClaw는 개인 agent입니다: 하나의 신뢰할 수 있는 운영자 경계.
- 공유/다중 사용자 설정에는 lock-down이 필요합니다 (신뢰 경계 분할, 도구 액세스 최소화, [Security](/gateway/security) 팔로우).

</Step>
<Step title="Local vs Remote">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

**Gateway**는 어디에서 실행됩니까?

- **This Mac (Local only):** onboarding이 auth를 구성하고 로컬로 credentials을 쓸 수 있습니다.
- **Remote (over SSH/Tailnet):** onboarding이 로컬 auth를 구성하지 **않습니다**; credentials은 gateway 호스트에 있어야 합니다.
- **Configure later:** 설정을 건너뛰고 app을 구성되지 않은 상태로 둡니다.

<Tip>
**Gateway auth tip:**

- wizard가 이제 loopback에도 **token**을 생성하므로 로컬 WS clients가 인증해야 합니다.
- auth를 비활성화하면 모든 로컬 process가 연결할 수 있습니다; 완전히 신뢰할 수 있는 머신에서만 사용합니다.
- 다중 머신 액세스 또는 non-loopback bind에 **token**을 사용합니다.

</Tip>
</Step>
<Step title="권한">
<Frame caption="OpenClaw에 제공하려는 권한을 선택합니다">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

Onboarding은 다음에 필요한 TCC 권한을 요청합니다:

- 자동화 (AppleScript)
- 알림
- 접근성
- Screen Recording
- 마이크
- Speech Recognition
- Camera
- 위치

</Step>
<Step title="CLI">
  <Info>이 단계는 선택 사항입니다</Info>
  app이 전역 `openclaw` CLI를 npm/pnpm을 통해 설치할 수 있어서 터미널 워크플로우 및 launchd 작업이 즉시 작동합니다.
</Step>
<Step title="Onboarding Chat (dedicated session)">
  설정 후 app이 dedicated onboarding chat session을 열어서 agent가 자신을 소개하고 다음 단계를 안내할 수 있습니다. 이것은 first-run 가이드를 일반적인 대화와 분리합니다. [Bootstrapping](/start/bootstrapping)에서 첫 agent 실행 중 gateway 호스트에서 무엇이 발생하는지 알아보세요.
</Step>
</Steps>
