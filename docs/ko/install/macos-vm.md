---
summary: "격리 또는 iMessage 가 필요할 때 샌드박스화된 macOS VM(로컬 또는 호스팅)에서 OpenClaw 를 실행합니다"
read_when:
  - 메인 macOS 환경과 분리하여 OpenClaw 를 사용하고 싶을 때
  - 샌드박스에서 iMessage 통합(BlueBubbles)을 사용하고 싶을 때
  - 복제 가능한 초기화 가능한 macOS 환경이 필요할 때
  - 로컬 vs 호스팅 macOS VM 옵션을 비교하고 싶을 때
title: "macOS VM"
---

# macOS VM 에서의 OpenClaw (샌드박스화)

## 권장 기본값(대부분의 사용자)

- **소형 Linux VPS**: 항상 켜져 있는 Gateway 와 저렴한 비용. [VPS hosting](/vps)을 참고하십시오.
- **전용 하드웨어**(Mac mini 또는 Linux 박스): 브라우저 자동화를 위한 완전한 제어와 **주거용 IP** 가 필요한 경우. 많은 사이트가 데이터 센터 IP 를 차단하므로 로컬 브라우징이 더 잘 작동하는 경우가 많습니다.
- **하이브리드**: 저렴한 VPS 에 Gateway 를 두고, 브라우저/UI 자동화가 필요할 때 Mac 을 **노드**로 연결합니다. [Nodes](/nodes) 및 [Gateway remote](/gateway/remote)을 참고하십시오.

macOS 전용 기능(iMessage/BlueBubbles)이 필요하거나 일상적인 Mac 과의 엄격한 격리가 필요할 때 macOS VM 을 사용하십시오.

## macOS VM 옵션

### Apple Silicon Mac 의 로컬 VM (Lume)

[Lume](https://cua.ai/docs/lume)를 사용하여 기존 Apple Silicon Mac 에서 샌드박스화된 macOS VM 으로 OpenClaw 를 실행합니다.

This gives you:

- 격리된 전체 macOS 환경(호스트는 깨끗하게 유지)
- BlueBubbles 를 통한 iMessage 지원(Linux/Windows 에서는 불가능)
- VM 복제로 즉시 초기화
- 추가 하드웨어나 클라우드 비용 없음

### 호스팅 Mac 프로바이더(클라우드)

클라우드에서 macOS 가 필요하다면 호스팅 Mac 프로바이더도 사용할 수 있습니다:

- [MacStadium](https://www.macstadium.com/) (호스팅 Mac)
- 기타 호스팅 Mac 벤더도 사용 가능하며, 각자의 VM + SSH 문서를 따르십시오

macOS VM 에 SSH 접근이 가능해지면 아래 6단계부터 진행하십시오.

---

## 빠른 경로(Lume, 숙련 사용자)

1. Lume 설치
2. `lume create openclaw --os macos --ipsw latest`
3. 설정 도우미 완료, 원격 로그인(SSH) 활성화
4. `lume run openclaw --no-display`
5. SSH 접속 후 OpenClaw 설치, 채널 구성
6. Done

---

## What you need (Lume)

- Apple Silicon Mac(M1/M2/M3/M4)
- 호스트에 macOS Sequoia 이상
- VM 당 약 60 GB 의 여유 디스크 공간
- 약 20분

---

## 1. Lume 설치

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

`~/.local/bin` 이 PATH 에 없다면:

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

확인:

```bash
lume --version
```

문서: [Lume Installation](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2. macOS VM 생성

```bash
lume create openclaw --os macos --ipsw latest
```

이 과정에서 macOS 를 다운로드하고 VM 을 생성합니다. VNC 창이 자동으로 열립니다.

참고: 다운로드는 네트워크 상태에 따라 시간이 걸릴 수 있습니다.

---

## 3. 설정 도우미 완료

VNC 창에서:

1. 언어 및 지역 선택
2. Apple ID 건너뛰기(또는 나중에 iMessage 를 사용하려면 로그인)
3. 사용자 계정 생성(사용자 이름과 비밀번호를 기억하십시오)
4. 모든 선택적 기능 건너뛰기

설정이 완료되면 SSH 를 활성화합니다:

1. 시스템 설정 → 일반 → 공유 열기
2. "원격 로그인" 활성화

---

## 4. VM 의 IP 주소 확인

```bash
lume get openclaw
```

IP 주소를 확인하십시오(보통 `192.168.64.x`).

---

## 5. VM 에 SSH 접속

```bash
ssh youruser@192.168.64.X
```

`youruser` 를 생성한 계정으로 바꾸고, IP 는 VM 의 IP 로 바꾸십시오.

---

## 6. OpenClaw 설치

VM 내부에서:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

온보딩 안내에 따라 모델 프로바이더(Anthropic, OpenAI 등)를 설정하십시오.

---

## 7. 채널 구성

구성 파일을 편집합니다:

```bash
nano ~/.openclaw/openclaw.json
```

채널을 추가합니다:

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    },
    "telegram": {
      "botToken": "YOUR_BOT_TOKEN"
    }
  }
}
```

그런 다음 WhatsApp 에 로그인합니다(QR 스캔):

```bash
openclaw channels login
```

---

## 8. 헤드리스로 VM 실행

VM 을 중지한 뒤 디스플레이 없이 다시 시작합니다:

```bash
lume stop openclaw
lume run openclaw --no-display
```

VM 은 백그라운드에서 실행됩니다. OpenClaw 데몬이 Gateway 를 계속 실행합니다.

상태 확인:

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## 보너스: iMessage 통합

macOS 에서 실행할 때의 핵심 기능입니다. [BlueBubbles](https://bluebubbles.app)를 사용하여 OpenClaw 에 iMessage 를 추가합니다.

VM 내부에서:

1. bluebubbles.app 에서 BlueBubbles 다운로드
2. Apple ID 로 로그인
3. Web API 를 활성화하고 비밀번호 설정
4. BlueBubbles 웹훅을 Gateway 로 지정(예: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

OpenClaw 구성에 추가:

```json
{
  "channels": {
    "bluebubbles": {
      "serverUrl": "http://localhost:1234",
      "password": "your-api-password",
      "webhookPath": "/bluebubbles-webhook"
    }
  }
}
```

Gateway 를 재시작하십시오. 이제 에이전트가 iMessages 를 송수신할 수 있습니다.

전체 설정 상세: [BlueBubbles channel](/channels/bluebubbles)

---

## 골든 이미지 저장

추가 커스터마이징 전에 깨끗한 상태를 스냅샷으로 저장하십시오:

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

언제든지 초기화:

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## 24/7 실행

VM 을 계속 실행하려면:

- Mac 을 전원에 연결 유지
- 시스템 설정 → 에너지 절약에서 잠자기 비활성화
- 필요 시 `caffeinate` 사용

완전한 상시 가동이 필요하다면 전용 Mac mini 또는 소형 VPS 를 고려하십시오. [VPS hosting](/vps)을 참고하십시오.

---

## 문제 해결

| 문제                | 해결 방법                                                        |
| ----------------- | ------------------------------------------------------------ |
| VM 에 SSH 접속 불가    | VM 의 시스템 설정에서 "원격 로그인" 이 활성화되어 있는지 확인하십시오                    |
| VM IP 가 표시되지 않음   | VM 이 완전히 부팅될 때까지 기다린 후 `lume get openclaw` 를 다시 실행하십시오       |
| Lume 명령을 찾을 수 없음  | `~/.local/bin` 를 PATH 에 추가하십시오                               |
| WhatsApp QR 스캔 실패 | `openclaw channels login` 실행 시 호스트가 아닌 VM 에 로그인되어 있는지 확인하십시오 |

---

## 관련 문서

- [VPS hosting](/vps)
- [Nodes](/nodes)
- [Gateway remote](/gateway/remote)
- [BlueBubbles channel](/channels/bluebubbles)
- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (고급)
- [Docker Sandboxing](/install/docker) (대안적 격리 접근 방식)
