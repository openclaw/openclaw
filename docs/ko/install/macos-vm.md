---
read_when:
    - OpenClaw를 기본 macOS 환경에서 격리하고 싶습니다.
    - 샌드박스에 iMessage 통합(BlueBubbles)을 원합니다.
    - 복제할 수 있는 재설정 가능한 macOS 환경을 원합니다.
    - 로컬 및 호스팅된 macOS VM 옵션을 비교하고 싶습니다.
summary: 격리 또는 iMessage가 필요한 경우 샌드박스 macOS VM(로컬 또는 호스트)에서 OpenClaw를 실행하세요.
title: macOS VM
x-i18n:
    generated_at: "2026-02-08T15:56:51Z"
    model: gtx
    provider: google-translate
    source_hash: 4d1c85a5e4945f9f0796038cd5960edecb71ec4dffb6f9686be50adb75180716
    source_path: install/macos-vm.md
    workflow: 15
---

# macOS VM의 OpenClaw(샌드박싱)

## 권장 기본값(대부분의 사용자)

- **소형 리눅스 VPS** 상시 접속 게이트웨이와 저렴한 비용을 위해. 보다 [VPS 호스팅](/vps).
- **전용 하드웨어** (Mac mini 또는 Linux 상자) 모든 권한과 **주거용 IP** 브라우저 자동화를 위해. 많은 사이트가 데이터 센터 IP를 차단하므로 로컬 검색이 더 잘 작동하는 경우가 많습니다.
- **잡종:** 게이트웨이를 저렴한 VPS로 유지하고 Mac을 **마디** 브라우저/UI 자동화가 필요할 때. 보다 [노드](/nodes) 그리고 [게이트웨이 원격](/gateway/remote).

특별히 macOS 전용 기능(iMessage/BlueBubbles)이 필요하거나 일상적인 Mac과의 엄격한 격리를 원하는 경우 macOS VM을 사용하세요.

## macOS VM 옵션

### Apple Silicon Mac의 로컬 VM(Lume)

다음을 사용하여 기존 Apple Silicon Mac의 샌드박스 macOS VM에서 OpenClaw를 실행하세요. [루메](https://cua.ai/docs/lume).

이는 다음을 제공합니다.

- 격리된 전체 macOS 환경(호스트가 깨끗하게 유지됨)
- BlueBubbles를 통한 iMessage 지원(Linux/Windows에서는 불가능)
- VM 복제를 통한 즉시 재설정
- 추가 하드웨어 또는 클라우드 비용 없음

### 호스팅된 Mac 제공업체(클라우드)

클라우드에서 macOS를 원하는 경우 호스팅된 Mac 제공업체도 작동합니다.

- [맥스타디움](https://www.macstadium.com/) (호스팅된 Mac)
- 다른 호스팅 Mac 공급업체도 작동합니다. VM + SSH 문서를 따르세요.

macOS VM에 대한 SSH 액세스 권한이 있으면 아래 6단계를 계속 진행하세요.

---

## 빠른 경로(Lume, 숙련된 사용자)

1. Lume 설치
2. `lume create openclaw --os macos --ipsw latest`
3. 설정 지원 완료, 원격 로그인(SSH) 활성화
4. `lume run openclaw --no-display`
5. SSH 연결, OpenClaw 설치, 채널 구성
6. 완료

---

## 필요한 것 (Lume)

- 애플 실리콘 맥(M1/M2/M3/M4)
- 호스트의 macOS Sequoia 이상
- VM당 최대 60GB의 여유 디스크 공간
- ~20분

---

## 1) 루메 설치

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

만약에 `~/.local/bin` PATH에 없습니다.

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

확인하다:

```bash
lume --version
```

문서: [루메 설치](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2) macOS VM 생성

```bash
lume create openclaw --os macos --ipsw latest
```

그러면 macOS가 다운로드되고 VM이 생성됩니다. VNC 창이 자동으로 열립니다.

참고: 연결 상태에 따라 다운로드하는 데 시간이 걸릴 수 있습니다.

---

## 3) 전체 설정 도우미

VNC 창에서:

1. 언어 및 지역 선택
2. Apple ID 건너뛰기(또는 나중에 iMessage를 사용하려면 로그인하세요)
3. 사용자 계정 만들기(사용자 이름과 비밀번호를 기억하세요)
4. 모든 선택적 기능 건너뛰기

설정이 완료되면 SSH를 활성화합니다.

1. 시스템 설정 열기 → 일반 → 공유
2. "원격 로그인" 활성화

---

## 4) VM의 IP 주소를 가져옵니다.

```bash
lume get openclaw
```

IP 주소를 찾습니다(일반적으로 `192.168.64.x`).

---

## 5) VM에 SSH로 연결

```bash
ssh youruser@192.168.64.X
```

바꾸다 `youruser` 생성한 계정으로, IP를 VM의 IP로 사용하세요.

---

## 6) 오픈클로 설치

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

이것이 macOS에서 실행되는 킬러 기능입니다. 사용 [블루버블스](https://bluebubbles.app) OpenClaw에 iMessage를 추가하려면

VM 내부:

1. bluebubbles.app에서 BlueBubbles를 다운로드하세요.
2. Apple ID로 로그인
3. Web API를 활성화하고 비밀번호를 설정하세요.
4. 게이트웨이에서 BlueBubbles 웹후크를 지정합니다(예: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

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
- 사용 `caffeinate` 필요한 경우

진정한 상시 접속을 위해서는 전용 Mac mini나 소형 VPS를 고려해보세요. 보다 [VPS 호스팅](/vps).

---

## 문제 해결

| Problem                  | Solution                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------- |
| Can't SSH into VM        | Check "Remote Login" is enabled in VM's System Settings                            |
| VM IP not showing        | Wait for VM to fully boot, run `lume get openclaw` again                           |
| Lume command not found   | Add `~/.local/bin` to your PATH                                                    |
| WhatsApp QR not scanning | Ensure you're logged into the VM (not host) when running `openclaw channels login` |

---

## 관련 문서

- [VPS 호스팅](/vps)
- [노드](/nodes)
- [게이트웨이 원격](/gateway/remote)
- [BlueBubbles 채널](/channels/bluebubbles)
- [Lume 빠른 시작](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI 참조](https://cua.ai/docs/lume/reference/cli-reference)
- [무인 VM 설정](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (고급의)
- [도커 샌드박싱](/install/docker) (대체 격리 접근 방식)
