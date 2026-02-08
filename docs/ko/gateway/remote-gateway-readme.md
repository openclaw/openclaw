---
read_when: Connecting the macOS app to a remote gateway over SSH
summary: 원격 게이트웨이에 연결하는 OpenClaw.app용 SSH 터널 설정
title: 원격 게이트웨이 설정
x-i18n:
    generated_at: "2026-02-08T15:55:30Z"
    model: gtx
    provider: google-translate
    source_hash: b1ae266a7cb4911b82ae3ec6cb98b1b57aca592aeb1dc8b74bbce9b0ea9dd1d1
    source_path: gateway/remote-gateway-readme.md
    workflow: 15
---

# 원격 게이트웨이로 OpenClaw.app 실행

OpenClaw.app은 SSH 터널링을 사용하여 원격 게이트웨이에 연결합니다. 이 가이드에서는 설정 방법을 보여줍니다.

## 개요

```
┌─────────────────────────────────────────────────────────────┐
│                        Client Machine                          │
│                                                              │
│  OpenClaw.app ──► ws://127.0.0.1:18789 (local port)           │
│                     │                                        │
│                     ▼                                        │
│  SSH Tunnel ────────────────────────────────────────────────│
│                     │                                        │
└─────────────────────┼──────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                         Remote Machine                        │
│                                                              │
│  Gateway WebSocket ──► ws://127.0.0.1:18789 ──►              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## 빠른 설정

### 1단계: SSH 구성 추가

편집하다 `~/.ssh/config` 그리고 다음을 추가하세요:

```ssh
Host remote-gateway
    HostName <REMOTE_IP>          # e.g., 172.27.187.184
    User <REMOTE_USER>            # e.g., jefferson
    LocalForward 18789 127.0.0.1:18789
    IdentityFile ~/.ssh/id_rsa
```

바꾸다 `<REMOTE_IP>` 그리고 `<REMOTE_USER>` 당신의 가치관으로.

### 2단계: SSH 키 복사

공개 키를 원격 시스템에 복사합니다(비밀번호는 한 번 입력).

```bash
ssh-copy-id -i ~/.ssh/id_rsa <REMOTE_USER>@<REMOTE_IP>
```

### 3단계: 게이트웨이 토큰 설정

```bash
launchctl setenv OPENCLAW_GATEWAY_TOKEN "<your-token>"
```

### 4단계: SSH 터널 시작

```bash
ssh -N remote-gateway &
```

### 5단계: OpenClaw.app 다시 시작

```bash
# Quit OpenClaw.app (⌘Q), then reopen:
open /path/to/OpenClaw.app
```

이제 앱이 SSH 터널을 통해 원격 게이트웨이에 연결됩니다.

---

## 로그인 시 터널 자동 시작

로그인할 때 SSH 터널이 자동으로 시작되도록 하려면 시작 에이전트를 생성하세요.

### PLIST 파일 만들기

이것을 다른 이름으로 저장 `~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>bot.molt.ssh-tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/ssh</string>
        <string>-N</string>
        <string>remote-gateway</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

### 실행 에이전트 로드

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist
```

이제 터널은 다음을 수행합니다.

- 로그인하면 자동으로 시작됩니다
- 충돌이 발생하면 다시 시작하세요.
- 백그라운드에서 계속 실행

기존 참고 사항: 남은 부분 제거 `com.openclaw.ssh-tunnel` LaunchAgent가 있는 경우.

---

## 문제 해결

**터널이 실행 중인지 확인합니다.**

```bash
ps aux | grep "ssh -N remote-gateway" | grep -v grep
lsof -i :18789
```

**터널을 다시 시작합니다.**

```bash
launchctl kickstart -k gui/$UID/bot.molt.ssh-tunnel
```

**터널을 중지합니다.**

```bash
launchctl bootout gui/$UID/bot.molt.ssh-tunnel
```

---

## 작동 방식

| Component                            | What It Does                                                 |
| ------------------------------------ | ------------------------------------------------------------ |
| `LocalForward 18789 127.0.0.1:18789` | Forwards local port 18789 to remote port 18789               |
| `ssh -N`                             | SSH without executing remote commands (just port forwarding) |
| `KeepAlive`                          | Automatically restarts tunnel if it crashes                  |
| `RunAtLoad`                          | Starts tunnel when the agent loads                           |

OpenClaw.app은 다음에 연결됩니다. `ws://127.0.0.1:18789` 클라이언트 컴퓨터에서. SSH 터널은 해당 연결을 게이트웨이가 실행 중인 원격 시스템의 포트 18789로 전달합니다.
