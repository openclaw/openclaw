---
read_when:
  - 처음부터 설치할 때
  - 가장 빠르게 동작하는 채팅 경로가 필요할 때
summary: OpenClaw를 설치하고 몇 분 안에 첫 채팅을 실행합니다.
title: 시작하기
---

# 시작하기

목표: 최소 설정으로 첫 번째 동작하는 채팅까지 빠르게 완료합니다.

<Info>
가장 빠른 방법은 Control UI를 여는 것입니다 (채널 설정 불필요). `openclaw dashboard`를 실행해 브라우저에서 채팅하거나, <Tooltip headline="Gateway 호스트" tip="OpenClaw gateway 서비스가 실행 중인 머신">Gateway 호스트</Tooltip>에서 `http://127.0.0.1:18789/`를 열어주세요.
문서: [Dashboard](/web/dashboard), [Control UI](/web/control-ui)
</Info>

## 사전 요구사항

- Node 22 이상

<Tip>
버전이 확실하지 않다면 `node --version`으로 확인하세요.
</Tip>

## 빠른 설정 (CLI)

<Steps>
  <Step title="OpenClaw 설치 (권장)">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    다른 설치 방식과 요구사항: [Install](/install)
    </Note>

  </Step>
  <Step title="온보딩 Wizard 실행">
    ```bash
    openclaw onboard --install-daemon
    ```

    Wizard가 인증, Gateway 설정, 선택 채널 구성을 진행합니다.
    자세한 내용은 [Onboarding Wizard](/start/wizard)를 참고하세요.

  </Step>
  <Step title="Gateway 상태 확인">
    서비스를 설치했다면 이미 실행 중이어야 합니다:

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Control UI 열기">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
Control UI가 로드되면 Gateway를 사용할 준비가 완료된 상태입니다.
</Check>

## 선택 점검 및 추가 작업

<AccordionGroup>
  <Accordion title="Gateway를 포그라운드로 실행">
    빠른 테스트나 문제 해결 시 유용합니다.

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="테스트 메시지 보내기">
    설정된 채널이 필요합니다.

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## 더 알아보기

<Columns>
  <Card title="Onboarding Wizard (상세)" href="/start/wizard">
    전체 CLI Wizard 레퍼런스와 고급 옵션.
  </Card>
  <Card title="macOS 앱 온보딩" href="/start/onboarding">
    macOS 앱 첫 실행 플로우.
  </Card>
</Columns>

## 완료 후 상태

- 실행 중인 Gateway
- 설정된 인증
- Control UI 접속 또는 연결된 채널

## 다음 단계

- DM 안전 및 승인: [Pairing](/channels/pairing)
- 채널 추가 연결: [Channels](/channels)
- 고급 워크플로/소스 빌드: [Setup](/start/setup)
