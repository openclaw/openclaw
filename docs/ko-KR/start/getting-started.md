---
summary: "Get OpenClaw installed and run your first chat in minutes."
read_when:
  - First time setup from zero
  - You want the fastest path to a working chat
title: "Getting Started"
x-i18n:
  source_hash: 4ec86bd0345cc7a70236e566da2ccb9ff17764cc5a7c3b23eab8d5d558251520
---

# 시작하기

목표: 최소한의 설정으로 0에서 첫 번째 작업 채팅으로 이동합니다.

<Info>
가장 빠른 채팅: 제어 UI를 엽니다(채널 설정이 필요하지 않음). `openclaw dashboard` 실행
브라우저에서 채팅하거나, `http://127.0.0.1:18789/`을 엽니다.
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">게이트웨이 호스트</Tooltip>.
문서: [대시보드](/web/dashboard) 및 [제어 UI](/web/control-ui).
</Info>

## 전제조건

- 노드 22 이상

<Tip>
확실하지 않은 경우 `node --version`로 Node 버전을 확인하세요.
</Tip>

## 빠른 설정(CLI)

<Steps>
  <Step title="Install OpenClaw (recommended)">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
        <img
  src="/assets/install-script.svg"
  alt="Install Script Process"
  className="rounded-lg"
/>
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    기타 설치 방법 및 요구 사항: [설치](/install).
    </Note>

  </Step>
  <Step title="Run the onboarding wizard">
    ```bash
    openclaw onboard --install-daemon
    ```

    마법사는 인증, 게이트웨이 설정 및 선택적 채널을 구성합니다.
    자세한 내용은 [온보딩 마법사](/start/wizard)를 참조하세요.

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
Control UI가 로드되면 게이트웨이를 사용할 준비가 되었습니다.
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

## 유용한 환경 변수

OpenClaw를 서비스 계정으로 실행하거나 사용자 정의 구성/상태 위치를 원하는 경우:

- `OPENCLAW_HOME` 내부 경로 확인에 사용되는 홈 디렉터리를 설정합니다.
- `OPENCLAW_STATE_DIR`는 상태 디렉터리를 재정의합니다.
- `OPENCLAW_CONFIG_PATH`는 구성 파일 경로를 재정의합니다.

전체 환경 변수 참조: [환경 변수](/help/environment).

## 더 깊이 들어가 보세요

<Columns>
  <Card title="Onboarding Wizard (details)" href="/start/wizard">
    전체 CLI 마법사 참조 및 고급 옵션.
  </Card>
  <Card title="macOS app onboarding" href="/start/onboarding">
    macOS 앱의 첫 번째 실행 흐름입니다.
  </Card>
</Columns>

## 당신이 갖게 될 것

- 실행 중인 게이트웨이
- 인증이 구성됨
- UI 접근 또는 연결된 채널 제어

## 다음 단계

- DM 안전 및 승인 : [페어링](/channels/pairing)
- 더 많은 채널 연결: [채널](/channels)
- 고급 워크플로 및 소스에서: [설정](/start/setup)
