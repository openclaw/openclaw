---
title: "온보딩 (macOS 앱)"
summary: "OpenClaw 의 최초 실행 설정 흐름 (macOS 앱)"
sidebarTitle: "온보딩: macOS 앱"
read_when:
  - macOS 온보딩 어시스턴트를 설계할 때
  - 인증 또는 ID 설정을 구현할 때
x-i18n:
  source_path: docs/start/onboarding.md
---

# 온보딩 (macOS 앱)

이 문서는 **현재** 최초 실행 설정 흐름을 설명합니다. 목표는 매끄러운 "Day 0" 경험입니다: Gateway 가 실행될 위치를 선택하고, 인증을 연결하고, 마법사를 실행하고, 에이전트가 스스로 부트스트랩하도록 합니다.
일반적인 온보딩 경로에 대한 개요는 [온보딩 개요](/start/onboarding-overview)를 참조하세요.

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
<Step title="환영 및 보안 안내">
<Frame caption="표시된 보안 안내를 읽고 그에 따라 결정하세요">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>

보안 신뢰 모델:

- 기본적으로 OpenClaw 는 개인 에이전트입니다: 하나의 신뢰된 운영자 경계입니다.
- 공유/다중 사용자 설정은 잠금(신뢰 경계 분리, 도구 접근 최소화, [보안](/gateway/security) 따르기)이 필요합니다.
- 로컬 온보딩은 이제 새 설정을 `tools.profile: "coding"` 으로 기본 설정하여 새로운 로컬 설정이 제한 없는 `full` 프로필을 강제하지 않고 파일시스템/런타임 도구를 유지합니다.
- 훅/웹훅 또는 기타 신뢰할 수 없는 콘텐츠 피드가 활성화된 경우, 강력한 최신 모델 티어를 사용하고 엄격한 도구 정책/샌드박싱을 유지하세요.

</Step>
<Step title="로컬 vs 원격">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

**Gateway** 가 어디서 실행되나요?

- **이 Mac (로컬 전용):** 온보딩이 인증을 구성하고 자격 증명을 로컬에 기록할 수 있습니다.
- **원격 (SSH/Tailnet 을 통해):** 온보딩은 로컬 인증을 구성하지 **않습니다**; 자격 증명이 Gateway 호스트에 있어야 합니다.
- **나중에 설정:** 설정을 건너뛰고 앱을 미구성 상태로 둡니다.

<Tip>
**Gateway 인증 팁:**

- 마법사는 이제 루프백에서도 **토큰**을 생성하므로, 로컬 WS 클라이언트도 인증해야 합니다.
- 인증을 비활성화하면 모든 로컬 프로세스가 연결할 수 있습니다; 완전히 신뢰할 수 있는 머신에서만 사용하세요.
- 다중 머신 접근 또는 비루프백 바인드에는 **토큰**을 사용하세요.

</Tip>
</Step>
<Step title="권한">
<Frame caption="OpenClaw 에 부여할 권한을 선택하세요">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

온보딩은 다음에 필요한 TCC 권한을 요청합니다:

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
  앱은 npm/pnpm 을 통해 전역 `openclaw` CLI 를 설치하여 터미널 워크플로와 launchd 작업이 바로 작동하도록 할 수 있습니다.
</Step>
<Step title="온보딩 채팅 (전용 세션)">
  설정 후 앱은 전용 온보딩 채팅 세션을 열어 에이전트가 자기소개를 하고 다음 단계를 안내합니다. 이렇게 하면 최초 실행 안내가 일반 대화와 분리됩니다. 첫 에이전트 실행 중 Gateway 호스트에서 일어나는 일에 대해서는 [부트스트래핑](/start/bootstrapping)을 참조하세요.
</Step>
</Steps>
