---
title: "시작하기"
summary: "OpenClaw 를 설치하고 몇 분 안에 첫 채팅을 실행하세요."
read_when:
  - 처음부터 설정하는 경우
  - 작동하는 채팅까지 가장 빠른 경로를 원할 때
x-i18n:
  source_path: docs/start/getting-started.md
---

# 시작하기

OpenClaw 를 설치하고, 온보딩을 실행하고, AI 어시스턴트와 채팅하세요 — 모두 약 5 분 안에 완료됩니다. 마지막에는 실행 중인 Gateway, 구성된 인증, 작동하는 채팅 세션을 갖게 됩니다.

## 필요한 것

- **Node.js** — Node 24 권장 (Node 22.16+ 도 지원)
- **API 키** — 모델 프로바이더(Anthropic, OpenAI, Google 등)에서 발급 — 온보딩에서 입력을 요청합니다

<Tip>
`node --version` 으로 Node 버전을 확인하세요.
**Windows 사용자:** 네이티브 Windows 와 WSL2 모두 지원됩니다. WSL2 가 더 안정적이며 전체 기능을 위해 권장됩니다. [Windows](/platforms/windows) 를 참조하세요.
Node 를 설치해야 하나요? [Node 설정](/install/node) 을 참조하세요.
</Tip>

## 빠른 설정

<Steps>
  <Step title="OpenClaw 설치">
    <Tabs>
      <Tab title="macOS / Linux">
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
    기타 설치 방법 (Docker, Nix, npm): [설치](/install).
    </Note>

  </Step>
  <Step title="온보딩 실행">
    ```bash
    openclaw onboard --install-daemon
    ```

    마법사가 모델 프로바이더 선택, API 키 설정, Gateway 구성을 안내합니다. 약 2 분이 소요됩니다.

    전체 참조: [온보딩 (CLI)](/start/wizard).

  </Step>
  <Step title="Gateway 실행 확인">
    ```bash
    openclaw gateway status
    ```

    Gateway 가 포트 18789 에서 수신 대기 중인 것을 확인할 수 있습니다.

  </Step>
  <Step title="대시보드 열기">
    ```bash
    openclaw dashboard
    ```

    브라우저에서 Control UI 가 열립니다. 로드되면 모든 것이 정상적으로 작동하는 것입니다.

  </Step>
  <Step title="첫 메시지 보내기">
    Control UI 채팅에서 메시지를 입력하면 AI 응답을 받을 수 있습니다.

    대신 휴대폰에서 채팅하고 싶으신가요? 가장 빠르게 설정할 수 있는 채널은
    [Telegram](/channels/telegram) 입니다 (봇 토큰만 있으면 됩니다). 모든 옵션은 [채널](/channels) 을 참조하세요.

  </Step>
</Steps>

## 다음 단계

<Columns>
  <Card title="채널 연결" href="/channels" icon="message-square">
    WhatsApp, Telegram, Discord, iMessage 등.
  </Card>
  <Card title="페어링 및 안전" href="/channels/pairing" icon="shield">
    에이전트에 메시지를 보낼 수 있는 사람을 제어합니다.
  </Card>
  <Card title="Gateway 설정" href="/gateway/configuration" icon="settings">
    모델, 도구, 샌드박스, 고급 설정.
  </Card>
  <Card title="도구 둘러보기" href="/tools" icon="wrench">
    브라우저, exec, 웹 검색, Skills, 플러그인.
  </Card>
</Columns>

<Accordion title="고급: 환경 변수">
  OpenClaw 를 서비스 계정으로 실행하거나 사용자 정의 경로를 원하는 경우:

- `OPENCLAW_HOME` — 내부 경로 해석을 위한 홈 디렉터리
- `OPENCLAW_STATE_DIR` — 상태 디렉터리 재정의
- `OPENCLAW_CONFIG_PATH` — 설정 파일 경로 재정의

전체 참조: [환경 변수](/help/environment).
</Accordion>
