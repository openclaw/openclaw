---
read_when:
    - macOS 온보딩 도우미 디자인
    - 인증 또는 ID 설정 구현
sidebarTitle: 'Onboarding: macOS App'
summary: OpenClaw(macOS 앱)의 첫 실행 온보딩 흐름
title: 온보딩(macOS 앱)
x-i18n:
    generated_at: "2026-02-08T16:02:37Z"
    model: gtx
    provider: google-translate
    source_hash: 45f912067527158fdf562b971223a801f29b6f16c7da7aa2d12caffc0cd43c7a
    source_path: start/onboarding.md
    workflow: 15
---

# 온보딩(macOS 앱)

이 문서에서는 **현재의** 첫 번째 실행 온보딩 흐름. 목표는
원활한 "0일차" 경험: 게이트웨이가 실행되는 위치를 선택하고, 인증을 연결하고,
마법사를 실행하고 에이전트가 자체적으로 부트스트랩하도록 합니다.

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
<Frame caption="Read the security notice displayed and decide accordingly">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remote">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

어디에서 **게이트웨이** 달리다?

- **이 Mac(로컬 전용):** 온보딩에서는 OAuth 흐름을 실행하고 자격 증명을 쓸 수 있습니다.
  로컬로.
- **원격(SSH/Tailnet을 통해):** 온보딩은 **~ 아니다** OAuth를 로컬에서 실행합니다.
  게이트웨이 호스트에 자격 증명이 있어야 합니다.
- **나중에 구성하십시오.** 설정을 건너뛰고 앱을 구성되지 않은 상태로 둡니다.

<Tip>
**게이트웨이 인증 팁:**
- 마법사는 이제 루프백에도 **토큰**을 생성하므로 로컬 WS 클라이언트는 인증해야 합니다.
- 인증을 비활성화하면 모든 로컬 프로세스가 연결될 수 있습니다. 완전히 신뢰할 수 있는 컴퓨터에서만 사용하세요.
- 다중 시스템 액세스 또는 비루프백 바인딩에는 **토큰**을 사용합니다.
</Tip>
</Step>
<Step title="Permissions">
<Frame caption="Choose what permissions do you want to give OpenClaw">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

온보딩에서는 다음에 필요한 TCC 권한을 요청합니다.

- 자동화(AppleScript)
- 알림
- 접근성
- 화면 녹화
- 마이크로폰
- 음성 인식
- 카메라
- 위치

</Step>
<Step title="CLI">
  <Info>이 단계는 선택사항입니다.</Info>
  앱은 npm/pnpm을 통해 전역 `openclaw` CLI를 설치할 수 있으므로 터미널
  워크플로우와 시작된 작업은 즉시 작동됩니다.
</Step>
<Step title="Onboarding Chat (dedicated session)">
  설정 후 앱은 상담원이 다음을 수행할 수 있도록 전용 온보딩 채팅 세션을 엽니다.
  자신을 소개하고 다음 단계를 안내합니다. 이렇게 하면 첫 실행 지침이 별도로 유지됩니다.
  당신의 일상적인 대화에서. 자세한 내용은 [부트스트래핑](/start/bootstrapping)을 참조하세요.
  첫 번째 에이전트가 실행되는 동안 게이트웨이 호스트에서 어떤 일이 발생합니까?
</Step>
</Steps>
