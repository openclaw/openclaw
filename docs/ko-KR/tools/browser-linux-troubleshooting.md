---
summary: "Fix Chrome/Brave/Edge/Chromium CDP startup issues for OpenClaw browser control on Linux"
read_when: "Browser control fails on Linux, especially with snap Chromium"
title: "Browser Troubleshooting"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/tools/browser-linux-troubleshooting.md
workflow: 15
---

# Browser Troubleshooting (Linux)

## Problem: "Failed to start Chrome CDP on port 18800"

OpenClaw의 browser control 서버가 다음 오류로 Chrome/Brave/Edge/Chromium 시작에 실패합니다:

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### Root Cause

Ubuntu 및 많은 Linux 배포판에서 기본 Chromium 설치는 **snap package** 입니다. Snap 의 AppArmor 격리는 OpenClaw 가 browser 프로세스를 생성하고 모니터링하는 방식을 방해합니다.

`apt install chromium` 명령은 snap 으로 리다이렉트하는 stub 패키지를 설치합니다:

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

이는 실제 browser 가 아닙니다 — 단지 래퍼일 뿐입니다.

### Solution 1: Google Chrome 설치 (권장)

공식 Google Chrome `.deb` 패키지를 설치합니다. 이는 snap 으로 샌드박스되지 않습니다:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

그런 다음 OpenClaw config (`~/.openclaw/openclaw.json`) 를 업데이트합니다:

```json
{
  "browser": {
    "enabled": true,
    "executablePath": "/usr/bin/google-chrome-stable",
    "headless": true,
    "noSandbox": true
  }
}
```

### Solution 2: Snap Chromium 을 Attach-Only Mode 로 사용

snap Chromium 을 사용해야 하는 경우, OpenClaw 를 수동으로 시작된 browser 에 연결되도록 구성합니다:

1. Config 업데이트:

```json
{
  "browser": {
    "enabled": true,
    "attachOnly": true,
    "headless": true,
    "noSandbox": true
  }
}
```

2. Chromium 을 수동으로 시작:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. 선택 사항: systemd user service 를 생성하여 Chrome 을 자동 시작:

```ini
# ~/.config/systemd/user/openclaw-browser.service
[Unit]
Description=OpenClaw Browser (Chrome CDP)
After=network.target

[Service]
ExecStart=/snap/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=18800 --user-data-dir=%h/.openclaw/browser/openclaw/user-data about:blank
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

활성화: `systemctl --user enable --now openclaw-browser.service`

### Browser 가 작동하는지 확인

상태 확인:

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

browsing 테스트:

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### Config Reference

| Option                   | Description                                                      | Default                                                     |
| ------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| `browser.enabled`        | Browser control 활성화                                           | `true`                                                      |
| `browser.executablePath` | Chromium 기반 browser 바이너리 경로 (Chrome/Brave/Edge/Chromium) | auto-detected (prefers default browser when Chromium-based) |
| `browser.headless`       | GUI 없이 실행                                                    | `false`                                                     |
| `browser.noSandbox`      | `--no-sandbox` 플래그 추가 (일부 Linux 설정에 필요)              | `false`                                                     |
| `browser.attachOnly`     | Browser 시작 안 함, 기존에만 연결                                | `false`                                                     |
| `browser.cdpPort`        | Chrome DevTools Protocol 포트                                    | `18800`                                                     |

### Problem: "Chrome extension relay is running, but no tab is connected"

`chrome` 프로필 (extension relay) 을 사용하고 있습니다. OpenClaw browser extension 이 실시간 탭에 연결되기를 예상합니다.

수정 옵션:

1. **관리되는 browser 사용:** `openclaw browser start --browser-profile openclaw`
   (또는 `browser.defaultProfile: "openclaw"` 설정).
2. **Extension relay 사용:** extension 을 설치하고, 탭을 열고, OpenClaw extension 아이콘을 클릭하여 연결합니다.

Notes:

- `chrome` 프로필은 가능한 경우 **system default Chromium browser** 를 사용합니다.
- 로컬 `openclaw` 프로필은 자동으로 `cdpPort`/`cdpUrl` 을 할당합니다; 원격 CDP 에만 설정합니다.
