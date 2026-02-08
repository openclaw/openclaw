---
summary: "OpenClaw 를 설치하고 몇 분 안에 첫 번째 채팅을 실행하십시오."
read_when:
  - 처음부터 처음 설정을 하는 경우
  - 작동하는 채팅까지 가장 빠른 경로가 필요한 경우
title: "시작하기"
x-i18n:
  source_path: start/getting-started.md
  source_hash: 6eeb4d38a70f2ad9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:26:16Z
---

# 시작하기

목표: 최소한의 설정으로 처음부터 첫 번째로 작동하는 채팅까지 도달하는 것입니다.

<Info>
가장 빠른 채팅: Control UI 를 엽니다(채널 설정 불필요). `openclaw dashboard` 을 실행하고
브라우저에서 채팅하거나,
<Tooltip headline="Gateway host" tip="OpenClaw gateway 서비스가 실행 중인 머신.">gateway host</Tooltip> 에서 `http://127.0.0.1:18789/` 을 여십시오.
문서: [Dashboard](/web/dashboard) 및 [Control UI](/web/control-ui).
</Info>

## 사전 요구 사항

- Node 22 이상

<Tip>
확실하지 않은 경우 `node --version` 로 Node 버전을 확인하십시오.
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
    다른 설치 방법과 요구 사항: [Install](/install).
    </Note>

  </Step>
  <Step title="온보딩 마법사 실행">
    ```bash
    openclaw onboard --install-daemon
    ```

    이 마법사는 인증, Gateway(게이트웨이) 설정, 선택적 채널을 구성합니다.
    자세한 내용은 [Onboarding Wizard](/start/wizard) 를 참고하십시오.

  </Step>
  <Step title="Gateway 확인">
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
Control UI 가 로드되면 Gateway 는 사용 준비가 완료된 것입니다.
</Check>

## 선택적 확인 및 추가 항목

<AccordionGroup>
  <Accordion title="Gateway 를 포그라운드에서 실행">
    빠른 테스트나 문제 해결에 유용합니다.

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="테스트 메시지 보내기">
    구성된 채널이 필요합니다.

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## 더 깊이 알아보기

<Columns>
  <Card title="온보딩 마법사 (자세한 내용)" href="/start/wizard">
    전체 CLI 마법사 참조 및 고급 옵션.
  </Card>
  <Card title="macOS 앱 온보딩" href="/start/onboarding">
    macOS 앱의 첫 실행 흐름.
  </Card>
</Columns>

## 제공되는 결과

- 실행 중인 Gateway
- 구성된 인증
- Control UI 접근 또는 연결된 채널

## 다음 단계

- 다이렉트 메시지 안전 및 승인: [Pairing](/channels/pairing)
- 더 많은 채널 연결: [Channels](/channels)
- 고급 워크플로 및 소스에서 실행: [Setup](/start/setup)
