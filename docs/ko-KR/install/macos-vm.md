---
summary: "Run OpenClaw in a sandboxed macOS VM (local or hosted) when you need isolation or iMessage"
read_when:
  - You want OpenClaw isolated from your main macOS environment
  - You want iMessage integration (BlueBubbles) in a sandbox
  - You want a resettable macOS environment you can clone
  - You want to compare local vs hosted macOS VM options
title: "macOS VMs"
x-i18n:
  source_hash: 4d1c85a5e4945f9f0796038cd5960edecb71ec4dffb6f9686be50adb75180716
---

# macOS VM의 OpenClaw(샌드박싱)

## 권장 기본값(대부분의 사용자)

- 상시 게이트웨이 및 저렴한 비용을 위한 **소형 Linux VPS**. [VPS 호스팅](/vps)을 참조하세요.
- 완전한 제어와 브라우저 자동화를 위한 **주거 IP**를 원하는 경우 **전용 하드웨어**(Mac mini 또는 Linux 상자). 많은 사이트가 데이터 센터 IP를 차단하므로 로컬 검색이 더 잘 작동하는 경우가 많습니다.
- **하이브리드:** 게이트웨이를 저렴한 VPS로 유지하고, 브라우저/UI 자동화가 필요할 때 Mac을 **노드**로 연결하세요. [노드](/nodes) 및 [게이트웨이 원격](/gateway/remote)을 참조하세요.

특별히 macOS 전용 기능(iMessage/BlueBubbles)이 필요하거나 일상적인 Mac과의 엄격한 격리를 원하는 경우 macOS VM을 사용하세요.

## macOS VM 옵션

### Apple Silicon Mac의 로컬 VM(Lume)

[Lume](https://cua.ai/docs/lume)을 사용하여 기존 Apple Silicon Mac의 샌드박스 macOS VM에서 OpenClaw를 실행하세요.

이는 다음을 제공합니다.

- 격리된 전체 macOS 환경(호스트가 깨끗하게 유지됨)
- BlueBubbles를 통한 iMessage 지원(Linux/Windows에서는 불가능)
- VM 복제를 통한 즉시 재설정
- 추가 하드웨어나 클라우드 비용이 없습니다.

### 호스팅된 Mac 제공업체(클라우드)

클라우드에서 macOS를 원하는 경우 호스팅된 Mac 제공업체도 작동합니다.

- [MacStadium](https://www.macstadium.com/) (호스트된 Mac)
- 다른 호스팅 Mac 공급업체도 작동합니다. VM + SSH 문서를 따르세요.

macOS VM에 대한 SSH 액세스 권한이 있으면 아래 6단계를 계속 진행하세요.

---

## 빠른 경로 (Lume, 숙련된 사용자)

1. 루메 설치
2. `lume create openclaw --os macos --ipsw latest`
3. 설정 도우미를 완료하고 원격 로그인(SSH)을 활성화합니다.
4. `lume run openclaw --no-display`
5. SSH 접속, OpenClaw 설치, 채널 구성
6. 완료

---

## 필요한 것 (Lume)

- 애플 실리콘 맥 (M1/M2/M3/M4)
- 호스트의 macOS Sequoia 이상
- VM당 최대 60GB의 여유 디스크 공간
- ~20분

---

## 1) Lume 설치

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

`~/.local/bin`가 PATH에 없는 경우:

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

그러면 macOS가 다운로드되고 VM이 생성됩니다. VNC 창이 자동으로 열립니다.

참고: 연결 상태에 따라 다운로드하는 데 시간이 걸릴 수 있습니다.

---

## 3) 설정 도우미 완료

VNC 창에서:

1. 언어와 지역을 선택하세요
2. Apple ID 건너뛰기(또는 나중에 iMessage를 사용하려면 로그인하세요)
3. 사용자 계정 생성(사용자 이름과 비밀번호를 기억하세요)
4. 모든 선택 기능 건너뛰기

설정이 완료되면 SSH를 활성화합니다.

1. 시스템 설정 → 일반 → 공유 열기
2. "원격 로그인" 활성화

---

## 4) VM의 IP 주소를 가져옵니다.

```bash
lume get openclaw
```

IP 주소(일반적으로 `192.168.64.x`)를 찾습니다.

---

## 5) VM에 SSH로 연결

```bash
ssh youruser@192.168.64.X
```

`youruser`를 생성한 계정으로 바꾸고 IP를 VM의 IP로 바꿉니다.

---

## 6) OpenClaw 설치

VM 내부:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

온보딩 메시지에 따라 모델 공급자(Anthropic, OpenAI 등)를 설정하세요.

---

## 7) 채널 구성

구성 파일을 편집합니다.

```bash
nano ~/.openclaw/openclaw.json
```

채널을 추가하세요:

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

그런 다음 WhatsApp에 로그인합니다(QR 스캔).

```bash
openclaw channels login
```

---

## 8) 헤드리스로 VM 실행

VM을 중지하고 표시 없이 다시 시작합니다.

```bash
lume stop openclaw
lume run openclaw --no-display
```

VM은 백그라운드에서 실행됩니다. OpenClaw의 데몬은 게이트웨이를 계속 실행합니다.

상태를 확인하려면:

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## 보너스: iMessage 통합

이것이 macOS에서 실행되는 킬러 기능입니다. [BlueBubbles](https://bluebubbles.app)를 사용하여 OpenClaw에 iMessage를 추가하세요.

VM 내부:

1. bluebubbles.app에서 BlueBubbles를 다운로드하세요.
2. Apple ID로 로그인
3. Web API 활성화 및 비밀번호 설정
4. 게이트웨이에서 BlueBubbles 웹훅을 가리킵니다(예: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`).

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

게이트웨이를 다시 시작하십시오. 이제 에이전트가 iMessage를 보내고 받을 수 있습니다.

전체 설정 세부정보: [BlueBubbles 채널](/channels/bluebubbles)

---

## 골든 이미지 저장

추가로 사용자 정의하기 전에 정리 상태의 스냅샷을 만드세요.

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

## 연중무휴 24시간 운영

다음을 수행하여 VM을 계속 실행하세요.

- Mac을 연결한 상태로 유지하기
- 시스템 설정 → 에너지 절약에서 절전 모드 비활성화
- 필요한 경우 `caffeinate` 사용

진정한 상시 접속을 위해서는 전용 Mac mini나 소형 VPS를 고려해보세요. [VPS 호스팅](/vps)을 참조하세요.

---

## 문제 해결

| 문제                         | 솔루션                                                                     |
| ---------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| VM에 SSH를 사용할 수 없음    | VM의 시스템 설정                                                           | 에서 "원격 로그인"이 활성화되어 있는지 확인하세요.  |
| VM IP가 표시되지 않음        | VM이 완전히 부팅될 때까지 기다린 후 `lume get openclaw`를 다시 실행하세요. |
| Lume 명령을 찾을 수 없습니다 | PATH에 `~/.local/bin` 추가                                                 |
| WhatsApp QR이 스캔되지 않음  | `openclaw channels login`                                                  | 실행 시 호스트가 아닌 VM에 로그인했는지 확인하세요. |

---

## 관련 문서

- [VPS 호스팅](/vps)
- [노드](/nodes)
- [게이트웨이 원격](/gateway/remote)
- [BlueBubbles 채널](/channels/bluebubbles)
- [Lume 빠른 시작](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI 참조](https://cua.ai/docs/lume/reference/cli-reference)
- [무인 VM 설정](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (고급)
- [Docker Sandboxing](/install/docker) (대체 격리 접근 방식)
