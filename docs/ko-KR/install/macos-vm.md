---
title: "macOS VM"
summary: "격리 또는 iMessage 가 필요할 때 샌드박스된 macOS VM (로컬 또는 호스팅) 에서 OpenClaw 실행"
read_when:
  - 주요 macOS 환경으로부터 OpenClaw 를 격리하고 싶을 때
  - 샌드박스에서 iMessage 통합 (BlueBubbles) 을 원할 때
  - 복제할 수 있는 재설정 가능한 macOS 환경을 원할 때
  - 로컬 vs 호스팅 macOS VM 옵션을 비교하고 싶을 때
x-i18n:
  source_path: docs/install/macos-vm.md
---

# macOS VM 에서 OpenClaw (샌드박싱)

## 권장 기본값 (대부분의 사용자)

- 상시 가동 Gateway 와 저비용을 위한 **소형 Linux VPS**. [VPS 호스팅](/vps)을 참고하세요.
- 완전한 제어와 브라우저 자동화를 위한 **주거용 IP** 가 필요하면 **전용 하드웨어** (Mac mini 또는 Linux 박스). 많은 사이트가 데이터센터 IP 를 차단하므로 로컬 브라우징이 보통 더 잘 작동합니다.
- **하이브리드:** 저렴한 VPS 에 Gateway 를 유지하고, 브라우저/UI 자동화가 필요할 때 Mac 을 **노드**로 연결. [노드](/nodes) 및 [Gateway 원격](/gateway/remote)을 참고하세요.

macOS 전용 기능 (iMessage/BlueBubbles) 이 특별히 필요하거나 일상 Mac 으로부터 엄격한 격리를 원할 때 macOS VM 을 사용하세요.

## macOS VM 옵션

### Apple Silicon Mac 에서 로컬 VM (Lume)

[Lume](https://cua.ai/docs/lume) 를 사용하여 기존 Apple Silicon Mac 에서 샌드박스된 macOS VM 에 OpenClaw 를 실행합니다.

제공하는 것:

- 격리된 전체 macOS 환경 (호스트는 깨끗하게 유지)
- BlueBubbles 를 통한 iMessage 지원 (Linux/Windows 에서는 불가능)
- VM 복제로 즉시 재설정
- 추가 하드웨어 또는 클라우드 비용 없음

### 호스팅 Mac 프로바이더 (클라우드)

클라우드에서 macOS 를 원하면 호스팅 Mac 프로바이더도 작동합니다:

- [MacStadium](https://www.macstadium.com/) (호스팅 Mac)
- 다른 호스팅 Mac 벤더도 작동; VM + SSH 문서를 따르세요

macOS VM 에 SSH 접근이 있으면 아래 6 단계부터 계속하세요.

---

## 빠른 경로 (Lume, 경험 있는 사용자)

1. Lume 설치
2. `lume create openclaw --os macos --ipsw latest`
3. Setup Assistant 완료, Remote Login (SSH) 활성화
4. `lume run openclaw --no-display`
5. SSH 접속, OpenClaw 설치, 채널 구성
6. 완료

---

## 필요한 것 (Lume)

- Apple Silicon Mac (M1/M2/M3/M4)
- 호스트의 macOS Sequoia 이상
- VM 당 약 60 GB 여유 디스크 공간
- 약 20 분

---

## 1) Lume 설치

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

`~/.local/bin` 이 PATH 에 없으면:

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

확인:

```bash
lume --version
```

문서: [Lume 설치](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2) macOS VM 생성

```bash
lume create openclaw --os macos --ipsw latest
```

macOS 를 다운로드하고 VM 을 생성합니다. VNC 창이 자동으로 열립니다.

참고: 연결 속도에 따라 다운로드에 시간이 걸릴 수 있습니다.

---

## 3) Setup Assistant 완료

VNC 창에서:

1. 언어 및 지역 선택
2. Apple ID 건너뛰기 (나중에 iMessage 를 원하면 로그인)
3. 사용자 계정 생성 (사용자 이름과 비밀번호를 기억하세요)
4. 모든 선택적 기능 건너뛰기

설정 완료 후 SSH 를 활성화합니다:

1. System Settings > General > Sharing 열기
2. "Remote Login" 활성화

---

## 4) VM IP 주소 가져오기

```bash
lume get openclaw
```

IP 주소 (보통 `192.168.64.x`) 를 찾습니다.

---

## 5) VM 에 SSH

```bash
ssh youruser@192.168.64.X
```

`youruser` 를 생성한 계정으로, IP 를 VM 의 IP 로 교체하세요.

---

## 6) OpenClaw 설치

VM 내부에서:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

온보딩 프롬프트를 따라 모델 프로바이더 (Anthropic, OpenAI 등) 를 설정합니다.

---

## 7) 채널 구성

설정 파일을 편집합니다:

```bash
nano ~/.openclaw/openclaw.json
```

채널을 추가합니다:

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
    },
    telegram: {
      botToken: "YOUR_BOT_TOKEN",
    },
  },
}
```

그런 다음 WhatsApp 에 로그인 (QR 스캔):

```bash
openclaw channels login
```

---

## 8) VM 을 헤드리스로 실행

VM 을 중지하고 디스플레이 없이 재시작:

```bash
lume stop openclaw
lume run openclaw --no-display
```

VM 이 백그라운드에서 실행됩니다. OpenClaw 의 데몬이 Gateway 를 계속 실행합니다.

상태를 확인하려면:

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## 보너스: iMessage 통합

macOS 에서 실행하는 것의 킬러 기능입니다. [BlueBubbles](https://bluebubbles.app) 를 사용하여 OpenClaw 에 iMessage 를 추가합니다.

VM 내부에서:

1. bluebubbles.app 에서 BlueBubbles 다운로드
2. Apple ID 로 로그인
3. Web API 활성화 및 비밀번호 설정
4. BlueBubbles 웹훅을 Gateway 로 지정 (예: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

OpenClaw 설정에 추가:

```json5
{
  channels: {
    bluebubbles: {
      serverUrl: "http://localhost:1234",
      password: "your-api-password",
      webhookPath: "/bluebubbles-webhook",
    },
  },
}
```

Gateway 를 재시작합니다. 이제 에이전트가 iMessage 를 보내고 받을 수 있습니다.

전체 설정 세부사항: [BlueBubbles 채널](/channels/bluebubbles)

---

## 골든 이미지 저장

추가 커스터마이징 전에 깨끗한 상태를 스냅샷합니다:

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

언제든지 재설정:

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## 24/7 실행

다음과 같이 VM 을 계속 실행합니다:

- Mac 을 전원에 연결
- System Settings > Energy Saver 에서 절전 비활성화
- 필요시 `caffeinate` 사용

진정한 상시 가동을 위해 전용 Mac mini 또는 소형 VPS 를 고려하세요. [VPS 호스팅](/vps)을 참고하세요.

---

## 문제 해결

| 문제                      | 해결책                                                                       |
| ------------------------- | ---------------------------------------------------------------------------- |
| VM 에 SSH 불가            | VM 의 System Settings 에서 "Remote Login" 이 활성화되어 있는지 확인          |
| VM IP 가 표시되지 않음    | VM 이 완전히 부팅될 때까지 기다리고, `lume get openclaw` 다시 실행           |
| Lume 명령을 찾을 수 없음  | PATH 에 `~/.local/bin` 추가                                                  |
| WhatsApp QR 이 스캔 안 됨 | `openclaw channels login` 실행 시 호스트가 아닌 VM 에 로그인되어 있는지 확인 |

---

## 관련 문서

- [VPS 호스팅](/vps)
- [노드](/nodes)
- [Gateway 원격](/gateway/remote)
- [BlueBubbles 채널](/channels/bluebubbles)
- [Lume 빠른 시작](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI 레퍼런스](https://cua.ai/docs/lume/reference/cli-reference)
- [무인 VM 설정](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (고급)
- [Docker 샌드박싱](/install/docker) (대안 격리 방법)
