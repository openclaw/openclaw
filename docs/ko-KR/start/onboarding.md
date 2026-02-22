---
summary: "OpenClaw (macOS 앱)을 위한 첫 실행 온보딩 흐름"
read_when:
  - macOS 온보딩 도우미 설계
  - 인증 또는 아이덴티티 설정 구현
title: "온보딩 (macOS 앱)"
sidebarTitle: "온보딩: macOS 앱"
---

# 온보딩 (macOS 앱)

이 문서는 **현재** 첫 실행 온보딩 흐름에 대해 설명합니다. 목표는 매끄러운 "첫날" 경험을 제공하는 것입니다: 게이트웨이 실행 위치를 선택하고, 인증을 연결하고, 마법사를 실행하여 에이전트가 자체 부트스트랩하도록 합니다. 온보딩 경로의 일반 개요는 [Onboarding Overview](/ko-KR/start/onboarding-overview)를 참조하세요.

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
<Frame caption="표시된 보안 공지를 읽고 이에 따라 결정하세요">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remote">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

**게이트웨이**가 어디에서 실행됩니까?

- **이 Mac (로컬 전용):** 온보딩 시 OAuth 흐름을 실행하고 로컬에 자격 증명을 기록할 수 있습니다.
- **원격 (SSH/Tailnet를 통해):** 온보딩 시 로컬에서 OAuth를 실행하지 않습니다. 자격 증명은 게이트웨이 호스트에 있어야 합니다.
- **나중에 구성:** 설정을 건너뛰고 앱을 미구성 상태로 둡니다.

<Tip>
**Gateway 인증 팁:**
- 마법사는 이제 로컬 루프백에도 **토큰**을 생성하므로 로컬 WS 클라이언트는 인증해야 합니다.
- 인증을 비활성화하면 모든 로컬 프로세스가 연결될 수 있으니 완전히 신뢰할 수 있는 기계에서만 사용하세요.
- 여러 기계 접근 또는 비루프백 바인드를 위해 **토큰**을 사용하세요.
</Tip>
</Step>
<Step title="Permissions">
<Frame caption="OpenClaw에 부여할 권한을 선택하세요">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

온보딩은 TCC 권한을 요청합니다:

- 자동화 (AppleScript)
- 알림
- 접근성
- 화면 녹화
- 마이크
- 음성 인식
- 카메라
- 위치

</Step>
<Step title="CLI">
  <Info>이 단계는 선택 사항입니다</Info>
  앱은 글로벌 `openclaw` CLI를 npm/pnpm을 통해 설치할 수 있어 터미널 워크플로우와 launchd 작업이 즉시 작동합니다.
</Step>
<Step title="Onboarding Chat (dedicated session)">
  설정 후, 앱은 전용 온보딩 채팅 세션을 열어 에이전트가 자기소개를 하고 다음 단계를 안내할 수 있게 합니다. 이는 첫 실행 안내를 일반 대화와 분리합니다. 첫 에이전트 실행 시 게이트웨이 호스트에서 무슨 일이 일어나는지에 대한 자세한 내용은 [Bootstrapping](/ko-KR/start/bootstrapping)을 참조하세요.
</Step>
</Steps>
