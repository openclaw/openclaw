---
read_when:
    - 0에서 처음 설정
    - 채팅을 진행하는 가장 빠른 경로를 원합니다.
summary: OpenClaw를 설치하고 몇 분 안에 첫 번째 채팅을 실행하세요.
title: 시작하기
x-i18n:
    generated_at: "2026-02-08T16:05:01Z"
    model: gtx
    provider: google-translate
    source_hash: 6eeb4d38a70f2ad9f20977ff24191a3e2417b73c989fb6074aceddcff0e633d4
    source_path: start/getting-started.md
    workflow: 15
---

# 시작하기

목표: 최소한의 설정으로 0에서 첫 번째 작업 채팅으로 이동합니다.

<Info>
가장 빠른 채팅: 제어 UI를 엽니다(채널 설정이 필요하지 않음). `openclaw dashboard` 실행
브라우저에서 채팅하거나 다음에서 `http://127.0.0.1:18789/`을 엽니다.
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">게이트웨이 호스트</Tooltip>.
문서: [대시보드](/web/dashboard) 및 [제어 UI](/web/control-ui).
</Info>

## 전제조건

- 노드 22 이상

<Tip>
확실하지 않은 경우 `node --version`으로 Node 버전을 확인하세요.
</Tip>

## 빠른 설정(CLI)

<Steps>
  <Step title="Install OpenClaw (recommended)">
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
    Other install methods and requirements: [Install](/install).
    </Note>

  </Step>
  <Step title="Run the onboarding wizard">
    ```bash
    openclaw onboard --install-daemon
    ```

    The wizard configures auth, gateway settings, and optional channels.
    See [Onboarding Wizard](/start/wizard) for details.

  </Step>
  <Step title="Check the Gateway">
    서비스를 설치했다면 이미 실행 중이어야 합니다.

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Open the Control UI">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
Control UI가 로드되면 게이트웨이를 사용할 준비가 된 것입니다.
</Check>

## 선택적 확인 사항 및 추가 사항

<AccordionGroup>
  <Accordion title="Run the Gateway in the foreground">
    빠른 테스트나 문제 해결에 유용합니다.

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="Send a test message">
    구성된 채널이 필요합니다.

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## 더 깊이 들어가세요

<Columns>
  <Card title="Onboarding Wizard (details)" href="/start/wizard">
    전체 CLI 마법사 참조 및 고급 옵션.
  </Card>
  <Card title="macOS app onboarding" href="/start/onboarding">
    macOS 앱의 첫 번째 실행 흐름입니다.
  </Card>
</Columns>

## 당신은 무엇을 갖게 될 것인가

- 실행 중인 게이트웨이
- 인증이 구성됨
- UI 액세스 또는 연결된 채널 제어

## 다음 단계

- DM 안전 및 승인: [편성](/channels/pairing)
- 더 많은 채널을 연결하세요: [채널](/channels)
- 고급 워크플로우 및 소스: [설정](/start/setup)
