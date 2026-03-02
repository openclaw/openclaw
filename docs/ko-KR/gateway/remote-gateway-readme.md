---
summary: "SSH 터널링으로 원격 게이트웨이에 연결하는 OpenClaw.app 설정"
read_when: "OpenClaw.app을 원격 게이트웨이에 연결 중"
title: "원격 게이트웨이 설정"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/remote-gateway-readme.md
  workflow: 15
---

# SSH 터널링으로 OpenClaw.app 원격 게이트웨이 실행

OpenClaw.app은 SSH 터널링을 사용하여 원격 게이트웨이에 연결합니다. 이 가이드는 설정 방법을 보여줍니다.

## 개요

OpenClaw.app은 로컬 포트 18789를 게이트웨이가 실행 중인 원격 머신의 포트 18789로 전달합니다. 앱은 `ws://127.0.0.1:18789`의 로컬 WebSocket에 연결합니다.

## 빠른 설정

### 1단계: SSH 설정 추가

`~/.ssh/config`를 편집하고 추가합니다:

```ssh
Host remote-gateway
    HostName <REMOTE_IP>
    User <REMOTE_USER>
    LocalForward 18789 127.0.0.1:18789
    IdentityFile ~/.ssh/id_rsa
```

`<REMOTE_IP>` 및 `<REMOTE_USER>`를 값으로 교체합니다.

### 2단계: SSH 키 복사

공개 키를 원격 머신에 복사합니다(암호 한 번 입력):

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

### 5단계: OpenClaw.app 재시작

```bash
# OpenClaw.app 종료(⌘Q), 그 다음 다시 열기:
open /path/to/OpenClaw.app
```

앱이 이제 SSH 터널을 통해 원격 게이트웨이에 연결됩니다.

## 자동 터널 시작

로그인 시 SSH 터널을 자동으로 시작하려면 Launch Agent를 만듭니다.

### PLIST 파일 만들기

이를 `~/Library/LaunchAgents/ai.openclaw.ssh-tunnel.plist`로 저장합니다:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.openclaw.ssh-tunnel</string>
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

### Launch Agent 로드

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openclaw.ssh-tunnel.plist
```

터널이 이제:

- 로그인할 때 자동으로 시작
- 충돌하면 다시 시작
- 백그라운드에서 실행 유지

## 문제 해결

**터널이 실행 중입니까?**

```bash
ps aux | grep "ssh -N remote-gateway" | grep -v grep
lsof -i :18789
```

**터널 재시작:**

```bash
launchctl kickstart -k gui/$UID/ai.openclaw.ssh-tunnel
```

**터널 중지:**

```bash
launchctl bootout gui/$UID/ai.openclaw.ssh-tunnel
```

## 작동 방식

| 구성 요소                            | 목적                            |
| ------------------------------------ | ------------------------------- |
| `LocalForward 18789 127.0.0.1:18789` | 로컬 18789를 원격 18789로 전달  |
| `ssh -N`                             | SSH 명령 실행 없이(포트 전달만) |
| `KeepAlive`                          | 터널이 충돌하면 자동 재시작     |
| `RunAtLoad`                          | 에이전트 로드 시 터널 시작      |

OpenClaw.app은 클라이언트 머신의 `ws://127.0.0.1:18789`에 연결합니다. SSH 터널이 해당 연결을 게이트웨이가 실행 중인 원격 머신의 포트 18789로 전달합니다.
