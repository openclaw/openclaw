---
summary: "OpenClaw (macOS 앱)의 최초 실행 온보딩 흐름"
read_when:
  - macOS 온보딩 어시스턴트 설계 시
  - 인증 또는 아이덴티티 설정 구현 시
title: "온보딩 (macOS 앱)"
sidebarTitle: "Onboarding: macOS App"
---

# 온보딩 (macOS 앱)

이 문서는 **현재**의 최초 실행 온보딩 흐름을 설명합니다. 목표는 매끄러운 'day 0' 경험입니다. 즉, Gateway(게이트웨이)가 실행될 위치를 선택하고, 인증을 연결하며, 마법사를 실행하고, 에이전트가 스스로 부트스트랩하도록 하는 것입니다.

<Steps>
<Step title="Approve macOS warning">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Approve find local networks">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Welcome and security notice">
<Frame caption="표시되는 보안 안내를 읽고 그에 따라 결정하십시오">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remote">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

**Gateway(게이트웨이)** 는 어디에서 실행됩니까?

- **이 Mac (로컬 전용):** 온보딩에서 OAuth 플로우를 실행하고 자격 증명을 로컬에 기록할 수 있습니다.
- **원격 (SSH/Tailnet 경유):** 온보딩에서 로컬로 OAuth 를 실행하지 **않습니다**. 자격 증명은 게이트웨이 호스트에 이미 존재해야 합니다.
- **나중에 구성:** 설정을 건너뛰고 앱을 미구성 상태로 둡니다.

<Tip>
**Gateway(게이트웨이) 인증 팁:**
- 이제 마법사는 loopback 에 대해서도 **토큰**을 생성하므로, 로컬 WS 클라이언트는 반드시 인증해야 합니다.
- 인증을 비활성화하면 어떤 로컬 프로세스든 연결할 수 있습니다. 완전히 신뢰된 머신에서만 사용하십시오.
- 다중 머신 접근 또는 non‑loopback 바인딩에는 **토큰**을 사용하십시오.
</Tip>
</Step>
<Step title="Permissions">
<Frame caption="OpenClaw 에 부여할 권한을 선택하십시오">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

온보딩은 다음에 필요한 TCC 권한을 요청합니다:

- 자동화 (AppleScript)
- 알림
- 접근성
- 화면 기록
- 마이크
- 음성 인식
- 카메라
- 위치

</Step>
<Step title="CLI">
  <Info>이 단계는 선택 사항입니다</Info>
  앱은 npm/pnpm 을 통해 전역 `openclaw` CLI 를 설치할 수 있으므로, 터미널 워크플로와 launchd 작업이 즉시 동작합니다.
</Step>
<Step title="Onboarding Chat (dedicated session)">
  설정이 완료되면 앱은 전용 온보딩 채팅 세션을 열어 에이전트가 자신을 소개하고 다음 단계를 안내하도록 합니다. 이는 최초 실행 가이드를 일반 대화와 분리합니다. 첫 번째 에이전트 실행 동안 게이트웨이 호스트에서 발생하는 작업에 대해서는 [Bootstrapping](/start/bootstrapping)을 참고하십시오.
</Step>
</Steps>
