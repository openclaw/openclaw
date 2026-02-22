---
summary: "OpenClaw를 설치하고 몇 분 안에 첫 채팅을 실행하기."
read_when:
  - 처음부터 시작하는 설정
  - 작동하는 채팅으로 가는 가장 빠른 경로를 원할 때
title: "시작하기"
---

# 시작하기

목표: 최소한의 설정으로 첫 작업 채팅까지 가는 것.

<Info>
가장 빠른 채팅: 제어 UI를 열고 (채널 설정 필요 없음) `openclaw dashboard`를 실행하여
브라우저에서 채팅하거나, 게이트웨이 호스트에서 `http://127.0.0.1:18789/`를 엽니다.
문서: [Dashboard](/ko-KR/web/dashboard) 및 [Control UI](/ko-KR/web/control-ui).
</Info>

## 필요조건

- Node 22 이상

<Tip>
Node 버전이 확실하지 않다면 `node --version`을 사용하여 확인하세요.
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
  alt="설치 스크립트 프로세스"
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
    다른 설치 방법 및 요구 사항: [설치](/ko-KR/install).
    </Note>

  </Step>
  <Step title="온보딩 마법사 실행">
    ```bash
    openclaw onboard --install-daemon
    ```

    마법사는 인증, 게이트웨이 설정 및 선택적 채널을 구성합니다.
    자세한 내용은 [온보딩 마법사](/ko-KR/start/wizard)를 참조하세요.

  </Step>
  <Step title="게이트웨이 확인">
    서비스를 설치한 경우 이미 실행 중이어야 합니다:

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="제어 UI 열기">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
제어 UI가 로드되면, 게이트웨이가 사용 준비가 된 것입니다.
</Check>

## 선택적 확인 및 추가 기능

<AccordionGroup>
  <Accordion title="포어그라운드에서 게이트웨이 실행">
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

## 유용한 환경 변수

OpenClaw를 서비스 계정으로 실행하거나 사용자 지정 구성/상태 위치를 원할 경우:

- `OPENCLAW_HOME`은 내부 경로 해결에 사용되는 홈 디렉토리를 설정합니다.
- `OPENCLAW_STATE_DIR`은 상태 디렉토리를 재정의합니다.
- `OPENCLAW_CONFIG_PATH`는 구성 파일 경로를 재정의합니다.

전체 환경 변수 참조: [환경 변수](/ko-KR/help/environment).

## 더 깊이 알아보기

<Columns>
  <Card title="온보딩 마법사 (상세)" href="/ko-KR/start/wizard">
    전체 CLI 마법사 참조 및 고급 옵션.
  </Card>
  <Card title="macOS 앱 온보딩" href="/ko-KR/start/onboarding">
    macOS 앱의 첫 실행 흐름.
  </Card>
</Columns>

## 얻을 수 있는 것

- 실행 중인 게이트웨이
- 인증 구성
- 제어 UI 접근 또는 연결된 채널

## 다음 단계

- 다이렉트 메시지 안전성 및 승인: [페어링](/ko-KR/channels/pairing)
- 더 많은 채널 연결: [채널](/ko-KR/channels)
- 고급 워크플로 및 소스에서: [설정](/ko-KR/start/setup)