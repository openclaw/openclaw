---
read_when:
  - 처음부터 초기 설정할 때
  - 동작하는 채팅까지 가장 빠른 경로를 원할 때
summary: OpenClaw를 설치하고 몇 분 만에 첫 번째 채팅을 실행하세요.
title: 시작하기
x-i18n:
  source_path: start/getting-started.md
---

# 시작하기

목표: 최소한의 설정으로 처음부터 동작하는 첫 번째 채팅을 구현합니다.

<Info>
가장 빠른 채팅 방법: Control UI를 엽니다(채널 설정 불필요). `openclaw dashboard`를 실행하고 브라우저에서 채팅하거나, <Tooltip headline="Gateway 호스트" tip="OpenClaw Gateway 서비스를 실행 중인 머신.">Gateway 호스트</Tooltip>에서 `http://127.0.0.1:18789/`을 엽니다.
문서: [Dashboard](/web/dashboard) 및 [Control UI](/web/control-ui).
</Info>

## 사전 요구 사항

- Node 22 이상

<Tip>
확실하지 않으면 `node --version`으로 Node 버전을 확인하세요.
</Tip>

## 빠른 설정 (CLI)

<Steps>
  <Step title="OpenClaw 설치 (권장)">
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
    다른 설치 방법 및 요구 사항: [설치](/install).
    </Note>

  </Step>
  <Step title="온보딩 위저드 실행">
    ```bash
    openclaw onboard --install-daemon
    ```

    위저드가 인증, Gateway 설정, 선택적 채널을 구성합니다.
    자세한 내용은 [온보딩 위저드](/start/wizard)를 참조하세요.

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
Control UI가 로드되면, Gateway가 사용할 준비가 된 것입니다.
</Check>

## 선택적 확인 및 추가 기능

<AccordionGroup>
  <Accordion title="Gateway를 포그라운드에서 실행">
    빠른 테스트나 트러블슈팅에 유용합니다.

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

## 유용한 환경 변수

OpenClaw를 서비스 계정으로 실행하거나 사용자 정의 설정/상태 경로를 사용하려면:

- `OPENCLAW_HOME`은 내부 경로 확인에 사용되는 홈 디렉토리를 설정합니다.
- `OPENCLAW_STATE_DIR`은 상태 디렉토리를 재정의합니다.
- `OPENCLAW_CONFIG_PATH`는 설정 파일 경로를 재정의합니다.

전체 환경 변수 참조: [환경 변수](/help/environment).

## 더 알아보기

<Columns>
  <Card title="온보딩 위저드 (상세)" href="/start/wizard">
    전체 CLI 위저드 참조 및 고급 옵션.
  </Card>
  <Card title="macOS 앱 온보딩" href="/start/onboarding">
    macOS 앱의 첫 실행 흐름.
  </Card>
</Columns>

## 완료 후 상태

- 실행 중인 Gateway
- 구성된 인증
- Control UI 접근 또는 연결된 채널

## 다음 단계

- DM 안전 및 승인: [페어링](/channels/pairing)
- 더 많은 채널 연결: [채널](/channels)
- 고급 워크플로 및 소스에서 빌드: [설정](/start/setup)
